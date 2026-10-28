"""Headroom above a stair: the overhead hits and the clearance measured along each run."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ifc_spatial.stairs_constants import HEADROOM_REACH
from ifc_spatial.stairs_constants import HEADROOM_TRANSPARENT
from ifc_spatial.stairs_constants import RAMP_TYPES
from ifc_spatial.stairs_constants import STAIR_TYPES
from ifc_spatial.stairs_ramp import _rake_samples
from ifc_spatial.stairs_ramp import _rakes_of
from ifc_spatial.stairs_reading import _flight_parts
from ifc_spatial.stairs_reading import _sources
from ifc_spatial.stairs_records import _Rake

from .clearance import CLEARANCE_BUDGET_SECONDS
from .clearance import _soup_distance
from .clearance import _usable_triangles
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import AIR_TYPES
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE
from .operators import MIN_INTRUSION
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind


def _overhead_hits(
    model: SpatialModel, points: np.ndarray, direction: np.ndarray, exclude: set[str]
) -> tuple[float | None, dict[str, float]]:
    """Cast one ray per sample point and report the shortest run and who stopped it.

    The exclusion discipline is :func:`~ifc_spatial.operators.clear_height`'s,
    reused rather than re-derived: :data:`~ifc_spatial.model.AIR_TYPES` never
    stops a ray (a space is air and an opening is a subtraction), and every entry
    of :data:`HEADROOM_TRANSPARENT` is tested with ``is_a`` because
    ``IfcFurniture`` is only a SUBTYPE of ``IfcFurnishingElement`` in IFC4 — in
    IFC2X3 it is not, and a chair once stopped a clear-height ray for that reason.

    ``IfcRailing`` is NOT in that list, and :data:`HEADROOM_TRANSPARENT` records
    the measurement that decided it: the balustrades this pass used to report
    were reached by the old single-plane rake across a whole dogleg, not by the
    filter, and with the flights read one at a time no railing is a candidate at
    all.
    """
    shortest: float | None = None
    hit_by: dict[str, float] = {}
    ray = (float(direction[0]), float(direction[1]), float(direction[2]))
    for point in points:
        origin = point + direction * MIN_INTRUSION
        # The NEAREST accepted hit on each ray, not the first one the tree hands
        # back. `clear_height` breaks on the first and gets away with it; nothing
        # in `select_ray`'s contract promises an ordering, and the whole point of
        # this pass is which element stops a head first.
        nearest: tuple[float, str] | None = None
        for hit in model.tree.select_ray(
            (float(origin[0]), float(origin[1]), float(origin[2])), ray, length=HEADROOM_REACH
        ):
            element = model.file.by_id(hit.instance.id())
            if element.is_a() in AIR_TYPES or any(element.is_a(name) for name in HEADROOM_TRANSPARENT):
                continue
            if element.GlobalId in exclude:
                continue
            run = float(hit.distance) + MIN_INTRUSION
            if run <= MIN_INTRUSION:
                continue
            if nearest is None or run < nearest[0]:
                nearest = (run, element.GlobalId)
        if nearest is None:
            continue
        run, global_id = nearest
        shortest = run if shortest is None else min(shortest, run)
        hit_by[global_id] = min(hit_by.get(global_id, run), run)
    return shortest, hit_by


def _exact_clearance(model: SpatialModel, rake: _Rake, candidates: dict[str, float]) -> tuple[float | None, str | None]:
    """Exact perpendicular distance from the walking plane to the found elements.

    This is where the operator stops being a sampling method. The shortest
    distance from a plane region to a body above it IS the perpendicular
    distance, so measuring surface to surface — with
    :func:`~ifc_spatial.clearance._soup_distance`, the same exact triangle-pair
    routine ``clear_width`` uses — gives the Durchgangshöhe without needing a
    sample to land on the critical point. The critical point on a stair is the
    EDGE of the slab above, and no ray hits an edge.

    Only triangles wholly above the walking plane count. An element that crosses
    it — the stringer wall beside the flight — would otherwise measure zero from
    its own part below the nosings, which is a distance to something a head never
    meets.
    """
    plane_point = rake.corners.mean(axis=0)
    rectangle = np.array([rake.corners[[0, 1, 2]], rake.corners[[0, 2, 3]]])
    best: float | None = None
    culprit: str | None = None
    for global_id in candidates:
        geo = model.geometry(global_id)
        if geo is None:
            continue
        tris = _usable_triangles(geo)
        if len(tris) == 0:
            continue
        above = (((tris - plane_point) @ rake.normal) > MIN_INTRUSION).all(axis=1)
        if not above.any():
            continue
        distance, _, _, _, aborted = _soup_distance(rectangle, tris[above], CLEARANCE_BUDGET_SECONDS)
        if aborted or not math.isfinite(distance):
            continue
        if best is None or distance < best:
            best, culprit = float(distance), global_id
    return best, culprit


def headroom(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The Durchgangshöhe over a stair flight or a ramp, measured perpendicular.

    The measurement people get wrong. The tight point on a stair is where the
    flight passes under the floor above, and a vertical ray from a tread misses
    it: the shortest line from the walking surface to that slab edge runs
    perpendicular to the pitch, and it is shorter than any vertical distance
    under it. On the test fixture — a 33.69° flight (0.180/0.270) passing an edge
    at x = 1.200 m with a soffit at 2.600 m — no vertical measurement over the
    pitch line can get below 1.620 m, and the true clear passage is **1.348 m**.
    Reporting the vertical number hands the architect 27 cm of headroom that does
    not exist.

    So the value is the minimum distance from the **raking plane** — the plane
    through the nosings, over the flight's width — to any body above it. That is
    the perpendicular distance by construction. Rays along the plane's normal
    find the candidates; the reported number is then measured exactly against
    their surfaces, so it does not depend on a sample landing on the critical
    point.

    ``vertical`` travels beside it, because a clause that means the vertical
    reading must be able to have it without a second call, and because the gap
    between the two is itself worth showing.

    A flight with nothing above it is decidable and says so: ``obstructed`` is
    false and ``searchedTo`` names how far up the search went. That is a
    statement about this file — most often that the storey above was not
    exported — and it must never be confused with a measurement of zero.
    """
    method = f"headroom({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in (*STAIR_TYPES, *RAMP_TYPES)):
        _wrong_kind(
            subject,
            method,
            "headroom",
            "einen Treppen- oder Rampenlauf (IfcStair, IfcStairFlight, IfcRamp, IfcRampFlight)",
            "für die lichte Höhe eines Raums: clearHeight(); für einen Durchgang: clearOpeningWidth()",
        )

    flights, _, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    readings = [(element, *_rakes_of(model, element)) for element in bodies]
    usable = [(element, rake) for element, rakes, _ in readings for rake in rakes]
    refusals = [reason for _, _, reasons in readings for reason in reasons]
    if not usable:
        geo, missing = _geometry_or_answer(model, subject, method)
        if geo is None:
            return missing  # type: ignore[return-value]
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine gerade Lauflinie an {subject.is_a()} „{model.label(subject) or global_id}“",
                remedy=" ".join(
                    [
                        *refusals,
                        "Eine Durchgangshöhe wird senkrecht über der Lauflinie gemessen, und die ergibt sich "
                        "aus den Trittflächen bzw. der Lauffläche. Dieser Körper zeigt keine auswertbare — "
                        "die Treppe bzw. Rampe mit voller Körpergeometrie und je einem IfcStairFlight pro "
                        "Lauf neu exportieren.",
                    ]
                ),
                elements=[global_id],
            ),
        )

    # The subject only. The flight being measured excludes ITSELF below, because
    # a body cannot stop a ray leaving its own surface; its SIBLINGS must stay
    # candidates, because the other flight of the same stair is the commonest
    # ceiling a staircase has. This set used to hold every body in `rakes`, which
    # made the exclusion identical for all flights and blinded each one to the
    # rest of its own assembly — on the two-flight „Treppe Turm" of
    # tests/test_stairs.py, whose Lauf OG stands 1.280 m over the top nosing of
    # Lauf UG, `headroom` on the assembly reported „kein Bauteil … begrenzt
    # nichts die Durchgangshöhe" while the same question asked about Lauf UG
    # alone answered 1.280 m. „Nichts darüber" is read as a gap in the export;
    # here it was a stair, and the direction of the error is the dangerous one.
    #
    # The exclusion is still per BODY and not per flight, and it has to be: the
    # ray tree knows elements, not the runs this module reads out of one. So on a
    # dogleg written as a single IfcStair, the upper flight cannot limit the lower
    # one — the caveat says as much where it applies. Where the export gives each
    # flight its own IfcStairFlight, the sibling case above still works.
    excluded_self = {global_id}

    per_body = {element.GlobalId: len(rakes) for element, rakes, _ in readings}
    seen: dict[str, int] = {}
    per_flight: list[dict[str, Any]] = []
    for element, rake in usable:
        samples = _rake_samples(rake)
        exclude = {*excluded_self, element.GlobalId}
        sampled, candidates = _overhead_hits(model, samples, rake.normal, exclude)
        vertical, _ = _overhead_hits(model, samples, np.array([0.0, 0.0, 1.0]), exclude)
        exact, culprit = _exact_clearance(model, rake, candidates)
        index = seen[element.GlobalId] = seen.get(element.GlobalId, 0) + 1
        label = model.label(element)
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": (
                    label
                    if per_body[element.GlobalId] <= 1
                    else f"{label or element.GlobalId} — Lauf {index} von {per_body[element.GlobalId]}"
                ),
                "headroom": exact if exact is not None else sampled,
                "sampledPerpendicular": sampled,
                "vertical": vertical,
                "obstructedBy": culprit or (min(candidates, key=candidates.get) if candidates else None),
                "samples": int(len(samples)),
            }
        )

    obstructed = [f for f in per_flight if f["headroom"] is not None]
    if not obstructed:
        return computed(
            {
                "headroom": None,
                "vertical": None,
                "obstructed": False,
                "searchedTo": HEADROOM_REACH,
                "flights": per_flight,
            },
            unit="m",
            tolerance=DIMENSION_TOLERANCE,
            from_=[global_id],
            method=method,
            caveat=(
                f"Über diesem Lauf liegt innerhalb von {HEADROOM_REACH:.1f} m kein Bauteil — in dieser Datei "
                "begrenzt nichts die Durchgangshöhe. Das ist eine Aussage über den Export und nicht über das "
                "Gebäude: meist fehlt das Geschoss darüber, seltener steht die Treppe tatsächlich im Freien. "
                "Möblierung (IfcFurnishingElement) und Luftkörper (IfcSpace, IfcOpeningElement) halten hier "
                "grundsätzlich nichts auf."
            ),
        )

    tightest = min(obstructed, key=lambda f: f["headroom"])
    culprit = tightest["obstructedBy"]
    culprit_name = None
    if culprit:
        try:
            culprit_name = model.label(model.file.by_guid(culprit)) or culprit
        except RuntimeError, KeyError:
            culprit_name = culprit

    value = {
        "headroom": tightest["headroom"],
        "vertical": tightest["vertical"],
        "obstructed": True,
        "obstructedBy": culprit,
        "searchedTo": HEADROOM_REACH,
        "flights": per_flight,
    }

    caveats = [
        "Lichte Durchgangshöhe, senkrecht zur Lauflinie gemessen — nicht lotrecht. Die enge Stelle einer "
        "Treppe ist die Kante der Decke darüber, und ein senkrecht nach oben gemessener Wert geht daran "
        "vorbei."
    ]
    if tightest["vertical"] is not None and tightest["headroom"] is not None:
        difference = tightest["vertical"] - tightest["headroom"]
        if difference > DIMENSION_TOLERANCE:
            caveats.append(
                f"Lotrecht gemessen wären es {tightest['vertical']:.3f} m, also {difference:.3f} m mehr als "
                f"die tatsächlich durchgehende Höhe von {tightest['headroom']:.3f} m."
            )
    if culprit_name:
        caveats.append(f"Die engste Stelle liegt unter: {culprit_name}.")
    if len(per_flight) > 1:
        # The second sentence describes a limitation of reading SEVERAL flights
        # out of ONE body: the ray tree keys on elements, so a flight cannot
        # stop a ray cast from its neighbour when both came from the same solid.
        # It is false for an export that writes an `IfcStairFlight` per flight —
        # there the exclusion is per element and a sibling flight DOES limit the
        # one beneath it, which `test_the_flight_above_belongs_to_the_same_stair
        # _and_still_counts` pins at 1.280 m. Printing it anyway would tell a
        # reader their file lacks something it has.
        split_body = any(count > 1 for count in per_body.values())
        caveats.append(
            f"Gemessen über {len(per_flight)} Läufen; ausgewiesen ist der engste."
            + (
                " Läuft ein Lauf über einen anderen desselben Körpers hinweg, kann er ihn hier nicht "
                "begrenzen — die Datei müsste dafür je Lauf ein eigenes IfcStairFlight führen."
                if split_body
                else ""
            )
        )
    if refusals:
        caveats.append("Ein Teil dieses Körpers ist nicht mitgemessen: " + " ".join(refusals))
    caveats.append(
        "Gemessen von der Ebene durch die Stufenvorderkanten (bei einer Rampe: von der Lauffläche) bis zur "
        "Oberfläche des nächstliegenden Bauteils darüber, über der mittleren Hälfte der Laufbreite. "
        "Möblierung ist ausgenommen; Unterzüge, abgehängte Decken, Leitungen und auch ein Geländer, das "
        "tatsächlich über der Lauflinie steht, zählen mit, soweit sie als Körper im Modell stehen."
    )

    return computed(
        value,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=_sources(global_id, *[f["globalId"] for f in per_flight], *([culprit] if culprit else [])),
        method=method,
        caveat=" ".join(caveats),
    )
