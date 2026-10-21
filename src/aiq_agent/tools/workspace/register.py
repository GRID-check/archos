"""``workspace``: everything a person can do in Piloti, reached through Piloti's own MCP server.

Four tools (``workspace__search``, ``workspace__describe``, ``workspace__call``,
``workspace__report_missing``), one NAT function group, because they share the
client and the refusal. They are the SAME four meta-tools an external agent
(Claude, Cursor) gets from the server in ``discovery`` mode (ADR-0121): the
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
import logging
from typing import Any

from aiq_agent import project_context
from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id
from nat.plugin_api import Builder
from nat.plugin_api import FunctionGroup
from nat.plugin_api import FunctionGroupBaseConfig
from nat.plugin_api import register_function_group

from ..documents.filing import SignedEnvelope
from .cards import emit_operation_proposal_card
from .cards import proposal_from
from .client import WorkspaceError
from .client import call_tool_result

logger = logging.getLogger(__name__)

FEATURE_TAG = "feature:workspace-mcp"

#: The server's tool names (kebab-case, fixed by the contract), by this group's function.
SERVER_TOOLS = {
    "search": "search-operations",
    "describe": "describe-operation",
    "call": "call-operation",
    "report_missing": "report-missing-capability",
}

_NO_ENVELOPE = (
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann Piloti im Namen einer Person "
    "nichts im Arbeitsbereich lesen oder tun. Nicht erneut versuchen."
)

DESCRIPTIONS = {
    "search": (
        "Findet, was Piloti im Arbeitsbereich tun kann: Projekte, Mitglieder, Dokumente und Fassungen, "
        "Eingang, Aufträge, Einstellungen. Aufrufen, wenn die Person etwas im Arbeitsbereich lesen oder "
        "ändern will und kein anderes Werkzeug es abdeckt. `query` beschreibt das Ziel in einfachen "
        "Worten („Mitglied zu Projekt hinzufügen“), `domain` grenzt optional auf einen Bereich ein, `limit` "
        "(Standard 10) auf die Trefferzahl. Antwort: Namen von Operationen mit je einer Zeile. Danach "
        "`workspace__describe` mit dem Namen, dann `workspace__call`. Nichts Passendes: "
        "`workspace__report_missing`."
    ),
    "describe": (
        "Zeigt, wie eine Operation aufgerufen wird: Zweck, Parameter (`params` für Pfad-IDs, `query`, "
        "`body`), Schreib- oder Lesezugriff und woher die IDs kommen. `name` ist ein Name aus "
        "`workspace__search`, genau so geschrieben. Immer vor dem ersten `workspace__call` einer Operation "
        "lesen; ein unbekannter Name kommt mit ähnlichen Namen zurück."
    ),
    "call": (
        "Führt eine Operation im Namen der Person aus, mit deren Rechten. `name` aus `workspace__search`, "
        "`input` mit den Feldern `params`, `query` und `body`, wie `workspace__describe` sie zeigt. Lesen "
        "läuft sofort. Ein Schreiben ändert NICHTS: es kommt als Vorschlag zurück, den die Person annimmt; "
        "sage ihr in einem Satz, was vorgeschlagen ist, und behaupte nie, es sei erledigt. Eine Ablehnung "
        "nennt den Grund und den nächsten Schritt; mach es nicht ein zweites Mal gleich."
    ),
    "report_missing": (
        "Meldet, dass die Person etwas im Arbeitsbereich will und es keine passende Operation gibt "
        "(erst `workspace__search` mit zwei verschiedenen Formulierungen versucht). `description` sagt in "
        "ein bis zwei Sätzen, was fehlt. Danach der Person ehrlich sagen, dass das (noch) nicht geht."
    ),
}


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


async def run_workspace(step: str, arguments: dict[str, Any]) -> str:
    """One call to the server as the turn's person; every refusal comes back as text for the model."""
    envelope = _envelope()
    if envelope is None:
        _observe(step, {"tool": SERVER_TOOLS[step]}, {"refused": "no_envelope"})
        return _NO_ENVELOPE
    try:
        result = await asyncio.to_thread(
            call_tool_result, SERVER_TOOLS[step], arguments, envelope, answer_message_id=_answer_message_id()
        )
    except WorkspaceError as exc:
        _observe(step, {"tool": SERVER_TOOLS[step]}, {"error": str(exc), "status": exc.status})
        return (
            f"Fehler beim Zugriff auf den Arbeitsbereich: {exc}. Es wurde nichts geändert; sage der Person, "
            "dass es nicht geklappt hat, und versuche es nicht in derselben Antwort erneut."
        )
    text = result.text
    outcome: dict[str, Any] = {"chars": len(text)}
    if step == "call":
        text = _show_proposal(result.structured, arguments, text, outcome)
    _observe(step, {"tool": SERVER_TOOLS[step], "operation": arguments.get("name")}, outcome)
    return text


#: Appended when the server stored the proposal and this run has nowhere to draw its card. The person
#: still finds it: the server told their inbox.
_PROPOSED_WITHOUT_CARD = (
    " Die Karte konnte in diesem Lauf nicht angezeigt werden; der Vorschlag wartet im Eingang der Person."
)


def _show_proposal(
    structured: dict[str, Any] | None, arguments: dict[str, Any], text: str, outcome: dict[str, Any]
) -> str:
    """Put the card for a write the server proposed in front of the reader; the text the model reads.

    A read, a refusal and any other answer pass through. The server's own short text ("Proposed — the
    person decides") is what the model reads; it never sees the structured result.
    """
    proposal = proposal_from(structured)
    if proposal is None:
        return text
    shown = emit_operation_proposal_card(proposal, arguments.get("input"))
    outcome.update({"proposed": proposal.operation, "card": shown})
    return text if shown else text + _PROPOSED_WITHOUT_CARD


async def run_search(query: str, domain: str = "", limit: int = 10) -> str:
    arguments: dict[str, Any] = {"query": query, "limit": limit}
    if (domain or "").strip():
        arguments["domain"] = domain.strip()
    return await run_workspace("search", arguments)


async def run_describe(name: str) -> str:
    return await run_workspace("describe", {"name": name})


async def run_call(name: str, input: dict[str, Any] | None = None) -> str:  # noqa: A002 - the server's own argument name
    return await run_workspace("call", {"name": name, "input": input or {}})


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
