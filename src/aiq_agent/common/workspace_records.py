"""Workspace reads and proposals as RECORDS: the third channel of evidence, beside passages and measurements.

Piloti reaches the office's own state through its MCP server (``workspace__call``,
ADR-0121): who is on a project, which approvals are open, what a task says. A
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
and never a normative one.

## Where records come from

From the turn's own transcript, not from the tool: each ``workspace__call``
the model made this turn, paired with its result. The tool's text is all the
model read, so it is all a sentence can have been written from:

- a READ answers with the route's JSON (``discovery.ts`` ``renderText``), whose
  scalar values become the record's haystack; a capped, non-JSON answer is
  matched as text;
- a WRITE answers „Proposed — the person decides. Nothing was changed.": a
  PROPOSAL, whose evidence is the server row the person decides on. Its values
  are the inputs the model proposed;
- a refusal („Fehler …") is no record at all.

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

#: The server's text for a write it filed as a proposal (``discovery.ts``).
PROPOSED_PREFIX = "Proposed"
#: How the tool words every refusal and failure for the model (``tools/workspace``).
_REFUSAL_PREFIXES = ("Fehler", "Error")

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

    def to_wire(self) -> dict[str, Any]:
        return {"operation": self.operation, "outcome": self.outcome}


def is_workspace_call(tool_name: str) -> bool:
    """Whether ``tool_name`` is the workspace group's ``call``, however the group was qualified."""
    name = (tool_name or "").strip()
    return any(name == qualified or name.endswith(f"__{qualified}") for qualified in _QUALIFIED_CALL_NAMES)


def _scalars(value: Any, counts: set[int]) -> Iterable[str]:
    """Every scalar under ``value``, as text; the length of every list on the way into ``counts``."""
    if isinstance(value, dict):
        for item in value.values():
            yield from _scalars(item, counts)
    elif isinstance(value, list):
        counts.add(len(value))
        for item in value:
            yield from _scalars(item, counts)
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
    if not stripped or stripped.startswith(_REFUSAL_PREFIXES):
        return None
    counts: set[int] = set()
    if stripped.startswith(PROPOSED_PREFIX):
        call_input = arguments.get("input") if isinstance(arguments.get("input"), dict) else {}
        values = list(_scalars(call_input, counts))
        return WorkspaceRecord(operation, "proposed", _haystack(values), frozenset())
    try:
        values = list(_scalars(json.loads(stripped), counts))
    except ValueError:
        values = [stripped]
    counts.update(Counter(value.casefold() for value in values).values())
    return WorkspaceRecord(operation, "read", _haystack(values), frozenset(counts))


def records_from_messages(messages: Sequence[Any]) -> list[WorkspaceRecord]:
    """The records this turn's workspace calls left, in the order their results arrived.

    ``messages`` is this turn's slice of the transcript. A result whose call is
    not on any message is skipped: without the call there is no operation to
    name.
    """
    calls = _calls_by_id(messages)
    records: list[WorkspaceRecord] = []
    for message in messages:
        if not is_workspace_call(getattr(message, "name", "") or ""):
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
