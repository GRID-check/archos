"""The geometry service's HTTP surface (ADR-0149): one typed route and two probes.

``POST /v1/internal/bim/geometry`` answers one geometry operation on one model for the person a
signed request-context envelope names. Two credentials, the ones every internal call from the BFF
carries, checked by the shared code in :mod:`agent.common.envelope_auth`:

* the internal token says the caller is the BFF;
* the envelope says who asked; the signed model sources beside it (``signed_sources.py``) say
  which bytes the BFF let this person read, after its own read gate. This service fetches nothing
  else and holds no access rules of its own.

A cold model is built in the background; the request waits at most
:data:`operations.WAIT_SECONDS` and is then answered ``409 {code: 'geometry_warming',
retryAfter}`` while the build continues.

``/healthz`` is liveness (the process answers). ``/readyz`` is readiness: the engine imports and
the internal token is configured, without which every request would be refused.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any

from fastapi import FastAPI
from fastapi import HTTPException
from fastapi import Request
from fastapi.responses import JSONResponse

from agent.common.envelope_auth import ENVELOPE_HEADER
from agent.common.envelope_auth import ENVELOPE_SIG_HEADER
from agent.common.envelope_auth import internal_token_refusal
from agent.common.envelope_auth import verified_envelope_context
from agent.knowledge.bim_query import BimQueryRejectedError
from agent.knowledge.bim_query import BimQueryUnavailableError
from agent.knowledge.ifc_spatial_client import ModelTooLargeError
from agent.knowledge.ifc_spatial_client import SpatialEngineUnavailableError

from . import engine
from . import operations
from .errors import GeometryBuildFailed
from .errors import GeometryBusy
from .errors import GeometryRequestError
from .errors import GeometryTimeout
from .errors import GeometryUnsigned
from .errors import GeometryWarming
from .signed_sources import SOURCES_HEADER
from .signed_sources import SOURCES_SIG_HEADER
from .signed_sources import verified_sources
from .trace import call_facts
from .trace import log_call
from .trace import model_handle
from .wire import GeometryRequest

logger = logging.getLogger(__name__)

GEOMETRY_PATH = "/v1/internal/bim/geometry"
#: The Langfuse trace the BFF opened for this call; a cold build scores `geometry-cold-ms` on it.
TRACE_HEADER = "x-trace-id"
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")

#: A failed build's kind, as the refusal it is answered with.
_BUILD_FAILURES = {
    "too_large": (413, "model_too_large"),
    "engine_unavailable": (503, "engine_unavailable"),
}


def _refuse(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    headers = {"Retry-After": str(extra["retryAfter"])} if "retryAfter" in extra else None
    return JSONResponse(status_code=status, content={"code": code, "error": message, **extra}, headers=headers)


def _authorize(request: Request) -> dict[str, dict[str, Any]]:
    """The signed model sources, bound to the verified envelope, or an HTTPException."""
    refusal = internal_token_refusal(request.headers.get)
    if refusal is not None:
        raise HTTPException(status_code=refusal[0], detail=refusal[1])
    context = verified_envelope_context(
        request.headers.get(ENVELOPE_HEADER),
        request.headers.get(ENVELOPE_SIG_HEADER),
    )
    if context is None:
        raise HTTPException(
            status_code=403,
            detail={"error": "context_envelope_required", "detail": "a signed, current request-context envelope"},
        )
    return verified_sources(request.headers.get(SOURCES_HEADER), request.headers.get(SOURCES_SIG_HEADER), context)


def _failure(exc: Exception) -> JSONResponse:
    """The refusal a failure is, in the shape the BFF's geometry client maps."""
    if isinstance(exc, GeometryWarming):
        return _refuse(409, "geometry_warming", "The model's geometry is being prepared", retryAfter=exc.retry_after)
    if isinstance(exc, GeometryUnsigned):
        return _refuse(403, "source_not_signed", str(exc))
    if isinstance(exc, GeometryBusy):
        return _refuse(503, "geometry_busy", "The geometry service is busy", retryAfter=exc.retry_after)
    if isinstance(exc, GeometryTimeout):
        return _refuse(504, "geometry_timeout", str(exc))
    if isinstance(exc, GeometryBuildFailed):
        status, code = _BUILD_FAILURES.get(exc.kind, (502, "build_failed"))
        return _refuse(status, code, exc.args[0] or "The model's geometry could not be built")
    if isinstance(exc, ModelTooLargeError):
        return _refuse(413, "model_too_large", str(exc))
    if isinstance(exc, BimQueryRejectedError):
        return _refuse(404, "model_not_found", "Model not found")
    if isinstance(exc, GeometryRequestError):
        return _refuse(400, "invalid_request", str(exc))
    if isinstance(exc, ValueError):  # the engine refused to build this model's index
        return _refuse(502, "build_failed", str(exc))
    if isinstance(exc, SpatialEngineUnavailableError):
        return _refuse(503, "engine_unavailable", "The spatial engine is not installed")
    if isinstance(exc, BimQueryUnavailableError):
        return _refuse(502, "source_unavailable", "The model file could not be read")
    logger.exception("geometry operation failed")
    return _refuse(500, "geometry_failed", "The geometry operation failed")


def create_app() -> FastAPI:
    app = FastAPI(title="Geometry", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        ready = bool(os.environ.get("INTERNAL_API_TOKEN")) and await asyncio.to_thread(engine.current().available)
        return JSONResponse(status_code=200 if ready else 503, content={"ready": ready})

    @app.post(GEOMETRY_PATH)
    async def geometry(body: GeometryRequest, request: Request) -> Any:
        sources = _authorize(request)
        op = body.operation.op
        try:
            trace = request.headers.get(TRACE_HEADER, "")
            trace_id = trace if _TRACE_ID.match(trace) else None
            outcome = await asyncio.to_thread(operations.run, body, sources, trace_id)
        except Exception as exc:  # noqa: BLE001 - every failure is mapped to a refusal
            response = _failure(exc)
            log_call(ifc_op=op, ifc_outcome=f"http_{response.status_code}", ifc_model=model_handle(body.model_id))
            return response
        facts = call_facts(outcome, model_id=body.model_id)
        log_call(**facts)
        return {
            "op": outcome.op,
            "result": outcome.result,
            "meta": {
                "cacheTier": outcome.cache_tier,
                "ms": outcome.ms,
                "elements": outcome.elements,
                "truncated": outcome.truncated,
            },
        }

    return app


app = create_app()
