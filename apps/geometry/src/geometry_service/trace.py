"""What one geometry call records: the shape of the call, never the building.

The same facts ``ifc_query`` and ``ifc_measure`` put on a turn's trace (``record_ifc_call`` in
``agent.tools.bim.trace``): operation, outcome, and here also which cache tier answered (``A`` a
resident parse, ``B`` the shared element index, ``cold`` a download and build), how many elements
the answer holds, how long it took and whether the engine truncated it. This service runs in no
turn, so it writes them as one structured log line and returns them in the response's ``meta``,
where the BFF puts them on its ``bim-geometry`` span and scores a cold call
(``geometry-cold-ms``, ``apps/workspace/bff/langfuse/geometry-trace.ts``).
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from .errors import GeometryOutcome

logger = logging.getLogger("geometry_service.calls")


def model_handle(model_id: str) -> str:
    """A stable, non-reversible name for one model, as ``agent.tools.bim.trace.model_handle`` makes one."""
    return hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:12]


def call_facts(outcome: GeometryOutcome, *, model_id: str) -> dict[str, Any]:
    """The record_ifc_call-style facts of one answered call."""
    return {
        "ifc_op": f"geometry:{outcome.op}",
        "ifc_outcome": "ok",
        "ifc_cache_tier": outcome.cache_tier,
        "ifc_elements": outcome.elements,
        "ifc_ms": outcome.ms,
        "ifc_truncated": outcome.truncated,
        "ifc_model": model_handle(model_id),
    }


def log_call(**facts: Any) -> None:
    """One JSON line per call; ``None`` facts are dropped."""
    logger.info(json.dumps({"event": "geometry_call", **{k: v for k, v in facts.items() if v is not None}}))
