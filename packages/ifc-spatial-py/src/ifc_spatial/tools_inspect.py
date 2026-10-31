"""Inspecting elements: finding them, one element's profile, its relations, the room inventory and the shopping list."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any

from ifc_spatial.tools_constants import _PROFILE_DROPS
from ifc_spatial.tools_constants import GEOMETRIC_RELATIONS
from ifc_spatial.tools_constants import KINDS
from ifc_spatial.tools_constants import MEASURE_EXPENSIVE
from ifc_spatial.tools_constants import MEASURE_FN
from ifc_spatial.tools_constants import MEASURE_SUBJECT
from ifc_spatial.tools_constants import MEASURES
from ifc_spatial.tools_constants import RELATION_FN
from ifc_spatial.tools_constants import RELATIONS
from ifc_spatial.tools_helpers import _clamp
from ifc_spatial.tools_helpers import _jsonable
from ifc_spatial.tools_helpers import _lower
from ifc_spatial.tools_helpers import _require
from ifc_spatial.tools_helpers import _select
from ifc_spatial.tools_measure import _compact
from ifc_spatial.tools_session import run
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import operators as op
from .briefing import KIND_LABEL
from .briefing import LEGACY_ROOM_USE_KINDS
from .briefing import inventory
from .model import SpatialModel
from .model import WrongKindError


def find_elements(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    limit = _clamp(args.get("limit", 50), 1, 500)
    matches, total = _select(model, args, limit)

    out: dict[str, Any] = {
        "elements": [model.ref(e).to_dict() for e in matches],
        "total": total,
        # Stated rather than implied: a page presented as a total is the
        # failure this whole library is built to avoid.
        "truncated": total > len(matches),
    }
    if total == 0:
        out["hint"] = (
            'Keine Treffer. Vor der Schlussfolgerung „gibt es nicht" das Briefing prüfen: '
            "Geschoßnamen und Typen stammen aus diesem Export."
        )
    return out


# ── element ─────────────────────────────────────────────────────────────


def element(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    global_id = str(args.get("globalId") or "")
    try:
        subject = model.file.by_guid(global_id)
    except RuntimeError, KeyError:
        raise ToolError(
            f"Bauteil {global_id} ist in diesem Modell nicht enthalten — GlobalId mit find_elements prüfen"
        ) from None

    storey = model.storey_of(subject)
    container = run(lambda: op.container_of(model, global_id))
    # Only the relations that are attribute reads are probed. The four in
    # GEOMETRIC_RELATIONS fall back to a contact map that costs seconds, and
    # building a menu is not worth that; they are listed separately as
    # "askable" instead of as "available", which is the honest distinction.
    available = []
    for name, fn in RELATION_FN.items():
        if name in GEOMETRIC_RELATIONS:
            continue
        try:
            answer = fn(model, global_id)
        except WrongKindError:
            # The ONE place a wrong kind is a question rather than a
            # mistake: this loop asks every relation whether it applies to
            # this element, and `hosts` on an IfcSpace answering "no" is the
            # menu working. Everywhere else the same refusal is the caller's
            # error and must reach them — so it is caught here by hand and
            # nowhere else, rather than softened at the source.
            continue
        if not answer.decidable:
            continue
        value = answer.value
        present = len(value) > 0 if isinstance(value, list) else value is not None
        if present:
            available.append(name)

    return {
        "element": model.ref(subject).to_dict(),
        "storey": getattr(storey, "Name", None),
        "elevation": next(
            (s.elevation for s in model.storeys if storey is not None and s.global_id == storey.GlobalId),
            None,
        ),
        "predefinedType": getattr(subject, "PredefinedType", None),
        "container": _jsonable(container.value),
        "available": available,
        "note": (
            "bounds, enclosedBy, opensTo und adjacentSpaces stehen nicht in dieser Liste: sie sind in "
            "einem Export ohne IfcRelSpaceBoundary nur aus der Geometrie ableitbar und kosten einmalig "
            "einige Sekunden. Über relations sind sie normal abrufbar."
        ),
    }


# ── relations / measure / distance ──────────────────────────────────────


def relations(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    name = str(args.get("relation") or "")
    fn = RELATION_FN.get(name)
    if fn is None:
        raise ToolError(f'relation "{name}" gibt es nicht. Erlaubt: {", ".join(RELATIONS)}')
    return run(lambda: fn(model, str(args.get("globalId") or "")))


def _profile_measures(model: SpatialModel, global_id: str, applicable: list[str]) -> dict[str, Any]:
    measures: dict[str, Any] = {}
    for name in applicable:
        fn = MEASURE_FN[name]
        try:
            answer = _jsonable(run(lambda fn=fn: fn(model, global_id)))
        except Exception as exc:  # noqa: BLE001
            # One measure that throws must not cost the caller the other
            # fifteen. The failure is reported in place, as a failure, and
            # the profile still comes back — the alternative is a dead call
            # and another turn spent finding out which kind was to blame.
            measures[name] = {"decidable": False, "error": f"{type(exc).__name__}: {exc}"}
            continue
        if isinstance(answer, dict):
            answer = {key: _compact(val) for key, val in answer.items() if key not in _PROFILE_DROPS}
        measures[name] = answer
    return measures


def element_profile(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """Every measure that applies to ONE element — the inverse of `survey`.

    `survey` is one measure over many elements; this is many measures over
    one. Both exist for the same reason: the expensive thing is not the
    measurement, it is the turn. „Erzähl mir alles über diesen Raum" is a
    normal opening move for a reviewer who has just been pointed at an
    outlier, and composed from primitives it costs one `measure` call per
    kind — twenty turns for a question that has one answer.

    Which measures apply is read from `MEASURE_SUBJECT`, so a door is not
    asked for its lichte Raumhöhe and a room is not asked for its
    Schwellenhöhe. The refusals that would produce are not useful output;
    they are noise that pushes the real numbers out of the context window.
    """
    model = resolve(args.get("model"))
    global_id = _require(args, "globalId")
    try:
        subject = model.file.by_guid(global_id)
    except RuntimeError, KeyError:
        raise ToolError(
            f"GlobalId {global_id} steht nicht in diesem Modell. "
            "Mit find_elements suchen — GlobalIds sind exakt 22 Zeichen und gelten je Datei."
        ) from None

    ifc_type = subject.is_a()
    applicable = [
        name
        for name in MEASURES
        if not MEASURE_SUBJECT.get(name, ())
        or any(subject.is_a(subject_type) for subject_type in MEASURE_SUBJECT[name])
    ]
    if not _lower(args.get("include")) == "expensive":
        applicable = [name for name in applicable if name not in MEASURE_EXPENSIVE]

    measures = _profile_measures(model, global_id, applicable)

    skipped = [name for name in MEASURES if name not in applicable]
    out: dict[str, Any] = {
        "element": model.ref(subject).to_dict(),
        "storey": getattr(model.storey_of(subject), "Name", None),
        "measures": measures,
    }
    if skipped:
        out["notMeasured"] = {
            "kinds": skipped,
            "why": (
                f"Diese Kennwerte sind nicht über ein {ifc_type} definiert (oder sind teuer und "
                'wurden übersprungen — dann include="expensive" setzen). Kein Befund über das '
                "Bauteil, sondern über die Frage."
            ),
        }
    return out


# ── ids ─────────────────────────────────────────────────────────────────


def shopping_list(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """The model's blind spots as a buildingSMART IDS file.

    The one output of this package that leaves the conversation and keeps
    working. Everything else is a sentence an architect reads once; this is
    a file they run in their own checker, on their own schedule, and re-run
    after the fix to prove it landed.
    """
    # Imported HERE, not at module scope. `ids_export` needs `ifctester`,
    # which ships with IfcOpenShell as a separate distribution and is not
    # guaranteed present — and a module-level import made a missing optional
    # dependency take down the ENTIRE tool surface, so a deployment without
    # it could not measure a wall either. One tool degrading is a fact about
    # one capability; eleven tools vanishing is an outage.
    try:
        from . import ids_export as ids
    except ImportError as error:
        raise ToolError(
            "Die IDS-Ausgabe steht in dieser Installation nicht zur Verfügung (ifctester fehlt). "
            "Die fehlenden Angaben stehen weiterhin im Briefing unter FEHLT und BLIND und können "
            "dort berichtet werden."
        ) from error

    model = resolve(args.get("model"))
    document = ids.blind_spots_as_ids(
        model,
        title=(str(args["title"]).strip() if args.get("title") else None),
        author=(str(args["author"]).strip() if args.get("author") else None),
    )
    written = ids.write_ids(document)
    return {**written, "summary": document.summary()}


# ── room_inventory ──────────────────────────────────────────────────────


def room_inventory(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """``kind`` is validated here, exactly like ``relation`` and ``measure``.

    It used to go straight through as ``str(args.get("kind") or "")``, and
    ``briefing.inventory`` indexed ``KIND_LABEL`` with it — so an omitted or
    misspelt kind came back as ``KeyError: ''`` from ``briefing.py:799``. A
    Python traceback is not a refusal: the caller cannot read it, cannot act
    on it, and an MCP client sees a crash where every other enum in this file
    produces a German sentence naming the allowed values. The agent-runtime tool layer
    happened to validate ``kind`` before this was reached, but this module is
    documented as transport-free and ``mcp_server`` hands arguments here
    unfiltered.
    """
    model = resolve(args.get("model"))
    kind = str(args.get("kind") or "").strip()
    kind = LEGACY_ROOM_USE_KINDS.get(kind, kind)
    if kind not in KIND_LABEL:
        raise ToolError(
            f'kind "{kind}" gibt es nicht. Erlaubt: {", ".join(KIND_LABEL)}'
            if kind
            else f"kind fehlt. Erlaubt: {', '.join(KIND_LABEL)}"
        )
    return inventory(model, kind)  # type: ignore[arg-type]


def _find_elements_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="find_elements",
        title="Find elements",
        description=(
            "Finds elements by IFC type, part of the name, storey or kind and returns their GlobalIds — the "
            "input to every other tool here. Copy storey names verbatim from the briefing."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "ifcType": {"type": "string", "description": "e.g. IfcWall, IfcWindow, IfcSpace"},
                "nameContains": {"type": "string"},
                "storey": {"type": "string", "description": "Storey name, verbatim from the briefing"},
                "kind": {"type": "string", "enum": KINDS},
                "limit": {"type": "number", "default": 50},
            },
            "required": ["model"],
        },
        handler=partial(find_elements, resolve),
    )


def _element_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="element",
        title="One element",
        description=(
            "Everything about ONE element: type, name, storey, container — and which relations it has at "
            "all. Costs no geometry."
        ),
        input_schema={
            "type": "object",
            "properties": {"model": {"type": "string"}, "globalId": {"type": "string"}},
            "required": ["model", "globalId"],
        },
        handler=partial(element, resolve),
    )


def _relations_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="relations",
        title="Spatial relations",
        description=(
            "The topological operators. Every answer says WHERE it comes from: `declared` is written so in "
            "the file, `computed` we derived from other relations or from the geometry. An empty result "
            "means 'this element has no such relation'; `decidable: false` means 'this export does not write "
            "this relation at all' — a finding about the export, not about the building, and `missing` says "
            "what fixes it.\n\n"
            + "\n".join(f"  {name} — {meaning}" for name, meaning in RELATIONS.items())
            + "\n\nbounds, enclosedBy, opensTo and adjacentSpaces fall back to the geometry when the file "
            "writes no IfcRelSpaceBoundary (the usual case). The first such call builds a contact map over "
            "all rooms — a few seconds, instant afterwards."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {"type": "string"},
                "relation": {"type": "string", "enum": list(RELATIONS)},
            },
            "required": ["model", "globalId", "relation"],
        },
        handler=partial(relations, resolve),
    )


def _element_profile_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="element_profile",
        title="Everything measurable on one element",
        description=(
            "Measures ALL quantities defined for this one element in one call — which ones follows from its "
            "IFC type. The call to make once an element has become interesting: the outlier from a survey, "
            "the room in the question, the door at issue. Instead of twenty `measure` calls with guessed "
            "quantities.\n\n"
            "Expensive quantities (egress path, reachability, turning circle, door approach) run only with "
            'include="expensive"; they need the door graph or a raster over the model. What was NOT '
            "measured is in the answer with the reason — a statement about the question, not about the "
            "building."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {"type": "string"},
                "include": {
                    "type": "string",
                    "enum": ["expensive"],
                    "description": "Also measure the expensive quantities (seconds instead of milliseconds).",
                },
            },
            "required": ["model", "globalId"],
        },
        handler=partial(element_profile, resolve),
    )


def _shopping_list_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="shopping_list",
        title="Missing data as an IDS file",
        description=(
            "Writes this model's blind spots as a buildingSMART IDS file (version 1.0) — what the export does "
            "NOT provide, in a format the architect can run against her own model in Solibri, BIMcollab or "
            "ifctester. Running it again after the fix proves the addition arrived.\n\n"
            "The file only requires THAT a property is present and evaluable, never WHICH VALUE it must have: "
            "limits are in the OIB guideline, and writing an invented limit into an architect's checking tool "
            "would be the worst mistake this tool could make.\n\n"
            "Not every blind spot can be expressed as IDS — missing IfcRelSpaceBoundary cannot. What cannot "
            "be expressed is reported and NOT silently dropped; the summary gives both counts."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "title": {"type": "string", "description": "Title of the IDS file"},
                "author": {"type": "string", "description": "E-mail or name for the IDS header"},
            },
            "required": ["model"],
        },
        handler=partial(shopping_list, resolve),
    )


def _room_inventory_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="room_inventory",
        title="Rooms by presumed use",
        description=(
            "Assigns rooms by name to a presumed use (habitable room, ancillary room, circulation). The result "
            "is explicitly `inferred`: whether a room is habitable is a legal classification, not a geometric "
            "one. Treat it as a proposal to confirm, never as a finding."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "kind": {
                    "type": "string",
                    "enum": ["habitable_room", "ancillary_room", "circulation"],
                },
            },
            "required": ["model", "kind"],
        },
        handler=partial(room_inventory, resolve),
    )
