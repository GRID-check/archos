"""The proposal's server half: ``POST /api/internal/proposals``, op ``create``.

A change Piloti proposes is a server object (ADR-0105): a proposed change the
BFF stores, and applies in the DECIDING person's session when they accept it.
This module asks for that object and hands back its id, which the card
carries. Three kinds exist, discriminated by ``kind`` and each created from a
different place:

* ``file_operation``: ``propose_file_change`` (``tools/files/cards.py``).
* ``memory``: the ``remember`` tool, when an organization-scoped write is
  refused (``memory/register.py``).
* ``project_profile``: the model's own ``project_profile_patch`` card, at the
  point the answer's cards become final (``cards/envelope.py``,
  ``register_envelope_card``).

Nothing here writes a document, a folder, a memory note or the project
profile; the BFF is the single writer of ``app`` (ADR-0003) and applying
is a person route, never this one.

The body is described once, in zod (``apps/workspace/bff/proposals/types.ts``,
``internalProposalRequestSchema``), and exported as JSON Schema
(``apps/workspace/tests/fixtures/proposals.schema.json``);
``packages/agent/tests/tools/files/test_proposals.py`` validates the body built here
against that file, for every kind. There is no Pydantic twin.

## Echo, never sign

The turn's signed envelope goes out byte-for-byte, beside the service token;
the BFF verifies it and records the person it names as the one Piloti acted
for. The rule and its reason are in ``packages/agent/src/aiq_agent/tools/AGENTS.md``.

## Every failure is a card without an id, not an error

A refusal never raises. An older BFF (404), a run with no envelope (CLI, eval,
job worker), a refusal or an unreachable BFF all come back as ``None`` and the
card stays registered without a ``proposal_id``. What that card does is the
caller's kind to say: a ``file_operation`` card is drawn read-only and its tool
reports that it could not propose (``tools/files/cards.py``); a ``memory`` and a
``project_profile`` card still work as they did before this route existed, and
the browser applies them as the reader. Each outcome is one
``proposals.create`` observation, so a deployment that silently stays on the
fallback is one Langfuse filter away.

## The card's index is its position, and it is the idempotency key

``originCardIndex`` says which card of the answer this proposal belongs to; with
``answerMessageId`` the database makes the create idempotent, so the same card
asked for twice returns the first proposal. The index is therefore the card's
REAL position in the turn's registry, which :func:`add_card` fixes by putting
the card in the registry first and asking for the proposal second.

The transport is :mod:`aiq_agent.common.bff_http`, the one BFF client.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any
from typing import Literal

from aiq_agent import project_context
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.common import bff_http
from aiq_agent.common.bff_http import SignedEnvelope
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id

logger = logging.getLogger(__name__)

PROPOSALS_PATH = "/api/internal/proposals"

#: One insert. Short, because the fallback is a working card: a slow BFF
#: should cost the reader the server object, not the turn's time.
REQUEST_TIMEOUT_SECONDS = 10

ProposalKind = Literal["file_operation", "memory", "project_profile"]


class ProposalRequestError(bff_http.BffError):
    """The route refused, or could not be reached. ``status`` is the HTTP status when there was one."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message, status=status)


def post_proposal(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one proposal request; the parsed body. Blocking: call off the loop.

    Raises :class:`ProposalRequestError` for every refusal and transport failure.
    """
    try:
        body = bff_http.post_json(PROPOSALS_PATH, payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=envelope.headers())
    except bff_http.BffNotConfiguredError as exc:
        raise ProposalRequestError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        raise ProposalRequestError(f"the proposals route refused ({exc.status})", status=exc.status) from exc
    except bff_http.BffError as exc:
        raise ProposalRequestError("the proposals route could not be reached") from exc
    if not isinstance(body, dict):
        raise ProposalRequestError("the proposals route answered with something that is not an object")
    return body


def proposal_request(kind: ProposalKind, payload: dict[str, Any], *, card_index: int | None = None) -> dict[str, Any]:
    """The ``create`` body: the kind, its payload, and the answer and card this turn writes.

    ``answerMessageId`` ties the proposal to the answer that carries its card
    (the same derived id the canvas tools send) and ``originCardIndex`` to the
    card's position in that answer; together they make the create idempotent.
    The project is never named: the BFF takes it from the envelope.
    """
    body: dict[str, Any] = {"op": "create", "kind": kind, "payload": payload}
    conversation_id = project_context.get_conversation_id_from_context()
    if conversation_id:
        body["answerMessageId"] = turn_answer_message_id(conversation_id)
        if card_index is not None:
            body["originCardIndex"] = card_index
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


async def create_proposal(kind: ProposalKind, payload: dict[str, Any], *, card_index: int | None = None) -> str | None:
    """Store the proposal on the server; its id, or ``None`` when the card must stay on its old path.

    Never raises. ``None`` covers a run with no envelope, a missing token, a
    refusal (an older BFF answers 404) and an unreachable route alike.
    """
    observed = {"kind": kind, "card_index": card_index}
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        emit_step_span("proposals.create", observed, {"outcome": "fallback", "reason": "no_envelope"})
        return None
    request = proposal_request(kind, payload, card_index=card_index)
    try:
        body = await asyncio.to_thread(post_proposal, request, SignedEnvelope(header=header, signature=signature))
    except ProposalRequestError as exc:
        logger.warning("Proposal (%s) not stored, card keeps its old path: %s", kind, exc)
        emit_step_span("proposals.create", observed, {"outcome": "fallback", "reason": "refused", "status": exc.status})
        return None
    proposal_id = _proposal_id(body)
    if proposal_id is None:
        logger.warning("Proposals route answered without a usable id (%s); card keeps its old path", kind)
        emit_step_span("proposals.create", observed, {"outcome": "fallback", "reason": "no_id"})
        return None
    emit_step_span("proposals.create", observed, {"outcome": "created", "status": body.get("status")})
    return proposal_id


async def add_card(
    registry: CardRegistry, card: dict[str, Any], *, kind: ProposalKind, payload: dict[str, Any]
) -> str | None:
    """Register ``card`` and store its proposal; the proposal's id, or ``None`` (the card stays as it is).

    The card goes into the registry FIRST, so the index sent as
    ``originCardIndex`` is the position it really has: a tool running in
    parallel can add its own card while the request is out, and an index read
    before the await would then name somebody else's. When the BFF answers,
    the card is replaced in place by a copy carrying ``proposal_id``; nothing
    that shows a card between the two reads the registry, because the
    registry is read once the turn's tools are done.

    A card that arrives with a ``proposal_id`` of its own is not this module's:
    the id on a registered card is always one the BFF returned.
    """
    index = len(registry)
    registry.add({key: value for key, value in card.items() if key != "proposal_id"})
    proposal_id = await create_proposal(kind, payload, card_index=index)
    if proposal_id is not None:
        registry.replace(index, {**card, "proposal_id": proposal_id})
    return proposal_id
