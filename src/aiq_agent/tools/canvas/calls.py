"""One canvas call: as whom, on which document, and what the model is told when the BFF says no."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiq_agent import project_context
from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id

from ..documents.filing import SignedEnvelope
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
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann Piloti in keinem Dokument lesen "
    "oder schreiben. Nicht erneut versuchen."
)
NO_DOCUMENT = (
    "Welches Dokument? Dieser Chat gehört zu keinem Dokument, und keines ist geöffnet. Nenne es in `document` "
    "(der Dateiname aus der Übersicht) oder frage, welches gemeint ist."
)
FORBIDDEN = (
    "Nicht möglich: Die Person darf an diesem Dokument nichts ändern, oder dieser Chat darf es nicht lesen. "
    "Sage es ihr so; nicht erneut versuchen."
)
DOCUMENT_GONE = (
    "Dieses Dokument gibt es nicht (mehr), es ist noch nicht freigegeben, oder dieser Chat darf es nicht lesen. "
    "Nicht erneut versuchen."
)
ANNOTATION_GONE = (
    "Diese Anmerkung gibt es auf dem Dokument nicht (mehr). Lies mit `marks` nach und nimm ihre id oder Nummer."
)
CONFLICT = "Jemand hat die Anmerkungen gerade geändert. Lies sie mit `marks` neu, bevor du weitermachst."
DELETE_FORBIDDEN = (
    "Nicht möglich: Löschen kann die Person nur Anmerkungen, die sie selbst gesetzt hat, und nur, wenn sie an "
    "diesem Dokument etwas ändern darf. Sag es ihr so; erledigen (`update` mit `status` `resolved`) geht, wenn sie "
    "es möchte."
)
#: The BFF's ``details.reason`` values for a mark its author may no longer delete (``deleteRefusalOf``).
DELETE_KEPT_REASONS = frozenset({"mark-discussed", "mark-carried"})
DELETE_KEPT = (
    "Nicht gelöscht: Andere haben im Verlauf dieser Anmerkung geantwortet, oder sie wurde zwischen Dokumenten "
    "übernommen. Sie bleibt, damit ihr Verlauf und ihre Nummer erhalten bleiben. Sag es der Person so; erledigen "
    "(`update` mit `status` `resolved`) geht, wenn sie es möchte."
)
ASSIGNEE_UNCLEAR = (
    "Unklar, wer gemeint ist ({detail}). Frage die Person, wen sie meint, und nimm dann den vollen Namen; nichts "
    "wurde geändert."
)
#: The BFF's ``details.reason`` when the organization has Piloti propose only (``piloti-acts`` off).
PILOTI_ACTS_OFF = "piloti-acts-off"
PROPOSE_ONLY_MARK = (
    "Nicht gesetzt: Dieses Büro lässt Piloti Anmerkungen nur vorschlagen. Setze sie mit `mark` ohne `open` als "
    "Vorschlag und sag der Person, dass sie ihn im Dokument übernehmen kann."
)
PROPOSE_ONLY_CHANGE = (
    "Nicht geändert: Dieses Büro lässt Piloti Anmerkungen nur vorschlagen, nicht ändern oder löschen. Sag der "
    "Person, dass sie das im Dokument selbst tun kann; nicht erneut versuchen."
)
UNREACHABLE = (
    "Fehler: Das Dokument ist gerade nicht erreichbar. Sage der Person, dass es nicht geklappt hat; nicht in "
    "derselben Antwort erneut versuchen."
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
        return Refused(f"Fehler: Die Anfrage wurde abgelehnt ({exc}). Korrigiere die Argumente.", "invalid")
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
