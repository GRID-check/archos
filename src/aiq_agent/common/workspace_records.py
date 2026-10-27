"""Workspace reads and proposals as RECORDS: the third channel of evidence, beside passages and measurements.

Piloti reaches the office's own state through its MCP server (``workspace__call``,
ADR-0122): who is on a project, which approvals are open, what a task says. A
sentence read straight off that state is grounded more firmly than any passage,
because the server row IS the fact. Before this module, the answer pipeline
could not tell: the workspace is not a data source (``NOT_SOURCES``), nothing
it returned reached the citation registry, and „Anna hat drei offene
Freigaben" surfaced as an ungrounded „low".

## Why a separate channel, not the ``SourceRegistry``

The same argument ``tools/bim/measurement_sources.py`` makes for measurements,
and for the same reason: the registry is what ``[N]`` resolves through, what
the single-source fallback once drew from, and what ``EmptySourceRegistryError``
means is empty. A record in it would let a member list ground an uncited legal
verdict, and a turn that read the task list and retrieved nothing would stop
being a turn without retrieved evidence. So a record never touches it. It
grounds descriptive and value sentences about the office (``claim_provenance``)
and never a verdict on the law (ADR-0139).

## Where records come from

From the turn's own transcript, not from the tool: each ``workspace__call``
the model made this turn, paired with its result. The tool's text is all the
model read, so it is all a sentence can have been written from:

- a READ answers with the route's JSON (``discovery.ts`` ``renderText``), whose
  scalar values become the record's haystack, one ITEM per element of a list
  (a row); a capped answer is the JSON cut short, matched as text, one item per
  fragment between brackets;
- a WRITE answers „Proposed — the person decides. Nothing was changed.": a
  PROPOSAL, whose evidence is the server row the person decides on. Its values
  are the inputs the model proposed;
- a ``list_files`` LISTING (tree or files view; ADR-0125, amendment of
  2026-10-22) is read like a capped read: the rendered text the model saw, cut
  at :data:`LISTING_MAX_CHARS`, one item per line, so „Einreichung: 6
  Dokumente, aktuell Index B" is a sentence read off the listing. It is
  provenance only: the listing stays an index, never cited, and registers no
  source (``citation_verification``);
- the CONFIRMED PROJECT PROFILE in the turn context (``PROJECT_CONTEXT v1``,
  its ``confirmed:`` rows, ADR-0139) is a read too: the person confirmed each
  row in the intake, and the prompt hands the rows to the model verbatim.
  :func:`profile_record` makes one item per row, its English tokens followed
  by the German the answer writes them in (:data:`_PROFILE_WORDS`), so
  „Geschoße · 5 oberirdisch" or „Widmung · Wohngebiet" is a sentence read off
  the profile. Notes (``PROJECT_MEMORY``), unknowns and assumptions are not:
  the prompt itself calls a note neither a confirmed fact nor law;
- anything else (a refusal, which the tool words „Error …", or a notice the
  agent's own guards answered the call with) is no JSON and no record.

## What a record never holds: Piloti's own words

A record is evidence because the server holds it and the model did not write
it. A conversation's history (``conversation-message-list``), a comment thread
or a report Piloti drafted are server rows too, but the words in them are an
earlier answer's, and matching a sentence against them would launder model
knowledge into ``record``. So an object marked as Piloti's (``role:
"assistant"``, ``authoredBy: "agent"``, ``authorKind: "piloti"``) contributes
nothing, and a capped answer carrying such a marker, which cannot be split by
author, is no record.

Pure: messages in, records out. The caller scopes the messages to this turn
(``answer_pipeline.this_turn``).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from typing import Literal

#: The function group the workspace tools are registered under (``configs``,
#: ``function_groups.workspace``) and its one tool that reads or proposes.
#: Matched on the QUALIFIED name: the bare basename ``call`` says nothing.
WORKSPACE_GROUP = "workspace"
WORKSPACE_CALL = "call"
_QUALIFIED_CALL_NAMES = (f"{WORKSPACE_GROUP}__{WORKSPACE_CALL}", f"{WORKSPACE_GROUP}.{WORKSPACE_CALL}")

#: ``list_files`` (knowledge layer), however the group qualified it, and the
#: operation name its records carry. The most listing text kept per call.
LISTING_TOOL = "list_files"
LISTING_MAX_CHARS = 12_000
#: How a listing refusal starts (bad argument, unknown shelf); no listing, no record.
_LISTING_REFUSALS = re.compile(r"^(?:`\w+` must be|Invalid |Unknown )", re.IGNORECASE)

#: The server's text for a write it filed as a proposal (``discovery.ts``).
PROPOSED_PREFIX = "Proposed"
#: How a read's text starts: the route's JSON, whole or capped.
_JSON_STARTS = ("{", "[")

#: The markers the workspace's wire puts on what Piloti wrote: a stored
#: answer's ``role``, a Kommentar's or a Dokument's ``authoredBy``, a thread
#: message's ``authorKind``. Matched casefolded.
_PILOTI_AUTHORED: dict[str, frozenset[str]] = {
    "role": frozenset({"assistant"}),
    "authoredby": frozenset({"agent", "piloti"}),
    "authorkind": frozenset({"agent", "piloti"}),
}
_PILOTI_AUTHORED_TEXT_RE = re.compile(
    r'"(?:role|authoredBy|authorKind)"\s*:\s*"(?:assistant|agent|piloti)"', re.IGNORECASE
)
_FRAGMENT_SPLIT_RE = re.compile(r"[{}\[\]\n]")

RecordOutcome = Literal["read", "proposed"]

_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})")

#: Workspace enum tokens and the German the answer writes for them. Both sides
#: go into the haystack, so „freigegeben" matches a stored ``approved``.
_ENUM_WORDS: dict[str, tuple[str, ...]] = {
    "approved": ("freigegeben", "genehmigt"),
    "accepted": ("angenommen",),
    "rejected": ("abgelehnt",),
    "dismissed": ("verworfen", "abgelehnt"),
    "pending": ("offen", "ausstehend"),
    "open": ("offen",),
    "done": ("erledigt", "abgeschlossen"),
    "completed": ("erledigt", "abgeschlossen"),
    "closed": ("geschlossen", "abgeschlossen"),
    "draft": ("entwurf",),
    "in_review": ("in prüfung", "zur prüfung"),
    "archived": ("archiviert",),
    "active": ("aktiv",),
    "owner": ("inhaber", "inhaberin"),
    "admin": ("administrator", "administratorin"),
    "member": ("mitglied",),
}


@dataclass(frozen=True)
class WorkspaceRecord:
    """One workspace call this turn: what it read or proposed, as text a sentence can be matched against."""

    #: The operation the model called (``project-members-list``), as it named it.
    operation: str
    outcome: RecordOutcome
    #: Every scalar value the result carried, casefolded, one per line; enum
    #: tokens are followed by their German.
    haystack: str
    #: The counts it implies without stating them: the length of every list,
    #: and how often each value repeats („2 offen" when two rows say pending).
    counts: frozenset[int] = frozenset()
    #: The haystack per item: one row of a list, or the values outside any
    #: list. Words a sentence is matched on must stand in one item together.
    items: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {"operation": self.operation, "outcome": self.outcome}


def is_workspace_call(tool_name: str) -> bool:
    """Whether ``tool_name`` is the workspace group's ``call``, however the group was qualified."""
    name = (tool_name or "").strip()
    return any(name == qualified or name.endswith(f"__{qualified}") for qualified in _QUALIFIED_CALL_NAMES)


def is_listing_call(tool_name: str) -> bool:
    """Whether ``tool_name`` is ``list_files``, bare or group-qualified."""
    name = (tool_name or "").strip()
    return name == LISTING_TOOL or name.endswith(f"__{LISTING_TOOL}")


def listing_record(text: str) -> WorkspaceRecord | None:
    """The record a ``list_files`` result makes: its rendered text, capped, one item per line.

    A listing is rows the knowledge layer computed, not words Piloti wrote, so
    it is a read. Numbers are matched against the text itself; the line counts
    (``12 file(s)``, ``6 documents``) are in it.
    """
    stripped = text.strip()
    if not stripped or _LISTING_REFUSALS.match(stripped):
        return None
    lines = [line.strip().casefold() for line in stripped[:LISTING_MAX_CHARS].splitlines() if line.strip()]
    return WorkspaceRecord(LISTING_TOOL, "read", "\n".join(lines), frozenset(), tuple(lines))


#: The operation a record of the confirmed project profile names.
PROFILE_OPERATION = "project-profile"

#: The German an answer writes a profile token in, by token: the intake's own
#: question and option labels (``frontends/ui/src/lib/project-profile/
#: intake-definition.ts``), cut to the words a sentence repeats. A token
#: missing here still matches on its numbers and its own spelling; the table
#: only lets a row like „Widmung · Wohngebiet" match without one.
_PROFILE_WORDS: dict[str, tuple[str, ...]] = {
    # Keys
    "zoning": ("widmung", "flächenwidmung", "flaechenwidmung"),
    "work_type": ("maßnahme", "massnahme", "vorhaben"),
    "construction_method": ("bauweise", "tragstruktur"),
    "storeys_above_ground": ("geschoße", "geschosse", "oberirdisch", "oberirdische"),
    "storeys_below_ground": ("geschoße", "geschosse", "unterirdisch", "unterirdische", "untergeschoß"),
    "uses": ("nutzung", "nutzungen"),
    "residential_form": ("wohnform",),
    "building_class": ("gebäudeklasse", "gebaeudeklasse"),
    "escape_level": ("fluchtniveau",),
    "escape_level_m": ("fluchtniveau", "rechenwert"),
    "elevator": ("aufzug",),
    "pv": ("photovoltaik", "photovoltaikanlage"),
    "heritage_protection": ("denkmalschutz",),
    "protected_area": ("schutzgebiet",),
    "contaminated_land": ("altlast", "altlasten"),
    "old_town_protection_zone": ("altstadterhaltungszone", "schutzzone", "altstadt"),
    "development_pattern": ("bebauungsweise", "bauweise"),
    "existing_year_built": ("baujahr", "bestand", "bestandsgebäude"),
    "site_address": ("adresse", "standort"),
    "project_name": ("projekt",),
    "federal_state": ("bundesland",),
    "project_phase": ("phase", "projektphase"),
    "bauherrschaft": ("bauherrschaft", "bauherr"),
    "max_building_height": ("höchstgebäudehöhe", "gebäudehöhe", "bauklasse"),
    "building_position": ("gebäudestellung",),
    "conditioning": ("konditionierung",),
    "development_plan": ("bebauungsplan",),
    "noise_situation": ("lärm", "lärmsituation"),
    "fire_brigade_access": ("feuerwehr", "feuerwehrzufahrt"),
    "drinking_water": ("trinkwasser",),
    "district_heating": ("fernwärme",),
    "building_lines": ("baufluchtlinien", "baugrenzen"),
    "build_to_plot_boundary": ("grundgrenze", "anbau"),
    "workplace": ("arbeitsstätte",),
    "public_access": ("öffentlich", "publikumsverkehr"),
    "fireplaces": ("feuerstätten", "rauchfänge"),
    "commercial_facility": ("betriebsanlage",),
    "water_rights": ("wasserrecht", "wasserrechtliche"),
    "tree_stock": ("baumbestand",),
    "funding": ("förderung", "zertifizierung"),
    "hazard_zones": ("gefahrenzonen", "standortrisiken"),
    "heat_supply": ("wärmeversorgung",),
    "fire_safety_systems": ("brandschutz", "anlagentechnischer"),
    "building_type": ("bauwerkstyp",),
    "country": ("land",),
    # Values
    "residential": ("wohnen", "wohngebiet", "wohnnutzung", "wohngebäude", "wohnhaus"),
    "office": ("büro", "verwaltung"),
    "lodging": ("beherbergung",),
    "extension": ("zubau",),
    "new_build": ("neubau",),
    "conversion": ("umbau",),
    "timber": ("holz", "holzbau", "holzbauweise"),
    "closed": ("geschlossen", "geschlossene"),
    "open": ("offen", "offene"),
    "preliminary_design": ("vorentwurf",),
    "vienna": ("wien",),
    "attached": ("angebaut",),
    "heated": ("beheizt",),
    "conventional": ("konventionell", "klassisch"),
    "urban": ("innerstädtisch", "städtisch"),
    "above_ground": ("oberirdisch",),
    "building": ("gebäude",),
    "private": ("privat",),
    "at": ("österreich",),
    "true": ("ja",),
    "false": ("nein", "kein", "keine", "keinen"),
    "none": ("keine", "kein"),
}
_PROFILE_ROW_RE = re.compile(r"^-\s*([^=\s][^=]*)=(.*)$")


def _profile_spellings(token: str) -> list[str]:
    """A profile token, its parts and its German: „escape_level_m@bldg1" reads as „escape level m fluchtniveau …"."""
    folded = token.strip().strip('"').casefold()
    parts = [part for part in re.split(r"[@_,\s]+", folded) if part]
    words = [folded, " ".join(parts)]
    # „gk5" is written „GK 5", „11-22m" as „11–22 m".
    words.append(re.sub(r"(?<=[^\W\d_])(?=\d)|(?<=\d)(?=[^\W\d_])", " ", re.sub(r"[-–]", " ", folded)))
    for name in (folded.split("@")[0], *[value.strip() for value in folded.split(",")], *parts):
        words.extend(_PROFILE_WORDS.get(name, ()))
    return words


def profile_record(project_context: str | None) -> WorkspaceRecord | None:
    """The record the confirmed rows of ``PROJECT_CONTEXT v1`` make, one item per row; None without one.

    Read from the same text the prompt renders (``prompt-view.ts``,
    ``buildProjectPromptView``): the ``confirmed:`` section, up to the next
    blank line. A row's key and value tokens are followed by their German.
    """
    if not project_context or "PROJECT_CONTEXT v1" not in project_context:
        return None
    items: list[str] = []
    in_confirmed = False
    for line in project_context.splitlines():
        stripped = line.strip()
        if stripped == "confirmed:":
            in_confirmed = True
            continue
        if not stripped or not stripped.startswith("-"):
            # A blank line or the next section's header ends the confirmed rows.
            in_confirmed = False
            continue
        match = _PROFILE_ROW_RE.match(stripped) if in_confirmed else None
        if match is None:
            continue
        key, value = match.group(1), match.group(2)
        items.append("\n".join([*_profile_spellings(key), *_profile_spellings(value)]))
    if not items:
        return None
    return WorkspaceRecord(PROFILE_OPERATION, "read", "\n".join(items), frozenset(), tuple(items))


def _piloti_authored(value: dict[str, Any]) -> bool:
    """Whether ``value`` is an object the workspace marks as written by Piloti."""
    for key, item in value.items():
        marks = _PILOTI_AUTHORED.get(str(key).casefold())
        if marks and isinstance(item, str) and item.strip().casefold() in marks:
            return True
    return False


def _scalars(value: Any, counts: set[int], items: list[list[str]] | None = None) -> Iterable[str]:
    """Every scalar under ``value`` as text, skipping what Piloti wrote; list lengths into ``counts``.

    With ``items``, each list element's scalars also go into an item of their own.
    """
    if isinstance(value, dict):
        if _piloti_authored(value):
            return
        for item in value.values():
            yield from _scalars(item, counts, items)
    elif isinstance(value, list):
        counts.add(len(value))
        for item in value:
            if items is None:
                yield from _scalars(item, counts, None)
                continue
            row = list(_scalars(item, counts, items))
            if row:
                items.append(row)
            yield from row
    elif isinstance(value, bool) or value is None:
        return
    elif isinstance(value, (int, float, str)):
        text = str(value).strip()
        if text:
            yield text


def _with_spellings(text: str) -> list[str]:
    """``text`` casefolded, plus the German an enum token and an ISO date are written as."""
    folded = text.casefold()
    spellings = [folded, *_ENUM_WORDS.get(folded, ())]
    for year, month, day in _ISO_DATE_RE.findall(folded):
        spellings += [f"{int(day)}.{int(month)}.{year}", f"{day}.{month}.{year}", f"{int(day)}.{int(month)}."]
    return spellings


def _haystack(values: Iterable[str]) -> str:
    return "\n".join(spelling for value in values for spelling in _with_spellings(value))


def _read_record(operation: str, text: str) -> WorkspaceRecord | None:
    """The record a read's JSON makes, whole or capped; None when it holds nothing but Piloti's words."""
    counts: set[int] = set()
    rows: list[list[str]] = []
    try:
        parsed = json.loads(text)
    except ValueError:
        if _PILOTI_AUTHORED_TEXT_RE.search(text):
            return None
        values = [text]
        rows = [[fragment] for fragment in _FRAGMENT_SPLIT_RE.split(text) if fragment.strip()]
    else:
        values = list(_scalars(parsed, counts, rows))
        loose = _outside_rows(parsed)
        if loose:
            rows.append(loose)
    if not values and not counts:
        return None
    counts.update(Counter(value.casefold() for value in values).values())
    items = tuple(_haystack(row) for row in rows) or (_haystack(values),)
    return WorkspaceRecord(operation, "read", _haystack(values), frozenset(counts), items)


def _outside_rows(value: Any) -> list[str]:
    """The scalars of ``value`` that stand outside every list: a page's total, a project's own name."""
    if isinstance(value, dict):
        if _piloti_authored(value):
            return []
        return [scalar for item in value.values() for scalar in _outside_rows(item)]
    if isinstance(value, list):
        return []
    return list(_scalars(value, set()))


def _calls_by_id(messages: Sequence[Any]) -> dict[str, dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}
    for message in messages:
        for call in getattr(message, "tool_calls", None) or []:
            if isinstance(call, dict) and call.get("id"):
                calls[str(call["id"])] = call
    return calls


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content)
    return str(content or "")


def record_from_result(operation: str, arguments: dict[str, Any], text: str) -> WorkspaceRecord | None:
    """The record one ``workspace__call`` result makes, or None for a refusal or an empty answer."""
    stripped = text.strip()
    if stripped.startswith(PROPOSED_PREFIX):
        call_input = arguments.get("input") if isinstance(arguments.get("input"), dict) else {}
        values = list(_scalars(call_input, set()))
        return WorkspaceRecord(operation, "proposed", _haystack(values), frozenset())
    if not stripped.startswith(_JSON_STARTS):
        return None
    return _read_record(operation, stripped)


#: How the tool names the proposal it filed, after the server's „Proposed …"
#: (``tools/workspace/register._show_proposal``): „Proposal <uuid>: <summary>.".
_PROPOSAL_ID_RE = re.compile(
    r"\bProposal ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"
)


def filed_proposal_ids(messages: Sequence[Any]) -> frozenset[str]:
    """The ids of the proposals this turn's workspace calls filed, lower-cased.

    ``messages`` is this turn's slice of the transcript. Read off the results
    the model was given, so an id here is one the server returned for a write
    this turn, never one the model wrote itself.
    """
    ids: set[str] = set()
    for message in messages:
        if not is_workspace_call(getattr(message, "name", "") or ""):
            continue
        text = _content_text(getattr(message, "content", "")).strip()
        if text.startswith(PROPOSED_PREFIX):
            ids.update(match.lower() for match in _PROPOSAL_ID_RE.findall(text))
    return frozenset(ids)


def records_from_messages(messages: Sequence[Any]) -> list[WorkspaceRecord]:
    """The records this turn's workspace calls left, in the order their results arrived.

    ``messages`` is this turn's slice of the transcript. A result whose call is
    not on any message is skipped: without the call there is no operation to
    name.
    """
    calls = _calls_by_id(messages)
    records: list[WorkspaceRecord] = []
    for message in messages:
        name = getattr(message, "name", "") or ""
        if is_listing_call(name):
            listing = listing_record(_content_text(getattr(message, "content", "")))
            if listing is not None:
                records.append(listing)
            continue
        if not is_workspace_call(name):
            continue
        call = calls.get(str(getattr(message, "tool_call_id", "") or ""))
        if call is None:
            continue
        arguments = call.get("args") if isinstance(call.get("args"), dict) else {}
        operation = str(arguments.get("name") or "").strip() or "unknown"
        record = record_from_result(operation, arguments, _content_text(getattr(message, "content", "")))
        if record is not None:
            records.append(record)
    return records
