"""One typed operation against one model: which tier answers it, and the engine call.

The broad-phase operations (``boxes``, ``group-boxes``, ``within``, ``near``, ``diff``) answer from
the element index (Tier B, or built cold); the narrow-phase ones (``in-room``, ``neighbours``,
``clash``) also need the parsed model (Tier A). ``warm`` starts the index build and returns at once.
"""

from __future__ import annotations

import time
from typing import Any

from . import engine
from . import index_cache
from .index_cache import CacheTier
from .index_cache import GeometryOutcome
from .index_cache import GeometryRequestError
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

#: The lists a result may carry, in the order the element count is read from.
_RESULT_LISTS = ("boxes", "elements", "pairs", "neighbours", "changes", "groups")

_TIER_RANK = {"A": 0, "B": 1, "cold": 2}


def _colder(*tiers: CacheTier) -> CacheTier:
    """The slowest tier that took part: one cold step makes the whole call cold."""
    return max(tiers, key=lambda tier: _TIER_RANK[tier])


def _size(result: dict[str, Any]) -> int:
    for key in _RESULT_LISTS:
        value = result.get(key)
        if isinstance(value, (list, dict)):
            return len(value)
    return 0


def _box_around(index: Any, global_id: str, margin: float) -> dict[str, list[float]]:
    """The element's own box grown by ``margin`` metres on every side."""
    answer = engine.current().element_boxes(index, [global_id])
    boxes = answer.get("boxes") or []
    if not boxes:
        raise GeometryRequestError(f"{global_id} has no box in this model")
    box = boxes[0]
    return {
        "min": [value - margin for value in box["min"]],
        "max": [value + margin for value in box["max"]],
    }


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
        return adapter.elements_near(index, op.point if op.point is not None else op.global_id, op.radius, op.limit)
    raise TypeError(type(op).__name__)


def _resident_op(op: Any, model: Any, index: Any) -> dict[str, Any]:
    adapter = engine.current()
    if isinstance(op, InRoomOp):
        return adapter.elements_in_room(model, op.space_global_id)
    if isinstance(op, NeighboursOp):
        return adapter.neighbours(model, index, op.global_id, op.gap)
    if isinstance(op, ClashOp):
        return adapter.clash(model, index, op.set_a, op.set_b, op.mode, op.tolerance)
    raise TypeError(type(op).__name__)


def _answer(
    op: Any, model_id: str, source: dict[str, Any], scope: tuple[str, str | None], deadline: float
) -> tuple[dict[str, Any], CacheTier]:
    index, tier = index_cache.load_index(index_cache.index_key(model_id, source), source, deadline)
    if isinstance(op, DiffOp):
        base_source = index_cache.resolve(scope[0], scope[1], op.base_model_id)
        base_key = index_cache.index_key(op.base_model_id, base_source)
        base_index, base_tier = index_cache.load_index(base_key, base_source, deadline)
        return engine.current().box_diff(base_index, index, op.global_ids), _colder(tier, base_tier)
    if isinstance(op, (InRoomOp, NeighboursOp, ClashOp)):
        model, model_tier = index_cache.load_model(source, deadline)
        return _resident_op(op, model, index), _colder(tier, model_tier)
    return _index_op(op, index), tier


def run(request: GeometryRequest, organization_id: str, project_id: str | None) -> GeometryOutcome:
    """Answer one operation for the caller the envelope named, within :data:`index_cache.WAIT_SECONDS`.

    Raises :class:`index_cache.GeometryWarming` past the wait (the build carries on),
    :class:`index_cache.GeometryModelUnresolved` for a model the caller cannot reach, and
    :class:`index_cache.GeometryRequestError` for a request the model cannot answer.
    """
    started = time.monotonic()
    op = request.operation
    source = index_cache.resolve(organization_id, project_id, request.model_id)
    if isinstance(op, WarmOp):
        status = index_cache.warm(request.model_id, source)
        result: dict[str, Any] = {"status": status}
        tier: CacheTier = "B" if status == "ready" else "cold"
    else:
        deadline = started + index_cache.WAIT_SECONDS
        result, tier = _answer(op, request.model_id, source, (organization_id, project_id), deadline)
    return GeometryOutcome(
        op=op.op,
        result=result,
        cache_tier=tier,
        ms=int((time.monotonic() - started) * 1000),
        elements=_size(result),
        truncated=bool(result.get("truncated")),
    )
