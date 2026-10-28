"""Distance to the site boundary, measured from the building's outline to the nearest point of the site."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from ifc_spatial.fire_constants import BOUNDARY_TERMS
from ifc_spatial.fire_constants import NOT_OCCUPIED_TERMS

from . import operators as op
from .briefing import normalise
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import AIR_TYPES
from .model import SpatialModel

# ════════════════════════════════════════════════════════════════════════════
# distance_to_site_boundary — the one that usually has to refuse
# ════════════════════════════════════════════════════════════════════════════


def distance_to_site_boundary(model: SpatialModel, global_id: str | None = None) -> Answer[dict[str, Any]]:
    """Horizontal distance from the building — or from one element — to the site boundary, in metres.

    The geometric input to Brandübertragung auf Nachbargrundstücke, and the
    operator in this module most likely to return nothing.

    ## Why there is no bounding-box fallback, deliberately

    Every ``IfcSite`` has a placement and most have a bounding box implied by
    whatever geometry hangs beneath them. It would take four lines to take the
    site's extent and report the distance from the building to its edge, and the
    number would be **fiction**: the site's extent in an architectural export is
    the extent of the *modelled* content — the terrain patch someone drew, or
    the building itself — and it has no relationship to the Grundstücksgrenze in
    the Katasterplan. A wrong Abstand zur Grundstücksgrenze is not a rounding
    error; it is the input to whether a facade may have openings at all, and it
    would arrive wearing a unit, a tolerance and ``provenance = computed`` like
    every honest number in this library.

    So: a boundary is measured only against a boundary that is actually in the
    file, and otherwise the answer is ``undecidable`` with a remedy naming what
    to export. **Measured on this repository's fixtures: none of the five
    carries one.** All five have ``IfcSite.Representation = None`` and not one
    ``IfcAnnotation`` between them. The sample house is even georeferenced
    (``RefLatitude`` 51° 30′) and still has no boundary — georeferencing places
    a model on the earth, it does not draw the plot.

    ## What counts as a boundary when it is there

    In order: a curve in the ``IfcSite``'s own representation (``FootPrint`` is
    where exporters put it), then an ``IfcAnnotation`` whose name matches
    :data:`BOUNDARY_TERMS`. Polylines and indexed poly-curves are read straight
    off the entity and transformed by their placement, rather than through the
    tessellator: a 2D ``FootPrint`` curve is not a body, and asking a solid
    kernel for one produces nothing at all.

    ## What is measured

    The shortest **horizontal** distance from the subject's body to the boundary
    polygon, over every vertex. With no ``global_id`` the subject is every
    physical element in the model — spaces and openings are air and are skipped
    — and the answer names the element that comes closest, because "das Gebäude
    steht 3,00 m von der Grenze" is only usable if you can see which corner of
    it that is.

    No verdict: how close is permissible depends on the Bestimmung, the
    Bebauungsplan and the neighbour's building, none of which is in this file.
    """
    method = "distanceToSiteBoundary(model)" if global_id is None else f"distanceToSiteBoundary({global_id})"
    subject = None if global_id is None else op._require(model, global_id, method)

    boundary = _site_boundary(model)
    if boundary is None:
        return undecidable(
            from_=[] if global_id is None else [global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="Grundstücksgrenze — keine Geometrie am IfcSite und keine IfcAnnotation dafür",
                remedy=(
                    "Dieser Export enthält die Grundstücksgrenze nicht. Ein IfcSite ist zwar vorhanden, trägt "
                    "aber keine Repräsentation, und es gibt keine Annotation, die eine Grenze beschreibt. "
                    "Abhilfe im CAD: die Grundstücksgrenze aus dem Kataster- bzw. Vermessungsplan als "
                    "geschlossenen Linienzug am IfcSite mitexportieren (Repräsentation „FootPrint“) oder als "
                    "IfcAnnotation mit sprechendem Namen („Grundstücksgrenze“). Eine Georeferenzierung "
                    "(RefLatitude/RefLongitude, IfcMapConversion) genügt dafür NICHT — sie verortet das "
                    "Modell auf der Erde, sie zeichnet die Parzelle nicht. Ein Abstand aus der Hüllbox des "
                    "Geländes wird hier bewusst NICHT gebildet: er sähe wie eine Messung aus und wäre eine "
                    "Erfindung."
                ),
                elements=None if global_id is None else [global_id],
            ),
        )

    subjects: list[Any]
    if subject is not None:
        subjects = [subject]
    else:
        subjects = [
            element
            for element in model.file.by_type("IfcProduct")
            if element.is_a() not in AIR_TYPES
            and model.kind_of(element) == "element"
            and getattr(element, "GlobalId", None)
        ]
    if not subjects:
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="kein Bauteil mit Körpergeometrie",
                remedy=(
                    "Dieses Modell enthält kein physisches Bauteil, dessen Abstand zur Grenze gemessen werden "
                    "könnte. Das Modell mit Körpergeometrie exportieren."
                ),
            ),
        )

    measured: list[dict[str, Any]] = []
    for element in subjects:
        geo = model.geometry(element.GlobalId)
        if geo is None:
            continue
        distance, on_element, on_boundary = _distance_to_polygon(geo.verts[:, :2], boundary["points"])
        measured.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
                "ifcType": element.is_a(),
                "distance": round(distance, 4),
                "pointOnElement": [round(float(c), 4) for c in on_element],
                "pointOnBoundary": [round(float(c), 4) for c in on_boundary],
            }
        )

    if not measured:
        return op._no_geometry(model, subjects[0], method, [s.GlobalId for s in subjects])

    measured.sort(key=lambda entry: (entry["distance"], entry["globalId"]))
    nearest = measured[0]
    # `None`, not `False`, on an open polyline: an even-odd crossing test has to
    # close the ring to run at all, and on three drawn sides of a parcel that
    # closing line is a line nobody drew. Reporting `False` would be an answer
    # about a shape this file does not contain.
    outside = _outside_polygon(np.array(nearest["pointOnElement"]), boundary["points"]) if boundary["closed"] else None

    caveat = [
        "Waagrechter Abstand zwischen dem Bauteilkörper und dem Grenzlinienzug, in der Grundrissebene "
        "gemessen. Nichts aus dem Regelwerk angewandt: welchen Abstand die Bestimmung verlangt, ergibt sich "
        "aus ihr und aus dem Bebauungsplan, nicht aus diesem Modell.",
        f"Die Grenze stammt aus: {boundary['via']}. Ihre Richtigkeit ist eine Eigenschaft des Exports — "
        "maßgeblich ist der Vermessungs- bzw. Katasterplan.",
    ]
    if not boundary["closed"]:
        caveat.append(
            "Der Linienzug ist NICHT geschlossen (erster und letzter Punkt fallen nicht zusammen). Gemessen "
            "wurde ausschließlich auf die GEZEICHNETEN Strecken — der Zug wird nicht rechnerisch geschlossen, "
            "denn die Schlusslinie hat niemand gezeichnet und ein Abstand darauf wäre erfunden. Fehlt hier "
            "eine Seite des Grundstücks, ist der gemeldete Abstand zu GROSS, und das ist die gefährliche "
            "Richtung: die fehlende Seite kann die nächstgelegene sein. Ob innen oder außen liegt, wird für "
            "einen offenen Zug nicht bestimmt."
        )
    if outside:
        caveat.append(
            "Der nächstgelegene Punkt des Bauwerks liegt AUSSERHALB des Grenzlinienzugs. Das ist zuerst ein "
            "Befund über den Export — Modell und Grenze stehen vermutlich auf verschiedenen Bezugspunkten — "
            "und erst danach eine Aussage über das Bauwerk. Der gemeldete Abstand ist in diesem Fall der "
            "Abstand nach außen."
        )
    # `elements` carries the ten nearest, never all of them, and the caveat has
    # to say which of the two it is. On a model with 12 candidate elements the
    # sentence „Die vollständige … Liste steht unter „elemente““ stood over a
    # payload of 10: a truncation that reads as „das ist alles" is exactly what
    # `Answer.caveat` means by "a caller that drops this is reporting a subset
    # as a total".
    listed = measured[:10]
    if global_id is None:
        caveat.append(
            f"Geprüft wurden {len(measured)} Bauteile; genannt ist das nächstgelegene "
            f"(„{nearest['name'] or nearest['globalId']}“). Räume und Öffnungen sind ausgenommen, sie sind "
            f"Luft. Unter „elemente“ stehen die {len(listed)} nächstgelegenen der {len(measured)} geprüften "
            "Bauteile, nach Abstand sortiert"
            + (
                "; das sind alle."
                if len(listed) == len(measured)
                else f" — die {len(measured) - len(listed)} entfernteren sind NICHT enthalten."
            )
        )

    return computed(
        {
            "distance": nearest["distance"],
            "nearest": nearest,
            "boundary": {
                "via": boundary["via"],
                "globalId": boundary["globalId"],
                "points": len(boundary["points"]),
                "closed": boundary["closed"],
            },
            "outside": outside,
            "elements": listed,
        },
        unit="m",
        tolerance=op.DIMENSION_TOLERANCE,
        from_=[boundary["globalId"], nearest["globalId"]],
        method=method,
        caveat=" ".join(caveat),
    )


def _site_boundary(model: SpatialModel) -> dict[str, Any] | None:
    """The site boundary polygon in world XY, or ``None`` when the file has none."""
    for site in model.file.by_type("IfcSite"):
        found = _curve_points(model, site)
        if found is not None:
            return {
                "globalId": site.GlobalId,
                "via": f"IfcSite „{model.label(site) or site.GlobalId}“, Repräsentation „{found[1]}“",
                "points": found[0],
                "closed": _is_closed(found[0]),
            }

    try:
        annotations = model.file.by_type("IfcAnnotation")
    except RuntimeError:
        annotations = []
    for annotation in annotations:
        label = " ".join(
            str(value)
            for value in (annotation.Name, getattr(annotation, "ObjectType", None), annotation.Description)
            if value
        )
        if _matching_term(label, BOUNDARY_TERMS) is None:
            continue
        found = _curve_points(model, annotation)
        if found is not None:
            return {
                "globalId": annotation.GlobalId,
                "via": f"IfcAnnotation „{model.label(annotation) or annotation.GlobalId}“",
                "points": found[0],
                "closed": _is_closed(found[0]),
            }
    return None


def _curve_points(model: SpatialModel, product: Any) -> tuple[np.ndarray, str] | None:
    """World-coordinate XY points of the first usable curve on this product.

    Read off the entity and transformed by its placement rather than shaped: a
    ``FootPrint`` is a 2D curve, ``ifcopenshell.geom.create_shape`` builds solids
    and surfaces, and asking it for a plot boundary returns nothing at all —
    which would be indistinguishable from the file not having one.
    """
    import ifcopenshell.util.placement as placement_util

    representation = getattr(product, "Representation", None)
    if representation is None:
        return None
    try:
        matrix = placement_util.get_local_placement(product.ObjectPlacement)
    except Exception:
        matrix = np.eye(4)

    for shape in representation.Representations or []:
        points = _points_of_items(shape.Items or [])
        if len(points) < 2:
            continue
        local = np.array(points, dtype=float)
        world = (matrix[:3, :3] @ local.T).T + matrix[:3, 3]
        return world[:, :2] * model.unit_scale, shape.RepresentationIdentifier or shape.RepresentationType or "?"
    return None


def _points_of_items(items: Sequence[Any]) -> list[tuple[float, float, float]]:
    """Cartesian points out of the curve kinds an exporter actually writes."""
    out: list[tuple[float, float, float]] = []
    for item in items:
        if item.is_a("IfcPolyline"):
            out.extend(_xyz(point) for point in item.Points)
        elif item.is_a("IfcIndexedPolyCurve"):
            coordinates = getattr(item.Points, "CoordList", None) or []
            out.extend(_xyz_tuple(entry) for entry in coordinates)
        elif item.is_a("IfcGeometricSet") or item.is_a("IfcGeometricCurveSet"):
            out.extend(_points_of_items(item.Elements or []))
        elif item.is_a("IfcCompositeCurve"):
            for segment in item.Segments or []:
                out.extend(_points_of_items([segment.ParentCurve]))
    return out


def _xyz(point: Any) -> tuple[float, float, float]:
    return _xyz_tuple(point.Coordinates)


def _xyz_tuple(coordinates: Sequence[float]) -> tuple[float, float, float]:
    values = [float(c) for c in coordinates]
    while len(values) < 3:
        values.append(0.0)
    return values[0], values[1], values[2]


def _is_closed(points: np.ndarray) -> bool:
    return bool(len(points) >= 3 and float(np.linalg.norm(points[0] - points[-1])) < op.COORDINATE_TOLERANCE)


def _distance_to_polygon(vertices: np.ndarray, boundary: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Shortest distance from a vertex cloud to a polyline, with both witnesses.

    Both endpoints come back because a bare number is not checkable: a reviewer
    with the two coordinates can put a dimension line on the plan and see
    whether it lands where they expect.
    """
    best = math.inf
    on_element = vertices[0]
    on_boundary = boundary[0]
    # Only the segments the file actually draws. An open polyline is NOT closed
    # here, deliberately: a survey layer routinely carries three sides of a
    # parcel, and the fourth side this code would invent lands wherever the
    # first and last point happen to be. Measured on a three-sided fixture, that
    # fabricated closing line came out **1.06 m** from a wall that is 7.70 m
    # from the nearest drawn boundary — a plausible, precise, invented number,
    # which is the same substitution this operator refuses to make from the
    # site's bounding box. The caveat says a missing side makes the distance too
    # large instead.
    for start, end in zip(boundary[:-1], boundary[1:], strict=False):
        edge = end - start
        length_squared = float(edge @ edge)
        if length_squared < 1e-18:
            projected = np.repeat(start[None, :], len(vertices), axis=0)
        else:
            t = np.clip(((vertices - start) @ edge) / length_squared, 0.0, 1.0)
            projected = start + t[:, None] * edge
        distances = np.linalg.norm(vertices - projected, axis=1)
        index = int(np.argmin(distances))
        if float(distances[index]) < best:
            best = float(distances[index])
            on_element = vertices[index]
            on_boundary = projected[index]
    return best, on_element, on_boundary


def _outside_polygon(point: np.ndarray, boundary: np.ndarray) -> bool:
    """Even-odd ray crossing in plan. Meaningless on an open polyline, and the
    caller says so in that case rather than suppressing the flag."""
    inside = False
    count = len(boundary)
    for index in range(count):
        x1, y1 = boundary[index]
        x2, y2 = boundary[(index + 1) % count]
        if (y1 > point[1]) != (y2 > point[1]):
            crossing = x1 + (point[1] - y1) / (y2 - y1) * (x2 - x1)
            if point[0] < crossing:
                inside = not inside
    return not inside


# ── shared helpers ──────────────────────────────────────────────────────────


def _matching_term(name: str | None, terms: Sequence[str] = NOT_OCCUPIED_TERMS) -> str | None:
    """The first term matching this name, normalised the way the lexicon is.

    Reuses :func:`~ifc_spatial.briefing.normalise` so ``Dachgeschoß``,
    ``Dachgeschoss`` and ``DACHGESCHOSS`` are one storey rather than three, and
    so a name only mangled by an exporter's encoding does not change the answer.
    """
    if not name:
        return None
    normalised = normalise(str(name))
    for term in terms:
        if term in normalised:
            return term
    return None


def _metres(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.3f} m".replace(".", ",")
