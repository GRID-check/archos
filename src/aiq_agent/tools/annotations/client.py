"""The Anmerkungen tool's client: ``POST /api/internal/document-annotations``.

Nothing here decides access, and nothing here names a document. The BFF reads
the acting person out of the signed request-context envelope this module
forwards byte-for-byte, builds that person's pinned session, resolves the
document from the envelope's CONVERSATION (its subject) and applies the rules a
person's own session would (ADR-0054 §4, ADR-0055). Echo, never sign: see
``src/aiq_agent/tools/AGENTS.md``.

The request bodies are described once, in zod (``frontends/ui/src/lib/annotations/types.ts``),
and exported as JSON Schema (``frontends/ui/tests/fixtures/document-annotations.schema.json``);
``tests/aiq_agent/tools/annotations/test_wire_contract.py`` validates the bodies
this tool builds against that file. There is no Pydantic twin.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from ..documents.filing import SignedEnvelope

logger = logging.getLogger(__name__)

ANNOTATIONS_PATH = "/api/internal/document-annotations"

#: A list reads at most 500 marks with their threads; a proposal is one insert.
REQUEST_TIMEOUT_SECONDS = 20


class AnnotationRequestError(RuntimeError):
    """The route refused, or could not be reached. ``status``, ``code`` and ``reason`` say which."""

    def __init__(
        self, message: str, *, status: int | None = None, code: str | None = None, reason: str | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.reason = reason


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: a 3xx means an auth middleware intercepted the call."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _error_body(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - the body may be empty, unreadable or not JSON
        return {}
    return payload if isinstance(payload, dict) else {}


def _refusal(exc: urllib.error.HTTPError) -> AnnotationRequestError:
    """The BFF's ``{error, code, details}`` envelope as an error the tool can word."""
    error = _error_body(exc)
    detail, code = error.get("error"), error.get("code")
    details = error.get("details") if isinstance(error.get("details"), dict) else {}
    reason = details.get("reason")
    return AnnotationRequestError(
        detail if isinstance(detail, str) and detail.strip() else f"the request was refused ({exc.code})",
        status=exc.code,
        code=code if isinstance(code, str) else None,
        reason=reason if isinstance(reason, str) else None,
    )


def post_annotations(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one ``InternalAnnotationRequest`` and return the parsed body. Blocking; call through ``asyncio.to_thread``.

    Raises :class:`AnnotationRequestError` for every refusal and transport
    failure, carrying the status, the BFF's ``code`` and ``details.reason``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise AnnotationRequestError("GRID_INTERNAL_API_TOKEN is not configured")
    request = urllib.request.Request(
        f"{_internal_base_url()}{ANNOTATIONS_PATH}",
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
        raise _refusal(exc) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("Document annotations request failed", exc_info=True)
        raise AnnotationRequestError("the annotations route could not be reached") from exc
    if not isinstance(body, dict):
        raise AnnotationRequestError("the annotations route answered with something that is not an object")
    return body
