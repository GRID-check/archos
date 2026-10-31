"""Analysis tools: fire, envelope, sun position, the view and drawing, light incidence and the overhang."""

from __future__ import annotations

import base64
import os
import tempfile
import time
from collections.abc import Callable
from functools import partial
from typing import Any

from ifc_spatial.tools_constants import ENVELOPE_ASPECTS
from ifc_spatial.tools_constants import FIRE_ASPECTS
from ifc_spatial.tools_helpers import _jsonable
from ifc_spatial.tools_helpers import _require
from ifc_spatial.tools_helpers import _short
from ifc_spatial.tools_session import run
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

from . import circulation as circ
from . import daylight as dl

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import envelope_geometry as env
from . import fire as fi
from . import operators as op
from .briefing import content_hash
from .model import SpatialModel

# ── the caption ─────────────────────────────────────────────────────────


def _plan_note(drawn: Any) -> str:
    """What the picture actually shows — which is not always a floor plan.

    ``render.plan`` returns ``None`` only when there is neither structure NOR
    a room. A storey that has a room outline and no structural element
    crossing the 1.2 m cut therefore comes back as a page holding one filled
    rectangle, with ``elementsDrawn: 0``. On the sample house that is
    ``view(storey='Roof')``: rooms ``['Roof']``, 0 elements, and a caption
    reading „auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken
    in der Wand" — a sentence about walls, in front of a picture with no
    walls in it. An agent that looks at that concludes the loft is open on
    every side.

    The page is not refused, because a room outline IS information and a
    blank page must stay distinguishable from a broken renderer (the module
    docstring's rule). What changes is that the caption stops describing a
    drawing that is not there.
    """
    head = f"Grundriss „{drawn.storey}“, waagrechter Schnitt {drawn.cut_z:.2f} m über Null"
    tail = "Maße NICHT aus dem Bild ablesen; dafür measure/distance."
    if drawn.drawn == 0:
        return (
            f"{head}. ACHTUNG: auf dieser Schnitthöhe wurde KEIN Bauteil gezeichnet "
            "(elementsDrawn = 0) — kein Bauteil dieses Geschoßes schneidet die Ebene. Im Bild "
            "stehen nur die Raumumrisse; das Fehlen von Wänden, Türen und Fenstern im Bild ist "
            f"keine Aussage über das Gebäude. {tail}"
        )
    return f"{head} — auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken in der Wand. {tail}"


# ── fire (OIB 2) ────────────────────────────────────────────────────────


def fire_op(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """The four OIB-2 operators behind one name.

    Grouped rather than given a tool each because they share a subject —
    the building as a fire problem — and four tools whose only difference
    is a name make a model choose a word instead of a question.
    """
    model = resolve(args.get("model"))
    # Matched case-insensitively against the real keys rather than
    # lowercased into them: `_lower` turned "compartmentArea" into
    # "compartmentarea", which matched nothing and refused a correct call.
    wanted = str(args.get("what") or "escape_level").strip().lower()
    # The German aspect token, accepted for one release. Remove after.
    wanted = "escape_level" if wanted == "fluchtniveau" else wanted
    what = next((k for k in FIRE_ASPECTS if k.lower() == wanted), wanted)
    ids = [part.strip() for part in str(args.get("globalId") or "").split(",") if part.strip()]
    if what == "escape_level":
        return run(lambda: fi.escape_level(model))
    if what == "compartmentArea":
        if not ids:
            raise ToolError(
                "compartmentArea braucht globalId: ein Geschoß oder die Räume des Abschnitts, "
                "mehrere durch Komma getrennt. GlobalIds liefert find_elements."
            )
        return run(lambda: fi.compartment_area(model, ids))
    if what == "separatingElements":
        if len(ids) != 2:
            raise ToolError(
                "separatingElements braucht ZWEI Räume in globalId, durch Komma getrennt — "
                "gefragt ist, was zwischen ihnen liegt."
            )
        return run(lambda: fi.separating_elements(model, ids[0], ids[1]))
    if what == "siteBoundary":
        return run(lambda: fi.distance_to_site_boundary(model, ids[0] if ids else None))
    if what == "doorGraph":
        # No `globalId`, like `escape_level`: the graph IS the building. It
        # was reachable from nothing while `egressPath` and `reachableFrom`
        # — both of which are views ONTO it — were on the surface, so an
        # agent could get a route and never the two lists that say how many
        # doors the route-finder could not read. A route out of a graph with
        # four unresolved doors is not wrong, it is unfounded, and the
        # difference was invisible from here.
        return run(lambda: circ.door_graph(model))
    raise ToolError(f'what "{what}" gibt es nicht. Erlaubt: {", ".join(FIRE_ASPECTS)}')


# ── envelope (OIB 6) ────────────────────────────────────────────────────


def envelope_op(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """The three OIB-6 operators behind one name.

    These existed, were tested, and were on NO tool surface — so an agent
    asked a Kompaktheit or Hüllfläche question reached nothing and said the
    export could not answer it, while the operator sat in the package with
    30 passing tests. A capability nobody can call is indistinguishable from
    a missing one, and the second is what the user was told.

    No `globalId`: all three take the whole model. `measure` is the tool for
    a named element; this one is for a set that has to be DERIVED before it
    can be measured, and the derivation is most of the answer.
    """
    model = resolve(args.get("model"))
    # Matched case-insensitively against the real keys rather than
    # lowercased into them — the same trap `fire_op` documents: lowercasing
    # turns "areaByOrientation" into "areabyorientation", which matches no
    # key and refuses a correct call.
    wanted = str(args.get("what") or "thermalEnvelope").strip().lower()
    what = next((k for k in ENVELOPE_ASPECTS if k.lower() == wanted), wanted)
    if what == "thermalEnvelope":
        return run(lambda: env.thermal_envelope(model))
    if what == "areaByOrientation":
        return run(lambda: env.envelope_area_by_orientation(model))
    if what == "compactness":
        return run(lambda: env.compactness(model))
    raise ToolError(f'what "{what}" gibt es nicht. Erlaubt: {", ".join(ENVELOPE_ASPECTS)}')


# ── view ────────────────────────────────────────────────────────────────


def view(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """A plan as base64 PNG, for a transport that can show it to the model.

    The bytes come back here rather than going to a file, which is the
    opposite of `draw`'s rule — and deliberately. `draw` writes a file
    because a few hundred kilobytes of SVG path data in a context window
    buys nothing: the agent cannot read path data. A raster is the reverse
    case; it is the only form the agent CAN read, and a path to it is worth
    exactly nothing to a model that has no eyes on the filesystem.

    The caller decides what to do with the base64 — an MCP client wraps it
    as an image content block, an HTTP host may hand back a URL instead.
    This layer does not know which, so it returns the bytes and the facts.
    """
    from . import render as rendering

    model = resolve(args.get("model"))
    started = time.perf_counter()
    drawn = rendering.plan(
        model,
        storey=(str(args["storey"]).strip() if args.get("storey") else None),
        highlight=[str(v) for v in (args.get("highlight") or [])],
        only=[str(v) for v in (args.get("only") or [])],
    )
    seconds = time.perf_counter() - started
    if drawn is None:
        # Not an empty picture. A blank page and a broken renderer are
        # indistinguishable to a reader, so the two must not share a result.
        raise ToolError(
            "Für dieses Geschoß gibt es nichts zu zeichnen — kein Bauteil dieses Geschoßes trägt "
            "Geometrie, oder der Geschoßname trifft nichts. Geschoßnamen stehen im Briefing."
        )

    return {
        "pngBase64": base64.b64encode(drawn.png).decode("ascii"),
        "mediaType": "image/png",
        "width": drawn.width,
        "height": drawn.height,
        "storey": drawn.storey,
        "cutHeight": round(drawn.cut_z, 3),
        "rooms": drawn.rooms,
        "highlighted": drawn.highlighted,
        "elementsDrawn": drawn.drawn,
        "northDeclared": drawn.north_deg is not None,
        "seconds": round(seconds, 2),
        "note": _plan_note(drawn),
    }


# ── draw ────────────────────────────────────────────────────────────────


def draw(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    import ifcopenshell.draw as drawing

    model = resolve(args.get("model"))
    settings = drawing.draw_settings(
        # A landscape sheet, because a floor plan of a building that is
        # wider than it is deep — which is most of them — otherwise arrives
        # scaled down to fit a portrait page it never needed.
        width=float(args.get("widthMm") or 420.0),
        height=float(args.get("heightMm") or 297.0),
        # No hidden-line projection. It is what makes `draw` slow and it
        # produces an elevation-like overlay that reads as clutter in a
        # plan; the cells and the poché are the drawing.
        include_projection=False,
        space_names=True,
    )
    if args.get("storey"):
        settings.storey_filter = str(args["storey"])
    if args.get("include"):
        settings.include_entities = ",".join(str(v) for v in args["include"])

    started = time.perf_counter()
    data = drawing.main(settings, [model.file])
    seconds = time.perf_counter() - started

    # The SVG goes to a file rather than into the reply. A whole-building
    # plan is a few hundred kilobytes of path data — putting that in an
    # agent's context would evict the conversation to deliver something the
    # agent cannot read anyway. The host shows the file; the agent gets the
    # facts about the drawing.
    directory = tempfile.mkdtemp(prefix="ifc-spatial-")
    path = os.path.join(directory, f"plan-{_short(content_hash(model))}.svg")
    with open(path, "wb") as handle:
        handle.write(data)

    return {
        "path": path,
        "bytes": len(data),
        "seconds": round(seconds, 2),
        "note": (
            "Die Zeichnung liegt als Datei vor und kann dem Nutzer gezeigt werden. "
            "Maße nicht aus dem Bild ablesen — dafür measure/distance verwenden."
        ),
    }


# ── sun_position ────────────────────────────────────────────────────────


def sun_position(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """Where the sun stood — from the FILE's georeference and nowhere else.

    The operator accepts ``latitude``/``longitude`` to override the model,
    and this tool deliberately does not forward them. On a library call an
    override is a surveyor handing over a better coordinate; on a tool
    surface it is a field an agent can fill, and an agent that CAN supply a
    latitude will supply one — which is exactly the substitution the
    operator refuses to make on its own. An assumed 48°N Vienna on a
    Vorarlberg project is 1.4° out in solar altitude and comes back as a
    `computed` number with a tolerance, indistinguishable from a measured
    one. A host that really has a survey coordinate calls the operator.

    ``when`` gets its own check rather than ``_require``: that helper's
    refusal names a GlobalId and find_elements, which for a timestamp sends
    the caller looking in the model for something that is not in it.
    """
    model = resolve(args.get("model"))
    when = args.get("when")
    if not isinstance(when, str) or not when.strip():
        raise ToolError(
            "when fehlt — den Zeitpunkt nach ISO 8601 MIT Zeitzone angeben, "
            "z. B. 2026-06-21T12:00:00+02:00 (Sommerzeit) oder 2026-06-21T10:00:00Z."
        )
    return run(lambda: dl.sun_position(model, when.strip()))


def _fire_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="fire",
        title="Fire safety geometry (OIB 2)",
        description=(
            "The geometric quantities OIB 2 comes down to:\n"
            + "\n".join(f"  {k} — {v}" for k, v in FIRE_ASPECTS.items())
            + "\n\nNO building class. escape_level returns a HEIGHT; which class follows from it is a legal "
            "classification under OIB 2 and state law. A tool that returns GK5 has applied a rule it never "
            "read."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "what": {"type": "string", "enum": list(FIRE_ASPECTS)},
                "globalId": {
                    "type": "string",
                    "description": "Depending on what: storey/rooms (comma-separated), two rooms, or empty",
                },
            },
            "required": ["model", "what"],
        },
        handler=partial(fire_op, resolve),
    )


def _envelope_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="envelope",
        title="Thermal building envelope (OIB 6)",
        description=(
            "The geometric quantities an OIB 6 calculation needs as input:\n"
            + "\n".join(f"  {k} — {v}" for k, v in ENVELOPE_ASPECTS.items())
            + "\n\nNO U-value is calculated. A declared U-value is passed on; an undeclared one is MISSING "
            "and is NOT derived from the layers — a U-value calculated from a material list is a different "
            "number from the one the architect signed, and looks exactly the same.\n\n"
            "NO limit and no 'compliant': which U-value or which A/V is permissible is in OIB 6 and the "
            "energy certificate procedure, not in the geometry.\n\n"
            "Costs geometry (seconds, not milliseconds): all three build the bodies of the envelope elements."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "what": {"type": "string", "enum": list(ENVELOPE_ASPECTS)},
            },
            "required": ["model", "what"],
        },
        handler=partial(envelope_op, resolve),
    )


def _view_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="view",
        title="Look at the floor plan",
        description=(
            "Renders a storey as a PNG and returns it so that the model can ACTUALLY SEE it — unlike draw, "
            "which writes an SVG file and only names the path.\n\n"
            "Meant for orientation before measuring: which element is meant, how the rooms are arranged, "
            "whether the window really sits in the wall hostedIn names. `highlight` marks single elements red "
            "in the whole plan (where is it?), `only` hides everything else (what does it look like?). "
            "GlobalIds come from find_elements or relations.\n\n"
            "ONE rule: numbers never come from the image. A dimension read off it is a guess, even when it "
            "happens to be right — use measure and distance for that."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "storey": {
                    "type": "string",
                    "description": "Storey name, verbatim from the briefing; the lowest when omitted",
                },
                "highlight": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "GlobalIds marked in red — the rest stays visible",
                },
                "only": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "GlobalIds the drawing is restricted to",
                },
            },
            "required": ["model"],
        },
        handler=partial(view, resolve),
    )


def _draw_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="draw",
        title="Draw the building",
        description=(
            "Draws a floor plan as SVG — wall poché, room cells with names, openings as gaps, from the same "
            "model the measurements come from. Use it whenever looking helps: to understand how something is "
            "arranged, to settle which element is meant, or to check whether a number can be plausible at "
            "all.\n\n"
            "ONE rule: numbers never come from the image. measure/distance give dimensions; the image shows "
            "the arrangement. A value read off a drawing is a guess, even when it is right.\n\n"
            "DURATION: about 5 seconds for a single-family house, more for a large model — plan for it before "
            "the call. The SVG is written to a file and the path is returned, not the content: a floor plan is "
            "hundreds of kilobytes of path data that are of no use in the context."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "storey": {
                    "type": "string",
                    "description": "Storey name, verbatim from the briefing; all storeys when omitted",
                },
                "include": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "IFC types to restrict to (e.g. IfcWall)",
                },
                "widthMm": {"type": "number", "default": 420},
                "heightMm": {"type": "number", "default": 297},
            },
            "required": ["model"],
        },
        handler=partial(draw, resolve),
    )


def _overhang_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="overhang",
        title="Overhang past a facade plane",
        description=(
            "How far one element projects past the facade plane of another, perpendicular to that plane, in "
            "metres. The number for a roof overhang, a balcony or a canopy.\n\n"
            "projecting: the projecting element (roof, balcony). facade: the element whose outer face is the "
            "reference plane — usually the wall below, which relations hostedIn returns for a window.\n\n"
            "Measured (`computed`) with a tolerance. Never report it as a value the model declares."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "projecting": {"type": "string", "description": "GlobalId of the projecting element"},
                "facade": {"type": "string", "description": "GlobalId of the element whose facade plane applies"},
            },
            "required": ["model", "projecting", "facade"],
        },
        handler=lambda args: _jsonable(
            op.overhang(resolve(args.get("model")), _require(args, "projecting"), _require(args, "facade"))
        ),
    )


def _light_incidence_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="light_incidence",
        title="Unobstructed light onto an opening",
        description=(
            "Builds the light prism above the lower edge of an opening and reports which elements reach into "
            "it and how deep. Answers 'is the light incidence unobstructed' GEOMETRICALLY.\n\n"
            "angle and swivel are PARAMETERS FROM THE PROVISION, not from the model. For OIB 3 they are 45 and "
            "30 degrees — they must still be passed, because this tool knows no rulebook and is not meant to.\n\n"
            "IMPORTANT: the result is not an assessment. Under OIB 3 an intersected prism INCREASES the required "
            "light entry area — it does not forbid the window. Turning 'blocked' into 'not compliant' skips the "
            "provision instead of applying it. Report what reaches in and how deep, then apply the clause.\n\n"
            "exclude: GlobalIds that do not count as obstruction — the window's own wall usually belongs here.\n"
            "Needs geometry: a few seconds on the first call on a model."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {"type": "string", "description": "GlobalId of the opening or its filling"},
                "angle": {"type": "number", "description": "Light incidence angle in degrees, from the provision"},
                "swivel": {"type": "number", "default": 0, "description": "Lateral swivel in degrees"},
                "exclude": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "GlobalIds that do not count as obstruction",
                },
            },
            "required": ["model", "globalId", "angle"],
        },
        handler=lambda args: _light_incidence(resolve(args.get("model")), args),
    )


def _sun_position_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="sun_position",
        title="Sun position over this building",
        description=(
            "Azimuth (degrees clockwise from north) and altitude of the sun at a point in time, plus the "
            "direction TO the sun in the coordinates of THIS model — the input to any shading study, and the "
            "number a sunlight question starts from.\n\n"
            "NOT a sunlight study. A sun position says the sun stood 61.9° high and 178.9° round; it does NOT "
            "say whether the neighbour's gable stood in front of it, whether the balcony above cut the ray or "
            "how many hours of sun the window got over the day. Those are shading questions, and they also "
            "need everything beyond the site boundary — which is not in this file. The caveat says so in every "
            "answer.\n\n"
            "Not decidable without IfcSite.RefLatitude/RefLongitude, and NO latitude is assumed: an assumed "
            "Vienna on a Vorarlberg project is 1.4° off in altitude, an assumed north on a building rotated by "
            "40° is 40° off — both would come back as a measured number with a tolerance. For the same reason "
            "this tool accepts no coordinates either.\n\n"
            "when MUST carry a time zone. Reading 2026-06-21T12:00:00 without a zone as UTC moves the sun in "
            "Austria by 30° — two hours of shade, from an input that looked complete.\n\n"
            "Accuracy 0.01° (Michalsky 1988) for 1950–2050, 0.1° outside; the tolerance is in the answer. No "
            "geometry, milliseconds."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "when": {
                    "type": "string",
                    "description": (
                        "Point in time in ISO 8601 WITH a time zone, e.g. 2026-06-21T12:00:00+02:00 "
                        "or 2026-06-21T10:00:00Z"
                    ),
                },
            },
            "required": ["model", "when"],
        },
        handler=partial(sun_position, resolve),
    )


def _light_incidence(model: SpatialModel, args: dict[str, Any]) -> Any:
    """The prism and what intrudes into it, in one call.

    Composed here rather than left to the caller because the halves are not
    independently useful: a prism nobody tested against the building answers
    nothing, and ``obstructions`` needs a volume the caller cannot build without
    this module's facade-plane resolution. One call also keeps the seconds of
    geometry work behind a single deliberate request rather than two.

    What it does not do is decide. The angles arrive from the clause and the
    intrusion depths go back to it; the verdict belongs to the rulebook, and the
    description says so where the model will read it.
    """
    opening = _require(args, "globalId")

    angle = args.get("angle")
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not 0 < float(angle) < 90:
        raise ToolError("angle muss ein Winkel zwischen 0 und 90 Grad sein — der Wert kommt aus der Bestimmung")
    swivel = args.get("swivel") or 0
    if isinstance(swivel, bool) or not isinstance(swivel, (int, float)) or not 0 <= float(swivel) < 90:
        raise ToolError("swivel muss zwischen 0 und 90 Grad liegen")

    built = op.prism(model, opening, float(angle), float(swivel))
    if not built.decidable or built.value is None:
        return _jsonable(built)

    exclude = [e for e in (args.get("exclude") or []) if isinstance(e, str)]
    found = op.obstructions(model, built.value, exclude=exclude or None)
    payload = _jsonable(found)
    if isinstance(payload, dict):
        blocking = found.value or []
        payload["free"] = bool(found.decidable and not blocking)
        payload["prism"] = {"angleDeg": float(angle), "swivelDeg": float(swivel), "openingId": opening}
        note = (
            "Diese Antwort ist Geometrie, kein Befund: ein geschnittenes Prisma vergrößert nach OIB 3 "
            "die erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Die Bewertung "
            "gehört zum Regelwerk."
        )
        # `obstructions` already carries this warning, in its own words. Appending
        # unconditionally printed it twice, and a caveat repeated is a caveat
        # skimmed — the second copy teaches the reader that this paragraph is
        # boilerplate, which is the opposite of what it is for.
        existing = payload.get("caveat") or ""
        if "kein Befund" not in existing:
            payload["caveat"] = f"{existing} {note}".strip() if existing else note
    return payload
