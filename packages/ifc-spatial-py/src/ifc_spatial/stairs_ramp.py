"""Ramps: the running surface, its slope, and the rake of each flight."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ifc_spatial.stairs_constants import _RAMP_SLOPE_NAMES
from ifc_spatial.stairs_constants import HEADROOM_LATERAL
from ifc_spatial.stairs_constants import HEADROOM_SAMPLE_SPACING
from ifc_spatial.stairs_constants import RAMP_TYPES
from ifc_spatial.stairs_constants import RUNNING_SURFACE_MIN_DOT
from ifc_spatial.stairs_reading import _flight_parts
from ifc_spatial.stairs_reading import _read_body
from ifc_spatial.stairs_reading import _reconcile
from ifc_spatial.stairs_reading import _sources
from ifc_spatial.stairs_records import _Flight
from ifc_spatial.stairs_records import _Rake
from ifc_spatial.stairs_records import _Running

from .clearance import _usable_triangles
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import undecidable
from .geometry import triangle_normals_areas
from .model import DeclaredQuantity
from .model import SpatialModel
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind


def _running_surface(model: SpatialModel, element: Any) -> _Running | None:
    """The ramp's walking surface, as a plane with an extent.

    Up-facing triangles are binned by quantised normal and the bin with the
    greatest AREA wins — the same rule, and the same reason, as
    ``geometry.dominant_vertical_plane``: a finely tessellated 0.2 m² kerb must
    not outvote a 7.5 m² running surface. The slope then comes from the winning
    bin's area-weighted normal rather than from a bounding box, which is what
    makes it right for a ramp that runs diagonally in plan.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return None
    tris = _usable_triangles(geo)
    if len(tris) == 0:
        return None
    normals, areas = triangle_normals_areas(tris)
    facing = normals[:, 2] > RUNNING_SURFACE_MIN_DOT
    if not facing.any():
        return None
    tris, normals, areas = tris[facing], normals[facing], areas[facing]

    keys = np.round(normals / 0.02).astype(np.int64)
    best_area, best = -1.0, None
    for key in np.unique(keys, axis=0):
        member = (keys == key).all(axis=1)
        area = float(areas[member].sum())
        if area > best_area:
            best_area, best = area, member
    if best is None:
        return None

    surface = tris[best]
    weights = areas[best]
    normal = (normals[best] * weights[:, None]).sum(axis=0)
    normal = normal / float(np.linalg.norm(normal))
    vertices = surface.reshape(-1, 3)

    horizontal = float(math.hypot(normal[0], normal[1]))
    if horizontal < 1e-9:
        uphill = None
        run = float(max(vertices[:, 0].max() - vertices[:, 0].min(), vertices[:, 1].max() - vertices[:, 1].min()))
        width = float(min(vertices[:, 0].max() - vertices[:, 0].min(), vertices[:, 1].max() - vertices[:, 1].min()))
    else:
        # Steepest ascent is the negated horizontal part of the up-normal.
        uphill = np.array([-normal[0] / horizontal, -normal[1] / horizontal, 0.0])
        across = np.array([-uphill[1], uphill[0], 0.0])
        along_extent = vertices @ uphill
        across_extent = vertices @ across
        run = float(along_extent.max() - along_extent.min())
        width = float(across_extent.max() - across_extent.min())
    rise = float(vertices[:, 2].max() - vertices[:, 2].min())

    return _Running(
        global_id=element.GlobalId,
        normal=normal,
        rise=rise,
        run=run,
        width=width,
        uphill=uphill,
        corners=vertices,
    )


def _slope_forms(tangent: float) -> dict[str, Any]:
    """One slope, in every form a clause or a drawing might use it.

    A bare "6" is ambiguous between 6 %, 1:6 and 6°, and the three differ by a
    factor of ten. All of them are therefore present at once, and ``slopePercent``
    is defined in the value itself as ``rise / run × 100`` so that no reader has
    to assume which convention this package chose.
    """
    percent = tangent * 100.0
    ratio = (1.0 / tangent) if tangent > 1e-9 else None
    return {
        "slopePercent": percent,
        "slopeRatio": ratio,
        "slopeRatioText": "0" if ratio is None else f"1:{ratio:.1f}",
        "slopeDegrees": math.degrees(math.atan(tangent)),
    }


def ramp_slope(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """A ramp's slope, as a percentage AND as a ratio, with the rise and run.

    Barrier-free ramps are decided on a percentage, drawn as a ratio and
    dimensioned in degrees by nobody, so all three forms are returned together
    and the percentage is defined in the answer itself: **rise / run × 100**.
    6 % is 6 cm of rise per 100 cm of plan length, which is 1:16,7. A caller that
    receives only "6" cannot tell that from 1:6, and the difference is a factor of
    ten on the one number the whole clause turns on.

    The slope comes from the area-weighted normal of the running surface, not
    from a bounding box: a ramp that runs diagonally in plan has a box whose
    diagonal is longer than its run, and the box route would report it as
    flatter than it is. ``rise`` and ``run`` are the extents of that same
    surface, so ``rise / run`` reproduces the reported percentage and a reader
    can check it.

    An ``IfcRamp`` that aggregates flights reports the **steepest** flight as the
    value, with every flight in ``flights``. That is a choice about which number
    answers the question "how steep is this ramp", not a verdict: nothing here
    knows what steep enough is.

    ``Pset_RampFlightCommon.Slope`` is triangulated in where it exists. It is an
    ``IfcPlaneAngleMeasure``, so it is read through the file's plane-angle unit
    and converted — a file that states 3.4336 DEGREE means 6.0 %, and a file that
    states the same number in radians means 24 000 %. Reading it as a raw number
    is how that mistake gets made.
    """
    method = f"rampSlope({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in RAMP_TYPES):
        _wrong_kind(
            subject,
            method,
            "rampSlope",
            "eine Rampe oder einen Rampenlauf (IfcRamp, IfcRampFlight)",
            "für eine Treppe: stairGeometry(); für die lichte Höhe über einem Lauf: headroom()",
        )

    flights, _, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    surfaces = [(element, _running_surface(model, element)) for element in bodies]
    measured = [(element, surface) for element, surface in surfaces if surface is not None]

    declared_slope = None
    declared_on = None
    for element in [subject, *flights]:
        found = model.declared_quantity(element, _RAMP_SLOPE_NAMES)
        if found is not None:
            declared_slope, declared_on = found, element.GlobalId
            break

    if not measured:
        if declared_slope is None:
            geo, missing = _geometry_or_answer(model, subject, method)
            if geo is None:
                return missing  # type: ignore[return-value]
            return undecidable(
                from_=[global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=f"keine auswertbare Lauffläche an {subject.is_a()} „{model.label(subject) or global_id}“",
                    remedy=(
                        "Der Körper dieses Bauteils zeigt keine nach oben gerichtete Fläche, aus der sich ein "
                        "Gefälle ablesen ließe. Abhilfe: die Rampe mit voller Körpergeometrie exportieren oder "
                        "das Gefälle in Pset_RampFlightCommon.Slope deklarieren."
                    ),
                    elements=[global_id],
                ),
            )
        # A declared plane angle, converted to SI radians by `declared_quantity`.
        forms = _slope_forms(math.tan(declared_slope.value))
        return declared(
            {**forms, "rise": None, "run": None, "clearWidth": None, "flights": []},
            unit="%",
            from_=[global_id, declared_on or global_id],
            method=method,
            caveat=(
                f"Nur deklariert ({declared_slope.path} = {declared_slope.raw:g}"
                f"{' ' + declared_slope.unit_label if declared_slope.unit_label else ''}, "
                f"also {math.degrees(declared_slope.value):.4f}°) — dieses Bauteil trägt keinen auswertbaren "
                "Körper, an dem sich das Gefälle nachmessen ließe. Steigung in Prozent heißt hier "
                "Höhenunterschied / Grundrisslänge × 100."
            ),
        )

    per_flight = []
    for element, surface in measured:
        tangent = float(math.hypot(surface.normal[0], surface.normal[1]) / surface.normal[2])
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
                **_slope_forms(tangent),
                "rise": surface.rise,
                "run": surface.run,
                "clearWidth": surface.width,
            }
        )
    steepest = max(per_flight, key=lambda f: f["slopePercent"])

    block, conflict = _reconcile(
        steepest["slopePercent"],
        None
        if declared_slope is None
        else DeclaredQuantity(
            path=declared_slope.path,
            value=math.tan(declared_slope.value) * 100.0,
            raw=declared_slope.raw,
            scale=declared_slope.scale,
            unit_label=declared_slope.unit_label,
        ),
        subject_id=global_id,
        declared_on=declared_on,
        method=method,
    )

    value = {
        "slopePercent": steepest["slopePercent"],
        "slopeRatio": steepest["slopeRatio"],
        "slopeRatioText": steepest["slopeRatioText"],
        "slopeDegrees": steepest["slopeDegrees"],
        "rise": steepest["rise"],
        "run": steepest["run"],
        "clearWidth": steepest["clearWidth"],
        "declaredSlopePercent": block["declared"],
        "agreement": block["agreement"],
        "flights": per_flight,
        "definition": "slopePercent = Höhenunterschied / Grundrisslänge × 100",
    }

    caveats = [
        f"Steigung {steepest['slopePercent']:.2f} % heißt {steepest['slopePercent']:.2f} cm Höhe je 100 cm "
        f"Grundrisslänge, als Verhältnis {steepest['slopeRatioText']}, als Winkel "
        f"{steepest['slopeDegrees']:.2f}°. Gemessen an der Neigung der Lauffläche selbst; Höhenunterschied "
        f"{steepest['rise']:.3f} m auf {steepest['run']:.3f} m Grundrisslänge bestätigen sie."
    ]
    if len(per_flight) > 1:
        caveats.append(
            f"Diese Rampe hat {len(per_flight)} Läufe; ausgewiesen ist der steilste. Die übrigen stehen in "
            "flights, dazwischenliegende Podeste zählen nicht mit."
        )
    if steepest["slopePercent"] < 0.1:
        caveats.append(
            "Die Lauffläche ist waagrecht — das ist ein Podest, kein geneigter Lauf, oder die Rampe ist ohne "
            "Gefälle modelliert."
        )
    caveats.append(
        "Die Nutzbreite ist die Breite der Lauffläche im Rohbau; Radabweiser, Handläufe und Bekleidungen "
        "schmälern sie und sind nur enthalten, soweit sie den Körper der Lauffläche begrenzen."
    )
    if conflict:
        caveats.append(conflict)

    return computed(
        value,
        unit="%",
        tolerance=0.1,
        from_=_sources(global_id, *[element.GlobalId for element, _ in measured]),
        method=method,
        caveat=" ".join(caveats),
    )


def _rakes_of(model: SpatialModel, element: Any) -> tuple[list[_Rake], list[str]]:
    """The raking planes a Durchgangshöhe is measured from, and what was refused.

    For a stair that is the plane through the NOSINGS — not the treads, not the
    soffit. The nosing line is what a person's head clears; a plane through the
    back of each tread sits half a going behind it and would report a headroom
    that is too large by ``going × sin(pitch)``, about 15 cm on an ordinary
    flight.

    A LIST because one body can hold more than one flight: a dogleg written as a
    single ``IfcStair`` has three pitch lines pointing three ways, and one plane
    fitted across all of them is a plane through the stairwell rather than over
    a walking surface. Each flight gets its own rake and the tightest one wins.

    For a ramp it is the running surface itself.
    """
    if element.is_a("IfcRampFlight") or element.is_a("IfcRamp"):
        rake = _ramp_rake(model, element)
        return ([rake] if rake is not None else []), []

    body = _read_body(model, element)
    rakes = [rake for flight in body.flights if (rake := _flight_rake(element, flight)) is not None]
    return rakes, body.refusals


def _ramp_rake(model: SpatialModel, element: Any) -> _Rake | None:
    """The running surface of a ramp, as the rectangle a head clears."""
    surface = _running_surface(model, element)
    if surface is None:
        return None
    pitch = surface.uphill if surface.uphill is not None else np.array([1.0, 0.0, 0.0])
    if surface.uphill is not None:
        tangent = float(math.hypot(surface.normal[0], surface.normal[1]) / surface.normal[2])
        pitch = surface.uphill * math.cos(math.atan(tangent)) + np.array([0.0, 0.0, 1.0]) * math.sin(math.atan(tangent))
    across = np.array([-pitch[1], pitch[0], 0.0])
    across = across / float(np.linalg.norm(across))
    vertices = surface.corners
    along = vertices @ pitch
    side = vertices @ across
    low, high = float(along.min()), float(along.max())
    left, right = float(side.min()), float(side.max())
    height = float((vertices @ surface.normal).mean())
    corners = np.array(
        [
            pitch * low + across * left + surface.normal * height,
            pitch * low + across * right + surface.normal * height,
            pitch * high + across * right + surface.normal * height,
            pitch * high + across * left + surface.normal * height,
        ]
    )
    return _Rake(
        global_id=element.GlobalId,
        corners=corners,
        normal=surface.normal,
        pitch=pitch,
        length=high - low,
        width=right - left,
    )


def _flight_rake(element: Any, flight: _Flight) -> _Rake | None:
    """One flight's nosing plane, as the rectangle a head clears."""
    if len(flight.nosings) < 2:
        return None
    first, last = flight.nosings[0], flight.nosings[-1]
    pitch = last - first
    length = float(np.linalg.norm(pitch))
    if length < 1e-9:
        return None
    pitch = pitch / length
    across = flight.across
    normal = np.cross(across, pitch)
    normal = normal / float(np.linalg.norm(normal))
    if normal[2] < 0:
        normal = -normal
    half = flight.clear_width / 2.0
    centre_offset = float(np.mean([t.centre @ across for t in flight.treads]))
    base_first = first - across * float(first @ across) + across * centre_offset
    base_last = last - across * float(last @ across) + across * centre_offset
    corners = np.array(
        [base_first - across * half, base_first + across * half, base_last + across * half, base_last - across * half]
    )
    return _Rake(
        global_id=element.GlobalId,
        corners=corners,
        normal=normal,
        pitch=pitch,
        length=length,
        width=flight.clear_width,
    )


def _rake_samples(rake: _Rake) -> np.ndarray:
    """Sample points on the walking plane — for the RAY pass only.

    These find which elements are overhead. They do not decide the number: the
    distance is measured against the surfaces of whatever they find, so a tight
    point between two samples changes nothing as long as the element it belongs
    to was hit at all.
    """
    steps = max(2, int(math.ceil(rake.length / HEADROOM_SAMPLE_SPACING)) + 1)
    bottom_left, bottom_right, top_left = rake.corners[0], rake.corners[1], rake.corners[3]
    along = np.linspace(0.0, 1.0, steps)
    points = []
    for t in along:
        base = bottom_left + (top_left - bottom_left) * t
        side = bottom_right - bottom_left
        for fraction in HEADROOM_LATERAL:
            points.append(base + side * fraction)
    return np.array(points)
