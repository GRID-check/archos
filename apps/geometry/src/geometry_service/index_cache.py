"""Geometry of one model by its id: model resolution, the element index cache and the builds.

The geometry service (ADR-0149) answers the operations the BFF route
``POST /api/bim/models/{id}/geometry`` and the agent door (``bim-model-geometry``) offer. The
model's bytes come the way ``ifc_measure``'s do, through :mod:`agent.knowledge.ifc_spatial_client`
(the BFF's ``/api/internal/bim/source``, its download guard and its memory admission:
``ModelTooLargeError`` refuses a model this pod cannot hold before it is parsed), reused here and
not copied.

## Two tiers, and why the second exists

**Tier A** is the parsed model resident in this process (``SpatialCache``, two models). It is
needed for the narrow-phase operations (``in-room``, ``neighbours``, ``clash``), which read
triangles.

**Tier B** is the model's element index (one box, centroid, storey and status per product, about
100 bytes an element) in the shared cache, under ``ifc:index:v1:{model_id}:{sha256(source
identity)}`` for 30 days. The broad-phase operations (``boxes``, ``group-boxes``, ``within``,
``near``, ``diff``) answer from it alone, so the second question about a building on any replica
opens no IFC at all. The source identity is the object's ETag (else the model id and its
``updatedAt``), so a re-export lands under a new key and is a guaranteed miss.

Building the index is the expensive step (download, parse, a geometry pass: seconds to minutes),
so it is single-flight across replicas: ``SET NX`` on ``<key>:lock`` for 120 s, held by the one
build, released only by its owner. A caller waits at most :data:`WAIT_SECONDS` for it; past that
it gets :class:`GeometryWarming` (the route's 409 with ``retryAfter``) while the build carries on
in this process's pool, and the next call finds the index in Tier B.

Every call into the engine goes through :mod:`geometry_service.engine`, the one adapter.

## Tenancy

The cache key names a model id the BFF just resolved for this caller (``/api/internal/bim/source``
with the caller's organization and project); a caller who may not see the model never reaches
the key. The index holds geometry and GlobalIds, never names or property values.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Any
from typing import Literal

from agent.common import cache
from agent.knowledge import ifc_spatial_client as spatial

from . import engine

logger = logging.getLogger(__name__)

INDEX_KEY_PREFIX = "ifc:index:v1"
#: A model revision's index is immutable (a new export is a new key); 30 days bounds what an unused one costs.
INDEX_TTL_SECONDS = 30 * 24 * 3600
#: Longer than a sample house's build and shorter than a stuck one: a dead builder frees the lock on its own.
BUILD_LOCK_SECONDS = 120
#: What a request waits for a cold build before it is told to come back.
WAIT_SECONDS = 20.0
#: The ``retryAfter`` a warming answer carries.
RETRY_AFTER_SECONDS = 10
_POLL_SECONDS = 0.25

#: Answered from the index alone (Tier B).
INDEX_OPS = frozenset({"boxes", "group-boxes", "within", "near", "diff"})
#: Need the parsed model's triangles (Tier A).
RESIDENT_OPS = frozenset({"in-room", "neighbours", "clash"})

CacheTier = Literal["A", "B", "cold"]


class GeometryWarming(Exception):
    """The model's index or parse is being built; ask again after ``retry_after`` seconds."""

    def __init__(self, retry_after: int = RETRY_AFTER_SECONDS) -> None:
        super().__init__("geometry_warming")
        self.retry_after = retry_after


class GeometryModelUnresolved(Exception):
    """The BFF answered ``resolved: false``: no such model here, or it is not ready yet."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class GeometryRequestError(ValueError):
    """The request cannot be answered as asked (an element with no box to search around)."""


@dataclass(frozen=True)
class GeometryOutcome:
    """One answered operation, with the shape facts the trace and the BFF's span record."""

    op: str
    result: dict[str, Any]
    cache_tier: CacheTier
    ms: int
    elements: int
    truncated: bool


# ── resolving and keying ─────────────────────────────────────────────────────


def resolve(organization_id: str, project_id: str | None, model_id: str) -> dict[str, Any]:
    """The model's source body from the BFF, as this caller may see it, or :class:`GeometryModelUnresolved`."""
    body = spatial.resolve_model_source(organization_id=organization_id, project_id=project_id, model_id=model_id)
    if body.get("resolved") is not True:
        raise GeometryModelUnresolved(str(body.get("reason") or "not_found"), str(body.get("message") or ""))
    return body


def index_key(model_id: str, source: dict[str, Any]) -> str:
    """``ifc:index:v1:{model_id}:{sha256(source identity)}``: a new export is a new key."""
    digest = hashlib.sha256(spatial.source_identity(source).encode("utf-8")).hexdigest()[:32]
    return f"{INDEX_KEY_PREFIX}:{model_id}:{digest}"


# ── builds, single-flight ────────────────────────────────────────────────────

#: Two builds at once at most: each holds a parse in memory (the open lock serialises parses anyway).
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ifc-geometry")
_INFLIGHT: dict[str, Future[Any]] = {}
_INFLIGHT_LOCK = threading.Lock()


def _submit_once(key: str, work: Callable[[], Any]) -> Future[Any]:
    """Run ``work`` in the pool unless a run under ``key`` is already in flight in this process."""
    with _INFLIGHT_LOCK:
        running = _INFLIGHT.get(key)
        if running is not None and not running.done():
            return running
        future = _POOL.submit(work)
        _INFLIGHT[key] = future

    def _forget(done: Future[Any]) -> None:
        with _INFLIGHT_LOCK:
            if _INFLIGHT.get(key) is done:
                _INFLIGHT.pop(key, None)

    future.add_done_callback(_forget)
    return future


def _open_resident(source: dict[str, Any]) -> Any:
    """The parsed model (download and parse when not resident). Blocking: run it in the pool."""
    spatial.open_model(source)
    model = spatial.resident_model(source)
    if model is None:  # evicted between open and lookup by a third model
        spatial.open_model(source)
        model = spatial.resident_model(source)
    return model


def _build_and_store(key: str, source: dict[str, Any], token: str) -> tuple[Any, CacheTier]:
    """Build the index from the parsed model and write it to Tier B; release the lock this build owns."""
    try:
        tier: CacheTier = "A" if spatial.resident_model(source) is not None else "cold"
        index = engine.current().build_index(_open_resident(source))
        cache.set_json(key, engine.current().index_to_json(index), INDEX_TTL_SECONDS)
        return index, tier
    finally:
        cache.delete_if_equal(f"{key}:lock", token)


def _start_build(key: str, source: dict[str, Any]) -> Future[Any] | None:
    """This process's build future, or None when another replica holds the lock."""
    with _INFLIGHT_LOCK:
        running = _INFLIGHT.get(key)
    if running is not None and not running.done():
        return running
    token = uuid.uuid4().hex
    if not cache.set_if_absent(f"{key}:lock", token, BUILD_LOCK_SECONDS):
        return None
    return _submit_once(key, lambda: _build_and_store(key, source, token))


def _tier_b(key: str) -> Any | None:
    data = cache.get_json(key)
    return None if data is None else engine.current().index_from_json(data)


def load_index(key: str, source: dict[str, Any], deadline: float) -> tuple[Any, CacheTier]:
    """The index from Tier B, or built (single-flight) within ``deadline``, or :class:`GeometryWarming`."""
    index = _tier_b(key)
    if index is not None:
        return index, "B"
    future = _start_build(key, source)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GeometryWarming()
        if future is not None:
            try:
                return future.result(timeout=remaining)
            except FutureTimeout:
                raise GeometryWarming() from None
        time.sleep(min(_POLL_SECONDS, remaining))
        index = _tier_b(key)
        if index is not None:
            return index, "B"
        # The other replica's lock may have lapsed without an index: take the build over.
        future = _start_build(key, source)


def load_model(source: dict[str, Any], deadline: float) -> tuple[Any, CacheTier]:
    """The parsed model (Tier A), or opened within ``deadline``, or :class:`GeometryWarming`."""
    model = spatial.resident_model(source)
    if model is not None:
        return model, "A"
    future = _submit_once(f"open:{spatial.source_identity(source)}", lambda: _open_resident(source))
    try:
        return future.result(timeout=max(0.0, deadline - time.monotonic())), "cold"
    except FutureTimeout:
        raise GeometryWarming() from None


def warm(model_id: str, source: dict[str, Any]) -> str:
    """Fire and forget: start the index build unless it is cached. ``ready`` or ``warming``."""
    key = index_key(model_id, source)
    if cache.get_json(key) is not None:
        return "ready"
    _start_build(key, source)
    return "warming"
