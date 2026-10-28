"""One canvas call: as whom, on which document, and what the model is told when the BFF says no."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiq_agent import project_context
from aiq_agent.common.bff_http import SignedEnvelope
from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id

from .client import CanvasRequestError
from .client import post_canvas
from .target import Target

logger = logging.getLogger(__name__)

#: The turn's Langfuse tag: every turn that worked on a document's canvas is one filter away.
FEATURE_TAG = "feature:canvas"


class Refused(Exception):
    """A call that answers the model with a sentence instead of a result; ``code`` is what Langfuse records."""

    def __init__(self, message: str, code: str = "invalid_arguments") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


NO_ENVELOPE = (
    "Error: This run has no signed session credential, so Piloti cannot read or write in any document. Do not retry."
)
NO_DOCUMENT = (
    "Which document? This chat belongs to no document, and none is open. Name it in `document` "
    "(the file name from the overview) or ask which one is meant."
)
FORBIDDEN = (
    "Not possible: The person may not change anything on this document, or this chat may not read it. "
    "Tell them so; do not retry."
)
DOCUMENT_GONE = (
    "This document does not exist (any more), it is not yet released, or this chat may not read it. Do not retry."
)
ANNOTATION_GONE = "This annotation does not exist (any more) on the document. Read `marks` and use its id or number."
CONFLICT = "Someone has just changed the annotations. Re-read them with `marks` before you continue."
DELETE_FORBIDDEN = (
    "Not possible: The person can delete only annotations they set themselves, and only if they may change "
    "this document. Tell them so; resolving (`update` with `status` `resolved`) works if they "
    "want it."
)
#: The BFF's ``details.reason`` values for a mark its author may no longer delete (``deleteRefusalOf``).
DELETE_KEPT_REASONS = frozenset({"mark-discussed", "mark-carried"})
DELETE_KEPT = (
    "Not deleted: Others have replied in this annotation's thread, or it was carried over between documents. "
    "It stays so that its thread and its number are kept. Tell the person so; resolving "
    "(`update` with `status` `resolved`) works if they want it."
)
ASSIGNEE_UNCLEAR = (
    "Unclear who is meant ({detail}). Ask the person whom they mean, then use the full name; nothing was changed."
)
#: The BFF's ``details.reason`` when the organization has Piloti propose only (``piloti-acts`` off).
PILOTI_ACTS_OFF = "piloti-acts-off"
PROPOSE_ONLY_MARK = (
    "Not set: This office lets Piloti only propose annotations. Set them with `mark` without `open` as a "
    "proposal and tell the person they can take it over in the document."
)
PROPOSE_ONLY_CHANGE = (
    "Not changed: This office lets Piloti only propose annotations, not change or delete them. Tell the "
    "person they can do this in the document themselves; do not retry."
)
UNREACHABLE = (
    "Error: The document is not reachable right now. Tell the person it did not work; do not retry in the same answer."
)


def envelope() -> SignedEnvelope:
    """The turn's signed envelope, exactly as it arrived; a refusal off a chat turn (echo, never sign)."""
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise Refused(NO_ENVELOPE, "no_envelope")
    return SignedEnvelope(header=header, signature=signature)


def _with_answer(payload: dict[str, Any]) -> dict[str, Any]:
    """Every body names the answer this turn writes (ADR-0093), as ``project_lookup`` does.

    The BFF admits the document against the conversation's audience and marks
    this answer when the document sits in a restricted folder.
    """
    conversation_id = project_context.get_conversation_id_from_context()
    if not conversation_id:
        return payload
    return {**payload, "answerMessageId": turn_answer_message_id(conversation_id)}


#: The ops that name one mark: a 404 there is the mark, not the document.
_ON_ONE_MARK = frozenset({"reply", "update", "delete"})


def refusal_for(exc: CanvasRequestError, operation: str) -> Refused:
    """A BFF refusal as the sentence the model relays."""
    if exc.reason == "no-document-subject":
        return Refused(NO_DOCUMENT, "no_document_subject")
    if exc.reason == PILOTI_ACTS_OFF:
        return Refused(PROPOSE_ONLY_MARK if operation == "create" else PROPOSE_ONLY_CHANGE, "piloti_acts_off")
    if exc.reason in ("assignee-unknown", "assignee-ambiguous"):
        return Refused(ASSIGNEE_UNCLEAR.format(detail=exc), "assignee_unclear")
    if exc.reason in DELETE_KEPT_REASONS:
        return Refused(DELETE_KEPT, "delete_kept")
    if exc.status == 403:
        return Refused(DELETE_FORBIDDEN if operation == "delete" else FORBIDDEN, "forbidden")
    if exc.status == 404:
        return Refused(ANNOTATION_GONE if operation in _ON_ONE_MARK else DOCUMENT_GONE, "not_found")
    if exc.status == 409:
        return Refused(CONFLICT, "conflict")
    if exc.status in (400, 422):
        return Refused(f"Error: The request was rejected ({exc}). Correct the arguments.", "invalid")
    return Refused(UNREACHABLE, "unreachable")


async def call(payload: dict[str, Any], target: Target, signed: SignedEnvelope) -> dict[str, Any]:
    """One request about ``target``, off the event loop, with every refusal worded for the model."""
    body = _with_answer({**payload, **target.body()})
    try:
        return await asyncio.to_thread(post_canvas, body, signed)
    except CanvasRequestError as exc:
        raise refusal_for(exc, str(payload.get("op"))) from exc


def observe(step: str, request: dict[str, Any], outcome: dict[str, Any]) -> None:
    """One ``canvas.<step>`` observation and the turn's ``feature:canvas`` tag. Never raises.

    Counts, numbers and pages, never the text of a mark or a reply: the trace
    records what the tool did, and the thread is where the words live.
    """
    add_trace_tag(FEATURE_TAG)
    emit_step_span(f"canvas.{step}", request, outcome)


def document_of(body: dict[str, Any], target: Target) -> dict[str, str]:
    """``{"id", "name"}`` for the activity card, from what the BFF returned."""
    name = body.get("documentName") or target.file_name or "Dokument"
    return {"id": str(body.get("documentId") or target.document_id or ""), "name": str(name)}
