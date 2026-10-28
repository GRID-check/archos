"""The canvas tools' client: ``POST /api/internal/document-annotations``, and one lookup.

Nothing here decides access. The BFF reads the acting person out of the signed
request-context envelope this module forwards byte-for-byte, builds that
person's pinned session, resolves the document (the ``documentId`` a call
names, checked against the asker's access and the turn's signed scope, or else
the envelope's CONVERSATION subject) and applies the rules a person's own
session would (ADR-0054 §4, ADR-0055). Echo, never sign: see
``packages/agent/src/aiq_agent/tools/AGENTS.md``.

The Anmerkungen bodies are described once, in zod (``frontends/ui/src/lib/annotations/types.ts``),
and exported as JSON Schema (``frontends/ui/tests/fixtures/document-annotations.schema.json``);
``packages/agent/tests/tools/canvas/test_wire_contract.py`` validates the bodies these
tools build against that file. There is no Pydantic twin. The room ops
(``room``, ``point``, ``highlight``, ``leave``) ride the same route and the same
schema file.
"""

from __future__ import annotations

import logging
from typing import Any

from aiq_agent.common import bff_http
from aiq_agent.common.bff_http import SignedEnvelope

logger = logging.getLogger(__name__)

ANNOTATIONS_PATH = "/api/internal/document-annotations"

#: A list reads at most 500 marks with their threads; a proposal is one insert.
REQUEST_TIMEOUT_SECONDS = 20
#: Leaving the room is presence, sent once a turn has ended: short, and never retried.
LEAVE_TIMEOUT_SECONDS = 3


class CanvasRequestError(bff_http.BffError):
    """The route refused, or could not be reached. ``status``, ``code`` and ``reason`` say which."""

    def __init__(
        self, message: str, *, status: int | None = None, code: str | None = None, reason: str | None = None
    ) -> None:
        super().__init__(message, status=status, code=code)
        self.reason = reason


def _refusal(exc: bff_http.BffRefusedError) -> CanvasRequestError:
    """The BFF's ``{error, code, details}`` envelope as an error the tool can word."""
    details = exc.body.get("details") if isinstance(exc.body.get("details"), dict) else {}
    reason = details.get("reason")
    return CanvasRequestError(
        exc.error_text or f"the request was refused ({exc.status})",
        status=exc.status,
        code=exc.code,
        reason=reason if isinstance(reason, str) else None,
    )


def post_canvas(
    payload: dict[str, Any], envelope: SignedEnvelope, *, timeout: float = REQUEST_TIMEOUT_SECONDS
) -> dict[str, Any]:
    """POST one canvas request (an Anmerkungen op or a room op); the parsed body. Blocking: call off the loop.

    Raises :class:`CanvasRequestError` for every refusal and transport
    failure, carrying the status, the BFF's ``code`` and ``details.reason``.
    """
    try:
        body = bff_http.post_json(ANNOTATIONS_PATH, payload, timeout=timeout, headers=envelope.headers())
    except bff_http.BffNotConfiguredError as exc:
        raise CanvasRequestError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        raise _refusal(exc) from exc
    except bff_http.BffError as exc:
        logger.warning("Canvas request %s failed", payload.get("op"), exc_info=True)
        raise CanvasRequestError("the canvas route could not be reached") from exc
    if not isinstance(body, dict):
        raise CanvasRequestError("the canvas route answered with something that is not an object")
    return body


#: The lookup a NAMED document goes through: the one ``look``'s renderer
#: already uses, which answers only inside the scope the echoed envelope signs.
DOCUMENT_FILE_PATH = "/api/internal/document-file"


def lookup_document_id(collection: str, file_name: str, envelope: SignedEnvelope) -> str | None:
    """The BFF's id of the document ``file_name`` in ``collection``, or None. Blocking.

    None for every failure, an unknown document, and an older BFF whose answer
    carries no ``documentId``: the caller then says it cannot address the
    document by name, which is true.
    """
    try:
        body = bff_http.get_json(
            DOCUMENT_FILE_PATH,
            timeout=REQUEST_TIMEOUT_SECONDS,
            query={"collection": collection, "filename": file_name},
            headers=envelope.headers(),
        )
    except bff_http.BffNotConfiguredError:
        return None
    except bff_http.BffError:
        logger.info("No document id for %s in %s", file_name, collection, exc_info=True)
        return None
    document_id = body.get("documentId") if isinstance(body, dict) else None
    return document_id if isinstance(document_id, str) and document_id else None
