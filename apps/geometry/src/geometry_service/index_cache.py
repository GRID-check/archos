"""Model resolution, the element index's cache keys, Tier B, its in-process memo and the failure window.

The geometry service (ADR-0149) answers the operations the BFF route
``POST /api/bim/models/{id}/geometry`` and the agent door (``bim-model-geometry``) offer. The BFF
signs each model's presigned internal URL and store identity into the request after its read gate
(``signed_sources.py``); the bytes are fetched by :mod:`agent.knowledge.ifc_spatial_client` (its
download guard and its memory admission: ``ModelTooLargeError`` refuses a model this pod cannot hold
before it is parsed), reused, not copied.

## The tiers

**Tier A** is the parsed model resident in this process (``SpatialCache``, two models), needed by
the narrow-phase operations (``in-room``, ``neighbours``, ``clash``).

**Tier B** is the model's element index in the shared cache, under ``ifc:index:v1:{model_id}:
{sha256(source identity)}`` for 30 days. The broad-phase operations (``boxes``, ``group-boxes``,
``within``, ``near``, ``diff``) answer from it alone, so a warmed model is answered on any replica
without opening the IFC. The source identity is the object's ETag (else the model id and its
``updatedAt``), so a re-export is a new key. An entry that does not read back as a valid index
(``IndexFormatError``: an older schema, a truncated write) is deleted and built again rather than
served or refused forever.

A parsed index is also kept in a small in-process memo (:data:`MEMO_MAX_BYTES`), so a hit does not
transfer and re-validate several megabytes of JSON on every call.

A build that failed is remembered for :data:`FAILURE_TTL_SECONDS` under ``<key>:failed`` with its
reason, so a model that cannot be read is not downloaded again by every caller in that window.

## Tenancy

A key names a model id whose source the BFF signed for this caller after its read gate; a caller
who may not see the model never reaches the key. The index holds
geometry and GlobalIds, never names or property values.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict
from typing import Any

from agent.common import cache
from agent.knowledge import ifc_spatial_client as spatial

from . import engine
from .errors import GeometryBuildFailed

logger = logging.getLogger(__name__)

INDEX_KEY_PREFIX = "ifc:index:v1"
#: A model revision's index is immutable (a new export is a new key); 30 days bounds what an unused one costs.
INDEX_TTL_SECONDS = 30 * 24 * 3600
#: How long a failed build is answered from memory before anyone tries again.
FAILURE_TTL_SECONDS = 300
#: The in-process memo of parsed indexes, by the size of their JSON. About 100 B an element.
MEMO_MAX_BYTES = 64 * 1024 * 1024


def index_key(model_id: str, source: dict[str, Any]) -> str:
    """``ifc:index:v1:{model_id}:{sha256(source identity)}``: a new export is a new key."""
    digest = hashlib.sha256(spatial.source_identity(source).encode("utf-8")).hexdigest()[:32]
    return f"{INDEX_KEY_PREFIX}:{model_id}:{digest}"


# ── the in-process memo ──────────────────────────────────────────────────────

_MEMO: OrderedDict[str, tuple[Any, int]] = OrderedDict()
_MEMO_BYTES = 0
_MEMO_LOCK = threading.Lock()


def _memo_get(key: str) -> Any | None:
    with _MEMO_LOCK:
        hit = _MEMO.get(key)
        if hit is None:
            return None
        _MEMO.move_to_end(key)
        return hit[0]


def memo_put(key: str, index: Any, size: int) -> None:
    """Keep a parsed index, evicting the least recently used past :data:`MEMO_MAX_BYTES`."""
    global _MEMO_BYTES
    if size > MEMO_MAX_BYTES:
        return
    with _MEMO_LOCK:
        previous = _MEMO.pop(key, None)
        _MEMO_BYTES -= previous[1] if previous else 0
        _MEMO[key] = (index, size)
        _MEMO_BYTES += size
        while _MEMO_BYTES > MEMO_MAX_BYTES and _MEMO:
            _, (_, evicted) = _MEMO.popitem(last=False)
            _MEMO_BYTES -= evicted


def memo_clear() -> None:
    global _MEMO_BYTES
    with _MEMO_LOCK:
        _MEMO.clear()
        _MEMO_BYTES = 0


# ── Tier B ───────────────────────────────────────────────────────────────────


def store(key: str, index: Any) -> None:
    """Write a built index to Tier B and the memo."""
    text = engine.current().index_to_json(index)
    cache.set_json(key, text, INDEX_TTL_SECONDS)
    memo_put(key, index, len(text))


def tier_b(key: str) -> Any | None:
    """The index from the memo or the shared cache; a poisoned entry is deleted and reads as a miss."""
    index = _memo_get(key)
    if index is not None:
        return index
    data = cache.get_json(key)
    if data is None:
        return None
    try:
        index = engine.current().index_from_json(data)
    except ValueError as exc:  # IndexFormatError: refused, not repaired, so built again
        logger.warning("element index %s did not read back (%s); deleting it to rebuild", key, exc)
        cache.delete(key)
        return None
    memo_put(key, index, len(data) if isinstance(data, str) else 0)
    return index


# ── the failure window ───────────────────────────────────────────────────────


def remember_failure(key: str, kind: str, message: str) -> None:
    cache.set_json(f"{key}:failed", {"kind": kind, "message": message}, FAILURE_TTL_SECONDS)


def raise_if_failed(key: str) -> None:
    """:class:`GeometryBuildFailed` while the model's last build failure is remembered."""
    failed = cache.get_json(f"{key}:failed")
    if isinstance(failed, dict):
        raise GeometryBuildFailed(str(failed.get("kind") or "unavailable"), str(failed.get("message") or ""))
