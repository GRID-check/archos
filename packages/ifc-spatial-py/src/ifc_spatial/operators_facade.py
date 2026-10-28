"""The facade plane, its overhang, and the rays and prisms that test what stands between a point and the sky."""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Sequence
from typing import Any

import numpy as np

from ifc_spatial.operators_bounds import hosted_in
from ifc_spatial.operators_constants import MIN_INTRUSION
from ifc_spatial.operators_constants import OUTWARD_MIN_DOT
from ifc_spatial.operators_constants import OUTWARD_MIN_SPAN
from ifc_spatial.operators_constants import TESSELLATION_TOLERANCE
from ifc_spatial.operators_guards import _geometry_or_answer
from ifc_spatial.operators_guards import _no_geometry
from ifc_spatial.operators_guards import _require
from ifc_spatial.operators_measures import _vector_text

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .geometry import clip_polygon
from .geometry import dominant_vertical_plane
from .geometry import outermost_parallel_face
from .geometry import signed_distance
from .model import AIR_TYPES
from .model import SpatialModel

# ════════════════════════════════════════════════════════════════════════════
# constructive — geometry the file does not contain, built from geometry it does
# ════════════════════════════════════════════════════════════════════════════


def facade_plane_of(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The element's facade plane, with its normal pointing away from the building.

    The reference plane every other constructive operator measures from:

    1. **Orientation** against the model's plan centre, because a face normal
       says which orientation a face has, never which side is outside.
    2. **Seating** onto the OUTERMOST parallel face — a real surface. An
       area-weighted average over every face sharing a normal lands *inside* the
       masonry on a layered wall, and an overhang measured from there is too
       large by the wall's build-up.

    ``outward=False`` means the side could not be established (an interior
    partition near the middle of the plan). The plane is still returned — it is
    real, only its side is a guess — with a caveat saying so.
    """
    method = f"facadePlaneOf({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        # A body the kernel REJECTED is a different finding from a body that was
        # never exported, and `_no_geometry` carries the kernel's own message.
        # The curtain-wall hint below only applies to the second case.
        if (model.geometry_failure(global_id) or "").startswith(("shape-failed", "empty-mesh")):
            return missing  # type: ignore[return-value]
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                # Same rule as `_no_geometry`: the renderer supplies the „nicht",
                # so this may not start with „keine" or the sentence negates
                # itself.
                what=f"Körpergeometrie für {subject.is_a()} in dieser Datei",
                remedy=(
                    "Dieses Bauteil trägt keinen eigenen Körper — eine Vorhangfassade exportiert ihre "
                    "Geometrie über Paneele und Pfosten. Die Unterbauteile abfragen, oder das Modell mit "
                    "Körpergeometrie exportieren."
                ),
                elements=[global_id],
            ),
        )

    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        name = model.label(subject) or global_id
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine senkrechte Fläche an {subject.is_a()} „{name}“",
                remedy=(
                    "Eine Fassadenebene braucht eine senkrechte Fläche. Dieses Bauteil hat keine "
                    "(z. B. eine Decke oder ein Flachdach)."
                ),
                elements=[global_id],
            ),
        )

    centre = model.plan_centre
    away = geo.centroid[:2] - (centre[:2] if centre is not None else geo.centroid[:2])
    span = float(np.linalg.norm(away))
    n = np.array([normal[0], normal[1], 0.0])
    outward = False
    if span >= OUTWARD_MIN_SPAN:
        cos = float(n[:2] @ (away / span))
        if abs(cos) >= OUTWARD_MIN_DOT:
            outward = True
            if cos < 0:
                n = -n

    seated = outermost_parallel_face(geo.triangles, n)
    if seated is None:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine auswertbare Fassadenfläche an {subject.is_a()}",
                remedy="Das Bauteil hat senkrechte Dreiecke, aber keine zusammenhängende Fläche brauchbarer Größe.",
                elements=[global_id],
            ),
        )

    # No `area` in this payload. It used to carry `seated.area`, which is the
    # summed triangle area of the seating bin and double-counts overlapping and
    # opposite-facing triangles: the south wall 3cUkl32yn9qRSPvBJVyWy4 published
    # 23.527 m² for an outer face that is 17.776 m². Nothing read the field, and
    # `_provenance_line` stamped it „(m)" alongside a point and a normal, so the
    # one honest option was to stop publishing it — the operator's job is to
    # SEAT A PLANE, and a plane has a position and a direction, not an area. A
    # facade area is `measure/extent` or the thermal-envelope operators, both of
    # which union their faces instead of summing them.
    return computed(
        {
            "normal": n.tolist(),
            "point": seated.point.tolist(),
            "outward": outward,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=None
        if outward
        else (
            "Die Außenseite dieser Ebene ist ungesichert: das Bauteil steht zu nahe an der Grundriss-Mitte "
            "oder seine Normale zeigt quer dazu. Alle daran gemessenen Werte können im Vorzeichen kippen."
        ),
    )


def overhang(model: SpatialModel, projecting_id: str, facade_element_id: str) -> Answer[float]:
    """How far one element projects past another's facade plane, in metres.

    The number the product reported as *"Überstand nicht messbar"* on a file that
    measures it fine. Measured perpendicular to the facade plane, over every
    vertex of the projecting element's real body — so a barrel roof is measured
    at its furthest point and not at its bounding box.

    Never negative: an element that does not reach the plane reports 0 with a
    caveat saying how far behind it stops.
    """
    method = f"overhang({projecting_id}, facadePlaneOf({facade_element_id}))"
    _require(model, projecting_id, method)
    _require(model, facade_element_id, method)

    plane_answer = facade_plane_of(model, facade_element_id)
    if not plane_answer.decidable or plane_answer.value is None:
        return undecidable(
            from_=[projecting_id, facade_element_id],
            method=method,
            provenance="computed",
            missing=plane_answer.missing
            or MissingFact(
                what=f"Fassadenebene von {facade_element_id}",
                remedy="Ohne Bezugsebene ist kein Überstand messbar",
            ),
        )
    plane = plane_answer.value

    geo = model.geometry(projecting_id)
    if geo is None:
        return _no_geometry(model, model.file.by_guid(projecting_id), method, [projecting_id, facade_element_id])

    normal = np.array(plane["normal"])
    point = np.array(plane["point"])
    depths = signed_distance(geo.verts, normal, point)
    furthest = float(depths.max())

    caveats: list[str] = []
    if not plane["outward"]:
        caveats.append(plane_answer.caveat or "Die Außenseite der Bezugsebene ist ungesichert.")
    if furthest < -TESSELLATION_TOLERANCE:
        caveats.append(
            f"Das Bauteil erreicht die Fassadenebene nicht — es bleibt {abs(furthest):.3f} m dahinter. "
            "Gemeldet ist 0, nicht ein negativer Überstand."
        )

    return computed(
        max(0.0, furthest),
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[projecting_id, facade_element_id],
        method=method,
        caveat=" ".join(caveats) if caveats else None,
    )


def ray(
    model: SpatialModel,
    origin: Sequence[float],
    direction: Sequence[float],
    length: float | None = None,
    exclude: Iterable[str] | None = None,
) -> Answer[dict[str, Any] | None]:
    """The first surface a ray meets — ``geom.tree.select_ray``.

    BESSER: the intersection is against the real OCCT surface, so the hit point
    is on the building rather than on a triangle that approximates it, and the
    call also returns the **surface normal** and the **dot product** with the ray
    — which is what tells a grazing hit from a square one. The TS ray tests
    retained triangles only and has to warn, in a caveat, about elements whose
    triangles the geometry pass dropped; there is nothing to drop here.

    Spaces and openings are skipped: air does not stop light. A decidable
    ``None`` means the ray reached ``length`` without meeting anything — which is
    a real answer and must never be confused with "could not look".
    """
    # Built defensively: the arguments are not validated yet, and a `method`
    # string that formats them as floats crashed on `ray(model, "x", ...)` —
    # before the check that was supposed to reject it could run.
    method = f"ray({_vector_text(origin)}, {_vector_text(direction)}" + (f", {length})" if length is not None else ")")
    try:
        d = np.array(direction, dtype=float).reshape(3)
        o = np.array(origin, dtype=float).reshape(3)
    except TypeError, ValueError:
        d = np.zeros(3)
        o = np.full(3, np.nan)
    bad_length = length is not None and (not np.isfinite(length) or float(length) <= 0)
    if not np.isfinite(d).all() or float(np.linalg.norm(d)) < 1e-9 or not np.isfinite(o).all() or bad_length:
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="brauchbarer Strahl (Richtung ≠ 0, endlicher Ursprung, Länge > 0)",
                remedy=(
                    "ray() mit einem Richtungsvektor ungleich Null, endlichen Koordinaten und einer "
                    "positiven, endlichen Länge aufrufen. Eine negative Länge liefert bei OCCT einen "
                    "Treffer hinter dem Ursprung — die Antwort sähe gültig aus und wäre es nicht."
                ),
            ),
        )
    if length is None and model.bounds is None:
        # `model.diagonal` falls back to a flat 100.0 when nothing in the file
        # has a body. Casting 100 m into a model with no geometry and reporting
        # "nichts getroffen" as decidable would dress a could-not-look up as a
        # result — the one substitution this library exists to prevent.
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine Modellausdehnung (kein Bauteil mit Geometrie)",
                remedy=(
                    "Ohne Geometrie im Modell gibt es keine Reichweite, über die ein Strahl etwas aussagen "
                    "könnte. Entweder das Modell mit Körpergeometrie exportieren oder ray() mit einer "
                    "ausdrücklichen Länge aufrufen."
                ),
            ),
        )
    d = d / np.linalg.norm(d)
    reach = float(length) if length is not None else model.diagonal
    skip = set(exclude or ())

    best: dict[str, Any] | None = None
    for hit in model.tree.select_ray(tuple(float(c) for c in o), tuple(float(c) for c in d), length=reach):
        element = model.file.by_id(hit.instance.id())
        if element.is_a() in AIR_TYPES or element.GlobalId in skip:
            continue
        if best is None or hit.distance < best["distance"]:
            best = {
                "hit": element.GlobalId,
                "name": model.label(element),
                "point": [float(c) for c in hit.position],
                "distance": float(hit.distance),
                "normal": [float(c) for c in hit.normal],
                "dotProduct": float(hit.dot_product),
            }

    return computed(
        best,
        unit="m" if best else None,
        tolerance=TESSELLATION_TOLERANCE if best else None,
        from_=[best["hit"]] if best else [],
        method=method,
    )


def prism(model: SpatialModel, opening_id: str, angle_deg: float, swivel_deg: float) -> Answer[dict[str, Any]]:
    """The light prism of a light opening — a construction, not a check.

    Anchored on the LOWER EDGE of the opening, lying in the facade plane: a ray
    arriving at the window head at ``angle_deg`` passes above the plane drawn
    from the sill, so the sill-anchored volume covers every path by which light
    at that angle or steeper can reach any point of the opening.

    Four half-spaces — ``facade``, ``incline``, ``lateralLeft``,
    ``lateralRight`` — because the volume is unbounded (it opens to the sky) and
    every test against it is a dot product. A caller can serialise the four
    planes and rebuild the volume exactly.

    The angles are PARAMETERS the caller binds from the clause. This module knows
    geometry, not law: it contains no OIB numbers, and it returns no verdict.
    """
    method = f"prism({opening_id}, {angle_deg}, {swivel_deg})"
    subject = _require(model, opening_id, method)

    if not (0 < angle_deg < 90) or not (0 <= swivel_deg < 90):
        return undecidable(
            from_=[opening_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="brauchbare Winkel (0° < angleDeg < 90°, 0° ≤ swivelDeg < 90°)",
                remedy=(
                    "Die Winkel kommen aus der Bestimmung, nicht aus dem Modell — prism() mit den Werten der "
                    "Klausel aufrufen"
                ),
                elements=[opening_id],
            ),
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    # The host wall sets the DIRECTION — its facade is decided by tens of square
    # metres, an opening's by one or two — while the plane is seated on the
    # OPENING's own outer face, because light enters at the opening and seating
    # it on the wall would hide a recessed window's own reveal shading.
    host = hosted_in(model, opening_id)
    host_id = host.value[0].global_id if host.decidable and host.value else None
    plane_answer = facade_plane_of(model, host_id or opening_id)
    if not plane_answer.decidable or plane_answer.value is None:
        plane_answer = facade_plane_of(model, opening_id)
        host_id = None
    if not plane_answer.decidable or plane_answer.value is None:
        return undecidable(
            from_=[opening_id],
            method=method,
            provenance="computed",
            missing=plane_answer.missing
            or MissingFact(
                what=f"Fassadenebene für {opening_id}",
                remedy="Ohne Fassadenebene ist die Richtung des Prismas unbestimmt",
            ),
        )

    n = np.array(plane_answer.value["normal"], dtype=float)
    n[2] = 0.0
    n = n / np.linalg.norm(n)
    lateral = np.cross(np.array([0.0, 0.0, 1.0]), n)
    lateral = lateral / np.linalg.norm(lateral)

    points = geo.verts
    u = points @ lateral
    v = points @ n
    u_min, u_max, v_max = float(u.min()), float(u.max()), float(v.max())
    z_min = float(points[:, 2].min())

    left = lateral * u_min + n * v_max
    left[2] = z_min
    right = lateral * u_max + n * v_max
    right[2] = z_min

    a = np.radians(angle_deg)
    s = np.radians(swivel_deg)
    incline = np.array([-np.sin(a) * n[0], -np.sin(a) * n[1], np.cos(a)])
    incline = incline / np.linalg.norm(incline)
    left_normal = lateral * np.cos(s) + n * np.sin(s)
    right_normal = -lateral * np.cos(s) + n * np.sin(s)

    half_spaces = [
        {"role": "facade", "normal": n.tolist(), "point": left.tolist()},
        {"role": "incline", "normal": incline.tolist(), "point": left.tolist()},
        {"role": "lateralLeft", "normal": (left_normal / np.linalg.norm(left_normal)).tolist(), "point": left.tolist()},
        {
            "role": "lateralRight",
            "normal": (right_normal / np.linalg.norm(right_normal)).tolist(),
            "point": right.tolist(),
        },
    ]

    return computed(
        {
            "openingId": opening_id,
            "facadeElementId": host_id,
            "angleDeg": angle_deg,
            "swivelDeg": swivel_deg,
            "normal": n.tolist(),
            "lateral": lateral.tolist(),
            "lowerEdge": [left.tolist(), right.tolist()],
            "sillZ": z_min,
            "halfSpaces": half_spaces,
            "reach": model.diagonal,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[opening_id] + ([host_id] if host_id else []),
        method=method + (f" über facadePlaneOf({host_id})" if host_id else f" über facadePlaneOf({opening_id})"),
        caveat=plane_answer.caveat,
    )


def obstructions(
    model: SpatialModel, volume: dict[str, Any], exclude: Iterable[str] | None = None
) -> Answer[list[dict[str, Any]]]:
    """Elements occupying the prism, and how deep each reaches into it.

    After ``geom.tree.select_box`` (broad phase over the prism's bounded extent)
    and Solibri's free-area check: the question is not "does anything touch this
    volume" but "what, and by how much", because only the second form is
    something a design decision can be made from.

    Every candidate triangle is CLIPPED against the prism's half-spaces
    (Sutherland–Hodgman; the volume is convex, so the clip is exact), and the
    depth is the maximum distance past the inclined plane over the clipped
    polygon. A vertex-inside test would have missed this file entirely: the
    sample house's roof is 376 triangles over 108 m², and a triangle spanning the
    whole prism can have every corner outside it.

    Never a candidate: spaces (air), openings (a subtraction), and the subject
    opening together with whatever fills it — a window's frame projects 40 mm past
    the facade and would otherwise report itself as its own obstruction. The HOST
    WALL is not auto-excluded, because a recessed window genuinely is shaded by
    its own reveal; that is what ``exclude`` is for.

    Returns geometry, never a verdict: a cut prism ENLARGES the required
    Lichteintrittsfläche under OIB 3, it does not ban the window.
    """
    # `volume` comes back from `prism()` and travels through a caller — an agent,
    # a JSON round-trip, a cache from a DIFFERENT model. All three can hand back
    # something that is not a prism, and a KeyError or a bare RuntimeError from
    # deep inside the broad phase tells nobody what went wrong.
    required = ("openingId", "angleDeg", "swivelDeg", "halfSpaces", "lowerEdge", "normal", "reach", "sillZ")
    if not isinstance(volume, dict) or any(k not in volume for k in required):
        absent = [k for k in required if not isinstance(volume, dict) or k not in volume]
        return undecidable(
            from_=[],
            method="obstructions(<kein Prisma>)",
            provenance="computed",
            missing=MissingFact(
                what=f"kein auswertbares Prisma: {', '.join(absent) or 'kein dict'} fehlt",
                remedy="obstructions() nimmt den Rückgabewert von prism() entgegen, unverändert.",
            ),
        )

    opening_id = volume["openingId"]
    method = (
        f"obstructions(prism({opening_id}, {volume['angleDeg']}, {volume['swivelDeg']})"
        + (f", exclude: [{', '.join(exclude)}]" if exclude else "")
        + ")"
    )

    skip = {opening_id, *(exclude or ())}
    # Through `by_id`, so a prism built against another model raises the contract
    # error instead of a raw RuntimeError from the wrapper.
    subject = _require(model, opening_id, method)
    for rel in getattr(subject, "HasFillings", []) or []:
        skip.add(rel.RelatedBuildingElement.GlobalId)
    for rel in getattr(subject, "FillsVoids", []) or []:
        skip.add(rel.RelatingOpeningElement.GlobalId)

    planes = [(np.array(h["normal"]), np.array(h["point"])) for h in volume["halfSpaces"]]
    incline = next(
        (np.array(h["normal"]), np.array(h["point"])) for h in volume["halfSpaces"] if h["role"] == "incline"
    )

    # Broad phase: the prism is unbounded, so it is boxed by the model's own
    # extent in front of the facade before it is handed to the tree.
    bounds = model.bounds
    edge = np.array(volume["lowerEdge"][0]), np.array(volume["lowerEdge"][1])
    reach = float(volume["reach"])
    corners = np.array(
        [
            edge[0],
            edge[1],
            edge[0] + np.array(volume["normal"]) * reach,
            edge[1] + np.array(volume["normal"]) * reach,
        ]
    )
    low = corners.min(axis=0) - reach * np.tan(np.radians(volume["swivelDeg"]))
    high = corners.max(axis=0) + reach * np.tan(np.radians(volume["swivelDeg"]))
    low[2] = float(volume["sillZ"])
    high[2] = float(bounds[1][2]) if bounds is not None else float(volume["sillZ"]) + reach
    if bounds is not None:
        low = np.maximum(low, bounds[0])
        high = np.minimum(high, bounds[1])

    found: list[dict[str, Any]] = []
    for element in model.tree.select_box((tuple(low.tolist()), tuple(high.tolist()))):
        if element.GlobalId in skip or element.is_a() in AIR_TYPES:
            continue
        if model.kind_of(element) != "element":
            continue
        geo = model.geometry(element.GlobalId)
        if geo is None:
            continue
        depth = -np.inf
        for triangle in geo.triangles:
            polygon: list[np.ndarray] = [triangle[0], triangle[1], triangle[2]]
            for normal, point in planes:
                polygon = clip_polygon(polygon, normal, point)
                if not polygon:
                    break
            if not polygon:
                continue
            past = float(max((p - incline[1]) @ incline[0] for p in polygon))
            depth = max(depth, past)
        if depth > MIN_INTRUSION:
            found.append(
                {
                    "globalId": element.GlobalId,
                    "name": model.label(element),
                    "intrusionDepth": round(depth, 6),
                }
            )

    found.sort(key=lambda f: -f["intrusionDepth"])
    return computed(
        found,
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[opening_id, *[f["globalId"] for f in found]],
        method=method,
        caveat=(
            "Das ist Geometrie, kein Befund: ein durchschnittenes Prisma VERGRÖSSERT nach OIB 3 die "
            "erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Die Winkel stammen aus dem "
            "Regelwerk, nicht aus dem Modell."
        ),
    )
