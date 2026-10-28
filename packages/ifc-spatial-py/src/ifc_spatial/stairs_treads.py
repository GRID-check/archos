"""Tread and walking surfaces, landings, runs and the turn of each run, measured from the geometry."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ifc_spatial.stairs_constants import BASE_RISER_RELATIVE_SLACK
from ifc_spatial.stairs_constants import BURIED_CLEARANCE
from ifc_spatial.stairs_constants import BURIED_OVERLAP_FRACTION
from ifc_spatial.stairs_constants import FLIGHT_STRAIGHTNESS
from ifc_spatial.stairs_constants import FLIGHT_TURN_DEGREES
from ifc_spatial.stairs_constants import LANDING_AREA_FACTOR
from ifc_spatial.stairs_constants import PLAUSIBLE_RISER
from ifc_spatial.stairs_constants import TREAD_FLATNESS
from ifc_spatial.stairs_constants import TREAD_NORMAL_DOT
from ifc_spatial.stairs_records import _Flight
from ifc_spatial.stairs_records import _Tread

from .clearance import _usable_triangles
from .geometry import FACE_AREA_FRACTION
from .geometry import MIN_FACE_AREA
from .geometry import triangle_normals_areas
from .model import ElementGeometry
from .operators import COORDINATE_TOLERANCE
from .operators import MIN_INTRUSION


def _tread_surfaces(geo: ElementGeometry) -> list[tuple[float, float, np.ndarray, np.ndarray]]:
    """Up-facing horizontal faces of a body, clustered by height.

    Returns ``(z, area, centre, vertices)`` per cluster, ascending. Slivers are
    dropped by the same rule ``geometry.outermost_parallel_face`` uses — a face
    carries a cluster only if it holds :data:`~ifc_spatial.geometry.FACE_AREA_FRACTION`
    of the largest one — because a 20 mm nosing chamfer is up-facing, horizontal
    and NOT a step, and one of those between two real treads would split a
    0.18 m riser into two of 0.16 and 0.02.
    """
    tris = _usable_triangles(geo)
    if len(tris) == 0:
        return []
    normals, areas = triangle_normals_areas(tris)
    level = (tris[:, :, 2].max(axis=1) - tris[:, :, 2].min(axis=1)) <= TREAD_FLATNESS
    up = (normals[:, 2] >= TREAD_NORMAL_DOT) & level
    if not up.any():
        return []
    tris = tris[up]
    areas = areas[up]
    heights = tris.mean(axis=1)[:, 2]

    order = np.argsort(heights)
    clusters: list[list[int]] = []
    for index in order:
        if clusters and abs(float(heights[index]) - float(heights[clusters[-1][-1]])) <= COORDINATE_TOLERANCE:
            clusters[-1].append(int(index))
        else:
            clusters.append([int(index)])

    out: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for members in clusters:
        member_areas = areas[members]
        total = float(member_areas.sum())
        if total <= 0:
            continue
        centroids = tris[members].mean(axis=1)
        centre = (centroids * member_areas[:, None]).sum(axis=0) / total
        z = float((heights[members] * member_areas).sum() / total)
        out.append((z, total, centre, tris[members].reshape(-1, 3)))

    if not out:
        return []
    floor = max(max(c[1] for c in out) * FACE_AREA_FRACTION, MIN_FACE_AREA)
    return [c for c in out if c[1] >= floor]


def _plan_polygon(vertices: np.ndarray) -> Any:
    """The plan outline of one cluster, as a shapely polygon.

    ``vertices`` is the flattened triangle array ``_tread_surfaces`` carries, so
    it reshapes back into the triangles it was made of — the union of those in
    plan is the face's real outline. A bounding box would not do: two consecutive
    treads of a flight running diagonally in plan have boxes that overlap by more
    than half while the treads themselves only touch along their nosing, and the
    buried-face rule below would then delete every second step.
    """
    import shapely
    import shapely.ops

    polygons = []
    for tri in vertices.reshape(-1, 3, 3):
        polygon = shapely.Polygon(tri[:, :2])
        if polygon.is_valid and polygon.area > 0:
            polygons.append(polygon)
    if not polygons:
        return None
    return shapely.ops.unary_union(polygons)


def _walking_surfaces(
    clusters: list[tuple[float, float, np.ndarray, np.ndarray]],
) -> list[tuple[float, float, np.ndarray, np.ndarray]]:
    """The clusters a foot can land on — the buried ones dropped.

    A horizontal face with another horizontal face of the same body directly
    above it is not a step; it is under one. ArchiCAD writes each step of
    ``AC20-Institute-Var-2.ifc`` as a structural step and a tread finish 60 mm
    above it, both up-facing and both level, and every step was therefore counted
    twice: **45 risers of 0.065 m** on a stair with 21 of 0.137 m, with the
    doubled count and the halved riser both reported as measurements. The same
    rule removes the four faces that sit 0.20 m under that stair's landings.

    The test is the physical one and not a spacing heuristic: overlap in plan by
    more than :data:`BURIED_OVERLAP_FRACTION` of the lower face's own area, with
    the upper face within :data:`BURIED_CLEARANCE`. Consecutive treads of a real
    flight are offset by their going and do not overlap at all, so nothing a foot
    can reach is dropped by it.
    """
    if len(clusters) < 2:
        return list(clusters)

    polygons = [_plan_polygon(vertices) for _, _, _, vertices in clusters]
    keep: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for index, cluster in enumerate(clusters):
        mine = polygons[index]
        buried = False
        for other in range(index + 1, len(clusters)):
            gap = clusters[other][0] - cluster[0]
            if gap > BURIED_CLEARANCE:
                break  # ascending, so everything past this one is further up
            theirs = polygons[other]
            if mine is None or theirs is None or mine.area <= 0:
                continue
            if mine.intersection(theirs).area >= BURIED_OVERLAP_FRACTION * mine.area:
                buried = True
                break
        if not buried:
            keep.append(cluster)
    return keep


def _landing_levels(clusters: list[tuple[float, float, np.ndarray, np.ndarray]]) -> list[bool]:
    """Which of these surfaces are Podeste — by area against the median tread.

    A landing is not a step and must not be measured as one: on the Institute
    stair the two landings are 2.518 m² and 2.783 m² against a median tread of
    0.598 m², and taking them as treads is what produced „Auftritte 0.023 m bis
    1.053 m" there. The median is the tread, because a flight has many more
    treads than landings; :data:`LANDING_AREA_FACTOR` is the factor between them.
    """
    if not clusters:
        return []
    median = float(np.median([area for _, area, _, _ in clusters]))
    if median <= 0:
        return [False] * len(clusters)
    return [area > LANDING_AREA_FACTOR * median for _, area, _, _ in clusters]


def _runs(
    clusters: list[tuple[float, float, np.ndarray, np.ndarray]], landings: list[bool]
) -> list[tuple[list[int], bool, bool]]:
    """Split the levels into flights: ``(tread indices, Podest below, above)``.

    Two things end a flight and they are both what ends one on a drawing:

    * **a Podest.** It is the head of the flight under it and the foot of the
      flight over it, and it belongs to neither one's Auftritt.
    * **a turn.** Where the plan direction from one tread to the next swings by
      more than :data:`FLIGHT_TURN_DEGREES`, the treads after the turn are a
      different flight — the case a dogleg makes when the export writes no
      ``IfcStairFlight`` at all, which is the ArchiCAD case this exists for.

    Indices rather than the clusters themselves, because a cluster carries numpy
    arrays and ``list.index`` on one of those raises rather than compares.
    """
    groups: list[tuple[list[int], bool, bool]] = []
    current: list[int] = []
    carried_landing = False
    for index in range(len(clusters)):
        if landings[index]:
            if current:
                groups.append((current, carried_landing, True))
            current, carried_landing = [], True
            continue
        if len(current) >= 2:
            previous = clusters[current[-1]][2][:2] - clusters[current[-2]][2][:2]
            step = clusters[index][2][:2] - clusters[current[-1]][2][:2]
            if _turn_degrees(previous, step) > FLIGHT_TURN_DEGREES:
                groups.append((current, carried_landing, False))
                current, carried_landing = [], False
        current.append(index)
    if current:
        groups.append((current, carried_landing, False))
    return groups


def _turn_degrees(first: np.ndarray, second: np.ndarray) -> float:
    """Angle between two plan steps, in degrees. 0° for a degenerate one."""
    a, b = float(np.linalg.norm(first)), float(np.linalg.norm(second))
    if a < 1e-9 or b < 1e-9:
        return 0.0
    cosine = float(np.clip(np.dot(first, second) / (a * b), -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def _measure_run(
    element: Any,
    treads_in: list[tuple[float, float, np.ndarray, np.ndarray]],
    *,
    base_z: float,
    landing_below: tuple[float, float, np.ndarray, np.ndarray] | None,
    landing_above: tuple[float, float, np.ndarray, np.ndarray] | None,
    alone: bool = False,
) -> tuple[_Flight | None, str | None]:
    """One straight run → a ``_Flight``, or ``None`` and the reason in German.

    The refusals are the point of this function. A stair that cannot be measured
    has to say so: the reader has already shipped „Nutzbreite 0.318 m" for a
    1.500 m flight and „16 Steigungen von 0.177 m bis 0.850 m" for a
    Wendeltreppe, and both were `decidable=True` with a confident number in them.
    Nothing here reports a value it could not derive.

    ``alone`` says this run is the whole body. A body that shows exactly one
    tread is a Blockstufe and is measured; a run of one tread cut out of a longer
    sequence by a turn on either side is a winder step, and at one of those there
    is no direction of travel to measure an Auftritt or a Nutzbreite along.
    """
    if len(treads_in) < 2 and landing_below is None and landing_above is None and not alone:
        return None, (
            "Ein Abschnitt des Körpers besteht aus einer einzelnen Trittfläche zwischen zwei "
            "Richtungswechseln. An einer gewendelten Stufe sind Auftritt und Nutzbreite nicht messbar."
        )

    if len(treads_in) >= 2:
        travel = treads_in[-1][2][:2] - treads_in[0][2][:2]
        length = float(np.linalg.norm(travel))
        if length < 1e-9:
            # Every tread centre over the same point in plan — a spiral flight
            # that closes on itself. Direction-based measurements are meaningless
            # here and pretending otherwise is how a Wendeltreppe gets reported
            # with a 0.00 m Auftritt.
            return None, (
                "Die Trittflächen liegen in der Draufsicht übereinander — ein Lauf, der sich um seine "
                "eigene Achse dreht. Auftritt und Nutzbreite sind daran nicht messbar."
            )
        along = np.array([travel[0] / length, travel[1] / length, 0.0])
    else:
        # A single tread between two Podeste is a real thing (one step down into
        # a room). Its travel direction is the SHORT axis of the tread: a step is
        # wide across and shallow along, so the short side of its own minimal
        # rectangle is the direction a person walks.
        along = _short_axis(treads_in[0][3])
        if along is None:
            return None, (
                "Eine einzelne Trittfläche ohne erkennbare Laufrichtung — an ihr ist keine Laufrichtung "
                "und damit keine Nutzbreite messbar."
            )
    across = np.array([-along[1], along[0], 0.0])

    if len(treads_in) >= 3:
        # Collinearity. A straight flight holds its tread centres on the line
        # through the first and the last to within tessellation noise; a winder
        # bows off it by half a metre, and every directional number measured
        # across that bow is a number about a chord and not about a step.
        first = treads_in[0][2][:2]
        last = treads_in[-1][2][:2]
        direction = last - first
        direction = direction / float(np.linalg.norm(direction))
        # The 2-D cross product, written out: numpy 2.0 deprecates `np.cross` on
        # 2-vectors and the perpendicular offset of a point from a unit line is
        # exactly this scalar.
        offsets = [
            abs(float(direction[0] * (cluster[2][1] - first[1]) - direction[1] * (cluster[2][0] - first[0])))
            for cluster in treads_in
        ]
        deviation = max(offsets)
        if deviation > FLIGHT_STRAIGHTNESS:
            return None, (
                f"Die Trittflächen liegen nicht auf einer Geraden: ihre Mitten weichen bis zu "
                f"{deviation:.3f} m von der Verbindungslinie zwischen erster und letzter Trittfläche ab. "
                "Das ist ein gewendelter Lauf; Steigung, Auftritt und Nutzbreite eines gewendelten Laufs "
                "sind entlang der Lauflinie zu messen, und die Lauflinie steht in dieser Datei nicht."
            )

    treads: list[_Tread] = []
    for z, area, centre, vertices in treads_in:
        a = vertices @ along
        b = vertices @ across
        treads.append(
            _Tread(z=z, area=area, centre=centre, span=(float(a.min()), float(a.max()), float(b.min()), float(b.max())))
        )

    levels = [t.z for t in treads]
    steps = [levels[i + 1] - levels[i] for i in range(len(levels) - 1)]
    if landing_below is not None:
        # The Podest under a flight IS its floor line, so the step up off it is
        # this flight's bottom riser and there is nothing to guess about.
        bottom = levels[0] - landing_below[0]
        base_riser_used = True
    else:
        bottom = levels[0] - base_z
        if steps:
            median = float(np.median(steps))
            base_riser_used = abs(bottom - median) <= BASE_RISER_RELATIVE_SLACK * median
        else:
            # Nothing to compare against. The body's underside is the only
            # candidate for a floor line, and the caveat says the measurement
            # rests on it.
            base_riser_used = bottom > MIN_INTRUSION
    risers = ([bottom] if base_riser_used else []) + steps
    if landing_above is not None:
        risers = risers + [landing_above[0] - levels[-1]]

    if risers:
        median_riser = float(np.median(risers))
        low, high = PLAUSIBLE_RISER
        if not low <= median_riser <= high:
            return None, (
                f"Die am Körper gemessene Steigungshöhe wäre {median_riser:.3f} m. Eine Stufe dieser Höhe "
                f"gibt es nicht (messbar sind {low:.2f} m bis {high:.2f} m) — die waagrechten Flächen dieses "
                "Körpers sind an dieser Stelle keine Stufen, sondern etwa Belagsschichten oder Auflager."
            )

    goings = [float(np.linalg.norm(treads[i + 1].centre[:2] - treads[i].centre[:2])) for i in range(len(treads) - 1)]
    widths = [t.span[3] - t.span[2] for t in treads]
    # The nosing is the FRONT edge of the tread — its minimum along the travel
    # direction — held at the tread's own lateral centre.
    nosings = np.array(
        [[*(t.centre[:2] + along[:2] * (t.span[0] - float(t.centre[:2] @ along[:2]))), t.z] for t in treads]
    )

    return (
        _Flight(
            global_id=element.GlobalId,
            treads=treads,
            risers=risers,
            base_riser_used=base_riser_used,
            goings=goings,
            clear_width=float(min(widths)),
            total_going=float(treads[-1].span[1] - treads[0].span[0]),
            total_rise=float(sum(risers)),
            along=along,
            across=across,
            nosings=nosings,
            landing_below=landing_below is not None,
            landing_above=landing_above is not None,
        ),
        None,
    )


def _short_axis(vertices: np.ndarray) -> np.ndarray | None:
    """Unit plan direction across the SHORT side of a face's minimal rectangle."""
    import shapely

    polygon = _plan_polygon(vertices)
    if polygon is None or polygon.area <= 0:
        return None
    rectangle = shapely.minimum_rotated_rectangle(polygon)
    corners = np.array(rectangle.exterior.coords[:-1]) if hasattr(rectangle, "exterior") else None
    if corners is None or len(corners) != 4:
        return None
    sides = [corners[(i + 1) % 4] - corners[i] for i in range(4)]
    shortest = min(sides[:2], key=lambda side: float(np.linalg.norm(side)))
    length = float(np.linalg.norm(shortest))
    if length < 1e-9:
        return None
    return np.array([shortest[0] / length, shortest[1] / length, 0.0])
