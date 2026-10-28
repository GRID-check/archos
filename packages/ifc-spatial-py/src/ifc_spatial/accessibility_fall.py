"""Falls: which voids a person could go through, and whether a railing stands between them and the drop."""

from __future__ import annotations

import math
from typing import Any

from ifc_spatial.accessibility_constants import _VOID_PROBES
from ifc_spatial.accessibility_constants import RAILING_FOOT
from ifc_spatial.accessibility_constants import RAILING_REACH
from ifc_spatial.accessibility_floor import _is_floor_void
from ifc_spatial.accessibility_floor import _surface_below
from ifc_spatial.accessibility_records import _Frame

from .model import SpatialModel
from .operators import CONTACT
from .operators import COORDINATE_TOLERANCE
from .operators import DIMENSION_TOLERANCE


def _fall_through(model: SpatialModel, opening: Any, railings: list[Any], space: Any | None) -> dict[str, Any] | None:
    """A hole in a FLOOR: the fall goes down through it, not sideways past it.

    Reached when :func:`_frame_of` refused, and it measures only what
    :func:`_is_floor_void` recognises; anything else stays ``None`` and is
    reported as unmeasurable, which is what the caveat already says honestly.

    ## Which room the fall belongs to

    One void, two rooms, and the same 2.700 m means opposite things to them.
    ``AC20-FZK-Haus``'s gallery void reaches BOTH „Galerie" (floor at z = 2.700,
    the room you can fall out of) and „Wohnen" (floor at z = 0.000, the room you
    would land in) through ``bounds()`` → ``hosts()``, because one slab is both
    rooms' slab. So the fall is measured only for the room whose floor is AT the
    void, and the room below gets the same entry with ``fall = null`` and a
    ``via`` that says why. Reporting 2.700 m to „Wohnen" would invent an
    Absturzkante in a ceiling — a defect an applicant would be asked to redesign
    that is not there.

    With no room in the question (``balustradeCheck`` aimed straight at the
    opening) the walking level is the void's own top face, which is the same
    number wherever the slab was modelled from.

    ## …and whether it belongs to that room at all

    A slab bounds EVERY room on its storey, and ``hosts()`` hands back every
    void that slab carries, so `_openings_at` lists a stairwell void at rooms
    on the far side of the building. Measured on ``AC20-Institute-Var-2``: its
    two „Slab Opening" voids (18.30…23.70 × 11.70…15.70) are listed at all 82
    spaces, „Buero" ``3zaEFaiGrF1ftyFPQrOe_i`` among them — **13.370 m** away in
    plan. Left alone, this function would have handed that office a 2.591 m
    Absturzkante and 64 other rooms one with it.

    So the void's plan rectangle has to come within ``CONTACT`` of the room's
    own plan extent, which is the same tolerance that decided the slab bounds
    the room in the first place. On that file it keeps the two stairwell
    corridors („Flur 2.OG Treppe", „Flur 3.OG Treppe", gap 0.000 m) and drops
    the rooms across the wall („Dachboden-1" and „Dachboden-2", gap 0.300 m —
    the corridor wall). The test is against the room's bounding box, so a room
    bent round a corner can still claim a void sitting in the notch of its
    L; that is the same over-inclusion ``bounds()`` itself carries and it is
    bounded by the room's own extent rather than by the storey's.

    ## The two levels

    Top: the floor of the room at the void — measured, not the void's nominal
    top. Bottom: the deepest of :data:`_VOID_PROBES` rays cast down through the
    void, air and furniture excluded by :func:`_surface_below`, exactly as the
    wall case probes the ground outside. ``parapet`` is ``None`` and not zero: a
    hole in a floor has no Brüstung, and zero is a number an agent puts in a
    sentence.
    """
    geo = model.geometry(opening.GlobalId)
    if geo is None or len(geo.triangles) == 0:
        return None
    if not _is_floor_void(model, opening, geo):
        return None

    x_min, y_min, z_min = (float(v) for v in geo.box[0])
    x_max, y_max, z_max = (float(v) for v in geo.box[1])
    rect = (x_min, y_min, x_max, y_max)
    top, inside_space = z_max, None
    if space is not None:
        space_geo = model.geometry(space.GlobalId)
        if space_geo is None:
            return None
        floor = float(space_geo.box[0][2])
        reach = _plan_gap(rect, space_geo.box)
        if reach > CONTACT:
            return _void_away_from(model, opening, space, floor, reach)
        if floor < z_min - DIMENSION_TOLERANCE:
            return _void_overhead(model, opening, space, floor, (z_min, z_max))
        if floor > z_max + DIMENSION_TOLERANCE:
            return None
        top, inside_space = floor, space

    # Cast from the middle of the void's own thickness: below the floor it is cut
    # into, above whatever is beneath it, and inside the hole for every void
    # thicker than nothing.
    probe_z = (z_min + z_max) / 2.0
    deepest: tuple[float, Any] | None = None
    for fx, fy in _VOID_PROBES:
        found = _surface_below(model, x_min + fx * (x_max - x_min), y_min + fy * (y_max - y_min), probe_z)
        if found is not None and (deepest is None or found[0] < deepest[0]):
            deepest = found
    if deepest is None:
        return None
    level, hit = deepest

    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": round(top - level, 4),
        "parapet": None,
        "position": "horizontal",
        "inside": {
            "direction": [0.0, 0.0],
            "space": None if inside_space is None else inside_space.GlobalId,
            "spaceName": None if inside_space is None else model.label(inside_space),
            "level": round(top, 4),
            "via": (
                "Fußboden am Rand der waagrechten Öffnung (Unterkante des Raumkörpers)"
                if inside_space is not None
                else "Oberkante der waagrechten Öffnung (kein Raum in der Anfrage)"
            ),
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": round(level, 4),
            "via": f"Strahl senkrecht nach unten durch die Öffnung, tiefster von {len(_VOID_PROBES)} Punkten",
            "surface": {
                "globalId": hit.GlobalId,
                "name": model.label(hit),
                "ifcType": hit.is_a(),
                "top": round(level, 4),
                "gap": None,
            },
        },
        "railings": _railings_at_void(model, (x_min, y_min, x_max, y_max), top, railings),
    }


def _plan_gap(rect: tuple[float, float, float, float], box: Any) -> float:
    """Shortest distance in plan between a rectangle and a body's bounding box.

    Zero when they overlap or touch, which is the case that matters: a gallery
    void lies AT the floor it interrupts, and „at" includes sharing an edge with
    it. One function so that the reach of a railing and the reach of a room are
    the same arithmetic.
    """
    gap_x = max(rect[0] - float(box[1][0]), float(box[0][0]) - rect[2], 0.0)
    gap_y = max(rect[1] - float(box[1][1]), float(box[0][1]) - rect[3], 0.0)
    return math.hypot(gap_x, gap_y)


def _void_away_from(model: SpatialModel, opening: Any, space: Any, floor: float, reach: float) -> dict[str, Any]:
    """A void in the same slab, but not at this room — the 13.370 m case.

    Listed with the distance rather than dropped, because it explains why an
    opening nobody at this room can reach is in this room's list at all: the
    slab it is cut into bounds the room, so ``hosts()`` hands it over.
    """
    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": None,
        "parapet": None,
        "position": "horizontal",
        "inside": {
            "direction": [0.0, 0.0],
            "space": space.GlobalId,
            "spaceName": model.label(space),
            "level": round(floor, 4),
            "via": "Unterkante des Raumkörpers (IfcSpace)",
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": None,
            "via": (
                f"waagrechte Öffnung derselben Decke, aber {reach:.3f} m von diesem Raum entfernt (im "
                "Grundriss) — sie liegt nicht an seinem Fußboden und ist hier keine Fallhöhe; sie steht in "
                "dieser Liste, weil die Decke, in der sie sitzt, den Raum begrenzt"
            ),
            "surface": None,
        },
        "railings": [],
    }


def _void_overhead(
    model: SpatialModel, opening: Any, space: Any, floor: float, span: tuple[float, float]
) -> dict[str, Any]:
    """The same floor void, seen from the room UNDERNEATH it.

    Listed rather than dropped, and with ``fall = null`` rather than a number:
    the opening genuinely bounds this room, and saying so with the reason beats
    letting it vanish into a count of unmeasurable openings — but nobody falls
    upward through their own ceiling.
    """
    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": None,
        "parapet": None,
        "position": "horizontal",
        "inside": {
            "direction": [0.0, 0.0],
            "space": space.GlobalId,
            "spaceName": model.label(space),
            "level": round(floor, 4),
            "via": "Unterkante des Raumkörpers (IfcSpace)",
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": None,
            "via": (
                f"waagrechte Öffnung in der DECKE dieses Raums (Öffnung von {span[0]:.3f} m bis "
                f"{span[1]:.3f} m, Fußboden dieses Raums bei {floor:.3f} m) — von hier aus führt sie nicht "
                "abwärts; die Fallhöhe ist am darüberliegenden Raum zu messen"
            ),
            "surface": None,
        },
        "railings": [],
    }


def _railings_at_void(
    model: SpatialModel, rect: tuple[float, float, float, float], top: float, railings: list[Any]
) -> list[dict[str, Any]]:
    """Railings standing at a floor void's perimeter, with their height over it.

    The plan test is the gap between two rectangles rather than a signed
    distance through a wall face: a floor void has no inside and outside, it has
    a perimeter, and a balustrade stands on it. Both of ``AC20-FZK-Haus``'s
    railings sit 0.030 m and 0.000 m from the gallery void's rectangle, well
    inside :data:`RAILING_REACH`.

    Two height tests keep the railing on the right storey, which is the whole
    risk of a purely-plan test in a building where every floor has the same
    plan: it must rise above the walking level, or it protects nothing here, and
    its foot must not stand more than :data:`RAILING_FOOT` above that level, or
    it is the balustrade of the storey above.
    """
    found = []
    for railing in railings:
        geo = model.geometry(railing.GlobalId)
        if geo is None:
            continue
        base, crest = float(geo.box[0][2]), float(geo.box[1][2])
        if crest <= top + COORDINATE_TOLERANCE or base > top + RAILING_FOOT:
            continue
        if _plan_gap(rect, geo.box) > RAILING_REACH:
            continue
        found.append(
            {
                "globalId": railing.GlobalId,
                "name": model.label(railing),
                "ifcType": railing.is_a(),
                "height": round(crest - top, 4),
                "top": round(crest, 4),
            }
        )
    found.sort(key=lambda r: (-r["height"], r["globalId"]))
    return found


def _railings_at(
    model: SpatialModel, frame: _Frame, sign: float, inside_level: float, railings: list[Any]
) -> list[dict[str, Any]]:
    """Railings standing at this edge, with their height over the inside floor.

    Tested in the opening's own frame rather than in model coordinates: a
    railing counts when it lies on the outside of the wall face, within
    :data:`RAILING_REACH` of it, and overlaps the opening laterally. Half a metre
    of lateral slack on each side, because a balustrade runs past the window it
    protects rather than stopping at its reveal.

    The through-wall test is done in a coordinate that increases OUTWARD —
    ``through × sign`` — so that the ``+`` and the ``−`` side are one piece of
    arithmetic instead of two mirrored ones. Mirrored comparisons are how a
    railing gets credited on the wrong side of a wall.
    """
    reference = frame.outer_face(sign) * sign
    found = []
    for railing in railings:
        geo = model.geometry(railing.GlobalId)
        if geo is None:
            continue
        points = geo.verts[:, :2]
        across = points @ frame.lateral
        outward = (points @ frame.normal) * sign
        if float(outward.min()) > reference + RAILING_REACH:
            continue  # entirely beyond reach of this edge
        if float(outward.max()) < reference - COORDINATE_TOLERANCE:
            continue  # entirely on the inside of the wall face
        if float(across.max()) < frame.u_min - 0.5 or float(across.min()) > frame.u_max + 0.5:
            continue
        found.append(
            {
                "globalId": railing.GlobalId,
                "name": model.label(railing),
                "ifcType": railing.is_a(),
                "height": round(float(geo.box[1][2]) - inside_level, 4),
                "top": round(float(geo.box[1][2]), 4),
            }
        )
    found.sort(key=lambda r: (-r["height"], r["globalId"]))
    return found
