"""Plan measures: extent, floor area and the footprint they rest on."""

from __future__ import annotations

from typing import Any

import ifcopenshell.util.shape as us
import numpy as np

from ifc_spatial.operators_constants import AREA_RELATIVE_TOLERANCE
from ifc_spatial.operators_constants import DIMENSION_TOLERANCE
from ifc_spatial.operators_guards import _geometry_or_answer
from ifc_spatial.operators_guards import _require

from .envelope import Answer
from .envelope import computed
from .envelope import declared
from .envelope import triangulate
from .geometry import dominant_vertical_plane
from .geometry import triangle_normals_areas
from .model import SpatialModel

# ════════════════════════════════════════════════════════════════════════════
# metric — numbers off the geometry, each with its error attached
# ════════════════════════════════════════════════════════════════════════════


def extent(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The element's bounding box and its three axis-aligned dimensions, in metres.

    ``ifcopenshell.util.shape.get_bbox`` over the world-coordinate vertices.

    The box is **axis-aligned to the MODEL**, not to the element: a wall running
    at 30° in plan has a bounding box far wider and deeper than the wall, and
    reporting that box's ``width`` as the wall's length would be wrong by a
    factor. When the element's own facade plane shows it is skewed to the model
    axes, the answer says so in a caveat rather than leaving the reader to notice.
    """
    method = f"extent({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    low, high = us.get_bbox(geo.verts)
    width, depth, height = (high - low).tolist()

    caveat = None
    normal = dominant_vertical_plane(geo.triangles)
    if normal is not None and abs(normal[0]) > 0.1 and abs(normal[1]) > 0.1:
        caveat = (
            "Dieses Bauteil steht schräg zu den Modellachsen. Breite und Tiefe sind die Ausdehnung der "
            "achsparallelen Hüllbox, NICHT Länge und Dicke des Bauteils selbst — diese Zahlen sind für ein "
            "schräges Bauteil systematisch zu groß."
        )

    return computed(
        {
            "box": {"min": low.tolist(), "max": high.tolist()},
            "width": width,
            "depth": depth,
            "height": height,
            "centroid": geo.centroid.tolist(),
        },
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=caveat,
    )


def floor_area(model: SpatialModel, global_id: str, declared_area: float | None = None) -> Answer[float]:
    """The element's floor area in m² — for a space, its usable plan area.

    BESSER, twice over:

    1. The TS operator sums the XY-projected areas of downward-facing triangles.
       :func:`_footprint_area` projects them and takes the shapely UNION, so two
       horizontal faces at different heights over the same plan — a stepped
       floor, a slab modelled with its screed — cannot double-count. It also
       measures from **both** sides, because an inside-out ``IfcSpace`` is not
       rare; see that function for the 0 m² room that made it necessary.
    2. The declared quantity is found here instead of being passed in. The TS
       operator takes ``declaredArea`` as a parameter because that library has no
       property access, so a host that forgets to read the quantity set gets a
       single-route answer. This searches every pset — which matters, because the
       corpus publishes room areas under four different names in four dialects
       (``BaseQuantities``, ``SpaceQuantities``, ``GSA Space Areas``,
       ``PSet_Revit_Dimensions``) and a search restricted to the canonical
       ``Qto_SpaceBaseQuantities`` finds none of them — and converts the value
       out of the file's own unit, because an export in square feet is not a
       disagreement with an export in square metres.

    Agreement raises confidence in the schedule; DISAGREEMENT is a finding about
    the export the architect can act on. :func:`~ifc_spatial.envelope.triangulate`
    writes the German caveat and reports the measured value when the two differ.
    """
    subject_id = global_id
    method = (
        f"floorArea({subject_id})" if declared_area is None else f"floorArea({subject_id}, declared={declared_area})"
    )
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    area = _footprint_area(geo.triangles)
    caveat = None
    if area == 0:
        caveat = (
            "Gemessene Grundfläche 0 m²: dieses Bauteil hat Geometrie, aber keine horizontalen Flächen "
            "(eine Wand, ein Pfosten). Das ist ein Messergebnis, keine fehlende Angabe."
        )
    measured = computed(
        area,
        unit="m²",
        tolerance=abs(area) * AREA_RELATIVE_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=caveat,
    )

    found = None
    declared_method = f"NetFloorArea({global_id})"
    declared_caveat = None
    if declared_area is None:
        # `Area` and `NetArea` mean "floor area" only on something that HAS a
        # floor. On a wall, Revit's `Dimensions.Area` is the elevation area —
        # 26.48 m² against this wall's 4.10 m² of footprint — and triangulating
        # the two produced "die Datei widerspricht sich" on every wall of every
        # Revit export. Both numbers were right; they measure different things,
        # and it is the comparison that was wrong. So the ambiguous names are
        # only consulted for a spatial element.
        names = ("NetFloorArea", "GrossFloorArea")
        if model.kind_of(subject) == "space":
            names = ("NetFloorArea", "NetArea", "GrossFloorArea", "Area")
        found = model.declared_quantity(subject, names)
        if found is None:
            return measured
        declared_area = found.value
        declared_method = f"{found.path}({global_id})"
        if found.scale != 1.0:
            declared_caveat = (
                f"Die Datei deklariert {found.raw:.4f} {found.unit_label or '(Einheit der Datei)'}; "
                f"umgerechnet {found.value:.4f} m². Verglichen wird in Metern."
            )
    else:
        # A caller-supplied number is assumed to be SI already; it has to be,
        # because nothing here can tell which unit the caller measured in.
        declared_area = float(declared_area)

    # The measured value goes in first because `triangulate` reports the COMPUTED
    # side when the two disagree: a declared quantity that contradicts the
    # geometry it describes is the thing under suspicion.
    answer = triangulate(
        measured,
        declared(declared_area, unit="m²", from_=[global_id], method=declared_method),
        method=method,
    )
    if declared_caveat:
        answer.caveat = f"{answer.caveat} {declared_caveat}" if answer.caveat else declared_caveat
    return answer


def _vector_text(value: Any) -> str:
    """A vector as it should read back in a `method`, whatever was passed in."""
    try:
        return "[" + ", ".join(f"{float(c):.3f}" for c in value) + "]"
    except TypeError, ValueError:
        return repr(value)


def _footprint_area(triangles: np.ndarray) -> float:
    """The plan area of a solid, measured from whichever side its faces point.

    ``util.shape.get_footprint_area`` keeps only triangles whose normal points
    **towards** the given direction, so it silently returns ``0.0`` for a mesh
    wound inside-out. Which is exactly what a Revit IFC2X3 ``IfcSpace`` is: the
    Duplex apartment's *Hallway* has 28 downward-facing faces, no upward ones,
    and reported **0 m² of floor** against a declared 7.80 m² — with a caveat
    claiming the element has no horizontal surfaces, which was false. A confident
    zero is the worst thing this library can produce, because zero is a number an
    agent will put in a sentence.

    Asking IfcOpenShell for the other direction is not a fix: ``direction=(0, 0,
    -1)`` builds a degenerate basis inside ``get_footprint_area`` and raises
    ``GEOSException: Points of LinearRing do not form a closed linestring``
    (0.8.5, ``util/shape.py:611``) — so the down-facing projection is done here.
    The method is the same one: keep the faces whose normal points along the
    direction, project them to the plane, and take the shapely UNION so
    overlapping horizontal faces cannot double-count.

    Both projections are taken and the larger wins. For a closed solid the two
    silhouettes have the same area, so nothing changes where the winding was
    already right: the sample house's rooms still measure 15.41678125 /
    51.994825 / 8.69350625 m², identical to the IfcOpenShell values the parity
    suite asserts.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return 0.0
    normals, _ = triangle_normals_areas(triangles)
    best = 0.0
    for sign in (1.0, -1.0):
        # 0.01 is IfcOpenShell's own `normal_tol`: close to perpendicular, with
        # a fuzz for numerical noise. Kept identical so the two agree face for
        # face on a correctly wound mesh.
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
            best = max(best, float(shapely.ops.unary_union(polygons).area))
        except Exception:
            continue
    return best
