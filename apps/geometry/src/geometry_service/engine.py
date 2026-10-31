"""The one adapter onto the spatial engine (``packages/ifc-spatial-py``).

Every name the service calls in ``ifc_spatial`` is spelled here and nowhere else, so wiring the
service to the engine's element index and locate operators is this file. The engine is imported
lazily: IfcOpenShell, numpy and shapely are seconds of import and hundreds of megabytes that a
health probe should never pay. Tests replace the adapter with :func:`set_for_tests`; the contract
test (``tests/test_engine_contract.py``) runs this one against the real engine.

Each operator returns the engine's ``Answer``; the adapter hands back its wire form
(``Answer.to_dict()``: ``value`` plus unit, tolerance, provenance, ``from``, ``method``, ``caveat``),
so the caller sees the provenance unchanged. Coordinates are IFC world, Z-up, metres.

Refusals the engine raises about the request (``ProximityLimitError``, ``IndexFormatError``,
``UnknownElementError``, any ``ValueError``) become :class:`EngineRefusal`, carrying the engine's
own message, which the route answers as a 400.

The narrow-phase operators bound their own work with module budgets (``CLASH_BUDGET_SECONDS`` and
its siblings). The adapter sets them to what is left of the request's budget for the duration of
one call, under a lock, so a narrow-phase call never outlives the request; this serialises the
narrow phase within a process (it is CPU-bound under the GIL anyway) until the engine takes a
budget argument.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any

#: The engine's own module budgets, by module and name, that one call may lower.
_BUDGETS = (
    ("ifc_spatial.operators_clash", "CLASH_BUDGET_SECONDS"),
    ("ifc_spatial.operators_clash", "NEIGHBOUR_BUDGET_SECONDS"),
    ("ifc_spatial.operators_proximity", "EXACT_BUDGET_SECONDS"),
    ("ifc_spatial.operators_proximity", "ROOM_BUDGET_SECONDS"),
)
_BUDGET_LOCK = threading.Lock()


class EngineRefusal(ValueError):
    """The engine refused the request as asked; the message is the engine's, for the caller."""


def _refusals() -> tuple[type[BaseException], ...]:
    from ifc_spatial.model import UnknownElementError

    return (ValueError, UnknownElementError)


def _wire(call: Callable[[], Any]) -> dict[str, Any]:
    try:
        answer = call()
    except _refusals() as exc:
        message = exc.args[0] if isinstance(exc, KeyError) and exc.args else str(exc)
        raise EngineRefusal(str(message)) from None
    return answer.to_dict()


@contextmanager
def _budget(seconds: float | None):
    """The engine's narrow-phase budgets lowered to ``seconds`` for one call."""
    if seconds is None:
        yield
        return
    import importlib

    with _BUDGET_LOCK:
        saved = []
        for module_name, name in _BUDGETS:
            module = importlib.import_module(module_name)
            saved.append((module, name, getattr(module, name)))
            setattr(module, name, max(0.5, min(getattr(module, name), seconds)))
        try:
            yield
        finally:
            for module, name, value in saved:
                setattr(module, name, value)


class GeometryEngine:
    """``ElementIndex`` and the locate operators, by the engine's own names."""

    def available(self) -> bool:
        """Whether the engine imports in this process (the readiness probe asks this)."""
        try:
            import ifc_spatial.element_index  # noqa: F401
            import ifc_spatial.operators_clash  # noqa: F401
            import ifc_spatial.operators_diff  # noqa: F401
            import ifc_spatial.operators_proximity  # noqa: F401
        except ImportError:
            return False
        return True

    def build_index(self, model: Any) -> Any:
        """The model's index, built once per open model and kept beside it (the narrow phase reuses it)."""
        from ifc_spatial.element_index import element_index

        return element_index(model)

    def index_to_json(self, index: Any) -> str:
        return index.to_json()

    def index_from_json(self, data: Any) -> Any:
        """Raises ``IndexFormatError`` (a ``ValueError``) for an entry that is not a valid index."""
        from ifc_spatial.element_index import ElementIndex

        return ElementIndex.from_json(data)

    def element_boxes(self, index: Any, ids: list[str]) -> dict[str, Any]:
        from ifc_spatial import operators_proximity as op

        return _wire(lambda: op.element_boxes(index, ids))

    def group_boxes(self, index: Any, groups: dict[str, list[str]]) -> dict[str, Any]:
        from ifc_spatial import operators_proximity as op

        return _wire(lambda: op.group_boxes(index, groups))

    def elements_within(
        self, index: Any, box: dict[str, list[float]], ifc_types: list[str] | None, limit: int
    ) -> dict[str, Any]:
        """Elements whose box meets ``box`` (``overlaps``): what is in or crosses the region."""
        from ifc_spatial import operators_proximity as op

        return _wire(lambda: op.elements_within(index, (box["min"], box["max"]), ifc_types, limit, mode="overlaps"))

    def elements_near(
        self, index: Any, *, point: list[float] | None, global_id: str | None, radius: float, limit: int
    ) -> dict[str, Any]:
        import numpy as np
        from ifc_spatial import operators_proximity as op

        centre = None if point is None else np.asarray(point, dtype=float)
        return _wire(lambda: op.elements_near(index, point=centre, global_id=global_id, radius=radius, limit=limit))

    def elements_in_room(self, model: Any, space_gid: str, budget: float | None = None) -> dict[str, Any]:
        from ifc_spatial import operators_proximity as op

        with _budget(budget):
            return _wire(lambda: op.elements_in_room(model, space_gid))

    def neighbours(self, model: Any, gid: str, gap: float, budget: float | None = None) -> dict[str, Any]:
        from ifc_spatial import operators_clash as op

        with _budget(budget):
            return _wire(lambda: op.neighbours(model, gid, gap))

    def clash(
        self,
        model: Any,
        set_a: list[str],
        set_b: list[str] | None,
        mode: str,
        tolerance: float | None,
        budget: float | None = None,
    ) -> dict[str, Any]:
        from ifc_spatial import operators_clash as op

        with _budget(budget):
            return _wire(lambda: op.clash(model, set_a, set_b, mode, tolerance))

    def box_diff(self, base_index: Any, index: Any, ids: list[str] | None) -> dict[str, Any]:
        from ifc_spatial import operators_diff as op

        return _wire(lambda: op.box_diff(base_index, index, ids))


_CURRENT: GeometryEngine = GeometryEngine()


def current() -> GeometryEngine:
    return _CURRENT


def set_for_tests(engine: GeometryEngine) -> GeometryEngine:
    """Swap the adapter; returns the previous one."""
    global _CURRENT
    previous, _CURRENT = _CURRENT, engine
    return previous
