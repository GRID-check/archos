"""Locating elements: boxes, what lies in a region or near a thing, what a room holds, neighbours, clashes, diffs.

The tools over :mod:`ifc_spatial.operators_proximity`,
:mod:`ifc_spatial.operators_clash` and :mod:`ifc_spatial.operators_diff`. The
first call on a model runs the geometry pass once (about 2 s for a house) to
build its element index; every later box question is answered from that index.

Every limit the operators publish is a refusal here, as a :class:`ToolError`
naming the limit, never a silent clamp.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from functools import partial
from functools import wraps
from typing import Any

from ifc_spatial.tools_session import run
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

from . import operators_clash as clash_ops
from . import operators_diff as diff_ops
from . import operators_proximity as prox
from .element_index import ElementIndex
from .element_index import IndexFormatError
from .element_index import element_index
from .element_index import finite_box
from .element_index import finite_point
from .model import SpatialModel

Resolve = Callable[[Any], SpatialModel]

_MODEL = {"type": "string", "description": "Model handle from open_model."}
_IDS = {"type": "array", "items": {"type": "string"}}
_POINT = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}
_BOX = {
    "type": "object",
    "properties": {"min": _POINT, "max": _POINT},
    "required": ["min", "max"],
    "description": "Axis-aligned box in IFC world coordinates, metres, Z up.",
}
_COORDINATES = "Coordinates are IFC world coordinates in metres, Z up (the BCF frame)."
#: Appended to every description: the one rule of this tool surface is that no
#: tool runs geometry behind the caller's back without saying so.
_COST = (
    "Cost: the first locating call on a model runs the geometry pass once to build its element index (about "
    "2 s for a house; it grows with the model and is not bounded by a budget today — a cold build belongs to "
    "the geometry service, which builds and caches the index ahead of the question). Later box questions are "
    "answered from the index in milliseconds."
)


def _guarded(fn: Callable[[Resolve, dict[str, Any]], Any]) -> Callable[[Resolve, dict[str, Any]], Any]:
    """Limits and malformed input become a :class:`ToolError` the caller can act on."""

    @wraps(fn)
    def wrapper(resolve: Resolve, args: dict[str, Any]) -> Any:
        try:
            return run(lambda: fn(resolve, args))
        except (prox.ProximityLimitError, IndexFormatError, ValueError) as error:
            raise ToolError(str(error)) from None
        except (TypeError, AttributeError) as error:
            # A number where a GlobalId belongs, an object where a list does: the
            # caller sent the wrong shape. Named, never a traceback.
            raise ToolError(f"{fn.__name__}: malformed argument ({error})") from None

    return wrapper


def _types(args: dict[str, Any]) -> list[str] | None:
    raw = args.get("ifcTypes")
    if raw is None:
        return None
    if not isinstance(raw, list) or not all(isinstance(t, str) for t in raw) or len(raw) > 20:
        raise ToolError("ifcTypes must be a list of at most 20 IFC class names")
    return raw


# ── handlers ────────────────────────────────────────────────────────────────


@_guarded
def element_boxes(resolve: Resolve, args: dict[str, Any]) -> Any:
    index = element_index(resolve(args.get("model")))
    return prox.element_boxes(index, args.get("globalIds"))  # type: ignore[arg-type]


@_guarded
def group_boxes(resolve: Resolve, args: dict[str, Any]) -> Any:
    index = element_index(resolve(args.get("model")))
    return prox.group_boxes(index, args.get("groups"))  # type: ignore[arg-type]


@_guarded
def elements_within(resolve: Resolve, args: dict[str, Any]) -> Any:
    index = element_index(resolve(args.get("model")))
    box = finite_box(args.get("box"), "box")
    mode = str(args.get("mode") or "inside")
    return prox.elements_within(index, box, _types(args), args.get("limit", prox.MAX_RESULTS), mode)


@_guarded
def elements_near(resolve: Resolve, args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    point = args.get("point")
    return prox.elements_near(
        element_index(model),
        point=None if point is None else finite_point(point, "point"),
        global_id=args.get("globalId"),
        radius=args.get("radius", 1.0),
        limit=args.get("limit", prox.MAX_RESULTS),
        ifc_types=_types(args),
        model=model if args.get("exact") else None,
    )


@_guarded
def elements_in_room(resolve: Resolve, args: dict[str, Any]) -> Any:
    return prox.elements_in_room(resolve(args.get("model")), str(args.get("spaceGlobalId") or ""))


@_guarded
def neighbours(resolve: Resolve, args: dict[str, Any]) -> Any:
    return clash_ops.neighbours(resolve(args.get("model")), str(args.get("globalId") or ""), args.get("gap", 0.05))


@_guarded
def clash(resolve: Resolve, args: dict[str, Any]) -> Any:
    return clash_ops.clash(
        resolve(args.get("model")),
        args.get("setA"),  # type: ignore[arg-type]
        args.get("setB"),
        str(args.get("mode") or "intersect"),
        args.get("tolerance"),
    )


@_guarded
def box_diff(resolve: Resolve, args: dict[str, Any]) -> Any:
    current = element_index(resolve(args.get("model")))
    has_model, has_index = args.get("baseModel") is not None, args.get("baseIndex") is not None
    if has_model == has_index:
        raise ToolError("give exactly one of baseModel (a handle from open_model) or baseIndex (a stored index)")
    if has_model:
        base = element_index(resolve(args.get("baseModel")))
    else:
        base = ElementIndex.from_dict(args.get("baseIndex"))
    return diff_ops.box_diff(base, current, args.get("globalIds"), args.get("tolerance", diff_ops.DIFF_TOLERANCE))


# ── definitions ─────────────────────────────────────────────────────────────


def _element_boxes_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="element_boxes",
        title="Element bounding boxes",
        description=(
            "Axis-aligned bounding box and centroid of each element, and the union box of all of them. An "
            "element without a body of its own (a curtain wall, a stair, a roof made of slabs) gets the union "
            "of its aggregated parts, marked via: parts. "
            f"At most {prox.MAX_BOX_IDS} GlobalIds. Ids without a body come back under `missing` with the "
            "reason (unknown-global-id, no-representation, empty-mesh, shape-failed, duplicate-global-id) "
            "instead of failing the "
            f"call. {_COORDINATES} A box frames a view or answers 'roughly where'; it is not a clearance."
        ),
        input_schema={
            "type": "object",
            "properties": {"model": _MODEL, "globalIds": {**_IDS, "maxItems": prox.MAX_BOX_IDS}},
            "required": ["model", "globalIds"],
        },
        handler=partial(element_boxes, resolve),
    )


def _group_boxes_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="group_boxes",
        title="Union box per group",
        description=(
            f"The union bounding box per named group of GlobalIds, in one call: e.g. one group per open "
            f"issue, to see which issues sit in the same place. At most {prox.MAX_GROUPS} groups of "
            f"{prox.MAX_GROUP_IDS} ids. Ids without a body are listed per group under `missing`. {_COORDINATES}"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "groups": {
                    "type": "object",
                    "additionalProperties": {**_IDS, "maxItems": prox.MAX_GROUP_IDS},
                    "description": "Group key -> GlobalIds.",
                },
            },
            "required": ["model", "groups"],
        },
        handler=partial(group_boxes, resolve),
    )


def _elements_within_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="elements_within",
        title="Elements in a box",
        description=(
            "Elements whose bounding box lies inside the given box (mode `inside`, 5 mm slack) or meets it "
            f"(mode `overlaps`). Optional `ifcTypes` filter is subtype-aware (IfcWall includes "
            f"IfcWallStandardCase). Openings are left out unless asked for by type. At most {prox.MAX_RESULTS} "
            f"results; `total` and `truncated` say whether there were more. {_COORDINATES} To ask about a "
            "room, prefer elements_in_room, which also reads the declared containment."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "box": _BOX,
                "mode": {"type": "string", "enum": ["inside", "overlaps"], "default": "inside"},
                "ifcTypes": _IDS,
                "limit": {"type": "number", "default": prox.MAX_RESULTS, "maximum": prox.MAX_RESULTS},
            },
            "required": ["model", "box"],
        },
        handler=partial(elements_within, resolve),
    )


def _elements_near_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="elements_near",
        title="Elements near a point or element",
        description=(
            f"Elements within `radius` (at most {prox.MAX_RADIUS:g} m) of a point or of an element, nearest "
            "first, each with its distance. Give exactly one of `point` or `globalId`. By default the distance "
            "is between bounding boxes, a lower bound; `exact: true` measures surface to surface on the "
            f"triangles (slower, budget {prox.EXACT_BUDGET_SECONDS:g} s). At most {prox.MAX_RESULTS} results. "
            f"{_COORDINATES}"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "point": _POINT,
                "globalId": {"type": "string"},
                "radius": {"type": "number", "default": 1.0, "maximum": prox.MAX_RADIUS},
                "exact": {"type": "boolean", "default": False},
                "ifcTypes": _IDS,
                "limit": {"type": "number", "default": prox.MAX_RESULTS, "maximum": prox.MAX_RESULTS},
            },
            "required": ["model"],
        },
        handler=partial(elements_near, resolve),
    )


def _elements_in_room_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="elements_in_room",
        title="What a room holds",
        description=(
            "The elements in one IfcSpace, from two routes, each element tagged with its `provenance`: "
            "`declared` (IfcRelContainedInSpatialStructure names the room), `computed` (its centroid lies "
            "inside the room's solid), or `both`. A `declared` or `computed` alone is a finding: the export "
            "assigns the element to a room it does not stand in, or to no room at all."
        ),
        input_schema={
            "type": "object",
            "properties": {"model": _MODEL, "spaceGlobalId": {"type": "string"}},
            "required": ["model", "spaceGlobalId"],
        },
        handler=partial(elements_in_room, resolve),
    )


def _neighbours_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="neighbours",
        title="Touching and nearby elements",
        description=(
            f"Elements whose surface comes within `gap` (default 0.05 m, at most "
            f"{clash_ops.MAX_NEIGHBOUR_GAP:g} m) of this element's surface, nearest first: `touching` when the "
            "surfaces meet, `near` otherwise, with the measured distance. Bounding boxes pick the candidates, "
            "the triangles decide. A window's neighbours include its host wall and the rooms it opens to."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "globalId": {"type": "string"},
                "gap": {"type": "number", "default": 0.05, "maximum": clash_ops.MAX_NEIGHBOUR_GAP},
            },
            "required": ["model", "globalId"],
        },
        handler=partial(neighbours, resolve),
    )


def _clash_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="clash",
        title="Clash check",
        description=(
            "Pairs between setA and setB (or within setA when setB is omitted) that `intersect` (share volume "
            "deeper than `tolerance`, default 0.005 m), `touch` (also surfaces within `tolerance`) or violate a "
            "`clearance` (every pair closer than `tolerance`, required, at most "
            f"{clash_ops.MAX_CLEARANCE:g} m). Each pair: a, b, kind, distance. Pairs whose contact the "
            "file declares (a window in its wall, an opening in its host, a part in its assembly) are skipped "
            "and counted in skippedDeclared; output is sorted by GlobalId. Leave IfcSpace out of the sets "
            "unless the question "
            f"is about rooms: a room contains its furniture by design. Limits: {clash_ops.MAX_CLASH_SET} ids per "
            f"set, {clash_ops.MAX_CANDIDATE_PAIRS} candidate pairs, {clash_ops.MAX_NARROW_PAIRS} pairs measured, "
            f"{clash_ops.CLASH_BUDGET_SECONDS:g} s; past any of them `truncated` is true and the caveat says how "
            "much was checked."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "setA": {**_IDS, "maxItems": clash_ops.MAX_CLASH_SET},
                "setB": {**_IDS, "maxItems": clash_ops.MAX_CLASH_SET},
                "mode": {"type": "string", "enum": list(clash_ops.CLASH_MODES), "default": "intersect"},
                "tolerance": {"type": "number"},
            },
            "required": ["model", "setA"],
        },
        handler=partial(clash, resolve),
    )


def _box_diff_tool(resolve: Resolve) -> ToolDef:
    return ToolDef(
        name="box_diff",
        title="What moved between revisions",
        description=(
            "Compares this model with an earlier revision, per GlobalId: added, removed, moved (centroid "
            "delta), resized (size delta), unchanged, "
            "no-geometry (one side has no box) or unknown (in neither), within `tolerance` (default "
            "0.005 m). The earlier "
            "revision is `baseModel` (another handle from open_model) or `baseIndex` (a stored element "
            f"index). With `globalIds` (at most {diff_ops.MAX_DIFF_IDS}) every one is listed; without, only "
            "the changes are listed and `counts` covers the whole model. A change of shape inside the same "
            "box is not detected."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": _MODEL,
                "baseModel": {"type": "string"},
                "baseIndex": {"type": "object"},
                "globalIds": {**_IDS, "maxItems": diff_ops.MAX_DIFF_IDS},
                "tolerance": {"type": "number", "default": diff_ops.DIFF_TOLERANCE},
            },
            "required": ["model"],
        },
        handler=partial(box_diff, resolve),
    )


def locate_tools(resolve: Resolve) -> list[ToolDef]:
    """The locating tools, in the order a caller meets them, each stating what its first call costs."""
    tools = [
        _element_boxes_tool(resolve),
        _group_boxes_tool(resolve),
        _elements_within_tool(resolve),
        _elements_near_tool(resolve),
        _elements_in_room_tool(resolve),
        _neighbours_tool(resolve),
        _clash_tool(resolve),
        _box_diff_tool(resolve),
    ]
    return [dataclasses.replace(tool, description=f"{tool.description}\n\n{_COST}") for tool in tools]
