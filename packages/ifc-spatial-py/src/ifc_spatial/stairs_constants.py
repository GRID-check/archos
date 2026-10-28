"""Tolerances and the field names a stair's record may use, each named once."""

from __future__ import annotations

from .operators import FURNISHING

# ── what counts as what ─────────────────────────────────────────────────────

#: The subjects :func:`stair_geometry` will measure. ``IfcStair`` is in the list
#: because half the exports in the wild never split a stair into flights at all —
#: Revit writes one ``IfcStair`` carrying the whole body — and an operator that
#: only accepted ``IfcStairFlight`` would report „keine Treppe" about a file with
#: a staircase in it.
STAIR_TYPES = ("IfcStair", "IfcStairFlight")
#: The same for ramps.
RAMP_TYPES = ("IfcRamp", "IfcRampFlight")

#: ``normal.z`` above which a triangle counts as a tread surface. 0.99 is ~8° of
#: slack, which absorbs tessellation noise on a flat face and still rejects the
#: sloped soffit underneath — that soffit is within 34° of horizontal on an
#: ordinary flight and would otherwise be clustered as if it were a step.
TREAD_NORMAL_DOT = 0.99

#: How much a tread triangle may fall across itself, in metres.
#:
#: The normal alone cannot tell a tread from a shallow ramp, and this was
#: measured here rather than reasoned about: the fixture's 6 % entrance ramp has
#: a running surface at 3.4°, well inside :data:`TREAD_NORMAL_DOT`'s 8° of slack,
#: and the tread reader clustered its two triangles into "steps" 0.100 m apart —
#: a riser invented out of a ramp. A tread is not merely near-horizontal, it is
#: LEVEL WITHIN ITSELF: an external stair's drainage fall of 1.5 % drops 4 mm
#: over a 0.27 m going, while a ramp face drops the whole rise. 20 mm separates
#: the two by an order of magnitude in either direction.
TREAD_FLATNESS = 0.02

#: ``normal.z`` above which a triangle belongs to a ramp's running surface. Much
#: looser than :data:`TREAD_NORMAL_DOT` on purpose: the running surface of a ramp
#: IS the sloped face, so anything that faces upward at all is a candidate and the
#: dominant planar cluster decides. 0.05 keeps out the near-vertical sides.
RUNNING_SURFACE_MIN_DOT = 0.05

#: How far above a flight :func:`headroom` looks, in metres. A storey height plus
#: a stair rise; past that a hit is not a Durchgangshöhe but the underside of a
#: roof two floors up, and reporting it would be worse than reporting nothing.
HEADROOM_REACH = 6.0

#: Spacing of the sample points along the pitch line, metres. Only used to FIND
#: obstructions — the reported distance is measured exactly against the surfaces
#: that were found, so this spacing does not enter the number the way
#: ``clear_height``'s grid enters its own.
HEADROOM_SAMPLE_SPACING = 0.10

#: Where across the flight the sample rays are cast, as fractions of the width.
#: Deliberately not 0.0 and 1.0: a ray on the very edge of a flight hits the
#: stairwell wall beside it, and a wall beside a stair is not a Durchgangshöhe.
HEADROOM_LATERAL = (0.25, 0.5, 0.75)

#: Types that never stop a :func:`headroom` ray. ``clear_height``'s list, and
#: ``clear_height``'s reason: a chair is not a Durchgangshöhe.
#:
#: ``IfcRailing`` was proposed for this list and is deliberately NOT in it, and
#: the reason is worth keeping because the evidence pointed the other way at
#: first. Every stair in the corpus reported its own balustrade as the tight
#: point over the flight — 0.415 m on the FZK Wendeltreppe (``IfcRailing
#: 0o5vgCKyTBzO5$QJcI2YDP``), 0.117 m on each of the four Institute stairs —
#: which reads exactly like a missing type filter, and ArchiCAD does contain the
#: balustrade in the STOREY rather than in the stair, so no ``IfcRelAggregates``
#: exclusion could have reached it.
#:
#: It was not the filter. Those rays were cast from the rake that
#: :func:`_read_body` replaces: one plane fitted across a three-flight dogleg,
#: 0.318 m wide and tilted along the diagonal of the stairwell, which passes
#: through everything standing in the well — the balustrade included. Measured
#: with the flights read correctly and railings still counted, **no railing is a
#: ray candidate on any of the twelve flights of the four Institute stairs**, and
#: the tight point is the slab it always was (1.745 m under „Decke-001").
#:
#: So the type ban would have been a bandage over a fault that no longer exists,
#: and it would cost something real: a balustrade that genuinely stands over a
#: walking line — a gallery edge above the flight below, a handrail that leans
#: into the middle of a narrow stair — is something a head meets, and this
#: operator has to be able to say so. The lateral sampling at
#: :data:`HEADROOM_LATERAL` already keeps a railing standing at the EDGE of its
#: own flight out of the measurement, which is the case that was feared.
HEADROOM_TRANSPARENT = FURNISHING

#: How much of a horizontal face may lie under another horizontal face of the
#: SAME body before it stops being a walking surface — as a fraction of its own
#: plan area.
#:
#: ArchiCAD writes every step of ``AC20-Institute-Var-2.ifc`` twice: the
#: structural step and, 60 mm above it, the tread finish. Both are up-facing,
#: both are level within themselves and both clear the sliver filter, so the
#: reader counted **45 risers of 0.065 m** where the stair has 21 of 0.137 m.
#: The rule that separates them is physical rather than statistical: you cannot
#: walk on a surface that has another surface directly above it. Two consecutive
#: treads of a real flight are offset by their going and do not overlap in plan
#: at all, so half the face's own area is a wide margin.
BURIED_OVERLAP_FRACTION = 0.5

#: How close above a horizontal face another face may stand, in metres, for the
#: lower one to be BURIED rather than walked on.
#:
#: Not a headroom: on a dogleg the upper flight passes ~2 m over the lower one
#: within the same body, and a large window here would delete the lower flight.
#: 0.30 m is above the 60 mm finish layer and above the 0.20 m at which the
#: Institute's stair slab meets its landing, and far below any distance a person
#: could pass through — nothing walkable has 0.30 m of clear height over it.
BURIED_CLEARANCE = 0.30

#: How far the plan direction from one tread to the next may turn, in degrees,
#: before the two treads belong to different flights.
#:
#: Generous on purpose. The Institute's dogleg turns 88° at each landing, so
#: anything under ~60° separates its three flights; a WINDER turns 15–25° per
#: step, and a tight threshold would cut it into fifteen one-tread "flights"
#: that each measure nothing. A winder must fail :data:`FLIGHT_STRAIGHTNESS` as
#: one piece and be refused as one piece, which is what 30° arranges.
FLIGHT_TURN_DEGREES = 30.0

#: How far a tread centre may lie off the straight line through the first and
#: last tread centre of its run, in metres, before the run is not a straight
#: flight and nothing directional may be measured on it.
#:
#: A straight flight holds its centres on that line to within tessellation noise
#: (the Institute's three flights: below 1 mm). The FZK Wendeltreppe's centres
#: bow 0.5 m off their own chord, which is what makes „Auftritt 0.184 m,
#: Nutzbreite 0.200 m" on that stair a measurement of a chord across a stairwell
#: rather than of a step.
FLIGHT_STRAIGHTNESS = 0.05

#: How many times the median tread area a horizontal surface must cover before
#: it is a Podest rather than a Stufe.
#:
#: Measured on both sides. Institute: treads 0.598 m², landings 2.518 m² and
#: 2.783 m² — a factor of 4.2. FZK Wendeltreppe: every winder tread 0.107 m²,
#: so no factor at all and nothing is misread as a landing. Area rather than
#: depth because a winder tread's minimal rectangle is nearly as deep as it is
#: wide and a depth test calls all fifteen of them Podeste.
LANDING_AREA_FACTOR = 2.0

#: The band a measured riser must fall into to be a step at all, in metres.
#:
#: This is NOT OIB 4's maximum — that number belongs to the Bestimmung and this
#: layer must not know it. It is the band outside which the number cannot be a
#: step of any kind: below 0.08 m it is a finish layer, a chamfer or a drainage
#: fall (the Institute's doubled faces measured 0.065 m and were reported as a
#: stair), above 0.40 m nobody climbs it in one movement. Inside the band every
#: value is reported without comment, including ones OIB 4 would reject.
PLAUSIBLE_RISER = (0.08, 0.40)

#: How far the step from the flight's own underside to its first tread may
#: deviate from the median of the visible risers before it is dropped.
#:
#: The bottom riser is the one riser a flight's body does not always show. A
#: monolithic wedge (and every synthetic flight in the tests) starts at floor
#: level, so ``first tread − body base`` IS the first riser. A flight with a
#: waist starts at the underside of the soffit, tens of centimetres lower, and
#: taking that difference as a riser would invent a 0.6 m step. 50 % of the
#: median is wide enough for a genuinely uneven bottom step and narrow enough
#: that a soffit never passes.
BASE_RISER_RELATIVE_SLACK = 0.5

#: Pset names for the declared stair schedule, in priority order. Both the stair
#: and the flight pset use the same property names, which is why one list serves.
_RISER_COUNT_NAMES = ("NumberOfRiser", "NumberOfRisers", "NumberOfRiserPerFlight")
_RISER_HEIGHT_NAMES = ("RiserHeight",)
_TREAD_LENGTH_NAMES = ("TreadLength", "TreadLengthAtOffset", "Going")
_FLIGHT_WIDTH_NAMES = ("ClearWidth", "Width", "NominalWidth")
_RAMP_SLOPE_NAMES = ("Slope", "RequiredSlope")
