"""Compartment areas: the floor area one fire compartment encloses, and the caveats that come with a declared zone."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ifc_spatial.fire_constants import MIN_OVERLAP_AREA

from . import operators as op
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel

# ════════════════════════════════════════════════════════════════════════════
# compartment_area — what a Brandabschnitt is measured on
# ════════════════════════════════════════════════════════════════════════════


def compartment_area(model: SpatialModel, storey_or_space_ids: str | Sequence[str]) -> Answer[dict[str, Any]]:
    """The floor area of a group of spaces taken together, in m².

    Takes one id or a list of them, and each may be:

      - an **``IfcZone`` or ``IfcGroup``** — the export's OWN declaration of what
        belongs together. When one is passed the grouping is ``declared``, and
        the answer says so: a declared compartment is the architect's statement
        and outranks anything this library would assemble from a storey.
      - an **``IfcBuildingStorey``** — every space aggregated into or contained
        in it. Convenient and *not* the same thing: a storey is not a
        Brandabschnitt, and the caveat says so every time.
      - an **``IfcSpace``** — itself.

    ## Why the constituents travel with the sum

    A single number is unauditable. Each space comes back with its own area and
    the provenance of that area, so a reviewer who thinks the total is wrong can
    point at the one room that is wrong. It also makes the two ways the sum can
    lie visible:

      - **double counting.** The same space reached twice — passed directly and
        again through its storey — is de-duplicated by GlobalId and the drop is
        reported. This is exact, not heuristic.
      - **overlap.** Two space bodies that overlap in plan at the same height
        are one room modelled twice, and their areas add up to more floor than
        the building has. The overlapping area is measured with shapely and
        reported; it is NOT subtracted, because which of the two rooms is the
        spurious one is not something geometry can decide.

    Spaces at *different* heights are never treated as overlapping: a
    Brandabschnitt over two storeys is measured as the sum of both floors, and
    unioning their footprints in plan would halve it.

    ## No threshold

    OIB Richtlinie 2 names a maximum Brandabschnittsfläche. That number is a
    fact about the clause and appears nowhere here; this returns square metres.
    """
    ids = [storey_or_space_ids] if isinstance(storey_or_space_ids, str) else list(storey_or_space_ids)
    method = f"compartmentArea([{', '.join(ids)}])"
    if not ids:
        return undecidable(
            from_=[],
            method="compartmentArea([])",
            provenance="computed",
            missing=MissingFact(
                what="kein Bezugsobjekt übergeben",
                remedy=(
                    "compartmentArea() braucht mindestens eine GlobalId — eine Zone (IfcZone/IfcGroup), ein "
                    "Geschoß oder einen Raum."
                ),
            ),
        )

    spaces: list[Any] = []
    seen: set[str] = set()
    duplicates: list[dict[str, Any]] = []
    grouping: list[dict[str, Any]] = []

    for global_id in ids:
        subject = op._require(model, global_id, method)
        resolved, via, is_declared = _resolve_group(model, subject)
        if resolved is None:
            op._wrong_kind(
                subject,
                method,
                "compartmentArea",
                "eine Zone (IfcZone/IfcGroup), ein Geschoß (IfcBuildingStorey) oder einen Raum (IfcSpace)",
                "für ein Bauteil: floorArea() misst seine Grundfläche einzeln",
            )
        grouping.append(
            {
                "globalId": global_id,
                "name": model.label(subject),
                "ifcType": subject.is_a(),
                "via": via,
                "declared": is_declared,
                "room_count": len(resolved),
            }
        )
        for space in resolved:
            if space.GlobalId in seen:
                duplicates.append({"globalId": space.GlobalId, "name": model.label(space), "group": global_id})
                continue
            seen.add(space.GlobalId)
            spaces.append(space)

    if not spaces:
        return undecidable(
            from_=list(ids),
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="IfcSpace unterhalb der übergebenen Objekte",
                remedy=(
                    "Keines der übergebenen Objekte führt auf einen Raum. Räume im CAD als IfcSpace "
                    "exportieren und sie dem Geschoß bzw. der Zone zuordnen (IfcRelAggregates, "
                    "IfcRelAssignsToGroup) — eine Brandabschnittsfläche wird auf Räumen gemessen."
                ),
                elements=list(ids),
            ),
        )

    measured: list[dict[str, Any]] = []
    without: list[dict[str, Any]] = []
    total = 0.0
    tolerance = 0.0
    for space in spaces:
        answer = op.floor_area(model, space.GlobalId)
        if not answer.decidable or not isinstance(answer.value, (int, float)):
            without.append(
                {
                    "globalId": space.GlobalId,
                    "name": model.label(space),
                    "why": answer.missing.what if answer.missing else "floorArea() war nicht entscheidbar",
                    "remedy": answer.missing.remedy if answer.missing else None,
                }
            )
            continue
        area = float(answer.value)
        total += area
        tolerance += float(answer.tolerance or abs(area) * op.AREA_RELATIVE_TOLERANCE)
        measured.append(
            {
                "globalId": space.GlobalId,
                "name": model.label(space),
                "ifcType": space.is_a(),
                "area": round(area, 4),
                "provenance": answer.provenance,
                "agreement": answer.agreement,
            }
        )

    if not measured:
        return undecidable(
            from_=[s.GlobalId for s in spaces],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="für keinen der Räume ist eine Grundfläche bestimmbar",
                remedy=(
                    "Kein Raum dieser Gruppe trägt eine auswertbare Körpergeometrie oder eine deklarierte "
                    "Fläche. Abhilfe im CAD: die Räume mit Körpergeometrie neu exportieren (Body-"
                    "Repräsentation, kein reiner Bounding-Box-Export) oder die Raumflächen als Mengen "
                    "mitexportieren (Qto_SpaceBaseQuantities.NetFloorArea). floorArea() nennt je Raum, was "
                    "genau fehlt. Ohne Flächen ist keine Brandabschnittsfläche bildbar."
                ),
                elements=[s.GlobalId for s in spaces],
            ),
        )

    overlaps = _plan_overlaps(model, spaces)
    caveat = _compartment_caveat(model, grouping, measured, without, duplicates, overlaps)

    value = {
        "area": round(total, 4),
        "spaceCount": len(measured),
        "spaces": measured,
        "grouping": grouping,
        "ohneFlaeche": without,
        "duplicates": duplicates,
        "overlaps": overlaps,
        "deklarierteZonen": _declared_zones(model),
    }
    # `computed`, always, even when the GROUPING is the architect's own IfcZone:
    # the envelope carries one provenance and the number is the sum of measured
    # areas. That the grouping was declared is stated in `grouping[].deklariert`
    # and in the caveat, where it can be read as what it is — a statement about
    # which rooms belong together, not about how large they are.
    return computed(
        value,
        unit="m²",
        tolerance=round(tolerance, 6),
        from_=[entry["globalId"] for entry in measured],
        method=method,
        caveat=caveat,
    )


def _resolve_group(model: SpatialModel, subject: Any) -> tuple[list[Any] | None, str, bool]:
    """The spaces behind one id, how they were reached, and whether that is declared."""
    kind = model.kind_of(subject)
    if kind == "space":
        return [subject], "Raum unmittelbar übergeben", True
    if subject.is_a("IfcGroup"):
        # `IfcZone` is a subtype of `IfcGroup`, so both arrive here. Only the
        # spaces are taken: a zone may legitimately group other zones and
        # elements, and an IfcWall inside a zone is not floor area.
        members = [
            member
            for rel in (getattr(subject, "IsGroupedBy", []) or [])
            for member in (rel.RelatedObjects or [])
            if member.is_a("IfcSpace")
        ]
        return members, f"deklarierte Gruppe {subject.is_a()} → IfcRelAssignsToGroup", True
    if kind == "storey":
        spaces = [space for space in model.file.by_type("IfcSpace") if _storey_id(model, space) == subject.GlobalId]
        return spaces, "alle Räume dieses Geschoßes (IfcRelAggregates / IfcRelContainedInSpatialStructure)", True
    # A building or a site is deliberately NOT accepted. "Alle Räume des
    # Gebäudes" is a plausible-looking call that produces the Brutto-Grundfläche
    # of the whole house under the name of a Brandabschnitt, and the answer would
    # carry no sign of the substitution. The caller has to name the storeys or
    # the zone it means.
    return None, "", False


def _storey_id(model: SpatialModel, space: Any) -> str | None:
    storey = model.storey_of(space)
    return None if storey is None else storey.GlobalId


def _plan_overlaps(model: SpatialModel, spaces: Sequence[Any]) -> list[dict[str, Any]]:
    """Pairs of spaces that occupy the same plan area at the same height.

    Only pairs whose Z ranges actually overlap are tested. Two rooms stacked on
    different storeys share their whole footprint in plan and are not double
    counting — a Brandabschnitt spanning two floors is the sum of both — so a
    plan-only union would silently halve exactly the compartment this operator
    is asked about most.
    """
    import shapely
    import shapely.ops

    footprints: list[tuple[Any, Any, tuple[float, float]]] = []
    for space in spaces:
        geo = model.geometry(space.GlobalId)
        if geo is None or geo.triangles is None or len(geo.triangles) == 0:
            continue
        polygons = []
        for triangle in geo.triangles:
            polygon = shapely.Polygon(triangle[:, :2])
            if polygon.is_valid and polygon.area > 0:
                polygons.append(polygon)
        if not polygons:
            continue
        try:
            merged = shapely.ops.unary_union(polygons)
        except Exception:
            continue
        footprints.append((space, merged, (float(geo.box[0][2]), float(geo.box[1][2]))))

    out: list[dict[str, Any]] = []
    for index, (space, shape, span) in enumerate(footprints):
        for other, other_shape, other_span in footprints[index + 1 :]:
            if min(span[1], other_span[1]) - max(span[0], other_span[0]) <= op.COORDINATE_TOLERANCE:
                continue
            try:
                area = float(shape.intersection(other_shape).area)
            except Exception:
                continue
            if area > MIN_OVERLAP_AREA:
                out.append(
                    {
                        "a": {"globalId": space.GlobalId, "name": model.label(space)},
                        "b": {"globalId": other.GlobalId, "name": model.label(other)},
                        "area": round(area, 4),
                    }
                )
    return out


def _declared_zones(model: SpatialModel) -> list[dict[str, Any]]:
    """Every zone or group this file declares over spaces, with its members.

    Reported on every answer, even when the caller asked about a storey. If the
    export states its own compartments, that statement is worth more than a
    storey-shaped guess and the caller should be told it exists.
    """
    out: list[dict[str, Any]] = []
    for ifc_type in ("IfcZone", "IfcGroup"):
        try:
            groups = model.file.by_type(ifc_type)
        except RuntimeError:
            continue
        for group in groups:
            if ifc_type == "IfcGroup" and group.is_a("IfcZone"):
                continue  # already listed under its own type
            members = [
                member
                for rel in (getattr(group, "IsGroupedBy", []) or [])
                for member in (rel.RelatedObjects or [])
                if member.is_a("IfcSpace")
            ]
            if not members:
                continue
            out.append(
                {
                    "globalId": group.GlobalId,
                    "name": model.label(group),
                    "ifcType": group.is_a(),
                    "spaces": [m.GlobalId for m in members],
                }
            )
    return out


def _compartment_caveat(
    model: SpatialModel,
    grouping: Sequence[dict[str, Any]],
    measured: Sequence[dict[str, Any]],
    without: Sequence[dict[str, Any]],
    duplicates: Sequence[dict[str, Any]],
    overlaps: Sequence[dict[str, Any]],
) -> str:
    parts = [
        "Summe der Einzelgrundflächen der genannten Räume. Nichts aus dem Regelwerk angewandt: die "
        "größtmögliche Brandabschnittsfläche steht in der Bestimmung, nicht im Modell, und wird hier mit "
        "nichts verglichen."
    ]
    if any(entry["ifcType"] == "IfcBuildingStorey" for entry in grouping):
        parts.append(
            "Mindestens eine der übergebenen Gruppen ist ein GESCHOSS. Ein Geschoß ist kein Brandabschnitt — "
            "ein Geschoß kann mehrere Brandabschnitte enthalten und ein Brandabschnitt mehrere Geschoße "
            "umfassen. Die Zahl ist die Geschoßfläche, solange nichts anderes deklariert ist."
        )
    if any(entry["declared"] and entry["ifcType"] in ("IfcZone", "IfcGroup") for entry in grouping):
        parts.append(
            "Die Zusammenstellung stammt aus einer im Export DEKLARIERTEN Gruppe (IfcZone/IfcGroup) — das ist "
            "die Aussage des Verfassers darüber, was zusammengehört, und wurde deshalb einer eigenen "
            "Zusammenstellung vorgezogen."
        )
    zones = _declared_zones(model)
    if zones and not any(entry["ifcType"] in ("IfcZone", "IfcGroup") for entry in grouping):
        parts.append(
            f"Dieser Export deklariert selbst {len(zones)} Zone(n)/Gruppe(n) über Räume ("
            + ", ".join(f"„{z['name'] or z['globalId']}“" for z in zones[:3])
            + "). Diese Zusammenstellung ist die Aussage des Verfassers; compartmentArea() mit deren GlobalId "
            "aufrufen misst genau sie."
        )
    if duplicates:
        parts.append(
            f"{len(duplicates)} Raum/Räume wurden über mehr als einen Weg erreicht und nur EINMAL gezählt; "
            "sie stehen unter „doppelt“. Ohne diese Entdopplung wäre die Fläche um deren Größe zu groß."
        )
    if overlaps:
        overlapping = round(sum(entry["area"] for entry in overlaps), 3)
        parts.append(
            f"{len(overlaps)} Raumpaar(e) überlappen sich auf derselben Höhe im Grundriss um zusammen "
            f"{overlapping} m². Das ist ein Befund über den Export — ein Raum ist vermutlich doppelt "
            "modelliert. Die Fläche wurde NICHT bereinigt, weil die Datei nicht sagt, welcher der beiden "
            "Räume der überzählige ist; die Summe ist insoweit zu groß."
        )
    if without:
        parts.append(
            f"{len(without)} Raum/Räume ohne bestimmbare Fläche sind NICHT enthalten — die Summe ist "
            "insofern eine Untergrenze. Was je Raum fehlt, steht unter „ohneFlaeche“."
        )
    if any(entry["agreement"] == "disagree" for entry in measured):
        parts.append(
            "Bei mindestens einem Raum widersprechen sich deklarierte und gemessene Fläche; floorArea() "
            "nennt für diesen Raum beide Zahlen."
        )
    parts.append(
        "Gemessen ist die Netto-Grundfläche der Raumkörper. Ob die Bestimmung die Brutto-Grundfläche meint — "
        "also einschließlich der umschließenden Wände — entscheidet die Bestimmung; der Unterschied liegt bei "
        "einem üblichen Grundriss im Bereich von 10–15 %."
    )
    return " ".join(parts)
