"""Reading a stair from the model: its sources, its body, and the declared counts reconciled against the geometry."""

from __future__ import annotations

from typing import Any

import numpy as np

from ifc_spatial.stairs_constants import _RISER_COUNT_NAMES
from ifc_spatial.stairs_records import _Body
from ifc_spatial.stairs_records import _Flight
from ifc_spatial.stairs_treads import _landing_levels
from ifc_spatial.stairs_treads import _measure_run
from ifc_spatial.stairs_treads import _runs
from ifc_spatial.stairs_treads import _tread_surfaces
from ifc_spatial.stairs_treads import _walking_surfaces

from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import triangulate
from .envelope import undecidable
from .model import DeclaredQuantity
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE


def _sources(*ids: str | None) -> list[str]:
    """The ``from_`` list: every element that fed the answer, once, in order.

    Deduplicated because the subject of these operators is often its own source —
    ``stairGeometry(<flight>)`` measures the flight it was handed — and a
    ``from`` list that names the same GlobalId twice reads as two independent
    pieces of evidence.
    """
    return list(dict.fromkeys([i for i in ids if i]))


def _read_body(model: SpatialModel, element: Any) -> _Body:
    """One solid → every flight in it, its landings, and what it refused.

    The reader used to assume that one body is one flight, and took the chord
    from the first tread centre to the last as the direction of travel. On the
    Institute's „Treppe-EG" — a three-flight dogleg written as ONE ``IfcStair``
    with no parts and no ``PredefinedType``, so nothing in the file announces the
    flights — that chord runs diagonally across the stairwell. Everything
    measured against it was measured against the wrong axis: the „Nutzbreite"
    it reported, **0.318 m**, is the depth of one tread across that diagonal —
    a step's going, near enough — on a flight that is **1.500 m** wide. A 4.7×
    understatement of the one number OIB 4's Nutzbreite question turns on, and
    in the direction that fails a stair which complies.

    So the levels are split into runs first — at the landings and at the turns —
    and each run is measured on its own axis. Whatever cannot be split into a
    straight run is refused with the measurement that decided it, never averaged
    into a number that looks like a stair.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return _Body(flights=[], landings=0, refusals=[], levels=0)
    clusters = _walking_surfaces(_tread_surfaces(geo))
    if not clusters:
        return _Body(flights=[], landings=0, refusals=[], levels=0)

    landings = _landing_levels(clusters)
    groups = _runs(clusters, landings)
    landing_positions = [index for index, is_landing in enumerate(landings) if is_landing]

    flights: list[_Flight] = []
    refusals: list[str] = []
    for indices, below, above in groups:
        first, last = indices[0], indices[-1]
        landing_under = next((clusters[i] for i in reversed(landing_positions) if i < first), None) if below else None
        landing_over = next((clusters[i] for i in landing_positions if i > last), None) if above else None
        flight, refusal = _measure_run(
            element,
            [clusters[i] for i in indices],
            base_z=float(geo.box[0][2]),
            landing_below=landing_under,
            landing_above=landing_over,
            alone=len(groups) == 1,
        )
        if flight is not None:
            flights.append(flight)
        elif refusal is not None and refusal not in refusals:
            refusals.append(refusal)

    return _Body(flights=flights, landings=len(landing_positions), refusals=refusals, levels=len(clusters))


def _spread(values: list[float]) -> dict[str, float]:
    """Mean, extremes and spread of a set of measurements.

    ``spread`` is max − min and not a standard deviation: an architect fixes the
    two steps at the ends of the range, not a distribution, and OIB 4's demand
    that risers be equal is a statement about exactly that difference.
    """
    array = np.array(values, dtype=float)
    return {
        "mean": float(array.mean()),
        "min": float(array.min()),
        "max": float(array.max()),
        "spread": float(array.max() - array.min()),
        "count": int(array.size),
    }


# ════════════════════════════════════════════════════════════════════════════
# what the file declares about a stair
# ════════════════════════════════════════════════════════════════════════════


def _declared_count(model: SpatialModel, elements: list[Any]) -> tuple[int | None, str | None]:
    """``NumberOfRiser`` off the first element that declares it, with its source.

    Read with ``declared_property`` and not ``declared_quantity``, because a
    riser COUNT carries no unit and must not be run through a length conversion —
    in a millimetre model that path would turn 18 risers into 0.018.
    """
    for element in elements:
        value = model.declared_property(element, _RISER_COUNT_NAMES)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        return int(value), element.GlobalId
    return None, None


def _declared_length(
    model: SpatialModel, elements: list[Any], names: tuple[str, ...]
) -> tuple[DeclaredQuantity | None, str | None]:
    """The first declared length among ``names``, in metres, with its element.

    ``declared_quantity`` rather than ``declared_property`` because this one DOES
    carry a unit: ``Pset_StairCommon.RiserHeight`` is an ``IfcPositiveLengthMeasure``
    stated in the file's own length unit, so a millimetre export declares 175.0
    and means 0.175 m.
    """
    for element in elements:
        quantity = model.declared_quantity(element, names)
        if quantity is not None:
            return quantity, element.GlobalId
    return None, None


def _reconcile(
    measured: float | None,
    declared_quantity: DeclaredQuantity | None,
    *,
    subject_id: str,
    declared_on: str | None,
    method: str,
) -> tuple[dict[str, Any], str | None]:
    """One measured number against one declared number — the triangulated pair.

    Returns the block that goes into the answer's value and the German sentence
    (or ``None``) that the disagreement is worth. The sentence is
    ``envelope.triangulate``'s own, unchanged: the reader must not be able to tell
    whether a schedule/geometry conflict was found on a room area or on a riser.

    The two ``undecidable`` branches below stand for ONE missing route, never for
    both — the early return covers that case — but they still carry real German,
    because a placeholder that can only surface in a bug surfaces in a bug.
    """
    if measured is None and declared_quantity is None:
        return {"value": None, "declared": None, "agreement": None}, None

    measured_answer = (
        computed(measured, unit="m", tolerance=DIMENSION_TOLERANCE, from_=[subject_id], method=method)
        if measured is not None
        else undecidable(
            from_=[subject_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="dieser Wert ist am Körper nicht messbar",
                remedy="Der Körper zeigt die Flächen nicht, aus denen sich dieser Wert ablesen ließe.",
            ),
        )
    )
    declared_answer = (
        declared(declared_quantity.value, unit="m", from_=[declared_on or subject_id], method=method)
        if declared_quantity is not None
        else undecidable(
            from_=[subject_id],
            method=method,
            missing=MissingFact(
                what="die Datei deklariert diesen Wert nicht",
                remedy=(
                    "Steigungshöhe und Auftritt in Pset_StairCommon bzw. Pset_StairFlightCommon eintragen "
                    "und erneut exportieren."
                ),
            ),
        )
    )
    pair = triangulate(measured_answer, declared_answer, method=method)
    block: dict[str, Any] = {
        "value": pair.value,
        "measured": measured,
        "declared": None if declared_quantity is None else declared_quantity.value,
        "declaredAs": None if declared_quantity is None else declared_quantity.path,
        "agreement": pair.agreement,
    }
    return block, pair.caveat


# ════════════════════════════════════════════════════════════════════════════
# stair_geometry
# ════════════════════════════════════════════════════════════════════════════


def _parts_of(element: Any) -> list[Any]:
    """``IfcRelAggregates`` parts of an assembly, in file order."""
    out: list[Any] = []
    for rel in getattr(element, "IsDecomposedBy", []) or []:
        for part in rel.RelatedObjects or []:
            if getattr(part, "GlobalId", None):
                out.append(part)
    return out


def _is_landing(element: Any) -> bool:
    """A landing, by the only statement IFC makes about one.

    ``IfcSlab.PredefinedType = LANDING`` — not the name. Names are „Podest",
    „Landing", „Zwischenpodest" and „Slab:Generic 200mm:314159" depending on the
    exporter, and a name test would classify by locale.
    """
    if not element.is_a("IfcSlab"):
        return False
    return str(getattr(element, "PredefinedType", "") or "").upper() == "LANDING"


def _flight_parts(element: Any) -> tuple[list[Any], list[Any], list[Any]]:
    """An assembly's parts, split into flights, landings and everything else."""
    flights, landings, other = [], [], []
    for part in _parts_of(element):
        if part.is_a("IfcStairFlight") or part.is_a("IfcRampFlight"):
            flights.append(part)
        elif _is_landing(part):
            landings.append(part)
        else:
            other.append(part)
    return flights, landings, other
