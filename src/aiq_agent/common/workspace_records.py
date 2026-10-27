"""Workspace reads and proposals as RECORDS: the third channel of evidence, beside passages and measurements.

Piloti reaches the office's own state through its MCP server (``workspace__call``,
ADR-0122): who is on a project, which approvals are open, what a task says. A
statement read straight off that state is backed more firmly than by any
passage, because the server row IS the fact. The answer check reads every
record of the turn beside the passages (``common/claim_judge.py``, ADR-0139).

## Why a separate channel, not the ``SourceRegistry``

The same argument ``tools/bim/measurement_sources.py`` makes for measurements,
and for the same reason: the registry is what ``[N]`` resolves through and what
``EmptySourceRegistryError`` means is empty. A record in it would be citable
like a passage of the law, and a turn that read the task list and retrieved
nothing would stop being a turn without retrieved evidence. So a record never
touches it, and the check is told that a record never backs a statement about
what a regulation requires.

## Where records come from

From the turn's own transcript, not from the tool: each ``workspace__call``
the model made this turn, paired with its result. The tool's text is all the
model read:

- a READ answers with the route's JSON (``discovery.ts`` ``renderText``),
  whole or capped;
- a WRITE answers „Proposed — the person decides. Nothing was changed.": a
  PROPOSAL, whose record is the input the model proposed;
- a ``list_files`` LISTING, or an ``ls`` or ``glob`` of the estate (ADR-0133
  slice 6), is its rendered text, cut at :data:`LISTING_MAX_CHARS`. It stays an
  index, never cited, and registers no source (``citation_verification``);
- anything else (a refusal, which the tool words „Error …", or a notice the
  agent's own guards answered the call with) is no JSON and no record.

## What a record never holds: Piloti's own words

A record is evidence because the server holds it and the model did not write
it. A conversation's history (``conversation-message-list``), a comment thread
or a report Piloti drafted are server rows too, but the words in them are an
earlier answer's, and reading them as evidence would launder model knowledge
into a record. So an object marked as Piloti's (``role:
"assistant"``, ``authoredBy: "agent"``, ``authorKind: "piloti"``) contributes
nothing, and a capped answer carrying such a marker, which cannot be split by
author, is no record.

Pure: messages in, records out. The caller scopes the messages to this turn
(``answer_pipeline.this_turn``).
"""

from __future__ import annotations

import json
import re
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

RecordOutcome = Literal["read", "proposed"]


@dataclass(frozen=True)
class WorkspaceRecord:
    """One workspace call or listing this turn: what it read or proposed, as the text the answer check reads."""

    #: The operation the model called (``project-members-list``), as it named it.
    operation: str
    outcome: RecordOutcome
    #: What the result held, Piloti's own words taken out: the route's JSON, the
    #: proposed input, or the listing's lines.
    text: str

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


#: The filesystem verbs that list the estate (ADR-0133 slice 6), read like ``list_files`` was.
ESTATE_LISTING_TOOLS = ("ls", "glob")


def is_estate_listing(tool_name: str, call: dict[str, Any] | None) -> bool:
    """Whether a result is an ``ls`` or ``glob`` of the estate; one of the drafts or the skills lists no files."""
    from aiq_agent.common.estate_paths import call_mount
    from aiq_agent.common.turn_status import tool_basename

    base = tool_basename(tool_name or "")
    if base not in ESTATE_LISTING_TOOLS or call is None:
        return False
    return call_mount(base, call.get("args")) not in (None, "drafts", "skills")


def listing_record(text: str, tool: str = LISTING_TOOL) -> WorkspaceRecord | None:
    """The record a ``list_files`` result makes: its rendered text, capped.

    A listing is rows the knowledge layer computed, not words Piloti wrote, so
    it is a read.
    """
    stripped = text.strip()
    if not stripped or _LISTING_REFUSALS.match(stripped):
        return None
    return WorkspaceRecord(tool, "read", stripped[:LISTING_MAX_CHARS])


def _piloti_authored(value: Any) -> bool:
    """Whether ``value`` is an object the workspace marks as written by Piloti."""
    if not isinstance(value, dict):
        return False
    for key, item in value.items():
        marks = _PILOTI_AUTHORED.get(str(key).casefold())
        if marks and isinstance(item, str) and item.strip().casefold() in marks:
            return True
    return False


def _without_piloti(value: Any) -> Any:
    """``value`` with every object the workspace marks as Piloti's own taken out."""
    if isinstance(value, dict):
        return {key: _without_piloti(item) for key, item in value.items() if not _piloti_authored(item)}
    if isinstance(value, list):
        return [_without_piloti(item) for item in value if not _piloti_authored(item)]
    return value


def _read_record(operation: str, text: str) -> WorkspaceRecord | None:
    """The record a read's JSON makes, whole or capped; None when it holds nothing but Piloti's words."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return None if _PILOTI_AUTHORED_TEXT_RE.search(text) else WorkspaceRecord(operation, "read", text)
    kept = None if _piloti_authored(parsed) else _without_piloti(parsed)
    if kept in (None, {}, []):
        return None
    return WorkspaceRecord(operation, "read", json.dumps(kept, ensure_ascii=False))


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
        return WorkspaceRecord(operation, "proposed", json.dumps(call_input, ensure_ascii=False))
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
        listed = calls.get(str(getattr(message, "tool_call_id", "") or ""))
        if is_listing_call(name) or is_estate_listing(name, listed):
            if getattr(message, "status", None) == "error":
                continue
            listing = listing_record(_content_text(getattr(message, "content", "")), name.rsplit("__", 1)[-1])
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
