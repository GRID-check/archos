"""Every way a geometry call can fail, as the refusal it is answered with: an HTTP-like status, a code."""

from __future__ import annotations

import logging
from typing import Any

from agent.knowledge.bim_query import BimQueryUnavailableError
from agent.knowledge.ifc_spatial_client import ModelTooLargeError
from agent.knowledge.ifc_spatial_client import SpatialEngineUnavailableError

from .errors import GeometryBuildFailed
from .errors import GeometryBusy
from .errors import GeometryRequestError
from .errors import GeometryTimeout
from .errors import GeometryUnsigned
from .errors import GeometryWarming
from .fetch import SourceRefused

logger = logging.getLogger(__name__)

#: A failed build's kind, as the refusal it is answered with.
_BUILD_FAILURES = {
    "too_large": (413, "model_too_large"),
    "engine_unavailable": (503, "engine_unavailable"),
    "source": (503, "geometry_source_unavailable"),
}


def body(status: int, code: str, message: str, **extra: Any) -> dict[str, Any]:
    """The refusal's wire form: the status the BFF maps, the stable code, the message."""
    return {"status": status, "code": code, "error": message, **extra}


def refusal(exc: Exception) -> dict[str, Any]:  # noqa: PLR0911 - one line per kind of failure
    """The refusal ``exc`` is, in the shape the BFF's geometry client maps."""
    if isinstance(exc, GeometryWarming):
        return body(409, "geometry_warming", "The model's geometry is being prepared", retryAfter=exc.retry_after)
    if isinstance(exc, GeometryUnsigned):
        return body(403, "source_not_signed", str(exc))
    if isinstance(exc, GeometryBusy):
        return body(503, "geometry_busy", "The geometry service is busy", retryAfter=exc.retry_after)
    if isinstance(exc, GeometryTimeout):
        return body(504, "geometry_timeout", str(exc))
    if isinstance(exc, GeometryBuildFailed):
        status, code = _BUILD_FAILURES.get(exc.kind, (502, "build_failed"))
        return body(status, code, exc.args[0] or "The model's geometry could not be built")
    if isinstance(exc, SourceRefused):
        return body(503, "geometry_source_unavailable", str(exc))
    if isinstance(exc, ModelTooLargeError):
        return body(413, "model_too_large", str(exc))
    if isinstance(exc, GeometryRequestError):
        return body(400, "invalid_request", str(exc))
    if isinstance(exc, ValueError):  # the engine refused to build this model's index
        return body(502, "build_failed", str(exc))
    if isinstance(exc, SpatialEngineUnavailableError):
        return body(503, "engine_unavailable", "The spatial engine is not installed")
    if isinstance(exc, BimQueryUnavailableError):
        return body(502, "source_unavailable", "The model file could not be read")
    logger.exception("geometry operation failed", exc_info=exc)
    return body(500, "geometry_failed", "The geometry operation failed")
