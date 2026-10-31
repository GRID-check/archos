"""Where elements are: boxes, groups of boxes, what lies in a box or near a point, what a room holds.

Every operator here except :func:`elements_in_room` answers from an
:class:`~ifc_spatial.element_index.ElementIndex` alone — no IFC, no geometry
kernel — so a host can answer from a cached index without opening the model.
The pair operators that need the triangles (``neighbours``, ``clash``) are in
:mod:`ifc_spatial.operators_clash`; the revision diff in
:mod:`ifc_spatial.operators_diff`.

## What a box is, and what it is not

An axis-aligned box in the IFC world frame (Z up, metres). It bounds the
element's tessellated body and is the right primitive for framing a view, for a
broad phase and for "roughly where"; it is not a clearance. ``elements_near``
in ``exact`` mode and :mod:`ifc_spatial.operators_clash` measure surfaces.

## Limits

Each limit is a refusal (:class:`ProximityLimitError`), never a silent clamp: a
caller that asked about 900 elements and got an answer about 500 would report a
subset as a total.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from functools import lru_cache
from typing import Any

import ifcopenshell.ifcopenshell_wrapper as wrapper
import numpy as np

from .clearance import _soup_distance
from .clearance import _usable_triangles
from .element_index import MAX_PART_DEPTH
from .element_index import MAX_PARTS
from .element_index import ElementIndex
from .element_index import element_index
from .element_index import finite_point
from .envelope import Answer
from .envelope import computed
from .envelope import declared
from .model import SpatialModel
from .operators_constants import TESSELLATION_TOLERANCE
from .proximity_mesh import overlaps_by_containment
from .proximity_mesh import point_distances
from .proximity_mesh import points_inside

MAX_BOX_IDS = 500
MAX_GROUPS = 300
MAX_GROUP_IDS = 200
MAX_RESULTS = 500
MAX_RADIUS = 50.0
#: Seconds one ``exact`` query may spend on triangles before it stops and says so.
EXACT_BUDGET_SECONDS = 20.0
#: Seconds ``elements_in_room`` may spend on its centroid-in-solid test.
ROOM_BUDGET_SECONDS = 20.0
#: Bodies that are holes, not things. Left out of every query unless asked for by type.
VOID_TYPES = ("IfcOpeningElement", "IfcVoidingFeature")
REASON_UNKNOWN = "unknown-global-id"


class ProximityLimitError(ValueError):
    """A request over a published limit, or malformed. The caller can correct it."""


# ── shared pieces ───────────────────────────────────────────────────────────


def _check_count(name: str, values: Any, limit: int) -> list[str]:
    """A list of GlobalId strings no longer than ``limit``, or a refusal naming both."""
    if not isinstance(values, (list, tuple)) or not all(isinstance(v, str) and v.strip() for v in values):
        raise ProximityLimitError(f"{name} must be a list of GlobalId strings")
    if len(values) > limit:
        raise ProximityLimitError(f"{name} has {len(values)} entries; at most {limit} are allowed")
    return [v.strip() for v in values]


def _check_number(name: str, value: Any, low: float, high: float) -> float:
    try:
        number = float(value)
    except TypeError, ValueError:
        raise ProximityLimitError(f"{name} must be a number") from None
    if not low <= number <= high:
        raise ProximityLimitError(f"{name} must be between {low:g} and {high:g}, got {number:g}")
    return number


def _box_dict(low: np.ndarray, high: np.ndarray) -> dict[str, list[float]]:
    return {"min": [float(v) for v in low], "max": [float(v) for v in high]}


def _missing_reason(index: ElementIndex, global_id: str) -> str | None:
    row = index.row(global_id)
    if row is None:
        return REASON_UNKNOWN
    return None if index.ok[row] else index.status[row]


def _split(index: ElementIndex, ids: Iterable[str]) -> tuple[list[int], list[dict[str, str]]]:
    """Rows that carry a box, and ``{globalId, reason}`` for the rest."""
    rows: list[int] = []
    missing: list[dict[str, str]] = []
    for global_id in dict.fromkeys(ids):
        reason = _missing_reason(index, global_id)
        if reason is not None:
            missing.append({"globalId": global_id, "reason": reason})
            continue
        rows.append(index.row(global_id))  # type: ignore[arg-type]
    return rows, missing


def _union(index: ElementIndex, rows: list[int]) -> dict[str, list[float]] | None:
    if not rows:
        return None
    return _box_dict(index.mins[rows].min(axis=0), index.maxs[rows].max(axis=0))


@lru_cache(maxsize=4096)
def _is_subtype(schema: str, ifc_type: str, wanted: str) -> bool:
    try:
        declaration = wrapper.schema_by_name(schema).declaration_by_name(ifc_type)
    except Exception:  # noqa: BLE001 — an unknown name in an index is simply not a match
        return ifc_type == wanted
    while declaration is not None:
        if declaration.name() == wanted:
            return True
        declaration = declaration.supertype()
    return False


def _is_spatial(schema: str, ifc_type: str) -> bool:
    """A space, storey, building or site — IFC4 says IfcSpatialElement, IFC2X3 IfcSpatialStructureElement."""
    return _is_subtype(schema, ifc_type, "IfcSpatialElement") or _is_subtype(
        schema, ifc_type, "IfcSpatialStructureElement"
    )


def _type_mask(index: ElementIndex, ifc_types: list[str] | None) -> np.ndarray:
    """Rows to search: ok, of a wanted type (subtype-aware), and not a void unless a void was asked for."""
    mask = index.ok.copy()
    wanted = [t for t in (ifc_types or []) if t]
    schema = index.schema_name
    for row, ifc_type in enumerate(index.ifc_types):
        if not mask[row]:
            continue
        if wanted:
            mask[row] = any(_is_subtype(schema, ifc_type, w) for w in wanted)
        else:
            mask[row] = not any(_is_subtype(schema, ifc_type, v) for v in VOID_TYPES)
    return mask


def _ref(index: ElementIndex, row: int, **extra: Any) -> dict[str, Any]:
    out = {
        "globalId": index.global_ids[row],
        "ifcType": index.ifc_types[row],
        "storeyGlobalId": index.storeys[row],
        **_box_dict(index.mins[row], index.maxs[row]),
    }
    if index.via[row]:
        out["via"] = index.via[row]
    out.update(extra)
    return out


# ── boxes ───────────────────────────────────────────────────────────────────


def element_boxes(index: ElementIndex, ids: list[str]) -> Answer[dict[str, Any]]:
    """The box and centroid of each element, their union, and why any id has none."""
    ids = _check_count("globalIds", ids, MAX_BOX_IDS)
    rows, missing = _split(index, ids)
    boxes = [
        {
            "globalId": index.global_ids[r],
            **_box_dict(index.mins[r], index.maxs[r]),
            "centroid": [float(v) for v in index.centroids[r]],
            **({"via": index.via[r]} if index.via[r] else {}),
        }
        for r in rows
    ]
    caveat = None if rows else "None of the requested elements has a body in this model; see missing."
    return computed(
        {"boxes": boxes, "union": _union(index, rows), "missing": missing},
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[index.global_ids[r] for r in rows],
        method=f"element_boxes({len(ids)} ids)",
        caveat=caveat,
    )


def group_boxes(index: ElementIndex, groups: dict[str, list[str]]) -> Answer[dict[str, Any]]:
    """The union box per named group of elements — one call for many candidate issues."""
    if not isinstance(groups, dict):
        raise ProximityLimitError("groups must be an object of key -> list of GlobalIds")
    if len(groups) > MAX_GROUPS:
        raise ProximityLimitError(f"groups has {len(groups)} keys; at most {MAX_GROUPS} are allowed")
    checked = {str(key): _check_count(f"groups[{key}]", ids, MAX_GROUP_IDS) for key, ids in groups.items()}
    out: dict[str, Any] = {}
    used: list[str] = []
    for key, ids in checked.items():
        rows, missing = _split(index, ids)
        used.extend(index.global_ids[r] for r in rows)
        out[key] = {"union": _union(index, rows), "count": len(rows), "missing": missing}
    return computed(
        {"groups": out},
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=list(dict.fromkeys(used)),
        method=f"group_boxes({len(checked)} groups)",
    )


# ── what lies where ─────────────────────────────────────────────────────────


def elements_within(
    index: ElementIndex,
    box: tuple[np.ndarray, np.ndarray],
    ifc_types: list[str] | None = None,
    limit: int = MAX_RESULTS,
    mode: str = "inside",
) -> Answer[dict[str, Any]]:
    """Elements whose box lies wholly inside ``box`` (``inside``) or meets it (``overlaps``).

    ``inside`` allows the tessellation tolerance (5 mm) past each face: the
    sample house's dining chairs reach 0.7 mm below the living room's floor,
    and a chair that stands in a room is in it.
    """
    limit = int(_check_number("limit", limit, 1, MAX_RESULTS))
    if mode not in ("inside", "overlaps"):
        raise ProximityLimitError("mode must be 'inside' or 'overlaps'")
    low, high = np.asarray(box[0], dtype=float), np.asarray(box[1], dtype=float)
    mask = _type_mask(index, ifc_types)
    slack = TESSELLATION_TOLERANCE
    with np.errstate(invalid="ignore"):
        if mode == "inside":
            hit = (index.mins >= low - slack).all(axis=1) & (index.maxs <= high + slack).all(axis=1)
        else:
            hit = (index.mins <= high).all(axis=1) & (index.maxs >= low).all(axis=1)
    rows = np.flatnonzero(mask & hit)
    shown = rows[:limit].tolist()
    return computed(
        {"elements": [_ref(index, r) for r in shown], "total": int(len(rows)), "truncated": len(rows) > limit},
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[index.global_ids[r] for r in shown],
        method=f"elements_within({mode}, {_box_dict(low, high)})",
        caveat="Box test on axis-aligned boxes: an element listed here may still not touch the region.",
    )


def _box_distances(index: ElementIndex, low: np.ndarray, high: np.ndarray) -> np.ndarray:
    """Euclidean gap between the query box and every row's box; 0 where they meet, NaN where no box."""
    gap = np.maximum(index.mins - high, low - index.maxs)
    return np.linalg.norm(np.maximum(gap, 0.0), axis=1)


def elements_near(
    index: ElementIndex,
    *,
    point: np.ndarray | None = None,
    global_id: str | None = None,
    radius: float = 1.0,
    limit: int = MAX_RESULTS,
    ifc_types: list[str] | None = None,
    model: SpatialModel | None = None,
) -> Answer[dict[str, Any]]:
    """Elements within ``radius`` of a point or of an element, nearest first.

    Box distance by default. Given ``model``, the box candidates are narrowed
    on the triangles (``exact``): the distance is then surface to surface, or
    point to surface, and candidates the box admitted but the surfaces do not
    are dropped.
    """
    radius = _check_number("radius", radius, 0.0, MAX_RADIUS)
    limit = int(_check_number("limit", limit, 1, MAX_RESULTS))
    low, high, subject_row = _near_subject(index, point, global_id)
    mask = _type_mask(index, ifc_types)
    if subject_row is not None:
        mask[subject_row] = False
    distances = _box_distances(index, low, high)
    with np.errstate(invalid="ignore"):
        rows = np.flatnonzero(mask & (distances <= radius))
    found = {int(r): float(distances[r]) for r in rows}
    caveat = "Box distances: a lower bound on the distance between the bodies."
    if model is not None:
        found, caveat = _exact_near(model, index, found, point, global_id, radius)
    ordered = sorted(found.items(), key=lambda item: (item[1], index.global_ids[item[0]]))
    shown = ordered[:limit]
    subject = global_id or [float(v) for v in low]
    return computed(
        {
            "elements": [_ref(index, r, distance=d) for r, d in shown],
            "total": len(ordered),
            "truncated": len(ordered) > limit,
            "mode": "exact" if model is not None else "box",
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=([global_id] if global_id else []) + [index.global_ids[r] for r, _ in shown],
        method=f"elements_near({subject}, radius={radius:g}, {'exact' if model is not None else 'box'})",
        caveat=caveat,
    )


def _near_subject(
    index: ElementIndex, point: np.ndarray | None, global_id: str | None
) -> tuple[np.ndarray, np.ndarray, int | None]:
    if (point is None) == (global_id is None):
        raise ProximityLimitError("give exactly one of point or globalId")
    if point is not None:
        p = finite_point(point.tolist() if isinstance(point, np.ndarray) else point, "point")
        return p, p, None
    if not isinstance(global_id, str) or not global_id.strip():
        raise ProximityLimitError("globalId must be a GlobalId string")
    reason = _missing_reason(index, global_id)  # type: ignore[arg-type]
    if reason is not None:
        raise ProximityLimitError(f"{global_id} has no box in this model ({reason})")
    row = index.row(global_id)  # type: ignore[arg-type]
    return index.mins[row], index.maxs[row], row


def _exact_near(
    model: SpatialModel,
    index: ElementIndex,
    found: dict[int, float],
    point: np.ndarray | None,
    global_id: str | None,
    radius: float,
) -> tuple[dict[int, float], str | None]:
    """Replace each box distance by the body distance; drop what the bodies put beyond ``radius``.

    Zero when the point lies inside the body, or one body lies inside the other:
    a surface distance alone would report a sofa as 2 m from the room it stands in.
    """
    subject = None if global_id is None else _triangles(model, global_id)
    if global_id is not None and subject is None:
        return {}, f"{global_id} has no triangles to measure from; no exact distances."
    deadline = time.perf_counter() + EXACT_BUDGET_SECONDS
    out: dict[int, float] = {}
    order = sorted(found, key=lambda r: (found[r], index.global_ids[r]))
    for position, row in enumerate(order):
        tris = _triangles(model, index.global_ids[row])
        if tris is None:
            continue
        distance = _exact_distance(subject, point, tris, deadline)
        if distance is None:
            unmeasured = len(order) - position
            return out, f"Stopped after {EXACT_BUDGET_SECONDS:g} s; {unmeasured} candidates were not measured."
        if distance <= radius:
            out[row] = distance
    return out, None


def _exact_distance(
    subject: np.ndarray | None, point: np.ndarray | None, tris: np.ndarray, deadline: float
) -> float | None:
    """Point-to-body or body-to-body distance, 0 inside; ``None`` once ``deadline`` has passed."""
    remaining = deadline - time.perf_counter()
    if remaining <= 0:
        return None
    if subject is None:
        probe = np.asarray([point], dtype=float)
        if points_inside(probe, tris)[0]:
            return 0.0
        return float(point_distances(probe, tris)[0])
    distance, _, _, _, aborted = _soup_distance(subject, tris, remaining)
    if aborted:
        return None
    if distance > 0 and overlaps_by_containment(subject, tris):
        return 0.0
    return float(distance)


def _triangles(model: SpatialModel, global_id: str) -> np.ndarray | None:
    """The element's usable triangles, or those of its aggregated parts when it has no body of its own."""
    geo = model.geometry(global_id)
    if geo is not None:
        tris = _usable_triangles(geo)
        return tris if len(tris) else None
    if not model.file.by_guid(global_id).is_a("IfcElement"):
        return None
    parts = [_usable_triangles(g) for g in _part_geometries(model, global_id)]
    parts = [t for t in parts if len(t)]
    return np.concatenate(parts) if parts else None


def _part_geometries(model: SpatialModel, global_id: str) -> list[Any]:
    """Bodies of everything aggregated under the element, walked with the index's own bounds."""
    element = model.file.by_guid(global_id)
    out: list[Any] = []
    frontier, seen = [element], {element.id()}
    for _ in range(MAX_PART_DEPTH):
        children = [c for p in frontier for rel in (p.IsDecomposedBy or []) for c in rel.RelatedObjects]
        frontier = [c for c in children if c.id() not in seen and getattr(c, "GlobalId", None)][:MAX_PARTS]
        seen.update(c.id() for c in frontier)
        out.extend(g for g in (model.geometry(c.GlobalId) for c in frontier) if g is not None)
        if not frontier or len(seen) > MAX_PARTS:
            break
    return out


# ── what a room holds ───────────────────────────────────────────────────────


def _declared_contents(model: SpatialModel, space: Any) -> list[Any]:
    out: list[Any] = []
    for rel in getattr(space, "ContainsElements", None) or []:
        out.extend(rel.RelatedElements)
    return out


def _computed_contents(model: SpatialModel, index: ElementIndex, space_id: str) -> list[int] | None:
    """Rows whose centroid lies inside the space's solid; ``None`` when the space has no body.

    Raises :class:`TimeoutError` past :data:`ROOM_BUDGET_SECONDS`.
    """
    tris = _triangles(model, space_id)
    row = index.row(space_id)
    if tris is None or row is None or not index.ok[row]:
        return None
    mask = _type_mask(index, None)
    mask &= np.array([not _is_spatial(index.schema_name, t) for t in index.ifc_types])
    with np.errstate(invalid="ignore"):
        mask &= ((index.centroids >= index.mins[row]) & (index.centroids <= index.maxs[row])).all(axis=1)
    candidates = np.flatnonzero(mask)
    deadline = time.perf_counter() + ROOM_BUDGET_SECONDS
    inside = points_inside(index.centroids[candidates], tris, deadline)
    return candidates[inside].tolist()


def elements_in_room(model: SpatialModel, space_global_id: str) -> Answer[dict[str, Any]]:
    """What a room holds: declared by containment, computed by centroid-in-solid, each tagged.

    The two routes disagree in both directions and both disagreements are
    findings: a sofa declared in the living room that stands in the hall, and
    a lamp standing in the room that the export assigned only to the storey.
    """
    method = f"elements_in_room({space_global_id})"
    space = model.by_id(space_global_id, method)
    if not space.is_a("IfcSpace"):
        raise ProximityLimitError(f"{space_global_id} is an {space.is_a()}, not an IfcSpace")
    index = element_index(model)
    tags: dict[str, set[str]] = {}
    for element in _declared_contents(model, space):
        tags.setdefault(element.GlobalId, set()).add("declared")
    try:
        rows = _computed_contents(model, index, space_global_id)
        timed_out = False
    except TimeoutError:
        rows, timed_out = None, True
    for row in rows or []:
        tags.setdefault(index.global_ids[row], set()).add("computed")
    elements = [_content_ref(model, gid, tags[gid]) for gid in sorted(tags)]
    value = {"elements": elements, "geometryUsed": rows is not None, "truncated": timed_out}
    if rows is None:
        reason = (
            f"The centroid test stopped after {ROOM_BUDGET_SECONDS:g} s"
            if timed_out
            else "The room has no body in this model"
        )
        return declared(
            value,
            from_=[space_global_id, *sorted(tags)],
            method=method,
            caveat=f"{reason}, so only declared containment is listed.",
        )
    return computed(
        value,
        tolerance=TESSELLATION_TOLERANCE,
        unit="m",
        from_=[space_global_id, *sorted(tags)],
        method=method,
        caveat="Each element says how it was found: declared (IfcRelContainedInSpatialStructure), "
        "computed (its centroid lies inside the room's solid) or both.",
    )


def _content_ref(model: SpatialModel, global_id: str, sources: set[str]) -> dict[str, Any]:
    ref = model.ref(model.file.by_guid(global_id)).to_dict()
    ref["provenance"] = "both" if len(sources) == 2 else next(iter(sources))
    return ref


__all__ = [
    "MAX_BOX_IDS",
    "MAX_GROUPS",
    "MAX_GROUP_IDS",
    "MAX_RADIUS",
    "MAX_RESULTS",
    "ProximityLimitError",
    "element_boxes",
    "elements_in_room",
    "elements_near",
    "elements_within",
    "group_boxes",
]
