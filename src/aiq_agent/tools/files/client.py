"""The proposal's server half: ``POST /api/internal/proposals``, op ``create``.

A file operation Piloti proposes is a server object (ADR-0105): a proposed
change the BFF stores, and applies in the DECIDING person's session when they
accept it. This module asks for that object and hands back its id, which the
card carries. Nothing here writes a document, a folder or an assignment; the
BFF is the single writer of ``grid_app`` (ADR-0003) and applying is a person
route, never this one.

The body is described once, in zod (``frontends/ui/src/lib/proposals/types.ts``,
``internalProposalRequestSchema``), and exported as JSON Schema
(``frontends/ui/tests/fixtures/proposals.schema.json``);
``tests/aiq_agent/tools/files/test_proposal_wire.py`` validates the body built
here against that file. There is no Pydantic twin.

## Echo, never sign

The turn's signed envelope goes out byte-for-byte, beside the service token;
the BFF verifies it and records the person it names as the one Piloti acted
for. The rule and its reason are in ``src/aiq_agent/tools/AGENTS.md``.

## Every failure is the old card, not an error

The card worked before this route existed: without a ``proposal_id`` the
browser executes it through the Files pane's routes, as the reader. So an
older BFF (404), a run with no envelope (CLI, eval, job worker), a refusal or
an unreachable BFF all come back as ``None`` and the tool emits that card. The
model is told the same thing either way, because either way nothing has
changed yet. Each outcome is one ``files.proposal`` observation, so a
deployment that silently stays on the old path is one Langfuse filter away.

The transport is the seventh copy of the internal-call shape; the reason it
is not lifted yet is in ``tools/documents/filing.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
import uuid
from typing import Any

from aiq_agent import project_context
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id

from ..documents.filing import SignedEnvelope

logger = logging.getLogger(__name__)

PROPOSALS_PATH = "/api/internal/proposals"

#: One insert. Short, because the fallback is a working card: a slow BFF
#: should cost the reader the server object, not the turn's time.
REQUEST_TIMEOUT_SECONDS = 10


class ProposalRequestError(RuntimeError):
    """The route refused, or could not be reached. ``status`` is the HTTP status when there was one."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: a 3xx means an auth middleware intercepted the call."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def post_proposal(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one proposal request; the parsed body. Blocking: call off the loop.

    Raises :class:`ProposalRequestError` for every refusal and transport failure.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise ProposalRequestError("GRID_INTERNAL_API_TOKEN is not configured")
    request = urllib.request.Request(
        f"{_internal_base_url()}{PROPOSALS_PATH}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
            # Who this is, forwarded exactly as the BFF minted it for the turn.
            "X-Grid-Request-Context": envelope.header,
            "X-Grid-Request-Context-Sig": envelope.signature,
        },
        method="POST",
    )
    try:
        with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ProposalRequestError(f"the proposals route refused ({exc.code})", status=exc.code) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ProposalRequestError("the proposals route could not be reached") from exc
    if not isinstance(body, dict):
        raise ProposalRequestError("the proposals route answered with something that is not an object")
    return body


def proposal_request(operation: str, items: list[dict[str, Any]], note: str | None) -> dict[str, Any]:
    """The ``create`` body: the card's operation and rows, and the answer this turn writes.

    ``answerMessageId`` ties the proposal to the answer that carries its card
    (the same derived id the canvas tools send). The project is never named:
    the BFF takes it from the envelope.
    """
    payload: dict[str, Any] = {"operation": operation, "operations": items}
    if note:
        payload["note"] = note
    body: dict[str, Any] = {"op": "create", "kind": "file_operation", "payload": payload}
    conversation_id = project_context.get_conversation_id_from_context()
    if conversation_id:
        body["answerMessageId"] = turn_answer_message_id(conversation_id)
    return body


def _proposal_id(body: dict[str, Any]) -> str | None:
    """The created proposal's id, when the answer carries one that is a UUID."""
    value = body.get("id")
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


async def create_proposal(operation: str, items: list[dict[str, Any]], note: str | None = None) -> str | None:
    """Store the proposal on the server; its id, or ``None`` when the card must stay browser-executed.

    Never raises. ``None`` covers a run with no envelope, a missing token, a
    refusal (an older BFF answers 404) and an unreachable route alike.
    """
    observed = {"operation": operation, "items": len(items)}
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        emit_step_span("files.proposal", observed, {"outcome": "fallback", "reason": "no_envelope"})
        return None
    request = proposal_request(operation, items, note)
    try:
        body = await asyncio.to_thread(post_proposal, request, SignedEnvelope(header=header, signature=signature))
    except ProposalRequestError as exc:
        logger.warning("Proposal not stored, card stays browser-executed: %s", exc)
        emit_step_span("files.proposal", observed, {"outcome": "fallback", "reason": "refused", "status": exc.status})
        return None
    proposal_id = _proposal_id(body)
    if proposal_id is None:
        logger.warning("Proposals route answered without a usable id; card stays browser-executed")
        emit_step_span("files.proposal", observed, {"outcome": "fallback", "reason": "no_id"})
        return None
    emit_step_span("files.proposal", observed, {"outcome": "created", "status": body.get("status")})
    return proposal_id
