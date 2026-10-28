"""Plan geometry for the checks: footprints, silhouettes, a room's free floor, and the surface an element stands on."""

from __future__ import annotations

from typing import Any

import numpy as np

from ifc_spatial.accessibility_constants import _VERTICAL_HOSTS
from ifc_spatial.accessibility_constants import BUFFER_QUAD_SEGS
from ifc_spatial.accessibility_constants import CONTACT_EXTEND
from ifc_spatial.accessibility_constants import FLOOR_CONTACT
from ifc_spatial.accessibility_constants import FREE_FLOOR_MAX_TRIANGLES
from ifc_spatial.accessibility_constants import INSCRIBED_STEPS
from ifc_spatial.accessibility_constants import MIN_OBSTACLE_AREA
from ifc_spatial.accessibility_constants import OUTSIDE_PROBE
from ifc_spatial.accessibility_constants import PROBE_LIFT
from ifc_spatial.accessibility_records import _Frame
from ifc_spatial.accessibility_records import _FreeFloor

from .envelope import Answer
from .envelope import MissingFact
from .envelope import undecidable
from .geometry import PARALLEL_DOT
from .geometry import VERTICAL_TOLERANCE
from .geometry import dominant_vertical_plane
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import SpatialModel
from .operators import COORDINATE_TOLERANCE
from .operators import FURNISHING

# ════════════════════════════════════════════════════════════════════════════
# plan geometry — the polygons the four operators are all built out of
# ════════════════════════════════════════════════════════════════════════════


def _plan_footprint(triangles: np.ndarray) -> Any | None:
    """A solid's floor polygon, by exactly the method ``_footprint_area`` measures.

    Kept in step with :func:`~ifc_spatial.operators._footprint_area` on purpose,
    down to the 0.01 normal tolerance and the both-windings sweep: that function
    returns the AREA of this union and a polygon cannot be recovered from an
    area, but the two must not drift apart, so ``test_accessibility`` asserts
    that this polygon's area equals what that function reports for all three
    rooms of the sample house.

    Both windings are taken and the larger wins for the reason spelled out
    there — a Revit IFC2X3 ``IfcSpace`` is routinely wound inside-out, and
    keeping only the faces pointing one way returns an empty polygon for a room
    that plainly has a floor. A confident zero is the worst thing this library
    can produce.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return None
    normals, _ = triangle_normals_areas(triangles)
    best = None
    for sign in (1.0, -1.0):
        facing = triangles[normals[:, 2] * sign > 0.01]
        if len(facing) == 0:
            continue
        polygons = []
        for tri in facing:
            polygon = shapely.Polygon(tri[:, :2])
            if polygon.is_valid and polygon.area > 0:
                polygons.append(polygon)
        if not polygons:
            continue
        try:
            union = shapely.ops.unary_union(polygons)
        except Exception:
            continue
        if best is None or union.area > best.area:
            best = union
    return best


def _plan_silhouette(triangles: np.ndarray) -> Any | None:
    """A solid's outline in plan — every triangle projected, unioned.

    Not the horizontal faces this time: an obstacle blocks the floor over its
    whole shadow, and a bed's shadow is bounded by its sides, not by its top.
    Taking only the horizontal faces of the sample house's bed would leave the
    mattress and lose the frame; taking all of them gives 3.61 m², which is the
    bed.

    The projection is a SHADOW and knows nothing about height, so a table is
    subtracted over its whole top even though a footrest fits under it. That is
    the conservative direction — it makes the circle smaller — and it is named in
    every caveat that uses this.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return None
    polygons = []
    for tri in triangles:
        polygon = shapely.Polygon(tri[:, :2])
        if polygon.is_valid and polygon.area > 1e-9:
            polygons.append(polygon)
    if not polygons:
        return None
    try:
        return shapely.ops.unary_union(polygons)
    except Exception:
        return None


def _is_furnishing(element: Any) -> bool:
    """Loose furniture, by the same three-way test :func:`daylight._is_excluded` uses.

    Every entry of ``FURNISHING`` is checked rather than only the base type,
    because IFC2X3 has no subtype relation between ``IfcFurniture`` and
    ``IfcFurnishingElement`` and a single-entry test would let an IFC2X3 chair
    count as a fixed installation.

    IFC has **no** flag for fixed versus loose — ``Pset_FurnitureTypeCommon``
    carries none — so the classification is by entity type and nothing else. A
    built-in wardrobe exported as ``IfcFurniture`` is counted as loose here, and
    the caveat says so, because there is no fact in the file that would separate
    it from a chair.
    """
    for kind in FURNISHING:
        try:
            if element.is_a(kind):
                return True
        except Exception:
            continue
    return False


def _largest_circle(polygon: Any) -> tuple[float, tuple[float, float]] | None:
    """The largest circle inscribed in a polygon: its radius and a centre.

    Erosion and bisection, which is the definition rather than an approximation
    of it: a disc of radius ``r`` fits inside ``P`` exactly when ``P`` eroded by
    ``r`` is non-empty, and the erosion is ``P.buffer(-r)`` with round joins. So
    the largest radius is found by halving the bracket ``[0, half the longer
    side]``, and the centre is a point of the last non-empty erosion — any point
    of it is a valid centre, and ``representative_point`` is guaranteed to lie
    inside even when that erosion has collapsed to a sliver.

    Cross-checked in the suite against GEOS's own ``maximum_inscribed_circle``,
    which is a completely different algorithm (a Voronoi-based cell search) and
    therefore a real oracle. On the sample house the two agree to 4 mm, and
    where they differ this one is the exact answer: the bedroom's largest circle
    is 3.4625 m, which is the room's own clear width to the millimetre, and
    GEOS's tolerance-bounded search returns a shade less.
    """
    if polygon is None or polygon.is_empty or polygon.area <= 0:
        return None
    min_x, min_y, max_x, max_y = polygon.bounds
    low = 0.0
    high = max(max_x - min_x, max_y - min_y) / 2.0 + COORDINATE_TOLERANCE
    best = None
    for _ in range(INSCRIBED_STEPS):
        mid = (low + high) / 2.0
        eroded = polygon.buffer(-mid, quad_segs=BUFFER_QUAD_SEGS)
        if eroded.is_empty or eroded.area <= 0:
            high = mid
        else:
            low = mid
            best = eroded
    if best is None:
        return None
    centre = best.representative_point()
    return low, (float(centre.x), float(centre.y))


def _free_floor(model: SpatialModel, space: Any, skip: set[str] | None = None) -> _FreeFloor | Answer[Any] | None:
    """The room's footprint minus the plan shadow of everything standing on it.

    Two polygons come back, not one, and which of them is the answer is the
    judgment this module is most exposed on:

      - ``fixed`` — the footprint less everything that is not
        ``IfcFurnishingElement`` and its kin: walls bulging in, columns, stairs,
        sanitary fittings, the door leaf where the export modelled it.
      - ``furnished`` — the same, less the loose furniture as well.

    The **headline is ``fixed``**, and the reason is what a building permit is
    granted on. The furniture in an IFC export is a presentation layer — the
    sample house's living room carries a piano, a couch, two Viper chairs and
    six dining chairs, placed by whoever made the visualisation — and an
    applicant is not bound to any of it. Reporting a room as too small to turn in
    because somebody left a coffee table in the render would be a finding about
    the render. But the furnished figure travels beside it in every answer,
    because a room that only turns when it is empty is a real design finding and
    the architect is the one who gets to decide which of the two matters.

    Candidates come from ``tree.select_box`` — the cheap broad phase — rather
    than from ``bounds()``, which is the right list for a different question:
    ``bounds`` deliberately drops anything CONTAINED in the room, and containment
    is exactly what a turning circle is about.
    """
    geo = model.geometry(space.GlobalId)
    if geo is None:
        return None
    footprint = _plan_footprint(geo.triangles)
    if footprint is None or footprint.is_empty:
        return None

    floor_z = float(geo.box[0][2])
    free = _FreeFloor(footprint, floor_z)
    skip = skip or set()

    for element in model.tree.select_box(space, extend=CONTACT_EXTEND):
        global_id = getattr(element, "GlobalId", None)
        if not global_id or global_id == space.GlobalId or global_id in skip:
            continue
        if element.is_a() in AIR_TYPES:
            continue
        other = model.geometry(global_id)
        if other is None:
            continue
        # The floor-contact rule. An element obstructs the clear floor when it
        # reaches DOWN to it: a ceiling at 2.20 m and a roof at 2.50 m project
        # over the whole room and take none of its floor away.
        if not (float(other.box[0][2]) <= floor_z + FLOOR_CONTACT < float(other.box[1][2])):
            continue
        free.triangles += len(other.triangles)
        if free.triangles > FREE_FLOOR_MAX_TRIANGLES:
            return _too_many_triangles(model, space, free.triangles)
        silhouette = _plan_silhouette(other.triangles)
        if silhouette is None:
            continue
        try:
            intruding = silhouette.intersection(footprint)
        except Exception:
            continue
        if intruding.area <= MIN_OBSTACLE_AREA:
            continue
        loose = _is_furnishing(element)
        free.furnished = free.furnished.difference(silhouette)
        if not loose:
            free.fixed = free.fixed.difference(silhouette)
        free.obstacles.append(
            {
                "globalId": global_id,
                "name": model.label(element),
                "ifcType": element.is_a(),
                "area": round(float(intruding.area), 4),
                "counts": "furnished" if loose else "fixed",
            }
        )

    free.obstacles.sort(key=lambda o: (-o["area"], o["globalId"]))
    return free


def _too_many_triangles(model: SpatialModel, space: Any, count: int) -> Answer[Any]:
    name = model.label(space) or space.GlobalId
    return undecidable(
        from_=[space.GlobalId],
        method=f"freieBodenfläche({space.GlobalId})",
        provenance="computed",
        missing=MissingFact(
            what=f"die freie Bodenfläche von „{name}“ ist für diese Auswertung zu fein tesselliert",
            remedy=(
                f"In diesem Raum stehen Bauteile mit zusammen über {count} Dreiecken. Die Grundrissprojektion "
                f"wird ab {FREE_FLOOR_MAX_TRIANGLES} Dreiecken nicht begonnen, weil ihre Laufzeit überlinear "
                "wächst und eine Anfrage sonst nicht zurückkommt. Abhilfe: das Modell mit gröberer "
                "Tessellierung exportieren, oder diesen Raum in einem Worker ohne Anfragezeitlimit auswerten."
            ),
            elements=[space.GlobalId],
        ),
    )


def _facing_area(triangles: np.ndarray, normal: np.ndarray) -> float:
    """Area of the vertical faces that look along ``normal`` — the frame's own face.

    The same selection :func:`geometry.dominant_vertical_plane` makes when it
    picks the winning bin, re-summed here because that function returns a
    direction and not the area that won it, and the area is what
    :func:`_is_floor_void` weighs.
    """
    normals, areas = triangle_normals_areas(triangles)
    facing = (np.abs(normals[:, 2]) < VERTICAL_TOLERANCE) & (np.abs(normals[:, :2] @ normal) >= PARALLEL_DOT)
    return float(areas[facing].sum())


def _is_floor_void(model: SpatialModel, element: Any, geo: Any) -> bool:
    """Is this aperture a hole in a FLOOR rather than a hole in a wall?

    The failure this decides: ``AC20-FZK-Haus``'s gallery void
    ``16PF6khT5_p$Z03P73inyv`` („Slab Opening", 4.26 × 3.71 m in plan, 0.20 m
    thick, hosted in the ``IfcSlab`` „Slab-033"). It has vertical faces — the
    four sides of the prism — so ``dominant_vertical_plane`` happily returns one
    of them and the wall measurement then probes 0.30 m to either side IN PLAN,
    lands on the room below on one side and the terrain on the other, both at
    z = 0.0, and reports „fall 0.000 m, parapet 2.500 m" at the one edge in the
    house that carries both of the model's railings. A parapet of 2.5 m at a
    floor void is not a physical quantity.

    Two independent signals, and the geometric one decides:

    - **plan against face.** The frame would be built from the largest vertical
      face; the aperture's plan rectangle is the hole itself. When the hole seen
      from above is LARGER than the face the frame would stand on, the body is a
      slab void and not a wall reveal. Measured: the gallery void is 15.805 m²
      of plan against 1.484 m² of face, a factor of ten. Every opening in
      ``Ifc4_SampleHouse`` runs the other way by as much — its window reveals
      0.525 m² of plan against 4.380 m² of face, its internal doors 0.077 m²
      against 3.418 m². The ratio rather than any absolute thickness is what
      keeps a wide, low strip window on the wall side where it belongs: at
      3.00 × 0.50 × 0.40 m that is 1.50 m² of plan against 2.40 m² of face.
    - **the host.** An aperture hosted in an ``IfcWall`` is a wall opening
      whatever its proportions, and is refused here rather than measured
      downward. ``hosted_in`` is consulted only to VETO, so a file with no
      ``IfcRelVoidsElement`` still gets the geometric answer.
    """
    from .operators import hosted_in

    normal3 = dominant_vertical_plane(geo.triangles)
    if normal3 is not None:
        normal = np.array([float(normal3[0]), float(normal3[1])])
        length = float(np.linalg.norm(normal))
        if length >= 1e-9:
            normal = normal / length
            lateral = np.array([-normal[1], normal[0]])
            points = geo.verts[:, :2]
            across = points @ lateral
            through = points @ normal
            plan = float(across.max() - across.min()) * float(through.max() - through.min())
            if plan <= _facing_area(geo.triangles, normal):
                return False

    host = hosted_in(model, element.GlobalId)
    if host.decidable and host.value:
        hosting = model.file.by_guid(host.value[0].global_id)
        if any(hosting.is_a(name) for name in _VERTICAL_HOSTS):
            return False
    return True


def _frame_of(model: SpatialModel, element: Any) -> _Frame | None:
    """The opening's plan frame, or ``None`` when it has no vertical plane.

    ``None`` is a real case and not a failure: a roof light in a flat roof has no
    vertical plane, so "in front of it" and "on the far side of it" are not
    defined in plan. Every caller turns this into an undecidable that says so.

    A body that HAS vertical faces can still be a hole in a floor — the sides of
    the prism are vertical — and for those this returns ``None`` as well. See
    :func:`_is_floor_void` for the measured numbers; ``balustrade_check`` then
    measures the fall downward through it instead, and the other two callers
    refuse, which is right: a threshold height and a clear approach at a gallery
    void are not defined either.
    """
    from .operators import hosted_in

    geo = model.geometry(element.GlobalId)
    if geo is None or len(geo.triangles) == 0:
        return None
    normal3 = dominant_vertical_plane(geo.triangles)
    if normal3 is None:
        return None
    normal = np.array([float(normal3[0]), float(normal3[1])])
    length = float(np.linalg.norm(normal))
    if length < 1e-9:
        return None
    if _is_floor_void(model, element, geo):
        return None
    normal = normal / length
    frame = _Frame(normal, np.array([-normal[1], normal[0]]))

    points = geo.verts[:, :2]
    across = points @ frame.lateral
    through = points @ frame.normal
    frame.u_min, frame.u_max = float(across.min()), float(across.max())
    frame.v_min, frame.v_max = float(through.min()), float(through.max())
    frame.z_min, frame.z_max = float(geo.box[0][2]), float(geo.box[1][2])

    host = hosted_in(model, element.GlobalId)
    if host.decidable and host.value:
        host_geo = model.geometry(host.value[0].global_id)
        if host_geo is not None:
            host_through = host_geo.verts[:, :2] @ frame.normal
            frame.host_min = float(host_through.min())
            frame.host_max = float(host_through.max())
    return frame


def _no_plane(model: SpatialModel, element: Any, method: str) -> Answer[Any]:
    name = model.label(element) or element.GlobalId
    return undecidable(
        from_=[element.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"keine senkrechte Öffnungsebene an {element.is_a()} „{name}“",
            remedy=(
                "Diese Messung braucht die Ebene der Öffnung, um „davor“ und „dahinter“ überhaupt zu "
                "definieren. Dieses Bauteil hat entweder keinen Körper im Export, oder es liegt waagrecht "
                "(ein Dachflächenfenster in einem Flachdach) und hat damit keine senkrechte Ebene. Abhilfe: "
                "den Export mit Körpergeometrie sowie mit Öffnungen und Füllungen wiederholen."
            ),
            elements=[element.GlobalId],
        ),
    )


def _spaces_by_side(model: SpatialModel, element: Any, frame: _Frame) -> dict[float, Any]:
    """Which room lies on which side of the opening, keyed by the sign along ``n``.

    ``opens_to`` gives the rooms; it does not say which side each is on, and for
    a door between two rooms that is the entire question. The test is the
    projection of the room's own area-weighted centroid onto the opening's
    normal — a room is on the ``+`` side when its centre is beyond the opening's
    own extent in ``+n``. A centroid rather than a box centre because an L-shaped
    room's box centre can sit outside the room.
    """
    from .operators import opens_to

    found: dict[float, Any] = {}
    answer = opens_to(model, element.GlobalId)
    if not answer.decidable or not answer.value:
        return found
    for ref in answer.value:
        geo = model.geometry(ref.global_id)
        if geo is None:
            continue
        through = float(np.array(geo.centroid[:2]) @ frame.normal)
        sign = 1.0 if through > (frame.v_min + frame.v_max) / 2.0 else -1.0
        # First room wins a side. Two rooms projecting onto the same side happens
        # when a door sits in a re-entrant corner; reporting the second as if it
        # were the far side would invent a step that is not there.
        found.setdefault(sign, model.file.by_guid(ref.global_id))
    return found


def _surface_below(model: SpatialModel, x: float, y: float, z: float) -> tuple[float, Any] | None:
    """The solid surface a person standing at ``(x, y)`` would be standing on.

    Cast downward from ``z``, first hit wins, air and furniture excluded — a
    doormat is not a floor level. When the probe point is already INSIDE a solid
    the ray would come out of its far side, so that case is answered from the
    occupying solid's box top instead: the ground outside is HIGHER than the
    opening's underside, which is a step up rather than a step down, and the box
    top is exact for the flat slab that produces it and an upper bound for a
    sloping one.
    """
    point = (float(x), float(y), float(z))
    occupying = [
        e
        for e in model.tree.select(point)
        if getattr(e, "GlobalId", None) and e.is_a() not in AIR_TYPES and not _is_furnishing(e)
    ]
    if occupying:
        best = None
        for element in occupying:
            geo = model.geometry(element.GlobalId)
            if geo is None:
                continue
            top = float(geo.box[1][2])
            if best is None or top > best[0]:
                best = (top, element)
        if best is not None:
            return best

    hits = sorted(
        model.tree.select_ray(point, (0.0, 0.0, -1.0), length=model.diagonal),
        key=lambda h: float(h.distance),
    )
    for hit in hits:
        element = model.file.by_id(hit.instance.id())
        if element.is_a() in AIR_TYPES or _is_furnishing(element):
            continue
        return float(point[2]) - float(hit.distance), element
    return None


def _standing_level(model: SpatialModel, element: Any, frame: _Frame, sign: float, space: Any | None) -> dict[str, Any]:
    """The level of the surface somebody stands on, on one side of an opening.

    Two routes, and the answer says which one it took, because they are not the
    same claim:

      - **the room body** — ``IfcSpace``'s own underside. That is the finished
        floor if and only if the room was modelled from finished floor level,
        which is the usual convention and not a guarantee. Cross-checked against
        the slab under it, and a disagreement is reported rather than resolved.
      - **a ray outside** — when no ``IfcSpace`` is on this side, which is the
        normal case for an external door. Then the level is whatever solid the
        ray finds, and its type travels with it: an ``IfcSlab`` under a door is a
        threshold; an ``IfcRoof`` would mean the probe went somewhere unintended.
    """
    from .daylight import below

    entry: dict[str, Any] = {
        "direction": [round(float(frame.normal[0] * sign), 4), round(float(frame.normal[1] * sign), 4)],
        "space": None,
        "spaceName": None,
        "level": None,
        "via": None,
        "surface": None,
    }
    if space is not None:
        geo = model.geometry(space.GlobalId)
        if geo is not None:
            entry["space"] = space.GlobalId
            entry["spaceName"] = model.label(space)
            entry["level"] = round(float(geo.box[0][2]), 4)
            entry["via"] = "Unterkante des Raumkörpers (IfcSpace)"
            under = below(model, space.GlobalId, samples=3)
            if under.decidable and under.value:
                nearest = under.value[0]
                entry["surface"] = {
                    "globalId": nearest["globalId"],
                    "name": nearest["name"],
                    "ifcType": nearest["ifcType"],
                    "top": round(float(entry["level"]) - float(nearest["gap"]), 4),
                    "gap": nearest["gap"],
                }
            return entry

    face = frame.outer_face(sign)
    plan = frame.point(frame.u_centre, face + sign * OUTSIDE_PROBE)
    found = _surface_below(model, float(plan[0]), float(plan[1]), frame.z_min + PROBE_LIFT)
    if found is None:
        return entry
    level, hit = found
    entry["level"] = round(level, 4)
    entry["via"] = f"Strahl nach unten, {OUTSIDE_PROBE:.2f} m vor der Öffnung (kein IfcSpace auf dieser Seite)"
    entry["surface"] = {
        "globalId": hit.GlobalId,
        "name": model.label(hit),
        "ifcType": hit.is_a(),
        "top": round(level, 4),
        "gap": None,
    }
    return entry


def _levels_both_sides(model: SpatialModel, element: Any, frame: _Frame) -> list[dict[str, Any]]:
    spaces = _spaces_by_side(model, element, frame)
    return [_standing_level(model, element, frame, sign, spaces.get(sign)) for sign in (1.0, -1.0)]
