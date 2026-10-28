"""Treppen und Rampen — the geometry OIB 4 and OIB 2 actually turn on.

The engine could measure a window sill to the millimetre and could not say how
high one step of a staircase is. That is an accident of history: the first
failing example this package chased happened to be a daylight question, so the
daylight side grew and the circulation side did not. The repository's own golden
benchmark asks *„Welche Anforderungen stellt OIB-RL 4 an Treppenlauf-Nutzbreiten
in Bürogebäuden?"* and the answer layer had nothing to measure against — no
riser, no tread, no Nutzbreite, no Durchgangshöhe.

## Four operators, and what each one is FOR

:func:`stair_geometry`
    Steigungshöhe, Auftrittsbreite, their **spread**, the total rise and going,
    and the Nutzbreite of the flight. The spread is not decoration: OIB 4 wants
    the risers of a flight equal, and a flight whose risers vary by 40 mm is a
    trip hazard that no single mean value reveals. The synthetic flight in
    ``test_stairs.py`` has risers of 0.160 / 0.190 / 0.170 / 0.200 / 0.180 m and
    a ``Pset_StairFlightCommon.RiserHeight`` of 0.180 — the declared value and
    the measured MEAN agree exactly, and the stair is still wrong. Only the
    spread says so.

:func:`ramp_slope`
    The slope as a percentage **and** as a ratio, because barrier-free ramps are
    decided on a percentage and drawn as a ratio, and because a bare number
    "6" is ambiguous between 6 %, 1:6 and 6°. All three forms travel together
    with the rise and the run they were derived from.

:func:`headroom`
    The Durchgangshöhe — measured PERPENDICULAR to the pitch, which is the
    measurement people get wrong. See the argument below; on the test fixture
    the vertical reading is 1.620 m and the true clear passage is 1.348 m, a
    27 cm error in the generous direction.

:func:`steps_of`
    The flights and landings an ``IfcStair`` aggregates, so a caller can ask
    about one flight rather than an assembly — OIB 4 limits risers per flight
    *without a landing*, so the landings are half the question.

## The geometric route, and why it is not the declared one

``Pset_StairCommon`` / ``Pset_StairFlightCommon`` carry ``NumberOfRiser``,
``RiserHeight`` and ``TreadLength``, and where they exist they are read. They are
not trusted on their own. A schedule value is what somebody TYPED; the solid is
what will be built, and the two disagree often enough that
:func:`~ifc_spatial.envelope.triangulate` exists in this package for exactly this
shape of finding. So both routes run and both are reported: the fixture's first
flight declares ``RiserHeight = 0.170`` over a body whose treads sit 0.180 m
apart, and the answer says so in the words `triangulate` already uses for a room
area — *"Das ist ein Befund über den Export, nicht über das Gebäude."*

The geometry itself is simple once seen: a stair flight's solid has horizontal
tread faces at regular heights. Cluster the up-facing triangles by Z, and the
spacings between consecutive clusters ARE the risers; the plan distance between
consecutive cluster centroids is the going; the width of the tread surfaces is
the Nutzbreite. No stair-specific kernel call is needed and none exists.

Two things that reading assumes are not true of real exports, and both cost this
module a confident wrong number on the first third-party file it met:

**One body is not one flight.** ArchiCAD writes the Institute's „Treppe-EG" as a
single ``IfcStair`` — no ``IfcStairFlight``, no landing slab, no
``PredefinedType`` — and it is a three-flight dogleg. Taking the chord from its
first tread centre to its last gives a diagonal across the stairwell, and every
number measured against that axis is a number about the stairwell: the reported
„Nutzbreite" of **0.318 m** is one tread measured across that diagonal — the
depth of a step, not the width of a flight — on flights that are **1.500 m**
wide. So the levels are split into runs at the turns and at the Podeste, and each
run is measured on its own axis (:func:`_read_body`).

**One step is not one face.** The same export writes each step twice — the
structural step and its tread finish 60 mm above it — so every riser was counted
twice and halved: **45 risers of 0.065 m** for 21 of 0.137 m. A face with another
face directly above it is not a walking surface, and :func:`_walking_surfaces`
drops it.

What cannot be read as a straight run is REFUSED, with the measurement that
decided it: a winder whose tread centres bow off their own chord, a "riser" of
0.065 m that no leg climbs. The refusal is a true statement about the file; the
number it replaces was a false statement about the building.

## Why the Durchgangshöhe is measured perpendicular

A vertical ray from a tread measures the wrong thing, and it is wrong in the
direction nobody checks. The tight point on a stair is where the flight passes
under the edge of the floor above; the shortest line from the walking surface to
that edge is perpendicular to the pitch, and it is SHORTER than any vertical
distance measured under it. On the fixture — a 33.7° flight passing under a slab
edge at x = 1.20 m, soffit 2.60 m — the smallest vertical clearance over the
pitch line is 1.620 m (1.645 m as this operator's rays sample it) and the true
clear passage is 1.348 m. An operator that reported the vertical figure would be
handing an architect 27 cm of headroom that is not there.

So the measurement is a surface-to-surface minimum from the **raking plane** (the
plane through the nosings, over the flight's width) to whatever is above it —
which is the perpendicular distance by construction, since the shortest distance
from a plane region to a point is along the normal. Rays along that normal find
the candidates; :func:`~ifc_spatial.clearance._soup_distance` then measures them
exactly, so the answer does not depend on a sample happening to land on the
critical point. Both numbers are reported, the perpendicular one as the value and
the vertical one beside it, because a clause that means the vertical reading must
be able to get it without a second call.

The exclusion discipline is :func:`~ifc_spatial.operators.clear_height`'s, not a
new one: :data:`~ifc_spatial.model.AIR_TYPES` and
:data:`~ifc_spatial.operators.FURNISHING` are skipped and everything else counts.
Unfiltered rays have already cost this repository three wrong answers, and a
chair is not a Durchgangshöhe. ``IfcRailing`` was proposed for that list and is
deliberately not in it — every stair in the corpus was reporting its own
balustrade as the thing a head hits (0.415 m on the FZK Wendeltreppe, 0.117 m on
each of the four Institute stairs, which measure 1.745 m), and the cause was the
rake and not the filter. See :data:`HEADROOM_TRANSPARENT` for the measurement
that settled it.

## What this module refuses to do

It names no OIB number. It does not know that a riser may be at most 18 cm, that
an office stair wants 1.20 m of Nutzbreite, or that a barrier-free ramp stops at
6 %. It measures, it reports the spread, it says which route each number came
from — and the Bestimmung decides. There is no verdict field, and „erfüllt"
appears nowhere in it.
"""

from __future__ import annotations

from typing import Any  # noqa: F401

from ifc_spatial.stairs_constants import _RISER_COUNT_NAMES  # noqa: F401
from ifc_spatial.stairs_constants import BURIED_CLEARANCE  # noqa: F401
from ifc_spatial.stairs_constants import BURIED_OVERLAP_FRACTION  # noqa: F401
from ifc_spatial.stairs_constants import FLIGHT_STRAIGHTNESS  # noqa: F401
from ifc_spatial.stairs_constants import FLIGHT_TURN_DEGREES  # noqa: F401
from ifc_spatial.stairs_constants import HEADROOM_LATERAL  # noqa: F401
from ifc_spatial.stairs_constants import HEADROOM_REACH  # noqa: F401
from ifc_spatial.stairs_constants import HEADROOM_SAMPLE_SPACING  # noqa: F401
from ifc_spatial.stairs_constants import HEADROOM_TRANSPARENT  # noqa: F401
from ifc_spatial.stairs_constants import LANDING_AREA_FACTOR  # noqa: F401
from ifc_spatial.stairs_constants import PLAUSIBLE_RISER  # noqa: F401
from ifc_spatial.stairs_constants import RAMP_TYPES  # noqa: F401
from ifc_spatial.stairs_constants import STAIR_TYPES  # noqa: F401
from ifc_spatial.stairs_constants import TREAD_FLATNESS  # noqa: F401
from ifc_spatial.stairs_constants import TREAD_NORMAL_DOT  # noqa: F401
from ifc_spatial.stairs_geometry import stair_geometry  # noqa: F401
from ifc_spatial.stairs_headroom import headroom  # noqa: F401
from ifc_spatial.stairs_ramp import ramp_slope  # noqa: F401
from ifc_spatial.stairs_reading import _flight_parts  # noqa: F401
from ifc_spatial.stairs_reading import _read_body  # noqa: F401
from ifc_spatial.stairs_reading import _sources  # noqa: F401
from ifc_spatial.stairs_treads import _measure_run  # noqa: F401
from ifc_spatial.stairs_treads import _tread_surfaces  # noqa: F401
from ifc_spatial.stairs_treads import _walking_surfaces  # noqa: F401

from .envelope import Answer  # noqa: F401
from .envelope import MissingFact  # noqa: F401
from .envelope import declared  # noqa: F401
from .envelope import undecidable  # noqa: F401
from .model import SpatialModel  # noqa: F401
from .operators import _require  # noqa: F401
from .operators import _wrong_kind  # noqa: F401

# ════════════════════════════════════════════════════════════════════════════
# steps_of
# ════════════════════════════════════════════════════════════════════════════


def steps_of(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The flights and landings a stair (or ramp) is made of — ``IfcRelAggregates``.

    Two reasons this is its own operator rather than a detail of
    :func:`stair_geometry`:

    1. **A caller must be able to ask about ONE flight.** A stair is an assembly
       and its parts carry their own psets and their own bodies; every operator
       in this module takes a flight as readily as a stair, and this is how a
       flight's GlobalId is found.
    2. **Landings are half of what OIB 4 asks.** The rule that limits risers per
       flight is a rule about flights *without an intervening landing*, so a
       count of risers on a stair means nothing until the landings are known. A
       landing is an ``IfcSlab`` with ``PredefinedType = LANDING`` — by that
       statement and not by its name, because the name is „Podest" in one export
       and „Slab:Generic 200mm:314159" in the next.

    A stair with no parts is an ``undecidable`` and not an empty list. Revit and
    ArchiCAD both write staircases as a single ``IfcStair`` with one body and no
    ``IfcRelAggregates`` at all, and ``{"flights": [], "landings": []}`` with
    ``decidable=True`` says „diese Treppe hat keine Läufe und keine Podeste" —
    a statement about the building, and one that is false for every building ever
    built. The Institute's „Treppe-EG" answered exactly that while carrying three
    flights and two Podeste in its solid, and a caller reading
    ``value["landings"] == []`` had no way to know. The caveat that used to sit
    beside the empty lists already said the statement could not be made; it is
    now where it belongs, in ``missing.what`` and ``missing.remedy``.
    """
    method = f"stepsOf({global_id})"
    subject = _require(model, global_id, method)
    if not (subject.is_a("IfcStair") or subject.is_a("IfcRamp")):
        parent = None
        for rel in getattr(subject, "Decomposes", []) or []:
            parent = rel.RelatingObject
            break
        suggestion = (
            f"dieser Lauf gehört zur Baugruppe {parent.GlobalId} — stepsOf({parent.GlobalId}) liefert deren "
            "Läufe und Podeste"
            if parent is not None and getattr(parent, "GlobalId", None)
            else "für einen einzelnen Lauf: stairGeometry() bzw. rampSlope() misst ihn direkt"
        )
        _wrong_kind(
            subject,
            method,
            "stepsOf",
            "eine Treppe oder eine Rampe als Baugruppe (IfcStair, IfcRamp)",
            suggestion,
        )

    flights, landings, other = _flight_parts(subject)
    risers_per_flight: dict[str, int | None] = {}
    for flight in flights:
        count = model.declared_property(flight, _RISER_COUNT_NAMES)
        risers_per_flight[flight.GlobalId] = (
            int(count) if isinstance(count, (int, float)) and not isinstance(count, bool) else None
        )

    value = {
        "flights": model.refs(flights),
        "landings": model.refs(landings),
        "other": model.refs(other),
        "risersPerFlight": risers_per_flight,
    }

    if not flights:
        # The empty list is not an answer, and this operator used to return one
        # with `decidable=True` beside a caveat that said the statement could not
        # be made. A caller reading `value["landings"] == []` concluded that the
        # stair has no Podest; the Institute's „Treppe-EG" has two, and its parts
        # list is empty only because ArchiCAD wrote no IfcRelAggregates at all.
        # An empty list that would be false for every building ever built is an
        # `undecidable` — the rule `relations.connects` states in its own module
        # docstring, applied here to the same shape of absence.
        return undecidable(
            from_=[global_id],
            method=method,
            missing=MissingFact(
                what=(
                    f"{subject.is_a()} „{model.label(subject) or global_id}“ ist in der Datei nicht in Läufe "
                    "gegliedert: keine IfcRelAggregates-Beziehung auf IfcStairFlight/IfcRampFlight"
                ),
                remedy=(
                    "Das heißt NICHT, dass diese Treppe aus einem einzigen Lauf besteht — mehrere Exporte "
                    "(Revit und ArchiCAD an erster Stelle) schreiben die ganze Treppe als einen Körper. Eine "
                    "Aussage „so viele Steigungen je Lauf ohne Podest“ ist an dieser Datei deshalb nicht zu "
                    "treffen. stairGeometry() misst den Körper und weist die darin erkannten Läufe und "
                    "Podeste aus; als Bauteilbezug bleibt dann aber nur die Treppe selbst. Abhilfe: im CAD "
                    "die Treppe als Treppenbauteil mit einzelnen Läufen (IfcStairFlight) und Podesten "
                    "(IfcSlab mit PredefinedType = LANDING) exportieren."
                ),
                elements=[global_id],
            ),
        )

    undeclared = [gid for gid, count in risers_per_flight.items() if count is None]
    caveat = (
        f"{len(flights)} Läufe und {len(landings)} Podeste, aus IfcRelAggregates gelesen. Podeste sind "
        "über IfcSlab.PredefinedType = LANDING erkannt; ein Podest, das der Export als gewöhnliche Decke "
        "schreibt, steht in other und fehlt in dieser Zählung."
    )
    if undeclared:
        caveat += (
            f" Für {len(undeclared)} der Läufe deklariert die Datei keine Steigungszahl "
            "(Pset_StairFlightCommon.NumberOfRiser) — stairGeometry() zählt sie am Körper nach."
        )

    return declared(
        value,
        from_=_sources(global_id, *[part.GlobalId for part in (*flights, *landings, *other)]),
        method=method,
        caveat=caveat,
    )


__all__ = [
    "BURIED_CLEARANCE",
    "BURIED_OVERLAP_FRACTION",
    "FLIGHT_STRAIGHTNESS",
    "FLIGHT_TURN_DEGREES",
    "HEADROOM_LATERAL",
    "HEADROOM_REACH",
    "HEADROOM_SAMPLE_SPACING",
    "HEADROOM_TRANSPARENT",
    "LANDING_AREA_FACTOR",
    "PLAUSIBLE_RISER",
    "RAMP_TYPES",
    "STAIR_TYPES",
    "TREAD_FLATNESS",
    "TREAD_NORMAL_DOT",
    "headroom",
    "ramp_slope",
    "stair_geometry",
    "steps_of",
]
