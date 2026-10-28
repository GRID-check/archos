"""The operator vocabulary, on IfcOpenShell.

A port of `packages/ifc-spatial/src/operators/{topology,metric,constructive}.ts`,
one function per TS operator, every one returning an :class:`~ifc_spatial.envelope.Answer`.
The German wording of `missing.what`, `missing.remedy` and every `caveat` is kept
verbatim wherever the TypeScript has one, because the sentence an architect reads
must not change when the engine underneath does.

## Three outcomes, never two — unchanged from the TS

  - **a value** — with provenance, tolerance and a method that reads like the call.
  - **undecidable** — the question was well-formed and this file cannot answer it.
    Carries the IFC relation or property that would settle it, in German.
  - **exception** — the GlobalId names nothing in this model
    (:class:`~ifc_spatial.model.UnknownElementError`). Never an undecidable: a
    hallucinated id must not be reportable as "das Modell sagt dazu nichts".

## Where IfcOpenShell is better than what it replaces, and it is used

Marked ``BESSER`` in the docstrings and listed in ``COVERAGE.md``:

  - :func:`floor_area` — ``util.shape.get_footprint_area`` UNIONS the projected
    faces (shapely) instead of summing them, so overlapping horizontal faces
    cannot double-count.
  - :func:`floor_area` also finds the declared quantity itself and triangulates
    against it; the TS operator takes it as a parameter and answers with one
    route when the host forgets to pass it.
  - :func:`ray` — ``geom.tree.select_ray`` intersects the real OCCT surface, not
    a retained triangle subset, and returns the surface normal and dot product
    besides the hit. The TS ray silently skips elements whose triangles the
    geometry pass dropped and says so in a caveat; there is nothing to drop here.
  - :func:`opens_to` and :func:`bounds` — ``geom.tree.select(element, extend=…)``
    is an exact solid proximity query, so the space a window opens into is found
    at a 5 cm contact tolerance instead of the TS derivation's 30 cm.
  - :func:`clear_height` — the TS operator returns the modelled space height and
    says in its caveat that the real clear height needs an intersection test it
    does not have. IfcOpenShell has it, so this one measures the lichte Höhe by
    casting rays up from the floor.

## Where it is worse, and the code says so rather than pretending

``tree.clash_collision_many`` / ``clash_clearance_many`` /
``clash_intersection_many`` return an EMPTY tuple for every input on the shipped
0.8.5 wheel — including two walls that visibly touch — without raising. §7 of the
design doc maps `adjacentTo` and `distance` onto exactly those calls. They are
therefore not used anywhere in this module: a primitive that answers "keine
Nachbarn" by failing silently is the single most dangerous thing this library
could be built on. :func:`distance` measures box gaps as the TS does, and
:func:`adjacent_spaces` goes through shared bounding elements.
"""

from __future__ import annotations

from collections.abc import Sequence  # noqa: F401
from typing import Any  # noqa: F401

import numpy as np  # noqa: F401

from ifc_spatial.operators_adjacency import adjacent_spaces  # noqa: F401
from ifc_spatial.operators_adjacency import container_of  # noqa: F401
from ifc_spatial.operators_adjacency import contains  # noqa: F401
from ifc_spatial.operators_adjacency import enclosed_by  # noqa: F401
from ifc_spatial.operators_adjacency import opens_to  # noqa: F401
from ifc_spatial.operators_bounds import _too_big_to_derive  # noqa: F401
from ifc_spatial.operators_bounds import bounds  # noqa: F401
from ifc_spatial.operators_bounds import filler_of  # noqa: F401
from ifc_spatial.operators_bounds import hosted_in  # noqa: F401
from ifc_spatial.operators_bounds import hosts  # noqa: F401
from ifc_spatial.operators_constants import _DERIVED_BOUNDARY_CAVEAT  # noqa: F401
from ifc_spatial.operators_constants import _RELATIONS  # noqa: F401
from ifc_spatial.operators_constants import AREA_RELATIVE_TOLERANCE  # noqa: F401
from ifc_spatial.operators_constants import COMPASS  # noqa: F401
from ifc_spatial.operators_constants import CONTACT  # noqa: F401
from ifc_spatial.operators_constants import COORDINATE_TOLERANCE  # noqa: F401
from ifc_spatial.operators_constants import DIMENSION_TOLERANCE  # noqa: F401
from ifc_spatial.operators_constants import FENESTRATION  # noqa: F401
from ifc_spatial.operators_constants import FURNISHING  # noqa: F401
from ifc_spatial.operators_constants import MIN_INTRUSION  # noqa: F401
from ifc_spatial.operators_constants import SIDE_TOLERANCE  # noqa: F401
from ifc_spatial.operators_facade import facade_plane_of  # noqa: F401
from ifc_spatial.operators_facade import obstructions  # noqa: F401
from ifc_spatial.operators_facade import overhang  # noqa: F401
from ifc_spatial.operators_facade import prism  # noqa: F401
from ifc_spatial.operators_facade import ray  # noqa: F401
from ifc_spatial.operators_guards import _geometry_or_answer  # noqa: F401
from ifc_spatial.operators_guards import _no_geometry  # noqa: F401
from ifc_spatial.operators_guards import _require  # noqa: F401
from ifc_spatial.operators_guards import _wrong_kind  # noqa: F401
from ifc_spatial.operators_measures import _footprint_area  # noqa: F401
from ifc_spatial.operators_measures import extent  # noqa: F401
from ifc_spatial.operators_measures import floor_area  # noqa: F401
from ifc_spatial.operators_vertical import azimuth  # noqa: F401
from ifc_spatial.operators_vertical import clear_height  # noqa: F401
from ifc_spatial.operators_vertical import distance  # noqa: F401
from ifc_spatial.operators_vertical import elevation  # noqa: F401
from ifc_spatial.operators_vertical import sill_and_head  # noqa: F401

from .envelope import Answer  # noqa: F401
from .envelope import MissingFact  # noqa: F401
from .envelope import computed  # noqa: F401
from .envelope import undecidable  # noqa: F401
from .geometry import dominant_plane  # noqa: F401
from .geometry import dominant_vertical_plane  # noqa: F401
from .geometry import triangle_normals_areas  # noqa: F401
from .model import SpatialModel  # noqa: F401


def _clear_opening_area(model: SpatialModel, opening: Any, z_band: tuple[float, float] | None = None) -> float | None:
    """The area of an opening's clear aperture — the Rohbaulichte.

    An ``IfcOpeningElement`` is a prism driven through the wall. Projected along
    the wall's own normal, its two end faces land on top of each other and the
    shapely UNION of the projection is exactly the clear opening — which is what
    a Lichteintrittsfläche is measured on, and which no bounding box gives for a
    round-headed or triangular window.

    The projection direction comes from the opening's own dominant vertical
    plane rather than from the host wall, so this still works where the export
    voided a wall the operator was not handed.

    ``None`` when there is no usable body or no vertical plane to project along
    — a skylight in a flat roof, an opening exported without geometry. The
    caller reports that as a gap rather than substituting a guess.
    """
    import shapely
    import shapely.ops

    global_id = getattr(opening, "GlobalId", None)
    if not global_id:
        return None
    geo = model.geometry(global_id)
    if geo is None or geo.triangles is None or len(geo.triangles) == 0:
        return None
    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        return None

    # An orthonormal basis in the opening's plane. `up` is world Z projected
    # into the plane, so the second axis is horizontal — which keeps the
    # projected coordinates readable if this ever needs debugging.
    up = np.array([0.0, 0.0, 1.0])
    up = up - normal * float(up @ normal)
    if np.linalg.norm(up) < 1e-9:
        return None
    up = up / np.linalg.norm(up)
    across = np.cross(normal, up)

    normals, _ = triangle_normals_areas(geo.triangles)
    # Only the faces that actually lie IN the aperture plane. The prism's side
    # walls (the reveal) are perpendicular to it and project to slivers that
    # would inflate the union.
    facing = geo.triangles[np.abs(normals @ normal) > 0.9]
    if len(facing) == 0:
        return None

    polygons = []
    for tri in facing:
        flat = [(float(p @ across), float(p @ up)) for p in tri]
        polygon = shapely.Polygon(flat)
        if polygon.is_valid and polygon.area > 0:
            polygons.append(polygon)
    if not polygons:
        return None
    try:
        merged = shapely.ops.unary_union(polygons)
    except Exception:
        return None

    if z_band is not None:
        # Only the part of the aperture that lies inside the ROOM. A curtain
        # wall runs past a floor: the sample house's 31.09 m² facade spans
        # z 0–3.36 and was credited in full to the living room (z 0–2.5) AND in
        # full to the 1.00 m loft above it, which came out at 40.65 %. Two rooms
        # cannot each own all of the same glass.
        #
        # `up` is world Z projected into the aperture plane, so for a vertical
        # opening the in-plane vertical coordinate is world Z divided by that
        # projection; the band is mapped through the same factor. Exact for a
        # vertical facade, slightly generous for a raked one.
        low, high = z_band
        minx, _, maxx, _ = merged.bounds
        span = float(up[2]) or 1.0
        band = sorted((low / span, high / span))
        try:
            merged = merged.intersection(shapely.box(minx - 1.0, band[0], maxx + 1.0, band[1]))
        except Exception:
            return None
    area = float(merged.area)
    return area if area > 0 else None


def _rooms_on_one_side(model: SpatialModel, element: Any, rooms: Sequence[Any]) -> bool | None:
    """Whether every room this element bounds lies on the SAME side of it.

    ``True`` → outside is on the other side. ``False`` → rooms both sides, so it
    is a Trennbauteil. ``None`` → the element's plane could not be established,
    and the caller must not fall back to counting (see :func:`_external_route`).

    The element's DOMINANT plane rather than its vertical one, so the same test
    serves a slab: a floor with rooms above and below is internal by exactly the
    reasoning that makes a wall with rooms left and right internal, and a ground
    slab carrying rooms only above it is external by the same test that catches
    a facade. The centroid is the point on that plane — for a wall it sits in
    the middle of the thickness, which is where the two sides part.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None or geo.faces.size == 0:
        return None
    normal = dominant_plane(geo.verts[geo.faces])
    if normal is None:
        return None
    length = float(np.linalg.norm(normal))
    if length <= 0:
        return None
    normal = np.asarray(normal, dtype=float) / length
    origin = np.asarray(geo.centroid, dtype=float)

    sides: set[bool] = set()
    unplaceable = False
    for ref in rooms:
        room = model.geometry(getattr(ref, "global_id", ref))
        if room is None:
            # A room we cannot place is not a room on the other side — it is a
            # room we know nothing about, and skipping it silently is how
            # „rooms on one side" gets returned from partial evidence.
            #
            # It matters because of WHICH way the error runs. A wall between
            # two rooms, one of them without a body, would come back with a
            # single side and be called external: `_external_route` puts it in
            # the thermal envelope, `_faces_outside` calls its windows daylight,
            # and `_facade_candidates` will rank it as a facade. Every one of
            # those adds something that is not there. Undecided is the honest
            # answer, and the callers all handle it.
            unplaceable = True
            continue
        offset = float(np.dot(np.asarray(room.centroid, dtype=float) - origin, normal))
        if abs(offset) < SIDE_TOLERANCE:
            # ON the plane, which says nothing about a side. Distinct from the
            # case above: this room WAS placed, and the placement is what is
            # uninformative, so it does not poison the rest of the evidence.
            continue
        sides.add(offset > 0)
    if unplaceable or not sides:
        return None
    return len(sides) == 1


def _faces_outside(model: SpatialModel, element: Any) -> tuple[bool | None, str]:
    """Whether this window or door lets daylight IN from outside.

    The first version of :func:`light_entry_area` summed every window and door
    bounding the room, and the sample house's bedroom came back at 25.3 % — of
    which an interior door to the hallway was 1.71 m². An internal door is not a
    Lichteintrittsfläche under any reading of OIB 3, and 25 % versus 14 % is the
    difference between two opposite answers to a daylight check.

    Two routes, and the declared one wins because it is the architect's own
    statement:

    1. ``Pset_*Common.IsExternal`` on the host wall.
    2. Otherwise the count of spaces the opening touches. An interior door joins
       two rooms; an external window touches one, because there is no IfcSpace
       outdoors. Weaker — a window onto an unmodelled conservatory reads as
       external — hence second.

    ``None`` means neither route decided, and the caller must report that rather
    than picking a side.
    """
    # The element's OWN declaration first. A window carries
    # `Pset_WindowCommon.IsExternal` and a curtain-wall pane carries
    # `Pset_PlateCommon.IsExternal`, and both outrank anything inferred — this
    # is the architect saying which side it faces.
    #
    # It also fixes a case the wall route cannot reach. A plate sits in no wall,
    # so `hosted_in` is empty and the space-count fallback decided it. That
    # fallback is a DOOR heuristic ("joins two rooms, therefore interior"), and
    # the sample house's glazed facade touches the living room AND the loft
    # above it — so every pane of a 4.49 m² glass wall was classified interior
    # and the room's largest daylight source counted as zero.
    own = model.declared_property(element, ("IsExternal",))
    if isinstance(own, bool):
        return own, "Pset_*Common.IsExternal am Bauteil selbst (deklariert)"

    hosts_ = hosted_in(model, element.GlobalId)
    if hosts_.decidable:
        for ref in hosts_.value or []:
            wall = model.file.by_guid(ref.global_id)
            found = model.declared_property(wall, ("IsExternal",))
            if isinstance(found, bool):
                return found, "Pset_*Common.IsExternal der Wand (deklariert)"
        # The wall declares nothing — so MEASURE the wall instead of giving up.
        #
        # A window is outside-facing exactly when the wall carrying it is, and
        # whether a wall is external is a question about its sides: rooms on one
        # side only means outside is on the other. Without this rung an export
        # that omits `IsExternal` — which `AC20-FZK-Haus.ifc` does on all 26 of
        # its walls — leaves every window undetermined, and
        # `light_entry_area` then reported **0.00 %** for the Schlafzimmer, the
        # Bad, the Büro, the Küche and the Galerie of a house with a window in
        # each of them. Honest (the windows land under „unbestimmt" and the
        # caveat says so) and still a 0 % headline on an OIB 3 daylight check,
        # which reads as a finding about the building.
        for ref in hosts_.value or []:
            wall = model.file.by_guid(ref.global_id)
            walls_rooms = enclosed_by(model, wall.GlobalId)
            if not walls_rooms.decidable or not walls_rooms.value:
                continue
            one_side = _rooms_on_one_side(model, wall, walls_rooms.value)
            if one_side is True:
                return True, "die tragende Wand hat Räume nur auf einer Seite (aus der Geometrie)"
            if one_side is False:
                return False, "die tragende Wand hat Räume auf beiden Seiten (aus der Geometrie)"

    # The space-count fallback is a DOOR heuristic and is applied ONLY to doors.
    # A curtain-wall pane runs past a floor, so it touches the room and the one
    # above it — and the heuristic then calls a glass facade an „Innentür".
    # Measured: strip `IsExternal` from the sample house and six panes were
    # classified interior, taking the living room from 72.42 % to 12.64 %.
    #
    # For anything that is not a door the honest answer is UNDETERMINED, which
    # `light_entry_area` reports separately and neither counts nor discards.
    if element.is_a("IfcDoor"):
        touching = opens_to(model, element.GlobalId)
        if touching.decidable and touching.value is not None:
            count = len(touching.value)
            if count >= 2:
                return False, f"öffnet in {count} Räume (Innentür)"
            if count == 1:
                return True, "berührt nur einen Raum — außen liegt kein IfcSpace"
    return None, "weder IsExternal deklariert noch aus den Raumberührungen ableitbar"


def light_entry_area(model: SpatialModel, space_global_id: str) -> Answer[dict[str, Any]]:
    """The room's light-entry area, and what fraction of its floor that is.

    The other half of the answer this library was built because of. The agent
    could not measure the Dachüberstand, and it could not measure the *Raum-%*
    either — the ratio an OIB 3 daylight check is decided on. `overhang` closed
    the first gap; this closes the second.

    For every window and door bounding the room, the operator walks
    ``FillsVoids → RelatingOpeningElement`` and measures that opening's clear
    aperture (:func:`_clear_opening_area`), then divides the sum by
    :func:`floor_area`. Both numbers and the ratio come back together, because a
    ratio whose two inputs are not visible cannot be checked by the person who
    has to sign it.

    ## What this deliberately does not do

    It applies no threshold. OIB 3 names a percentage; that percentage is a fact
    about the *clause*, and the same refusal that keeps `light_incidence` from
    supplying its own 45° keeps this from reporting „erfüllt".

    It also does not decide WHICH area the clause means. This measures the
    structural clear opening — the Rohbaulichte. A regulation may instead mean
    the glazed area, or the clear opening less frame and sash, and the
    difference on an ordinary window is 15–25 %. Substituting one for the other
    silently would be the most expensive kind of wrong: a number that is right
    to the millimetre and answers a different question. So the caveat says which
    was measured, and the clause decides whether that is the one it wants.
    """
    method = f"lightEntryArea({space_global_id})"
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        _wrong_kind(
            subject,
            method,
            "lightEntryArea",
            "ein Raum (IfcSpace)",
            "für ein einzelnes Fenster: measure/extent",
        )

    floor = floor_area(model, space_global_id)
    if not floor.decidable or not floor.value:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="die Bodenfläche des Raums",
                remedy=(
                    "Ohne Bodenfläche ist kein Flächenanteil bildbar. Zuerst measure/floorArea aufrufen — "
                    "die Antwort dort nennt, was fehlt."
                ),
            ),
        )

    bounding = bounds(model, space_global_id)
    if not bounding.decidable:
        return bounding  # type: ignore[return-value]

    openings: list[dict[str, Any]] = []
    without_geometry: list[str] = []
    # `IfcPlate` is here because of a real hole: the sample house's living room
    # is glazed with a curtain wall, and a curtain wall is exported as members
    # and PLATES, not as windows. Counting only IfcWindow/IfcDoor made the
    # largest glazed surface in the building contribute exactly nothing — a
    # fully glazed room reporting 0 % daylight. That is the safe direction for a
    # threshold and still a false finding, and an architect shown 0 % on a glass
    # wall stops trusting the number that is right.
    #
    # Plates carry no IfcOpeningElement (they fill no void; they ARE the wall),
    # so they land on the element-body route below and are labelled as such.
    GLAZING = ("IfcWindow", "IfcDoor", "IfcPlate")

    # The room's own height band, so an opening that runs past a floor is
    # credited only for the part inside THIS room.
    space_geo = model.geometry(space_global_id)
    z_band = None
    if space_geo is not None and space_geo.triangles is not None and len(space_geo.triangles):
        zs = space_geo.triangles.reshape(-1, 3)[:, 2]
        z_band = (float(zs.min()), float(zs.max()))

    # Deduplicated by GlobalId. A 2nd-level export publishes one
    # IfcRelSpaceBoundary row PER FACE, so a window bounding a room twice
    # appeared twice in `bounds` and was summed twice — the bedroom reported
    # 28.41 % instead of 14.21 %, listing the same GlobalId in both lines. The
    # better the export, the more reliably it happened.
    seen: set[str] = set()
    for ref in bounding.value or []:
        if ref.ifc_type not in GLAZING or ref.global_id in seen:
            continue
        seen.add(ref.global_id)
        element = model.file.by_guid(ref.global_id)
        voids = [rel.RelatingOpeningElement for rel in (getattr(element, "FillsVoids", []) or [])]
        area = None
        via = "IfcOpeningElement"
        for void in voids:
            area = _clear_opening_area(model, void, z_band)
            if area:
                break
        if not area:
            # No opening bookkeeping, or an opening without a body. The element's
            # own aperture is the next best thing and is NOT the same number —
            # it includes the frame — so it is labelled, not silently mixed in.
            area = _clear_opening_area(model, element, z_band)
            via = (
                "Verglasungsfeld (Vorhangfassade, Rahmen enthalten)"
                if ref.ifc_type == "IfcPlate"
                else "Bauteilkörper (Rahmen enthalten)"
            )
        if not area:
            without_geometry.append(ref.global_id)
            continue
        external, why = _faces_outside(model, element)
        openings.append(
            {
                "globalId": ref.global_id,
                "name": ref.name,
                "ifcType": ref.ifc_type,
                "area": round(area, 6),
                "via": via,
                "external": external,
                "because": why,
            }
        )

    if not openings:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine messbare Fensteröffnung an diesem Raum",
                remedy=(
                    "Entweder grenzt an diesen Raum kein Fenster und keine Tür, oder deren Öffnungen "
                    "tragen keine Geometrie. bounds() zeigt, was den Raum begrenzt."
                ),
            ),
        )

    # ONLY the openings that face outside are summed. An interior door is not a
    # Lichteintrittsfläche under any reading of OIB 3, and including one took the
    # sample house's bedroom from 14.2 % to 25.3 % — two opposite answers to the
    # same daylight check. The others stay in the payload, labelled, because a
    # number is only checkable when what was left out of it is visible.
    external = [entry for entry in openings if entry["external"] is True]
    internal = [entry for entry in openings if entry["external"] is False]
    unknown = [entry for entry in openings if entry["external"] is None]

    total = sum(entry["area"] for entry in external)
    ratio = total / float(floor.value)

    caveat = (
        "Gemessen ist die ROHBAULICHTE (die lichte Öffnung im Mauerwerk), nicht die Glasfläche und nicht "
        "die Öffnung abzüglich Rahmen und Flügel — der Unterschied beträgt bei einem üblichen Fenster "
        "15–25 %. Welche dieser Flächen die Bestimmung meint, entscheidet die Bestimmung. Kein Grenzwert "
        "angewandt: der Prozentsatz stammt aus dem Regelwerk, nicht aus dem Modell."
    )
    if internal:
        caveat += (
            f" {len(internal)} innenliegende Öffnung(en) sind NICHT eingerechnet (eine Innentür belichtet "
            "nicht von außen); sie stehen unter „interior“ mit Begründung."
        )
    if unknown:
        caveat += (
            f" Bei {len(unknown)} Öffnung(en) ließ sich außen/innen nicht bestimmen — sie sind WEDER "
            "eingerechnet noch verworfen und stehen unter „unbestimmt“. Abhilfe: IsExternal an der Wand "
            "setzen. Solange das offen ist, ist der Anteil eine Untergrenze."
        )
    if not external:
        caveat += (
            " Keine einzige außenliegende Öffnung an diesem Raum: der Anteil ist 0 %, was ein Befund über "
            "die Zuordnung im Export sein kann und nicht zwingend über den Raum."
        )
    if any(entry["via"] != "IfcOpeningElement" for entry in openings):
        caveat += (
            " Für mindestens eine Öffnung war kein IfcOpeningElement mit Geometrie vorhanden; dort wurde "
            "der Bauteilkörper gemessen, der den Rahmen einschließt und damit zu GROSS ist."
        )
    if without_geometry:
        caveat += (
            f" {len(without_geometry)} Öffnung(en) ohne verwertbare Geometrie sind NICHT enthalten — "
            "die Summe ist insofern eine Untergrenze."
        )
    if bounding.provenance == "computed" and bounding.caveat:
        caveat += f" Raumbegrenzung: {bounding.caveat}"

    return computed(
        {
            "lightEntryArea": round(total, 4),
            "floorArea": round(float(floor.value), 4),
            "ratio": round(ratio, 5),
            "percent": round(ratio * 100.0, 2),
            "openings": external,
            "interior": internal,
            "undetermined": unknown,
        },
        unit="m²",
        tolerance=abs(total) * AREA_RELATIVE_TOLERANCE,
        from_=[space_global_id, *[entry["globalId"] for entry in external]],
        method=method,
        caveat=caveat,
    )


__all__ = [
    "adjacent_spaces",
    "azimuth",
    "bounds",
    "clear_height",
    "container_of",
    "contains",
    "distance",
    "elevation",
    "enclosed_by",
    "extent",
    "facade_plane_of",
    "filler_of",
    "floor_area",
    "hosted_in",
    "hosts",
    "light_entry_area",
    "obstructions",
    "opens_to",
    "overhang",
    "prism",
    "ray",
    "sill_and_head",
]
