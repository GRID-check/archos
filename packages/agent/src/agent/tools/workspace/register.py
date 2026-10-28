"""``workspace``: everything a person can do in Piloti, reached through Piloti's own MCP server.

Four tools (``workspace__search``, ``workspace__describe``, ``workspace__call``,
``workspace__report_missing``), one NAT function group, because they share the
client and the refusal. They are the SAME four meta-tools an external agent
(Claude, Cursor) gets from the server in ``search`` mode (ADR-0122): the
model finds an operation by what it wants to do, reads its schema, then calls
it. Reads run; a write comes back as a proposal the person accepts, so nothing
here changes the workspace on its own authority (ADR-0105).

## Identity

The envelope is read HERE, at call time, in the turn's own async context, and
echoed (``client.py``). Nothing is connected at build time and nothing is
cached between calls, so a call can only carry the identity of the turn that
made it. Why NAT's ``mcp_client`` group was not used is in ``client.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from agent import project_context
from agent.common.action_outcome import ActionOutcome
from agent.common.action_rows import ActionRow
from agent.common.bff_http import SignedEnvelope
from agent.common.turn_status import record_lane_hit
from agent.observability.langfuse_trace_attributes import add_trace_tag
from agent.observability.retrieval_trace import emit_step_span
from agent.turn.response import turn_answer_message_id
from nat.plugin_api import Builder
from nat.plugin_api import FunctionGroup
from nat.plugin_api import FunctionGroupBaseConfig
from nat.plugin_api import register_function_group

from .cards import REVISION_COMPARE_OPERATION
from .cards import emit_operation_proposal_card
from .cards import emit_revision_compare_card
from .cards import proposal_from
from .client import WorkspaceError
from .client import call_tool_result

logger = logging.getLogger(__name__)

FEATURE_TAG = "feature:workspace-mcp"

#: The ``shelf`` a workspace read carries in the retrieval ledger (``common/retrieval_ledger.py``). An English
#: token, like every shelf: the UI words it for the reader (``chat.thinking.node.workspaceRead``), and the
#: lane's ``name`` is the operation, the identifier the read ran.
WORKSPACE_SHELF = "workspace"

#: The server's tool names (kebab-case, fixed by the contract), by this group's function.
SERVER_TOOLS = {
    "search": "search-operations",
    "describe": "describe-operation",
    "call": "call-operation",
    "report_missing": "report-missing-operation",
}

# Everything the model reads from these tools is English, one word per concept (AGENTS.md, "Industry
# standard first"; the terms are in docs/glossary.md, "Agent surface and standard terms"). The model
# answers the person in their language; it does not quote these sentences.

#: A 429, from the door itself or from the route an operation runs. The limit is per minute and a round
#: takes seconds, so the next round may well be served; this one is not.
RATE_LIMITED = "Error: rate limited; nothing was changed. Call again in the next round, not in this one."

#: How a route's own 429 reads once ``discovery.ts`` has worded it (``refusalResult``).
_ROUTE_RATE_LIMITED = re.compile(r"\(HTTP 429\b")

_NO_ENVELOPE = (
    "Error: this run carries no signed request context, so Piloti cannot read or do anything in the "
    "workspace on a person's behalf. Do not retry."
)

#: The meta-tools' words, written once by the server (``metaToolsFor`` in
#: ``apps/workspace/bff/agent-api/discovery.ts``) and exported here by
#: ``meta-tools.spec.ts`` (``UPDATE_FIXTURES=1``): the in-product variant, which
#: never offers the ``platform`` domain. This file keeps no copy of its own.
META_TOOLS_PATH = Path(__file__).with_name("meta_tools.json")


def _local_names(text: str) -> str:
    """``text`` with the server's tool names as this group's (``call-operation`` -> ``workspace__call``)."""
    for step, server_name in SERVER_TOOLS.items():
        text = re.sub(rf"(?<![\w-]){re.escape(server_name)}(?![\w-])", f"workspace__{step}", text)
    return text


def _descriptions() -> dict[str, str]:
    tools = json.loads(META_TOOLS_PATH.read_text(encoding="utf-8"))["tools"]
    return {step: _local_names(tools[server_name]["description"]) for step, server_name in SERVER_TOOLS.items()}


DESCRIPTIONS = _descriptions()


class WorkspaceConfig(FunctionGroupBaseConfig, name="piloti_workspace"):
    """The workspace tools as one group (``function_groups.workspace``)."""


def _envelope() -> SignedEnvelope | None:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        return None
    return SignedEnvelope(header=header, signature=signature)


def _answer_message_id() -> str | None:
    """The answer this turn writes, for the BFF to mark (ADR-0093); none outside a conversation."""
    conversation_id = project_context.get_conversation_id_from_context()
    return turn_answer_message_id(conversation_id) if conversation_id else None


def _observe(step: str, request: dict[str, Any], outcome: dict[str, Any]) -> None:
    """A ``workspace.<step>`` observation and the turn's tag. Names and sizes, never the answer's text."""
    add_trace_tag(FEATURE_TAG)
    emit_step_span(f"workspace.{step}", request, outcome)


async def run_workspace(step: str, arguments: dict[str, Any], outcome: ActionOutcome | None = None) -> str:
    """One call to the server as the turn's person; every refusal comes back as text for the model.

    ``outcome`` is told when the call was refused or failed, for the action row of ``workspace__call``.
    """
    outcome = outcome if outcome is not None else ActionOutcome()
    envelope = _envelope()
    if envelope is None:
        outcome.failed = True
        _observe(step, {"tool": SERVER_TOOLS[step]}, {"refused": "no_envelope"})
        return _NO_ENVELOPE
    try:
        result = await asyncio.to_thread(
            call_tool_result, SERVER_TOOLS[step], arguments, envelope, answer_message_id=_answer_message_id()
        )
    except WorkspaceError as exc:
        outcome.failed = True
        _observe(step, {"tool": SERVER_TOOLS[step]}, {"error": str(exc), "status": exc.status})
        if exc.status == 429:
            return RATE_LIMITED
        return (
            f"Error reaching the workspace: {exc}. Nothing was changed. Tell the person it did not work, and do "
            "not retry in the same answer."
        )
    text = result.text
    # `structured` is None for a tool-level refusal (`isError`): the call did not run.
    outcome.failed = result.structured is None
    observed: dict[str, Any] = {"chars": len(text)}
    if result.structured is None and _ROUTE_RATE_LIMITED.search(text):
        _observe(step, {"tool": SERVER_TOOLS[step], "operation": arguments.get("name")}, {"status": 429})
        return RATE_LIMITED
    if step == "call":
        text = _show_proposal(result.structured, arguments, text, observed)
        if arguments.get("name") == REVISION_COMPARE_OPERATION:
            number = emit_revision_compare_card(result.structured, arguments.get("input"))
            observed["compare_card"] = number
            if number is not None:
                text = f"{text}\n\nThe person sees both pages side by side, the changes boxed: [[card:{number}]]."
        _record_read(result, arguments, observed)
    _observe(step, {"tool": SERVER_TOOLS[step], "operation": arguments.get("name")}, observed)
    return text


def _record_read(result: Any, arguments: dict[str, Any], outcome: dict[str, Any]) -> None:
    """Put a read that answered into the retrieval ledger, the account of what the turn read off the office.

    Only a read. A proposal is no reading (its card stands for it), and a refusal read nothing.
    """
    if "proposed" in outcome or result.structured is None:
        return
    operation = str(arguments.get("name") or "").strip()
    if operation:
        record_lane_hit(operation, shelf=WORKSPACE_SHELF)


#: Appended when the server stored the proposal and this run has nowhere to draw its card. The person
#: still finds it: the server told their inbox.
_PROPOSED_WITHOUT_CARD = " The card could not be shown in this run; the proposal waits in the person's inbox."


def _show_proposal(
    structured: dict[str, Any] | None, arguments: dict[str, Any], text: str, outcome: dict[str, Any]
) -> str:
    """Put the card for a write the server proposed in front of the reader; the text the model reads.

    A read, a refusal and any other answer pass through. For a proposal the model reads the server's
    short text ("Proposed — the person decides") with the proposal's id and summary after it: the id is
    what the work report's ``proposed`` names and what the next turn's WORKSPACE block lists, and the
    summary is what the person sees on the card, so the model says what waits in the card's words.
    """
    proposal = proposal_from(structured)
    if proposal is None:
        return text
    shown = emit_operation_proposal_card(proposal, arguments.get("input"))
    outcome.update({"proposed": proposal.operation, "card": shown})
    text = f"{text} Proposal {proposal.proposal_id}: {proposal.summary.rstrip('.')}."
    return text if shown else text + _PROPOSED_WITHOUT_CARD


async def read_operation(name: str, input: dict[str, Any]) -> dict[str, Any] | None:  # noqa: A002 - the server's own argument name
    """A read operation's ``structuredContent``, run as the turn's person, for a tool that shapes it itself.

    ``None`` when it could not run: no envelope, a refusal, a transport failure, or a result
    too large to come back structured. The caller falls back or says so; nothing is retried.
    """
    envelope = _envelope()
    if envelope is None:
        _observe("call", {"tool": SERVER_TOOLS["call"], "operation": name}, {"refused": "no_envelope"})
        return None
    try:
        result = await asyncio.to_thread(
            call_tool_result,
            SERVER_TOOLS["call"],
            {"name": name, "input": input},
            envelope,
            answer_message_id=_answer_message_id(),
        )
    except WorkspaceError as exc:
        _observe("call", {"tool": SERVER_TOOLS["call"], "operation": name}, {"error": str(exc), "status": exc.status})
        return None
    _observe(
        "call",
        {"tool": SERVER_TOOLS["call"], "operation": name},
        {"chars": len(result.text), "structured": result.structured is not None},
    )
    return result.structured


async def run_search(query: str, domain: str = "", limit: int = 10) -> str:
    arguments: dict[str, Any] = {"query": query, "limit": limit}
    if (domain or "").strip():
        arguments["domain"] = domain.strip()
    return await run_workspace("search", arguments)


async def run_describe(name: str) -> str:
    return await run_workspace("describe", {"name": name})


async def run_call(name: str, input: dict[str, Any] | None = None) -> str:  # noqa: A002 - the server's own argument name
    outcome = ActionOutcome()
    row = ActionRow("workspace", target=name)
    try:
        result = await run_workspace("call", {"name": name, "input": input or {}}, outcome)
    except BaseException:
        row.finish("error")
        raise
    outcome.settle(row)
    return result


async def run_report_missing(description: str) -> str:
    return await run_workspace("report_missing", {"description": description})


@register_function_group(config_type=WorkspaceConfig)
async def piloti_workspace(config: WorkspaceConfig, _builder: Builder):
    """The workspace tools, as one group."""
    group = FunctionGroup(config=config)
    for name, fn in (
        ("search", run_search),
        ("describe", run_describe),
        ("call", run_call),
        ("report_missing", run_report_missing),
    ):
        group.add_function(name, fn, description=DESCRIPTIONS[name])
    yield group
