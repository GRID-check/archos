"""One typed operation against one model, within one request budget.

The broad-phase operations (``boxes``, ``group-boxes``, ``within``, ``near``, ``diff``) answer from
the element index (Tier B, or built cold); the narrow-phase ones (``in-room``, ``neighbours``,
``clash``) read the parsed model (Tier A). ``warm`` starts the index build and returns at once.

One budget covers the whole request (:data:`REQUEST_BUDGET_SECONDS`, below the BFF's timeout): the
wait for a cold build takes at most :data:`WAIT_SECONDS` of it, and what is left bounds the engine's
narrow phase. With less than :data:`MIN_OPERATION_SECONDS` left nothing more is started. The result
is the engine's ``Answer`` in wire form: ``value`` and its provenance.
"""

from __future__ import annotations

import time
from typing import Any

from . import builds
from . import engine
from . import index_cache
from .engine import EngineRefusal
from .errors import CacheTier
from .errors import GeometryOutcome
from .errors import GeometryRequestError
from .errors import GeometryTimeout
from .errors import GeometryUnsigned
from .wire import BoxesOp
from .wire import ClashOp
from .wire import DiffOp
from .wire import GeometryRequest
from .wire import GroupBoxesOp
from .wire import InRoomOp
from .wire import NearOp
from .wire import NeighboursOp
from .wire import WarmOp
from .wire import WithinOp

#: The whole request, load and operation; the BFF waits a little longer (`GEOMETRY_TIMEOUT_MS`).
REQUEST_BUDGET_SECONDS = 40.0
#: The longest a request waits for a cold build before it is told to come back.
WAIT_SECONDS = 20.0
#: Below this, an operation is not started: its answer would arrive after the caller gave up.
MIN_OPERATION_SECONDS = 1.0

#: The lists a result's value may carry, in the order the element count is read from.
_RESULT_LISTS = ("boxes", "elements", "pairs", "neighbours", "groups")

_TIER_RANK = {"A": 0, "B": 1, "cold": 2}


def _colder(*tiers: CacheTier) -> CacheTier:
    """The slowest tier that took part: one cold step makes the whole call cold."""
    return max(tiers, key=lambda tier: _TIER_RANK[tier])


def _value(result: dict[str, Any]) -> dict[str, Any]:
    value = result.get("value")
    return value if isinstance(value, dict) else {}


def _size(result: dict[str, Any]) -> int:
    value = _value(result)
    for key in _RESULT_LISTS:
        if isinstance(value.get(key), (list, dict)):
            return len(value[key])
    return 0


def _box_around(index: Any, global_id: str, margin: float) -> dict[str, list[float]]:
    """The element's own box grown by ``margin`` metres on every side."""
    boxes = _value(engine.current().element_boxes(index, [global_id])).get("boxes") or []
    if not boxes:
        raise GeometryRequestError(f"{global_id} has no box in this model")
    box = boxes[0]
    return {"min": [v - margin for v in box["min"]], "max": [v + margin for v in box["max"]]}


def _index_op(op: Any, index: Any) -> dict[str, Any]:
    adapter = engine.current()
    if isinstance(op, BoxesOp):
        return adapter.element_boxes(index, op.global_ids)
    if isinstance(op, GroupBoxesOp):
        return adapter.group_boxes(index, op.groups)
    if isinstance(op, WithinOp):
        box = op.box.model_dump() if op.box else _box_around(index, str(op.around_global_id), op.margin)
        return adapter.elements_within(index, box, op.ifc_types, op.limit)
    if isinstance(op, NearOp):
        return adapter.elements_near(index, point=op.point, global_id=op.global_id, radius=op.radius, limit=op.limit)
    raise TypeError(type(op).__name__)


def _resident_op(op: Any, model: Any, budget: float) -> dict[str, Any]:
    adapter = engine.current()
    if isinstance(op, InRoomOp):
        return adapter.elements_in_room(model, op.space_global_id, budget)
    if isinstance(op, NeighboursOp):
        return adapter.neighbours(model, op.global_id, op.gap, budget)
    if isinstance(op, ClashOp):
        return adapter.clash(model, op.set_a, op.set_b, op.mode, op.tolerance, budget)
    raise TypeError(type(op).__name__)


def _remaining(end: float) -> float:
    left = end - time.monotonic()
    if left < MIN_OPERATION_SECONDS:
        raise GeometryTimeout("the request's time ran out before the operation could start")
    return left


def _source(sources: dict[str, dict[str, Any]], model_id: str) -> dict[str, Any]:
    source = sources.get(model_id)
    if source is None:
        raise GeometryUnsigned(f"no signed source for model {model_id}")
    return source


def _answer(
    request: GeometryRequest, sources: dict[str, dict[str, Any]], end: float, trace: str | None
) -> tuple[dict[str, Any], CacheTier]:
    op = request.operation
    source = _source(sources, request.model_id)
    wait_until = min(time.monotonic() + WAIT_SECONDS, end - MIN_OPERATION_SECONDS)
    if isinstance(op, (InRoomOp, NeighboursOp, ClashOp)):
        model, tier = builds.load_model(source, wait_until, trace)
        return _resident_op(op, model, _remaining(end)), tier
    index, tier = builds.load_index(index_cache.index_key(request.model_id, source), source, wait_until, trace)
    if isinstance(op, DiffOp):
        base_source = _source(sources, op.base_model_id)
        base_key = index_cache.index_key(op.base_model_id, base_source)
        base_index, base_tier = builds.load_index(base_key, base_source, wait_until, trace)
        _remaining(end)
        return engine.current().box_diff(base_index, index, op.global_ids), _colder(tier, base_tier)
    _remaining(end)
    return _index_op(op, index), tier


def run(request: GeometryRequest, sources: dict[str, dict[str, Any]], trace_id: str | None = None) -> GeometryOutcome:
    """Answer one operation within :data:`REQUEST_BUDGET_SECONDS`.

    Raises :class:`GeometryWarming` past the wait (the build carries on), :class:`GeometryTimeout`
    when no budget is left to start the operation, :class:`GeometryUnsigned` for a model the BFF did
    not sign a source for, and :class:`GeometryRequestError` for a request the engine refuses.
    """
    started = time.monotonic()
    op = request.operation
    try:
        if isinstance(op, WarmOp):
            status = builds.warm(request.model_id, _source(sources, request.model_id), trace_id)
            result: dict[str, Any] = {"value": {"status": status}}
            tier: CacheTier = "B" if status == "ready" else "cold"
        else:
            result, tier = _answer(request, sources, started + REQUEST_BUDGET_SECONDS, trace_id)
    except EngineRefusal as exc:
        raise GeometryRequestError(str(exc)) from None
    return GeometryOutcome(
        op=op.op,
        result=result,
        cache_tier=tier,
        ms=int((time.monotonic() - started) * 1000),
        elements=_size(result),
        truncated=bool(_value(result).get("truncated")),
    )
