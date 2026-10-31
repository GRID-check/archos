"""Building a model's element index once across replicas, and waiting for it within a budget.

Building is the expensive step (download, parse, a geometry pass: seconds to minutes). It runs in
this process's small pool and is single-flight across replicas:

* the lock ``<key>:lock`` (``SET NX``, :data:`BUILD_LOCK_SECONDS`) is taken when the build actually
  starts, in the pool, not when it is queued, so a build waiting for a worker holds nothing;
* a heartbeat extends it every :data:`HEARTBEAT_SECONDS` while the build runs, so a long build
  never loses it to a second builder, and a dead one frees it within the TTL;
* it is released by compare-and-delete, so a build never frees a lock a successor took;
* at most :data:`MAX_QUEUED_BUILDS` builds are queued or running in a process; past that the caller
  is told to come back (:class:`GeometryBusy`);
* a failed build is remembered for a few minutes with its reason (``index_cache.remember_failure``).

A caller waits until its deadline; past it the answer is :class:`GeometryWarming` while the build
carries on, and the next call finds the index in Tier B. When a build that was cold completes,
whether or not its caller is still waiting, its milliseconds are scored ``geometry-cold-ms`` on the
trace of the request that started it, so a 409 does not leave the slowest builds out of the score.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

from agent.common import cache
from agent.knowledge import ifc_spatial_client as spatial

from . import engine
from . import index_cache
from .errors import CacheTier
from .errors import GeometryBusy
from .errors import GeometryWarming

logger = logging.getLogger(__name__)

#: Longer than a heartbeat interval with room to spare; a dead builder frees the lock on its own.
BUILD_LOCK_SECONDS = 120
HEARTBEAT_SECONDS = 30
#: Builds queued or running in one process; each holds a parse in memory.
MAX_QUEUED_BUILDS = 4
_POLL_SECONDS = 0.25

_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ifc-geometry")
_INFLIGHT: dict[str, Future[Any]] = {}
_INFLIGHT_LOCK = threading.Lock()


def _submit(key: str, work: Callable[[], Any]) -> Future[Any]:
    """The run under ``key`` already in flight here, or a new one; :class:`GeometryBusy` when the queue is full."""
    with _INFLIGHT_LOCK:
        running = _INFLIGHT.get(key)
        if running is not None and not running.done():
            return running
        if sum(1 for future in _INFLIGHT.values() if not future.done()) >= MAX_QUEUED_BUILDS:
            raise GeometryBusy()
        future = _POOL.submit(work)
        _INFLIGHT[key] = future

    def _forget(done: Future[Any]) -> None:
        with _INFLIGHT_LOCK:
            if _INFLIGHT.get(key) is done:
                _INFLIGHT.pop(key, None)

    future.add_done_callback(_forget)
    return future


def _failure_kind(exc: BaseException) -> str:
    if isinstance(exc, spatial.ModelTooLargeError):
        return "too_large"
    if isinstance(exc, spatial.SpatialEngineUnavailableError):
        return "engine_unavailable"
    if isinstance(exc, ValueError):
        return "invalid"
    return "unavailable"


def score_cold(trace_id: str | None, ms: int) -> None:
    """``geometry-cold-ms`` on the requesting trace. Never raises, never waits."""
    if not trace_id:
        return
    from agent.observability.langfuse_scores import RuntimeScore
    from agent.observability.langfuse_scores import emit_scores

    emit_scores([RuntimeScore("geometry-cold-ms", float(ms))], writer="geometry", trace_id=trace_id)


def _open_resident(source: dict[str, Any]) -> Any:
    """The parsed model (download and parse when not resident). Blocking: run it in the pool."""
    spatial.open_model(source)
    model = spatial.resident_model(source)
    if model is None:  # evicted between open and lookup by a third model
        spatial.open_model(source)
        model = spatial.resident_model(source)
    return model


def _heartbeat(lock_key: str, token: str, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_SECONDS):
        if not cache.refresh_if_equal(lock_key, token, BUILD_LOCK_SECONDS):
            logger.warning("lost the build lock %s while building", lock_key)
            return


def _build(key: str, source: dict[str, Any], trace_id: str | None) -> tuple[Any, CacheTier] | None:
    """Build and store the index under the lock; None when another builder holds it."""
    lock_key, token = f"{key}:lock", json.dumps(uuid.uuid4().hex)
    if not cache.set_if_absent(lock_key, token, BUILD_LOCK_SECONDS):
        return None
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(lock_key, token, stop), daemon=True).start()
    started = time.monotonic()
    try:
        index = index_cache.tier_b(key)  # finished elsewhere between the miss and the lock
        if index is not None:
            return index, "B"
        tier: CacheTier = "A" if spatial.resident_model(source) is not None else "cold"
        index = engine.current().build_index(_open_resident(source))
        index_cache.store(key, index)
        if tier == "cold":
            score_cold(trace_id, int((time.monotonic() - started) * 1000))
        return index, tier
    except Exception as exc:
        index_cache.remember_failure(key, _failure_kind(exc), str(exc))
        raise
    finally:
        stop.set()
        cache.delete_if_equal(lock_key, token)


def load_index(key: str, source: dict[str, Any], deadline: float, trace_id: str | None = None) -> tuple[Any, CacheTier]:
    """The index from Tier B, or built single-flight within ``deadline``, or :class:`GeometryWarming`."""
    index = index_cache.tier_b(key)
    if index is not None:
        return index, "B"
    index_cache.raise_if_failed(key)
    future: Future[Any] | None = _submit(key, lambda: _build(key, source, trace_id))
    while True:
        if future is not None and future.done():
            built = future.result()  # a build's own failure propagates
            if built is not None:
                return built
            future = None
        index = index_cache.tier_b(key)
        if index is not None:
            return index, "B"
        index_cache.raise_if_failed(key)
        if future is None and cache.get_json(f"{key}:lock") is None:
            # The other builder is gone without an index: take the build over.
            future = _submit(key, lambda: _build(key, source, trace_id))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GeometryWarming()
        time.sleep(min(_POLL_SECONDS, remaining))


def _open_job(source: dict[str, Any], trace_id: str | None) -> Any:
    started = time.monotonic()
    model = _open_resident(source)
    score_cold(trace_id, int((time.monotonic() - started) * 1000))
    return model


def load_model(source: dict[str, Any], deadline: float, trace_id: str | None = None) -> tuple[Any, CacheTier]:
    """The parsed model (Tier A), or opened within ``deadline``, or :class:`GeometryWarming`."""
    model = spatial.resident_model(source)
    if model is not None:
        return model, "A"
    future = _submit(f"open:{spatial.source_identity(source)}", lambda: _open_job(source, trace_id))
    try:
        return future.result(timeout=max(0.0, deadline - time.monotonic())), "cold"
    except FutureTimeout:
        raise GeometryWarming() from None


def warm(model_id: str, source: dict[str, Any], trace_id: str | None = None) -> str:
    """Fire and forget: start the index build unless it is cached. ``ready`` or ``warming``."""
    key = index_cache.index_key(model_id, source)
    if index_cache.tier_b(key) is not None:
        return "ready"
    index_cache.raise_if_failed(key)
    _submit(key, lambda: _build(key, source, trace_id))
    return "warming"
