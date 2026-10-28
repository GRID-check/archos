"""Clear approach: the space in front of a door, and how much of it the swing and furnishings leave."""

from __future__ import annotations

import math
from typing import Any

from ifc_spatial.accessibility_constants import _NOT_A_VERDICT
from ifc_spatial.accessibility_constants import INSCRIBED_STEPS
from ifc_spatial.accessibility_constants import MIN_OBSTACLE_AREA
from ifc_spatial.accessibility_constants import OUTSIDE_PROBE
from ifc_spatial.accessibility_floor import _frame_of
from ifc_spatial.accessibility_floor import _free_floor
from ifc_spatial.accessibility_floor import _no_plane
from ifc_spatial.accessibility_floor import _plan_silhouette
from ifc_spatial.accessibility_floor import _spaces_by_side
from ifc_spatial.accessibility_records import _Frame
from ifc_spatial.accessibility_records import _FreeFloor

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE
from .operators import FENESTRATION
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind

# ════════════════════════════════════════════════════════════════════════════
# 4 — clear approach
# ════════════════════════════════════════════════════════════════════════════


def clear_approach(model: SpatialModel, door_global_id: str) -> Answer[dict[str, Any]]:
    """The free floor in front of a door, on each side, and what ends it.

    A wheelchair user pulling a door open needs room to stand beside it, and
    ``clearOpeningWidth`` cannot see that: it measures the hole. This measures
    the floor. A strip as wide as the clear opening is pushed perpendicularly
    away from the door face into the room and the depth is the furthest it goes
    while staying entirely inside the free floor — the same free-floor polygon
    :func:`turning_circle` uses, so what counts as an obstacle is defined in one
    place and one way.

    Both sides are reported. A side with no ``IfcSpace`` — the outside of an
    external door — gets a null depth and a reason rather than a zero, because
    zero is a number an agent will put in a sentence.

    ``depth`` counts fixed obstruction only and ``withFurnishing`` repeats it
    with the loose furniture in, for the reason argued in :func:`_free_floor`.
    On this fixture the internal door `…VyWax` has 4.390 m into the bedroom and
    9.238 m into the living room with the rooms empty, and 2.383 m and 3.446 m
    once the bed and a chair are counted — the difference between a door you can
    open and a door you can open in a photograph.

    ``limitedBy`` names what the strip ran into. An empty ``limitedBy`` with
    ``boundedByRoom`` true means nothing stopped it but the far wall, which is
    the answer for a small room and not a failure.
    """
    method = f"clearApproach({door_global_id})"
    subject = _require(model, door_global_id, method)
    if subject.is_a() not in FENESTRATION:
        _wrong_kind(
            subject,
            method,
            "clearApproach",
            "eine Tür, ein Fenster oder eine Öffnung",
            "für die Bewegungsfläche eines ganzen Raums: turningCircle(); für das lichte Maß: clearOpeningWidth()",
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]
    frame = _frame_of(model, subject)
    if frame is None:
        return _no_plane(model, subject, method)

    from .clearance import clear_opening_width

    aperture = clear_opening_width(model, door_global_id)
    if not aperture.decidable or not aperture.value:
        return undecidable(
            from_=[door_global_id],
            method=method,
            provenance="computed",
            missing=aperture.missing
            or MissingFact(
                what=f"die lichte Öffnungsbreite von {door_global_id}",
                remedy="Ohne lichte Breite ist die Breite des zu prüfenden Streifens unbestimmt.",
            ),
        )
    width = float(aperture.value["width"])

    spaces = _spaces_by_side(model, subject, frame)
    sides: list[dict[str, Any]] = []
    for sign in (1.0, -1.0):
        sides.append(_approach_on(model, subject, frame, sign, spaces.get(sign), width))

    caveat = (
        f"{_NOT_A_VERDICT} Gemessen ist die Tiefe eines {width:.3f} m breiten Streifens — der lichten "
        "Öffnungsbreite — senkrecht vor der Öffnung, bis er zum ersten Mal aus der freien Bodenfläche "
        f"herausragt. {aperture.value['via']} war die Grundlage der Breite. Der Hauptwert zählt nur FESTE "
        "Bauteile; „withFurnishing“ wiederholt ihn mit der losen Möblierung."
    )
    caveat += (
        " Nicht berücksichtigt ist der Schwenkbereich des Türblatts: es zählt in der Lage, in der es "
        "modelliert ist, und das ist in den meisten Exporten die geschlossene. Die seitliche Lage des "
        "Streifens ist die der Öffnung — ob daneben genug Platz zum Anfahren des Drückers ist, ist eine "
        "andere Frage als diese."
    )
    if any(s["space"] is None for s in sides):
        caveat += (
            " Auf mindestens einer Seite liegt kein IfcSpace: dort ist keine freie Bodenfläche definiert und "
            "die Tiefe bleibt offen (null, nicht 0). Abhilfe: den angrenzenden Raum als IfcSpace exportieren."
        )

    return computed(
        {"width": round(width, 4), "sides": sides},
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[door_global_id, *[s["space"] for s in sides if s["space"]]],
        method=method,
        caveat=caveat,
    )


def _approach_on(
    model: SpatialModel, element: Any, frame: _Frame, sign: float, space: Any | None, width: float
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "direction": [round(float(frame.normal[0] * sign), 4), round(float(frame.normal[1] * sign), 4)],
        "space": None,
        "spaceName": None,
        "depth": None,
        "limitedBy": [],
        "boundedByRoom": None,
        "withFurnishing": None,
        "because": "kein IfcSpace auf dieser Seite",
    }
    if space is None:
        return entry

    free = _free_floor(model, space, skip={element.GlobalId})
    if isinstance(free, Answer) or free is None:
        entry["because"] = "freie Bodenfläche dieses Raums nicht bestimmbar"
        return entry

    entry["space"] = space.GlobalId
    entry["spaceName"] = model.label(space)
    entry["because"] = None

    base = frame.outer_face(sign)
    reach = _reach_of(free.footprint) + OUTSIDE_PROBE
    fixed_depth = _strip_depth(frame, sign, base, width, free.fixed, reach)
    loose_depth = _strip_depth(frame, sign, base, width, free.furnished, reach)

    entry["depth"] = round(fixed_depth, 4)
    # What ENDED the strip: the room, or something standing in it. The test is
    # whether one step further leaves the room's own FOOTPRINT — not whether the
    # bisection ran out of bracket, which it never does because the bracket is
    # the room's diagonal. Told apart because "4.39 m and then the far wall" and
    # "4.39 m and then a wardrobe" are different findings for the architect.
    beyond = _strip(frame, sign, base, width, fixed_depth + 0.01)
    entry["boundedByRoom"] = bool(beyond.difference(free.footprint).area > MIN_OBSTACLE_AREA)
    entry["limitedBy"] = _limiting(model, frame, sign, base, width, fixed_depth, free, loose=False)
    entry["withFurnishing"] = {
        "depth": round(loose_depth, 4),
        "limitedBy": _limiting(model, frame, sign, base, width, loose_depth, free, loose=True),
    }
    return entry


def _reach_of(polygon: Any) -> float:
    min_x, min_y, max_x, max_y = polygon.bounds
    return float(math.hypot(max_x - min_x, max_y - min_y))


def _strip(frame: _Frame, sign: float, base: float, width: float, depth: float) -> Any:
    import shapely

    half = width / 2.0
    a = frame.point(frame.u_centre - half, base)
    b = frame.point(frame.u_centre + half, base)
    c = frame.point(frame.u_centre + half, base + sign * depth)
    d = frame.point(frame.u_centre - half, base + sign * depth)
    return shapely.Polygon([tuple(a), tuple(b), tuple(c), tuple(d)])


def _strip_depth(frame: _Frame, sign: float, base: float, width: float, free: Any, reach: float) -> float:
    """How far the strip goes before it leaves the free floor. Bisection, same as the circle."""
    if free is None or free.is_empty:
        return 0.0
    low, high = 0.0, reach
    for _ in range(INSCRIBED_STEPS):
        mid = (low + high) / 2.0
        try:
            outside = _strip(frame, sign, base, width, mid).difference(free).area
        except Exception:
            outside = 1.0
        if outside <= MIN_OBSTACLE_AREA:
            low = mid
        else:
            high = mid
    return low


def _limiting(
    model: SpatialModel,
    frame: _Frame,
    sign: float,
    base: float,
    width: float,
    depth: float,
    free: _FreeFloor,
    *,
    loose: bool,
) -> list[dict[str, Any]]:
    """What the strip would run into just past where it stopped.

    Probed a handspan beyond the measured depth rather than exactly at it: at the
    limit itself the strip only TOUCHES the obstacle, and a touching intersection
    has zero area and names nothing. 0.10 m past it is enough to overlap whatever
    stopped it and short enough not to collect the next thing along.
    """
    probe = _strip(frame, sign, base, width, depth + 0.10)
    found = []
    for obstacle in free.obstacles:
        if not loose and obstacle["counts"] == "furnished":
            continue
        geo = model.geometry(obstacle["globalId"])
        if geo is None:
            continue
        silhouette = _plan_silhouette(geo.triangles)
        if silhouette is None:
            continue
        try:
            overlap = float(silhouette.intersection(probe).area)
        except Exception:
            continue
        if overlap <= MIN_OBSTACLE_AREA:
            continue
        found.append({**obstacle, "overlap": round(overlap, 4)})
    found.sort(key=lambda o: (-o["overlap"], o["globalId"]))
    return found
