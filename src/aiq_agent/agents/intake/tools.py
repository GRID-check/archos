"""The Erfassungs-Agent's own tools: ``intake_needs``, ``record_values``, ``finish_intake`` (ADR-0111).

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
import logging
import re
from collections import Counter
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import Field

from . import client
from .read_log import NOT_FOUND
from .read_log import current_read_log

logger = logging.getLogger(__name__)

INTAKE_NEEDS_TOOL = "intake_needs"
RECORD_VALUES_TOOL = "record_values"
FINISH_INTAKE_TOOL = "finish_intake"

#: The quote the model copies: the exact words, short enough to read on the review.
MAX_QUOTE_CHARS = 300
#: Needs one rendering lists; the rest are counted and stay for the next call.
MAX_RENDERED_NEEDS = 60
#: Unread file names one rendering lists.
MAX_RENDERED_FILES = 40
MAX_WHY_CHARS = 160
MAX_OPTIONS_RENDERED = 30

SELECT_TYPES = frozenset({"single_select", "multi_select"})
NUMBER_TYPES = frozenset({"number", "number_tri"})

_OUTCOME_TEXT = {
    "suggested": "suggested — a person will check it",
    "corroborated": "corroborated — the profile already holds this value; your evidence was added",
    "contradiction": "contradiction — differs from the value already on the profile; kept beside it for a person",
}
_REFUSAL_TEXT = {
    "vocabulary": "refused: the value is not one of the question's options (use the option tokens exactly)",
    "not-a-need": "refused: not an open need (check the key and its @bwN suffix with intake_needs)",
    "dismissed": "refused: a person dismissed this value before; do not record it again",
    "unreadable-file": "refused: this file may not feed the profile; take the value from another document",
}


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
    outcomes: Counter = field(default_factory=Counter)
    refusals: Counter = field(default_factory=Counter)

    def remember_needs(self, body: dict[str, Any]) -> None:
        needs = [need for need in body.get("needs") or [] if isinstance(need, dict) and need.get("key")]
        self.needs = {str(need["key"]): need for need in needs}
        self.mode = str(body.get("mode") or self.mode)
        self.decisive_open = sum(1 for need in needs if need.get("decisive") and need.get("state") == "open")


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


def _need_order(need: dict[str, Any]) -> tuple[int, int]:
    return (0 if need.get("decisive") else 1, 0 if need.get("state") == "open" else 1)


def render_needs(body: dict[str, Any]) -> str:
    """The ``needs`` answer as the model reads it: bounded, decisive and open needs first, and says it is bounded."""
    needs = sorted((need for need in body.get("needs") or [] if isinstance(need, dict)), key=_need_order)
    unread = [str(name) for name in body.get("unreadFiles") or []]
    lines = [f"Mode: {body.get('mode') or 'active'}"]
    if body.get("description"):
        lines.append(f"Description by the person who created the project: {body['description']}")
    location = body.get("location")
    if isinstance(location, dict) and location.get("label"):
        lines.append(f"Address chosen at creation: {location['label']}")
    open_count = sum(1 for need in needs if need.get("state") == "open")
    lines.append(f"\nNeeds: {len(needs)} ({open_count} open, {len(needs) - open_count} only suggested so far)")
    lines.extend(render_need(need) for need in needs[:MAX_RENDERED_NEEDS])
    if len(needs) > MAX_RENDERED_NEEDS:
        lines.append(
            f"[{len(needs) - MAX_RENDERED_NEEDS} more needs not listed (bounded at {MAX_RENDERED_NEEDS}). "
            "Call intake_needs again after recording: covered needs drop out and the rest move up.]"
        )
    if not needs:
        lines.append("Nothing is needed any more: finish the intake.")
    lines.append(f"\nFiles not read by any reading yet: {len(unread)}")
    lines.extend(f"- {name}" for name in unread[:MAX_RENDERED_FILES])
    if len(unread) > MAX_RENDERED_FILES:
        lines.append(f"[{len(unread) - MAX_RENDERED_FILES} more; list_files shows every file.]")
    return "\n".join(lines)


INTAKE_NEEDS_DESCRIPTION = (
    "What the project's profile still needs, from the intake API: every open question the wizard would ask now "
    "(key, label, type, option tokens, unit, where the value is usually found, why it is asked), decisive needs "
    "first (filling one could change the Gebäudeklasse), and the files no reading has read yet. A need marked "
    "`suggested` already has a value from a document: record it again only to corroborate it from another "
    "document or to report a different value. Call it again after recording values: what you covered drops out, "
    "and new needs can appear (a Wohnbau asks for its Wohnungen)."
)


class _NoArguments(BaseModel):
    pass


# ── record_values ────────────────────────────────────────────────────────────


class RecordedValue(BaseModel):
    key: str = Field(description="The need's key exactly as intake_needs lists it, with its @bwN suffix if it has one.")
    value: bool | int | float | str | list[str] = Field(
        description=(
            "The value the document states for THIS project. Select: the option token exactly (multi_select: a "
            "list of tokens). Number: a number in the question's unit, no unit text. Boolean: true or false. "
            "Text: the words as written."
        )
    )
    file_name: str = Field(description="The file the quote stands in, exactly as the reading tool named it.")
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
    "Record values the project's documents state, each with the file, the page and the verbatim quote that "
    f"states it. Up to {client.MAX_RECORD_VALUES} per call. Nothing you record becomes a fact: each value is a "
    "suggestion a person confirms, so record only what a document states for THIS project, never a guess, an "
    "average or something you worked out. The Gebäudeklasse is derived by the system from the values you record; "
    "never compute it. Checked before anything is sent: the quote must stand in text you read in this run in "
    "that file (read the page with read_document first), a select value must be one of the option tokens, and "
    "the quote must say the value. The answer gives one outcome per key: suggested, corroborated, contradiction "
    "(a different value is already on the profile; yours is kept beside it), or refused with the reason."
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
    file_name = log.canonical_name(item.file_name)
    if file_name is None or not log.has_text(file_name):
        return _NotSent(
            "not-read",
            f"not sent: you have not read „{item.file_name}“ in this run; read the page with read_document first",
        )
    found = log.contains(file_name, quote, item.page)
    if found is NOT_FOUND:
        return _NotSent(
            "quote-not-read",
            f"not sent: the quote does not stand in what you read of „{file_name}“. Read the page with "
            "read_document first and copy the document's exact words",
        )
    need = session.needs.get(item.key)
    value = _coerce(item.value, need)
    outside = _outside_options(value, need)
    if outside:
        tokens = ", ".join(str(option.get("token")) for option in (need or {}).get("options") or [])
        listed = ", ".join(outside)
        return _NotSent(
            "not-an-option", f"not sent: {listed} is not an option of this question; the tokens are: {tokens}"
        )
    page = found if isinstance(found, int) else (item.page if item.page and item.page >= 1 else None)
    return _Candidate(index, item.key, value, file_name, page, quote, need)


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


def _outcome_line(key: str, result: dict[str, Any]) -> tuple[str, str]:
    outcome = str(result.get("outcome") or "")
    if outcome == "refused":
        reason = str(result.get("reason") or "")
        return f"refused:{reason or 'unknown'}", _REFUSAL_TEXT.get(reason, f"refused ({reason or 'no reason given'})")
    return outcome, _OUTCOME_TEXT.get(outcome, outcome or "no outcome")


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
    if to_send:
        reply = await client.call_intake("record", client.record_request(session.job_id, [c.wire() for c in to_send]))
        session.stale = session.stale or reply.stale
        results = reply.body.get("results") if reply.ok else None
        for position, candidate in enumerate(to_send):
            result = results[position] if isinstance(results, list) and position < len(results) else None
            if not isinstance(result, dict):
                lines[candidate.index] = f"- {candidate.key}: not recorded — {reply.refusal or 'no result returned'}"
                continue
            counted, text = _outcome_line(candidate.key, result)
            (session.refusals if counted.startswith("refused") else session.outcomes)[counted] += 1
            lines[candidate.index] = f"- {candidate.key} = {candidate.value!r}: {text}"
    out = [lines[index] for index in sorted(lines)]
    if overflow > 0:
        out.append(f"[{overflow} more value(s) not sent: at most {client.MAX_RECORD_VALUES} per call.]")
    return "\n".join(out) if out else "Nothing to record."


# ── finish_intake ────────────────────────────────────────────────────────────


class FinishInput(BaseModel):
    summary: str = Field(
        description=(
            "Two to four German sentences for the person who checks the reading: what you read, what you found, "
            f"what stays open and which document would answer it. At most {client.MAX_SUMMARY_CHARS} characters."
        )
    )


FINISH_INTAKE_DESCRIPTION = (
    "End the reading: tell the intake API it is done, with your summary, and stop. Call it once, when the needs "
    "are covered, when the documents hold nothing more for them, or when the step budget is spent. Nothing runs "
    "after it."
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


def make_intake_tools(session: IntakeSession) -> list[StructuredTool]:
    """The three intake tools, bound to this run's session."""

    async def _needs() -> str:
        reply = await client.call_intake("needs", client.needs_request(session.job_id))
        if not reply.ok:
            session.stale = session.stale or reply.stale
            return reply.refusal
        session.remember_needs(reply.body)
        return render_needs(reply.body)

    async def _record(values: list[RecordedValue]) -> str:
        return await record_values(session, values)

    async def _finish(summary: str) -> str:
        return await finish_intake(session, summary)

    return [
        StructuredTool.from_function(
            coroutine=_needs, name=INTAKE_NEEDS_TOOL, description=INTAKE_NEEDS_DESCRIPTION, args_schema=_NoArguments
        ),
        StructuredTool.from_function(
            coroutine=_record,
            name=RECORD_VALUES_TOOL,
            description=RECORD_VALUES_DESCRIPTION,
            args_schema=RecordValuesInput,
        ),
        StructuredTool.from_function(
            coroutine=_finish,
            name=FINISH_INTAKE_TOOL,
            description=FINISH_INTAKE_DESCRIPTION,
            args_schema=FinishInput,
            return_direct=True,
        ),
    ]
