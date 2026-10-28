"""The stair operator: geometry of a whole stair, its flights and landings."""

from __future__ import annotations

from typing import Any

from ifc_spatial.stairs_constants import _FLIGHT_WIDTH_NAMES
from ifc_spatial.stairs_constants import _RISER_HEIGHT_NAMES
from ifc_spatial.stairs_constants import _TREAD_LENGTH_NAMES
from ifc_spatial.stairs_constants import STAIR_TYPES
from ifc_spatial.stairs_reading import _declared_count
from ifc_spatial.stairs_reading import _declared_length
from ifc_spatial.stairs_reading import _flight_parts
from ifc_spatial.stairs_reading import _read_body
from ifc_spatial.stairs_reading import _reconcile
from ifc_spatial.stairs_reading import _sources
from ifc_spatial.stairs_reading import _spread

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import undecidable
from .model import DeclaredQuantity
from .model import SpatialModel
from .operators import COORDINATE_TOLERANCE
from .operators import DIMENSION_TOLERANCE
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind


def stair_geometry(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """Steigungshöhe, Auftrittsbreite, their spread, rise, going and Nutzbreite.

    Both routes run and both are reported:

    - **the schedule** — ``Pset_StairCommon`` / ``Pset_StairFlightCommon`` with
      ``NumberOfRiser``, ``RiserHeight`` and ``TreadLength``, and
      ``Qto_StairFlightBaseQuantities`` where the export writes it;
    - **the solid** — the up-facing horizontal faces of the body, clustered by
      height. Consecutive spacings are the risers; the plan distance between
      consecutive tread centres is the going; the narrowest tread surface is the
      Nutzbreite.

    Where both exist they are triangulated, and a disagreement is reported as a
    finding about the EXPORT rather than resolved silently in favour of either.
    On the fixture: ``RiserHeight = 0.170`` declared, 0.180 measured, 5.6 % apart
    — the geometry wins the value and the caveat names both numbers.

    ## The spread is the point

    A mean riser height cannot fail. The fixture's second stair has risers of
    0.160, 0.190, 0.170, 0.200 and 0.180 m; their mean is exactly the declared
    0.180 and their **spread is 0.040 m**. OIB 4 requires the risers of a flight
    to be equal, and every number except the spread hides that they are not. So
    ``riserHeight`` and ``treadDepth`` each carry ``min``, ``max`` and ``spread``
    beside the mean, and the caveat says in German how far the steps vary.

    ## Assemblies

    An ``IfcStair`` that aggregates flights is measured flight by flight and the
    measurements are POOLED — a stair whose two flights are individually regular
    but differ from each other is exactly as unwalkable as one irregular flight,
    and pooling is what surfaces it. The per-flight breakdown travels in
    ``flights`` so a caller can still ask about one of them. An ``IfcStair`` with
    no parts is measured directly: Revit writes the whole staircase as one body
    and refusing that file would refuse most files.

    ## …and the assemblies that are not declared as one

    A body with no parts is not the same thing as a body with one flight, and
    treating it as one is what this operator got wrong. ArchiCAD writes the
    Institute's „Treppe-EG" as a single ``IfcStair`` with no ``IfcStairFlight``,
    no landing slab and no ``PredefinedType`` — nothing in the file says it is a
    three-flight dogleg — and the reader took the chord from its first tread to
    its last, which runs diagonally across the stairwell. It reported
    ``riserCount 45``, ``riserHeight 0.065``, ``clearWidth 0.318``, ``landings 0``
    with ``decidable=True``, for a stair with 21 risers of 0.137 m, a going of
    0.348 m, a **1.500 m** Nutzbreite and two Podeste. So the flights are found
    at the body — at the turns and at the landings — and each is measured on its
    own axis (:func:`_read_body`). What cannot be read as a straight flight is
    refused with the measurement that decided it rather than averaged.

    No threshold is applied and no verdict is returned. The maximum riser and the
    minimum Nutzbreite are in OIB 4, and OIB 4 is not this layer.
    """
    method = f"stairGeometry({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in STAIR_TYPES):
        _wrong_kind(
            subject,
            method,
            "stairGeometry",
            "eine Treppe oder einen Treppenlauf (IfcStair, IfcStairFlight)",
            "für eine Rampe: rampSlope(); für die lichte Höhe über einem Lauf: headroom()",
        )

    flights, landings, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    schedule_sources = [subject, *flights]

    readings = [(element, _read_body(model, element)) for element in bodies]
    measured = [(element, flight) for element, body in readings for flight in body.flights]
    refusals = [reason for _, body in readings for reason in body.refusals]
    measured_landings = sum(body.landings for _, body in readings)

    count, count_on = _declared_count(model, schedule_sources)
    riser_declared, riser_on = _declared_length(model, schedule_sources, _RISER_HEIGHT_NAMES)
    tread_declared, tread_on = _declared_length(model, schedule_sources, _TREAD_LENGTH_NAMES)
    width_declared, width_on = _declared_length(model, schedule_sources, _FLIGHT_WIDTH_NAMES)

    if not measured:
        # No body to read. A declared schedule is still an answer — an existing
        # building surveyed into a pset is a real case — and it is reported as
        # `declared`, never dressed up as a measurement.
        if riser_declared is None and tread_declared is None and count is None:
            geo, missing = _geometry_or_answer(model, subject, method)
            if geo is None:
                return missing  # type: ignore[return-value]
            # Two different absences, and they must not be reported as one. The
            # body that shows no horizontal face at all is an export defect; the
            # body that shows steps the reader would not measure is a stair this
            # engine cannot measure, and the reason it refused is the answer.
            return undecidable(
                from_=[global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=(
                        (f"kein gerader Lauf am Körper von {subject.is_a()} „{model.label(subject) or global_id}“")
                        if refusals
                        else (
                            f"keine waagrechten Trittflächen am Körper von {subject.is_a()} "
                            f"„{model.label(subject) or global_id}“"
                        )
                    ),
                    remedy=(
                        " ".join(
                            [
                                *refusals,
                                "Abhilfe: die Treppe im CAD als Treppenbauteil mit je einem IfcStairFlight "
                                "pro Lauf exportieren, oder Steigungshöhe und Auftritt in "
                                "Pset_StairCommon.RiserHeight / .TreadLength deklarieren.",
                            ]
                        )
                        if refusals
                        else (
                            "Der Körper dieses Bauteils zeigt keine auswertbaren Stufen — er ist als Hüllquader, "
                            "als reine Fläche oder als eine einzige geschwungene Rampe exportiert. Abhilfe: die "
                            "Treppe im CAD als Treppenbauteil (IfcStair mit IfcStairFlight) mit voller "
                            "Körpergeometrie exportieren, oder Steigungshöhe und Auftritt in "
                            "Pset_StairCommon.RiserHeight / .TreadLength deklarieren."
                        )
                    ),
                    elements=[global_id],
                ),
            )

        # The same key shape as the measured route, with the measured half empty.
        # A consumer that reads `value["riserHeight"]["agreement"]` must not have
        # to know which route produced the answer — provenance already says that,
        # and a KeyError is a worse way to learn it.
        def _declared_block(quantity: DeclaredQuantity | None) -> dict[str, Any]:
            return {
                "value": None if quantity is None else quantity.value,
                "measured": None,
                "declared": None if quantity is None else quantity.value,
                "declaredAs": None if quantity is None else quantity.path,
                "agreement": None,
            }

        value: dict[str, Any] = {
            "riserCount": count,
            "risers": {
                "value": count,
                "measured": None,
                "declared": count,
                "declaredAs": None if count_on is None else "Pset_Stair(Flight)Common.NumberOfRiser",
                "agreement": None,
            },
            "riserHeight": _declared_block(riser_declared),
            "treadDepth": _declared_block(tread_declared),
            "clearWidth": None if width_declared is None else width_declared.value,
            "declaredWidth": None if width_declared is None else width_declared.value,
            "totalRise": None if (count is None or riser_declared is None) else count * riser_declared.value,
            "totalGoing": None,
            "flights": [],
            "landings": len(landings),
            "declaredLandings": len(landings),
            # Not zero: nothing was measured here, and a zero would read as „am
            # Körper ist kein Podest" about a body that was never read.
            "measuredLandings": None,
        }
        return declared(
            value,
            unit="m",
            from_=_sources(global_id, *[e for e in (count_on, riser_on, tread_on, width_on) if e]),
            method=method,
            caveat=" ".join(
                [
                    "Ausschließlich aus den deklarierten Eigenschaften gelesen — dieses Bauteil trägt in "
                    "der Datei keinen auswertbaren Körper. Die Werte sind also das, was jemand eingetragen "
                    "hat, und nicht das, was gebaut wird; ob die Steigungen tatsächlich gleich sind, lässt "
                    "sich daraus grundsätzlich nicht sagen.",
                    *refusals,
                ]
            ),
        )

    risers: list[float] = []
    goings: list[float] = []
    per_flight: list[dict[str, Any]] = []
    # How many flights came out of each body, so that a body split into three can
    # say WHICH of the three each row is. The GlobalId cannot say it — the three
    # flights of „Treppe-EG" are one IfcStair — and a reader looking at three rows
    # with the same id has to be able to tell them apart.
    per_body = {element.GlobalId: len(body.flights) for element, body in readings}
    seen: dict[str, int] = {}
    for element, flight in measured:
        risers.extend(flight.risers)
        goings.extend(flight.goings)
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
                "risers": len(flight.risers),
                "riserHeight": _spread(flight.risers) if flight.risers else None,
                "treadDepth": _spread(flight.goings) if flight.goings else None,
                "clearWidth": flight.clear_width,
                "totalRise": flight.total_rise,
                "totalGoing": flight.total_going,
                "treadSurfaces": len(flight.treads),
                # A flight read out of a body that was not split into flights in
                # the file. The number is a measurement either way; where it came
                # from is not the same statement and the reader may need both.
                "fromBody": per_body[element.GlobalId] > 1 or not flights,
                "landingBelow": flight.landing_below,
                "landingAbove": flight.landing_above,
            }
        )

    riser_stats = _spread(risers) if risers else None
    tread_stats = _spread(goings) if goings else None
    clear_width = min(flight.clear_width for _, flight in measured)
    total_rise = float(sum(flight.total_rise for _, flight in measured))
    total_going = float(sum(flight.total_going for _, flight in measured))

    riser_block, riser_conflict = _reconcile(
        None if riser_stats is None else riser_stats["mean"],
        riser_declared,
        subject_id=global_id,
        declared_on=riser_on,
        method=method,
    )
    tread_block, tread_conflict = _reconcile(
        None if tread_stats is None else tread_stats["mean"],
        tread_declared,
        subject_id=global_id,
        declared_on=tread_on,
        method=method,
    )
    if riser_stats is not None:
        riser_block.update(riser_stats)
    if tread_stats is not None:
        tread_block.update(tread_stats)

    measured_count = len(risers)
    count_block: dict[str, Any] = {
        "value": count if count is not None else measured_count,
        "measured": measured_count,
        "declared": count,
        "declaredAs": None if count_on is None else "Pset_Stair(Flight)Common.NumberOfRiser",
        "agreement": None if count is None else ("agree" if count == measured_count else "disagree"),
    }

    value = {
        "riserCount": count_block["value"],
        "risers": count_block,
        "riserHeight": riser_block,
        "treadDepth": tread_block,
        "clearWidth": clear_width,
        "declaredWidth": None if width_declared is None else width_declared.value,
        "totalRise": total_rise,
        "totalGoing": total_going,
        "flights": per_flight,
        # Landings from BOTH routes, because a file states them in either. The
        # synthetic assembly declares its Podest as an IfcSlab/LANDING part; the
        # Institute's dogleg declares nothing at all and its two Podeste are only
        # in the solid, where `landings 0` used to be reported over them.
        "landings": len(landings) + measured_landings,
        "declaredLandings": len(landings),
        "measuredLandings": measured_landings,
    }

    caveats: list[str] = []
    if riser_stats is not None and riser_stats["count"] > 1:
        if riser_stats["spread"] > COORDINATE_TOLERANCE:
            caveats.append(
                f"Die Steigungen dieses Laufs sind nicht gleich hoch: {riser_stats['count']} gemessene "
                f"Steigungen streuen von {riser_stats['min']:.3f} m bis {riser_stats['max']:.3f} m, also um "
                f"{riser_stats['spread']:.3f} m. Ein Mittelwert allein verdeckt das."
            )
        else:
            caveats.append(
                f"{riser_stats['count']} gemessene Steigungen, Streuung {riser_stats['spread'] * 1000:.0f} mm — "
                "im Rahmen der Tessellierungsgenauigkeit gleich hoch."
            )
    if tread_stats is not None and tread_stats["count"] > 1 and tread_stats["spread"] > 2 * COORDINATE_TOLERANCE:
        # „Auch" only when the risers were the previous sentence's finding. On a
        # stair with equal risers and a 25 mm spread in the goings — the
        # Institute's dogleg, where the top tread is the floor slab's own face —
        # it made the answer read as if the risers had been unequal too.
        uneven_risers = riser_stats is not None and riser_stats["spread"] > COORDINATE_TOLERANCE
        caveats.append(
            f"{'Auch die' if uneven_risers else 'Die'} Auftritte sind ungleich "
            f"({tread_stats['min']:.3f} m bis {tread_stats['max']:.3f} m). "
            "Eine einzelne deutlich tiefere Stufe ist oft ein Podest, das im selben Körper steckt und hier "
            "als Stufe mitgemessen wird — "
            + (
                f"{value['landings']} Podest(e) sind an diesem Körper erkannt und aus den Auftritten "
                "herausgerechnet; ein weiteres, flacheres kann darin stecken."
                if measured_landings
                else "stepsOf() zeigt, ob die Datei ein eigenes Podest führt."
            )
        )
    if not all(flight.base_riser_used for _, flight in measured):
        caveats.append(
            "Die unterste Steigung ist nicht mitgemessen: die Unterseite dieses Körpers liegt nicht auf der "
            "Höhe des Antritts (eine Laufplatte mit Untersicht). Gezählt und gemessen sind nur die Steigungen "
            "zwischen zwei sichtbaren Trittflächen."
        )
    if len(per_flight) > 1:
        # Which flights, and where they came from. „landings 0" over a body with
        # two Podeste in it was the previous answer on the Institute's dogleg,
        # and a reader had no way to see that the three flights had been averaged
        # into one.
        from_body = sum(1 for f in per_flight if f["fromBody"])
        caveats.append(
            f"Gemessen sind {len(per_flight)} Läufe"
            + (
                f", davon {from_body} am Körper selbst erkannt (die Datei gliedert diesen Körper nicht in "
                "IfcStairFlight; die Läufe sind an den Richtungswechseln und an den Podesten getrennt)"
                if from_body
                else ""
            )
            + f". Die Steigungen sind über alle Läufe zusammengefasst; {value['landings']} Podest(e) sind "
            "erkannt und zählen nicht als Stufe."
        )
    if refusals:
        caveats.append(
            "Ein Teil dieses Körpers ist nicht mitgemessen: " + " ".join(refusals) + " Die ausgewiesenen "
            "Werte gelten nur für die Läufe, die gemessen werden konnten."
        )
    caveats.append(
        f"Nutzbreite {clear_width:.3f} m ist die schmalste gemessene Trittfläche, quer zur Laufrichtung "
        "dieses Laufs gemessen. Sie ist eine Rohbaulichte: Handläufe, Wandbekleidungen und Geländer "
        "schmälern sie und sind nur enthalten, soweit sie den Trittflächenkörper selbst begrenzen. Ist der "
        "Lauf samt Wangen als ein Körper exportiert, misst diese Zahl über die Wangen hinweg und ist dann "
        "zu groß."
    )
    for conflict in (riser_conflict, tread_conflict):
        if conflict:
            caveats.append(conflict)
    if count_block["agreement"] == "disagree":
        caveats.append(
            f"Die Datei deklariert {count} Steigungen, gemessen sind {measured_count}. Der deklarierte Wert "
            "steht im Ergebnis, weil eine Stufenzahl gezählt und nicht geschätzt wird — die Abweichung ist "
            "ein Befund über den Export (eine unterste oder oberste Stufe, die im Körper fehlt oder die zum "
            "Podest gehört)."
        )

    return computed(
        value,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=_sources(global_id, *[element.GlobalId for element, _ in measured]),
        method=method,
        caveat=" ".join(caveats),
    )
