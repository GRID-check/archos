"""The Erfassungs-Agent's own tools: ``intake_needs``, ``record_values``, ``withdraw_values``, ``finish_intake``.

ADR-0111.

Built per run in Python, not registered with NAT: they exist only for this
agent, close over the run's :class:`IntakeSession`, and nothing else binds
them. The rules about how each is used live in its description (ADR-0060), so
the prompt keeps only the job.

The BFF decides what a recorded value becomes. This side checks only what it
can check better than the BFF: that the quote stands in text this run read of
that file (``read_log``), that a token is one of the question's options, and,
for a select question, whether the quote says the value at all
(``knowledge/fingerprint_verify``, ADR-0096's check, ADR-0064 use 12).
"""

from __future__ import annotations

import asyncio
import difflib
import logging
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import Field

from . import client
from .read_log import NOT_FOUND
from .read_log import current_read_log
from .reading import citation_parts

logger = logging.getLogger(__name__)

INTAKE_NEEDS_TOOL = "intake_needs"
RECORD_VALUES_TOOL = "record_values"
WITHDRAW_VALUES_TOOL = "withdraw_values"
FINISH_INTAKE_TOOL = "finish_intake"

#: The quote the model copies: the exact words, short enough to read on the review.
MAX_QUOTE_CHARS = 300
#: Needs one rendering lists; the rest are counted and stay for the next call.
MAX_RENDERED_NEEDS = 60
#: Unread file names one rendering lists.
MAX_RENDERED_FILES = 40
MAX_WHY_CHARS = 160
MAX_OPTIONS_RENDERED = 30
#: Opened needs one record answer names; the rest are counted.
MAX_RENDERED_OPENED = 30
#: Keys and files the finish hold names.
MAX_HELD_ITEMS = 12

SELECT_TYPES = frozenset({"single_select", "multi_select"})
NUMBER_TYPES = frozenset({"number", "number_tri"})

_OUTCOME_TEXT = {
    "suggested": "suggested — a person will check it",
    "corroborated": "corroborated — the profile already holds this value; your evidence was added",
    "contradiction": "contradiction — differs from the value already on the profile; kept beside it for a person",
}
_REFUSAL_TEXT = {
    "vocabulary": (
        "refused: not a value this question takes (select: its option tokens exactly; number: a plain number in "
        "the question's unit; yes/no: true or false)"
    ),
    "unknown-key": (
        "refused: no question of the intake writes this key, or not with this @bldgN/@bldgN@use suffix, or the "
        "Bauwerk is not on the profile"
    ),
    "dismissed": "refused: a person dismissed this value before; do not record it again",
    "unreadable-file": "refused: this file may not feed the profile; take the value from another document",
}
_WITHDRAW_TEXT = {
    "withdrawn": "withdrawn — no longer on the profile, and not refused: a later reading may record it again",
    "nothing-suggested": "refused: nothing is suggested under this key",
    "confirmed": "refused: a person confirmed this value; it stays",
    "not-this-reading": (
        "refused: not a suggestion of this reading (an earlier reading's, the derived Gebäudeklasse, a default); "
        "it stays for a person to decide"
    ),
}
_CLASS_REFUSAL = (
    "refused: the Gebäudeklasse is derived from the inputs you record, never recorded; record the inputs the "
    "document gives"
)
#: Keys one ``unknown-key`` refusal names as the closest it knows.
CLOSEST_KEYS = 3


@dataclass
class IntakeSession:
    """One run's dealings with the intake API: what it was told, and what came of it."""

    job_id: str
    organization_id: str | None = None
    needs: dict[str, dict[str, Any]] = field(default_factory=dict)
    mode: str = "active"
    decisive_open: int = 0
    finished: bool = False
    finish_status: str | None = None
    summary: str = ""
    stale: bool = False
    #: ``finish_intake`` answered once with what is still open instead of finishing.
    finish_held: bool = False
    outcomes: Counter = field(default_factory=Counter)
    refusals: Counter = field(default_factory=Counter)

    def remember_needs(self, body: dict[str, Any]) -> None:
        needs = [need for need in body.get("needs") or [] if isinstance(need, dict) and need.get("key")]
        self.needs = {str(need["key"]): need for need in needs}
        self.mode = str(body.get("mode") or self.mode)
        self.decisive_open = sum(1 for need in needs if need.get("decisive") and need.get("state") == "open")

    def closest_keys(self, key: str) -> list[str]:
        """The keys intake_needs listed that come closest to ``key``: for a refusal the model can act on."""
        return difflib.get_close_matches(key, list(self.needs), n=CLOSEST_KEYS, cutoff=0.5)


# ── intake_needs ─────────────────────────────────────────────────────────────


def _options_text(need: dict[str, Any]) -> str:
    options = [option for option in need.get("options") or [] if isinstance(option, dict)]
    if not options:
        return ""
    shown = ", ".join(f"{option.get('token')} ({option.get('label')})" for option in options[:MAX_OPTIONS_RENDERED])
    more = f", … {len(options) - MAX_OPTIONS_RENDERED} more" if len(options) > MAX_OPTIONS_RENDERED else ""
    return f" · options: {shown}{more}"


def render_need(need: dict[str, Any]) -> str:
    """One need as one line: key, label, type and unit, state, options, where it is found, why it is asked."""
    flags = "[decisive] " if need.get("decisive") else ""
    unit = f", {need['unit']}" if need.get("unit") else ""
    found_in = ", ".join(str(item) for item in need.get("foundIn") or [])
    why = str(need.get("why") or "").strip()
    why = (why[:MAX_WHY_CHARS] + "…") if len(why) > MAX_WHY_CHARS else why
    parts = [f"- {flags}{need.get('key')} — {need.get('label')} ({need.get('type')}{unit}) · {need.get('state')}"]
    parts.append(_options_text(need))
    if found_in:
        parts.append(f" · found in: {found_in}")
    if why:
        parts.append(f" · why: {why}")
    return "".join(parts)


_STATE_ORDER = {"open": 0, "suggested": 1, "confirmed": 2}


def _need_order(need: dict[str, Any]) -> tuple[int, int]:
    return (0 if need.get("decisive") else 1, _STATE_ORDER.get(str(need.get("state")), 1))


def render_needs(body: dict[str, Any], start: int = 0) -> str:
    """The ``needs`` answer as the model reads it: bounded, decisive first, then open, suggested, confirmed.

    ``start`` pages past the first :data:`MAX_RENDERED_NEEDS`; the answer says
    when it is bounded and which call shows the rest.
    """
    needs = sorted((need for need in body.get("needs") or [] if isinstance(need, dict)), key=_need_order)
    unread = [str(name) for name in body.get("unreadFiles") or []]
    lines = [f"Mode: {body.get('mode') or 'active'}"]
    if body.get("description"):
        lines.append(f"Description by the person who created the project: {body['description']}")
    location = body.get("location")
    if isinstance(location, dict) and location.get("label"):
        lines.append(f"Address chosen at creation: {location['label']}")
    states = Counter(str(need.get("state")) for need in needs)
    lines.append(
        f"\nNeeds: {len(needs)} ({states['open']} open, {states['suggested']} suggested so far, "
        f"{states['confirmed']} confirmed by a person)"
    )
    start = max(0, min(start, len(needs)))
    shown = needs[start : start + MAX_RENDERED_NEEDS]
    if start:
        lines.append(f"[Needs {start + 1}–{start + len(shown)} of {len(needs)}.]")
    lines.extend(render_need(need) for need in shown)
    rest = len(needs) - start - len(shown)
    if rest > 0:
        lines.append(
            f"[{rest} more needs not listed (bounded at {MAX_RENDERED_NEEDS}): intake_needs(start="
            f"{start + len(shown)}) lists them. Recording moves an open need behind the open ones.]"
        )
    if not needs:
        lines.append("Nothing is needed any more: finish the intake.")
    lines.append(f"\nFiles not read by any reading yet: {len(unread)}")
    lines.extend(f"- {name}" for name in unread[:MAX_RENDERED_FILES])
    if len(unread) > MAX_RENDERED_FILES:
        lines.append(f"[{len(unread) - MAX_RENDERED_FILES} more; list_files shows every file.]")
    return "\n".join(lines)


INTAKE_NEEDS_DESCRIPTION = (
    "What the project's profile still needs, from the intake API, as it stands now: every question the wizard "
    "would ask for what is known (key, label, type, option tokens, unit, where the value is usually found, why it "
    "is asked), and the files no reading has read yet. `decisive`: filling it could change a Bauwerk's "
    "Gebäudeklasse. State `open`: nothing on the profile. `suggested`: a document's value is there, unconfirmed; "
    "record it again only from another document, which corroborates it or, if different, is kept beside it for "
    "a person. `confirmed`: a person confirmed a Gebäudeklasse input; record it only from a document that states "
    "it (a newer Stand, say): the same value corroborates it, a different one becomes a contradiction a person "
    "decides, and the confirmed value is never overwritten. Answers change as values are recorded: a recorded "
    "value can open new questions (Nutzungen open the Wohnungen of a Wohnbau). A key you know from the "
    "documents need not be listed yet to be recorded: any key a wizard question writes is taken. Bounded at "
    f"{MAX_RENDERED_NEEDS} needs per answer; `start` pages on."
)


class NeedsInput(BaseModel):
    start: int = Field(
        default=0, ge=0, description="Skip this many needs: the answer names the next start when bounded."
    )


# ── record_values ────────────────────────────────────────────────────────────


class RecordedValue(BaseModel):
    key: str = Field(
        description=(
            "The profile key exactly as intake_needs lists it, with its @bldgN (Bauwerk) or @bldgN@use (Nutzungszone) "
            "suffix. A key not listed yet is taken when a wizard question writes it (dwelling_units@bldg1@residential "
            "before the Nutzungen are recorded)."
        )
    )
    value: bool | int | float | str | list[str] = Field(
        description=(
            "The value the document states for THIS project. Select: the option token exactly (multi_select: a "
            "list of tokens). Number: a number in the question's unit, no unit text. Boolean: true or false. "
            "Text: the words as written."
        )
    )
    citation: str | None = Field(
        default=None,
        description=(
            "Where the quote stands, as the reading tool printed it: `Baubeschreibung.pdf, p.3` from a search hit, "
            "or `Baubeschreibung.pdf, S. 3`. Give this or file_name."
        ),
    )
    file_name: str | None = Field(
        default=None, description="The file the quote stands in, exactly as the reading tool named it."
    )
    page: int | None = Field(default=None, description="The page from the [Seite N] marker or the hit; null if none.")
    quote: str = Field(
        description=(
            f"The document's own words that state the value, copied verbatim from text a tool showed you in this "
            f"run, at most {MAX_QUOTE_CHARS} characters. Never paraphrased, never assembled from two places."
        )
    )


class RecordValuesInput(BaseModel):
    values: list[RecordedValue] = Field(
        description=f"1 to {client.MAX_RECORD_VALUES} values, each with its evidence. Several keys in one call."
    )


RECORD_VALUES_DESCRIPTION = (
    "Record values the project's documents state, each with where it stands (citation, or file_name and page) "
    f"and the verbatim quote that states it. Up to {client.MAX_RECORD_VALUES} per call, several keys at once. "
    "Nothing you record becomes a fact: each value is a suggestion a person confirms against the quote, so "
    "record only what a document states for THIS project, as its Zielzustand (a Bestand key: the existing "
    "building), never a guess, a typical value or something you worked out. A value the document calls "
    "undecided, under review or one of several options is not stated: a person would be confirming a decision "
    "nobody made. A drawing's Planart (Einreichplan) names the drawing, not the project's phase. Never record "
    "the Gebäudeklasse, even where a document states one: the system derives it from the inputs you record and "
    "a person confirms it there, so record the inputs the document gives. Value: select, the option "
    "token exactly (multi_select: a list); number, "
    "a plain number in the question's unit, no unit text (`7,2 m` is 7.2); yes/no, true or false; text, the "
    "words as written. Quote: the document's own words, copied from text a tool showed you in this run in that "
    f"file, at most {MAX_QUOTE_CHARS} characters, the sentence, table row or title-block line, never paraphrased "
    "or joined from two places. Checked before anything is sent: the quote stands in what you read of that file "
    "(when it does not, the answer shows the closest passage you did read), a select value is one of the option "
    'tokens and its quote says it. Example: {"values": [{"key": "storeys_above_ground@bldg1", '
    '"value": 3, "citation": "Baubeschreibung.pdf, S. 3", "quote": "Das Gebäude hat drei '
    'oberirdische Geschoße"}]}. Outcomes, one per value: suggested (new on the profile, a person will check '
    "it); corroborated (the profile holds the same value; your evidence was added); contradiction (the profile "
    "holds a different value; yours is kept beside it for a person to decide); refused, with the reason and "
    "what to do instead. The answer also names the needs your values opened (a Gebäude opens its Geschoße, "
    "Fluchtniveau and areas), decisive ones marked: they are needs now, and intake_needs lists them with their "
    "options."
)


_GROUPED_THOUSANDS = re.compile(r"^-?\d{1,3}(\.\d{3})+$")


def _number(text: str) -> int | float | None:
    """A number as a German document writes it: `12,5`, `1.200`, `1.200,50`; None when it is not one."""
    text = text.strip().replace("\u00a0", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    elif _GROUPED_THOUSANDS.match(text):
        text = text.replace(".", "")
    try:
        number = float(text)
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def _coerce(value: Any, need: dict[str, Any] | None) -> Any:
    """The value in the type the question takes, where the model sent it as text: `"12,5"` for a number."""
    kind = (need or {}).get("type")
    if kind in NUMBER_TYPES and isinstance(value, str):
        number = _number(value)
        return value if number is None else number
    if kind == "boolean" and isinstance(value, str) and value.strip().casefold() in {"true", "false", "ja", "nein"}:
        return value.strip().casefold() in {"true", "ja"}
    if kind == "multi_select" and isinstance(value, str):
        return [value]
    if kind == "single_select" and isinstance(value, list) and len(value) == 1:
        return value[0]
    return value


def _outside_options(value: Any, need: dict[str, Any] | None) -> list[str]:
    """Tokens of a select value that are not among the question's options."""
    if not need or need.get("type") not in SELECT_TYPES or not need.get("options"):
        return []
    tokens = {str(option.get("token")) for option in need["options"] if isinstance(option, dict)}
    given = value if isinstance(value, list) else [value]
    return [str(token) for token in given if str(token) not in tokens]


@dataclass
class _Candidate:
    index: int
    key: str
    value: Any
    file_name: str
    page: int | None
    quote: str
    need: dict[str, Any] | None

    def wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "value": self.value,
            "evidence": {"fileName": self.file_name, "page": self.page, "quote": self.quote},
        }


@dataclass(frozen=True)
class _NotSent:
    """Why a value never left the process: a code for the trace, a sentence for the model."""

    code: str
    text: str


def _checked(index: int, item: RecordedValue, session: IntakeSession) -> _Candidate | _NotSent:
    """The value ready to verify and send, or why it is not sent."""
    log = current_read_log()
    quote = " ".join((item.quote or "").split())[:MAX_QUOTE_CHARS].strip()
    if log is None:
        return _NotSent("no-read-log", "not sent: nothing was read in this run, so no quote can be checked")
    if item.value is None or item.value in ("", []):
        return _NotSent("empty", "not sent: an empty value records nothing; leave the need open instead")
    if not quote:
        return _NotSent("no-quote", "not sent: a value needs the quote that states it")
    named, cited_page = _where(item)
    if not named:
        return _NotSent("no-file", "not sent: say where the quote stands, as citation or file_name")
    asked_page = item.page if item.page is not None else cited_page
    file_name = log.canonical_name(named)
    if file_name is None or not log.has_text(file_name):
        return _NotSent(
            "not-read",
            f"not sent: you have not read „{named}“ in this run; read the page with read_document first",
        )
    found = log.contains(file_name, quote, asked_page)
    if found is NOT_FOUND:
        return _NotSent("quote-not-read", _not_read_text(log, file_name, quote, asked_page))
    need = session.needs.get(item.key)
    value = _coerce(item.value, need)
    outside = _outside_options(value, need)
    if outside:
        tokens = ", ".join(str(option.get("token")) for option in (need or {}).get("options") or [])
        listed = ", ".join(outside)
        return _NotSent(
            "not-an-option", f"not sent: {listed} is not an option of this question; the tokens are: {tokens}"
        )
    page = found if isinstance(found, int) else (asked_page if asked_page and asked_page >= 1 else None)
    return _Candidate(index, item.key, value, file_name, page, quote, need)


def _where(item: RecordedValue) -> tuple[str, int | None]:
    """The file and page a value names: ``file_name`` and ``page`` when given, else parsed from its citation."""
    if item.file_name and item.file_name.strip():
        name = item.file_name.strip()
        # A model that put the whole citation in file_name: read it as one.
        parsed, page = citation_parts(name)
        return (name, None) if page is None else (parsed, page)
    if item.citation and item.citation.strip():
        return citation_parts(item.citation)
    return "", None


def _not_read_text(log: Any, file_name: str, quote: str, page: int | None) -> str:
    """Why a quote was not sent, with the closest passage that WAS read there, so the next call can succeed."""
    text = f"not sent: the quote does not stand in what you read of „{file_name}“."
    closest = log.closest(file_name, quote, page)
    if closest is None:
        return f"{text} Read the page with read_document and copy the document's exact words."
    where = f" on page {closest.page}" if closest.page else ""
    return (
        f"{text} Closest passage you read{where}: „{closest.text}“. If it states the value, quote it exactly; "
        "otherwise read the page that does."
    )


def _verify_selects(candidates: list[_Candidate], session: IntakeSession) -> dict[int, str]:
    """Ask the decision model whether each select value's quote states it; drop the clear contradictions.

    Blocking. Returns the refusal per candidate index; a multi-select value it
    trims keeps its remaining tokens in place.
    """
    from aiq_agent.knowledge.fingerprint_verify import verify_fingerprint
    from aiq_agent.knowledge.project_experience import Evidence
    from aiq_agent.knowledge.project_experience import FingerprintValue
    from aiq_agent.knowledge.project_experience import VocabularyEntry
    from aiq_agent.knowledge.project_experience import VocabularyOption

    selects = [c for c in candidates if c.need and c.need.get("type") in SELECT_TYPES]
    if not selects:
        return {}
    vocabulary: dict[str, VocabularyEntry] = {}
    labels: dict[str, str] = {}
    values: list[FingerprintValue] = []
    for candidate in selects:
        need = candidate.need or {}
        base = str(need.get("baseKey") or candidate.key)
        options = [o for o in need.get("options") or [] if isinstance(o, dict) and o.get("token") and o.get("label")]
        vocabulary[base] = VocabularyEntry(
            multiple=need.get("type") == "multi_select",
            options=[VocabularyOption(token=str(o["token"]), label=str(o["label"])) for o in options],
        )
        labels[base] = str(need.get("label") or base)
        page = str(candidate.page) if candidate.page else None
        evidence = Evidence(fileName=candidate.file_name, page=page, quote=candidate.quote)
        values.append(FingerprintValue(key=base, value=candidate.value, evidence=[evidence]))
    kept = verify_fingerprint(values, vocabulary, organization_id=session.organization_id, fact_labels=labels)
    refused: dict[int, str] = {}
    position = 0
    for candidate, value in zip(selects, values, strict=True):
        match = kept[position] if position < len(kept) else None
        if match is not None and match.key == value.key and match.evidence == value.evidence:
            position += 1
            if match.value != value.value:
                candidate.value = match.value
            continue
        refused[candidate.index] = (
            "not sent: read as not stating this value (the quote does not say it for this project); "
            "find a passage that states it, or leave the need open"
        )
    return refused


def _outcome_line(key: str, result: dict[str, Any], session: IntakeSession) -> tuple[str, str]:
    outcome = str(result.get("outcome") or "")
    if outcome == "refused":
        reason = str(result.get("reason") or "")
        if reason == "unknown-key" and key.split("@", maxsplit=1)[0] in {"building_class", "gebaeudeklasse"}:
            return "refused:unknown-key", _CLASS_REFUSAL
        text = _REFUSAL_TEXT.get(reason, f"refused ({reason or 'no reason given'})")
        close = session.closest_keys(key) if reason == "unknown-key" else []
        if close:
            text = f"{text}; closest keys intake_needs listed: {', '.join(close)}"
        return f"refused:{reason or 'unknown'}", text
    return outcome, _OUTCOME_TEXT.get(outcome, outcome or "no outcome")


def render_opened(opened: Any) -> str:
    """The needs a record opened, as one line: ``opened: key [decisive], …``; empty when it opened none."""
    items = [item for item in opened or [] if isinstance(item, dict) and item.get("key")]
    if not items:
        return ""
    shown = ", ".join(
        f"{item['key']}{' [decisive]' if item.get('decisive') else ''}" for item in items[:MAX_RENDERED_OPENED]
    )
    more = f", … {len(items) - MAX_RENDERED_OPENED} more" if len(items) > MAX_RENDERED_OPENED else ""
    return f"opened: {shown}{more} (now needs; intake_needs lists them with their options)"


async def record_values(session: IntakeSession, values: list[RecordedValue]) -> str:
    """Check, verify and send ``values``; one line per key. Never raises."""
    if session.stale:
        return "Not sent: this reading is no longer the project's current one. Call finish_intake and stop."
    if session.finished:
        return "Not sent: the intake is already finished."
    batch = list(values or [])[: client.MAX_RECORD_VALUES]
    overflow = len(values or []) - len(batch)
    lines: dict[int, str] = {}
    candidates: list[_Candidate] = []
    for index, item in enumerate(batch):
        checked = _checked(index, item, session)
        if isinstance(checked, _NotSent):
            session.refusals[f"local:{checked.code}"] += 1
            lines[index] = f"- {item.key}: {checked.text}"
        else:
            candidates.append(checked)
    try:
        refused = await asyncio.to_thread(_verify_selects, candidates, session)
    except Exception:  # noqa: BLE001 — verification is a filter; when it fails, the values go as they are
        logger.warning("Intake: select verification failed; sending unverified", exc_info=True)
        refused = {}
    for index, reason in refused.items():
        session.refusals["local:not-stated"] += 1
        lines[index] = f"- {batch[index].key}: {reason}"
    to_send = [candidate for candidate in candidates if candidate.index not in refused]
    opened = ""
    if to_send:
        reply = await client.call_intake("record", client.record_request(session.job_id, [c.wire() for c in to_send]))
        session.stale = session.stale or reply.stale
        _record_results(session, to_send, reply, lines)
        opened = render_opened(reply.body.get("opened")) if reply.ok else ""
    out = [lines[index] for index in sorted(lines)]
    if overflow > 0:
        out.append(f"[{overflow} more value(s) not sent: at most {client.MAX_RECORD_VALUES} per call.]")
    if opened:
        out.append(opened)
    return "\n".join(out) if out else "Nothing to record."


def _record_results(
    session: IntakeSession, sent: list[_Candidate], reply: client.IntakeReply, lines: dict[int, str]
) -> None:
    """One line per value the route answered, counted on the session."""
    results = reply.body.get("results") if reply.ok else None
    for position, candidate in enumerate(sent):
        result = results[position] if isinstance(results, list) and position < len(results) else None
        if not isinstance(result, dict):
            lines[candidate.index] = f"- {candidate.key}: not recorded — {reply.refusal or 'no result returned'}"
            continue
        counted, text = _outcome_line(candidate.key, result, session)
        (session.refusals if counted.startswith("refused") else session.outcomes)[counted] += 1
        lines[candidate.index] = f"- {candidate.key} = {candidate.value!r}: {text}"


# ── withdraw_values ──────────────────────────────────────────────────────────


class WithdrawInput(BaseModel):
    keys: list[str] = Field(
        description=f"1 to {client.MAX_RECORD_VALUES} keys, each one you recorded in this run, exactly as recorded."
    )


WITHDRAW_VALUES_DESCRIPTION = (
    "Take back values you recorded in this run once you see a document does not state them for this project: "
    "undecided after all, one of several options, another building's, an older Fassung's. Only your own "
    "suggestions from this run can go; a value a person gave or confirmed, the derived Gebäudeklasse and an "
    "earlier reading's suggestion stay, and the answer says so. A withdrawn value is not refused: no person said "
    "no, so a later reading may record it again from a document that states it. To replace a value with "
    "another, withdraw it and record the other."
)


async def withdraw_values(session: IntakeSession, keys: list[str]) -> str:
    """Send the keys to ``withdraw``; one line per key. Never raises."""
    if session.stale:
        return "Not sent: this reading is no longer the project's current one. Call finish_intake and stop."
    if session.finished:
        return "Not sent: the intake is already finished."
    wanted = list(dict.fromkeys(key.strip() for key in keys or [] if key and key.strip()))
    if not wanted:
        return "Nothing to withdraw."
    batch = wanted[: client.MAX_RECORD_VALUES]
    reply = await client.call_intake("withdraw", client.withdraw_request(session.job_id, batch))
    session.stale = session.stale or reply.stale
    if not reply.ok:
        return reply.refusal
    lines = []
    for item in reply.body.get("results") or []:
        if not isinstance(item, dict):
            continue
        outcome, reason = str(item.get("outcome") or ""), str(item.get("reason") or "")
        if outcome == "withdrawn":
            session.outcomes["withdrawn"] += 1
        else:
            session.refusals[f"withdraw:{reason or 'unknown'}"] += 1
        lines.append(f"- {item.get('key')}: {_WITHDRAW_TEXT.get(reason or outcome, outcome or 'no outcome')}")
    if len(wanted) > len(batch):
        lines.append(f"[{len(wanted) - len(batch)} more key(s) not sent: at most {client.MAX_RECORD_VALUES} per call.]")
    return "\n".join(lines) or "No result returned."


# ── finish_intake ────────────────────────────────────────────────────────────


class FinishInput(BaseModel):
    summary: str = Field(
        description=(
            "Two to four German sentences for the person who checks the reading: what you read, what you found, "
            f"what stays open and which document would answer it. At most {client.MAX_SUMMARY_CHARS} characters."
        )
    )


FINISH_INTAKE_DESCRIPTION = (
    "End the reading: tell the intake API it is done, with your summary, and stop. Call it when the needs "
    "are covered, when the documents hold nothing more for them, or when the budget is spent. Nothing runs after "
    "it. While decisive needs are open and files are unread, the first call does not finish: it names them, "
    "and a second call finishes as it is. The summary is shown to the person who checks the reading and is "
    "handed to the next reading of this project as its starting note: every claim in it rests on something a "
    "tool returned in this run (files read, values recorded, refusals), and it says plainly what stays open and "
    "which document would answer it."
)


async def finish_intake(session: IntakeSession, summary: str) -> str:
    """POST ``finish`` once, with the files the run opened and the trace id. Never raises."""
    from aiq_agent.observability.turn_trace import current_trace_id_hex

    if session.finished:
        return "The intake is already finished."
    session.finished = True
    session.summary = (summary or "").strip()[: client.MAX_SUMMARY_CHARS]
    log = current_read_log()
    documents = log.documents_read if log is not None else []
    reply = await client.call_intake(
        "finish", client.finish_request(session.job_id, session.summary, documents, current_trace_id_hex())
    )
    if not reply.ok:
        session.stale = session.stale or reply.stale
        return f"Finished, but the intake API did not take it: {reply.refusal}"
    session.finish_status = str(reply.body.get("status") or "") or None
    return f"Intake finished ({session.finish_status or 'status unknown'}); {len(documents)} document(s) read."


def _named(items: list[str]) -> str:
    shown = ", ".join(items[:MAX_HELD_ITEMS])
    return shown + (f", … {len(items) - MAX_HELD_ITEMS} more" if len(items) > MAX_HELD_ITEMS else "")


async def finish_hold(session: IntakeSession) -> str | None:
    """Once per run: what stands against finishing now, when decisive needs are open and files are unread.

    None when nothing does, when the hold was given already, or when the needs
    cannot be read: a failed check never keeps a run from finishing.
    """
    if session.finish_held or session.finished or session.stale:
        return None
    reply = await client.call_intake("needs", client.needs_request(session.job_id))
    if not reply.ok:
        return None
    session.remember_needs(reply.body)
    decisive = [key for key, need in session.needs.items() if need.get("decisive") and need.get("state") == "open"]
    log = current_read_log()
    read = set(log.documents_read if log is not None else [])
    unread = [str(name) for name in reply.body.get("unreadFiles") or [] if str(name) not in read]
    if not decisive or not unread:
        return None
    session.finish_held = True
    return (
        f"Not finished yet. Decisive needs still open, each could change a Gebäudeklasse: {_named(decisive)}. "
        f"Files no reading has opened: {_named(unread)}. Read those that could state them, or call finish_intake "
        "again to finish as it is."
    )


def make_intake_tools(
    session: IntakeSession, *, budget_spent: Callable[[], bool] = lambda: False
) -> list[StructuredTool]:
    """The four intake tools, bound to this run's session.

    ``budget_spent`` says the step budget is used up: then ``finish_intake``
    finishes at once, since nothing else would run.
    """

    async def _needs(start: int = 0) -> str:
        reply = await client.call_intake("needs", client.needs_request(session.job_id))
        if not reply.ok:
            session.stale = session.stale or reply.stale
            return reply.refusal
        session.remember_needs(reply.body)
        return render_needs(reply.body, start)

    async def _record(values: list[RecordedValue]) -> str:
        return await record_values(session, values)

    async def _withdraw(keys: list[str]) -> str:
        return await withdraw_values(session, keys)

    async def _finish(summary: str) -> str:
        held = None if budget_spent() else await finish_hold(session)
        return held or await finish_intake(session, summary)

    return [
        StructuredTool.from_function(
            coroutine=_needs, name=INTAKE_NEEDS_TOOL, description=INTAKE_NEEDS_DESCRIPTION, args_schema=NeedsInput
        ),
        StructuredTool.from_function(
            coroutine=_record,
            name=RECORD_VALUES_TOOL,
            description=RECORD_VALUES_DESCRIPTION,
            args_schema=RecordValuesInput,
        ),
        StructuredTool.from_function(
            coroutine=_withdraw,
            name=WITHDRAW_VALUES_TOOL,
            description=WITHDRAW_VALUES_DESCRIPTION,
            args_schema=WithdrawInput,
        ),
        # Not return_direct: a held finish must reach the model. The run ends on
        # ``session.finished`` instead (``IntakeToolMiddleware.abefore_model``).
        StructuredTool.from_function(
            coroutine=_finish,
            name=FINISH_INTAKE_TOOL,
            description=FINISH_INTAKE_DESCRIPTION,
            args_schema=FinishInput,
        ),
    ]
