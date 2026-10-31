"""The one adapter onto the spatial engine (``packages/ifc-spatial-py``).

Every name the service calls in ``ifc_spatial`` is spelled here and nowhere else, so wiring the
service to the engine's element index and locate operators is this file. The engine is imported
lazily: IfcOpenShell, numpy and shapely are seconds of import and hundreds of megabytes that a
health probe should never pay. Tests replace the adapter with :func:`set_for_tests`.

The operators' contract (coordinates are IFC world, Z-up, metres; every answer carries its
provenance) is the engine's; this adapter passes arguments and results through unchanged.
"""

from __future__ import annotations

from typing import Any


class GeometryEngine:
    """``ElementIndex`` and the locate operators, by the engine's own names."""

    def available(self) -> bool:
        """Whether the engine imports in this process (the readiness probe asks this)."""
        try:
            import ifc_spatial.element_index  # noqa: F401
            import ifc_spatial.operators_proximity  # noqa: F401
        except ImportError:
            return False
        return True

    def build_index(self, model: Any) -> Any:
        from ifc_spatial.element_index import ElementIndex

        return ElementIndex.build(model)

    def index_to_json(self, index: Any) -> Any:
        return index.to_json()

    def index_from_json(self, data: Any) -> Any:
        from ifc_spatial.element_index import ElementIndex

        return ElementIndex.from_json(data)

    def element_boxes(self, index: Any, ids: list[str]) -> dict[str, Any]:
        return self._op("element_boxes")(index, ids)

    def group_boxes(self, index: Any, groups: dict[str, list[str]]) -> dict[str, Any]:
        return self._op("group_boxes")(index, groups)

    def elements_within(
        self, index: Any, box: dict[str, Any], ifc_types: list[str] | None, limit: int
    ) -> dict[str, Any]:
        return self._op("elements_within")(index, box, ifc_types, limit)

    def elements_near(self, index: Any, around: Any, radius: float, limit: int) -> dict[str, Any]:
        """``around`` is a point ``[x, y, z]`` or a GlobalId."""
        return self._op("elements_near")(index, around, radius, limit)

    def elements_in_room(self, model: Any, space_gid: str) -> dict[str, Any]:
        return self._op("elements_in_room")(model, space_gid)

    def neighbours(self, model: Any, index: Any, gid: str, gap: float) -> dict[str, Any]:
        return self._op("neighbours")(model, index, gid, gap)

    def clash(
        self, model: Any, index: Any, set_a: list[str], set_b: list[str] | None, mode: str, tolerance: float
    ) -> dict[str, Any]:
        return self._op("clash")(model, index, set_a, set_b, mode, tolerance)

    def box_diff(self, base_index: Any, index: Any, ids: list[str] | None) -> dict[str, Any]:
        return self._op("box_diff")(base_index, index, ids)

    @staticmethod
    def _op(name: str) -> Any:
        from ifc_spatial import operators_proximity

        return getattr(operators_proximity, name)


_CURRENT: GeometryEngine = GeometryEngine()


def current() -> GeometryEngine:
    return _CURRENT


def set_for_tests(engine: GeometryEngine) -> GeometryEngine:
    """Swap the adapter; returns the previous one."""
    global _CURRENT
    previous, _CURRENT = _CURRENT, engine
    return previous
