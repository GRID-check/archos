"""The measure vocabulary: operations, relations, measures, kinds, and the tokens the model may name."""

import logging
from collections.abc import Sequence
from typing import Any
from typing import Literal

from agent.tools.bim import measure_register
from agent.tools.bim.failures import rejected_text
from agent.tools.bim.failures import too_large_text
from agent.tools.bim.failures import unrunnable_text

logger = logging.getLogger(__name__)


# The failure texts, under the names Piloti's tests fix.

_rejected_text = rejected_text


_unrunnable_text = unrunnable_text


_too_large_text = too_large_text


#: The operations, in the order the description teaches them.
#:
#: ORDERED, and that is not cosmetic. This tuple becomes the ``enum`` on the
#: ``operation`` field of the wire schema, and a set's iteration order varies
#: between processes because string hashing is randomised. A schema whose enum
#: reorders on every restart is a different schema to every prefix cache in
#: front of the model.

OPERATIONS: tuple[str, ...] = (
    "briefing",
    "find_elements",
    "element",
    "relations",
    "measure",
    "survey",
    "element_profile",
    "distance",
    "clearance",
    "sun_position",
    "storey_heights",
    "room_inventory",
    "draw",
    "view",
    "shopping_list",
    "fire",
    "envelope",
    "overhang",
    "light_incidence",
)


VALID_OPERATIONS = frozenset(OPERATIONS)


#: Operations that answer with something other than a quantity, and therefore
#: carry no measurement-evidence trailer (:func:`_render`).
#:
#: A briefing, a hit list, an element's index metadata, a written IDS file and a
#: drawing's path are all real results and none of them measures the building.
#: Telling the model „Messwerte in diesem Ergebnis: 0" about a `draw` reads as a
#: measurement that failed and invites a retry that costs one of five tool
#: iterations.
#:
#: This is an allow-list of SUPPRESSION, not of grounding, so it fails in the
#: safe direction: an operation missing from this set gets a trailer stating its
#: true count, and an operation wrongly IN it gets no trailer — which the
#: confidence gate reads as no measurement either way. `relations` is
#: deliberately absent: „0 Messwerte" is exactly what the model needs to hear
#: before it turns a list of bounding walls into „rund 2,7 m".

NON_MEASURING_OPERATIONS: frozenset[str] = frozenset(
    {
        "briefing",
        "find_elements",
        "element",
        "draw",
        "view",
        "shopping_list",
    }
)


# ── the enums, mirrored ──────────────────────────────────────────────────────
#
# These four sets mirror `ifc_spatial.tools.RELATIONS`, `.MEASURES`, `.KINDS`
# and the room-use lexicon, and `packages/agent/tests/tools/bim/test_ifc_measure_tool.py`
# pins them against the package so a renamed operator fails there rather than at
# the user.
#
# Copied rather than imported for one reason: `import ifc_spatial` pulls in
# IfcOpenShell, numpy and shapely — a second of import time and a few hundred
# megabytes of address space — and this module is imported by NAT's plugin
# discovery at startup on every deployment, including the ones that never touch
# a building. The engine is imported when a call is actually made.

#: relation → what it answers, in the tool's own words.

RELATIONS: dict[str, str] = {
    "hostedIn": "which wall carries this window/door (from voids+fills)",
    "hosts": "which openings are cut out of this element",
    "fillerOf": "what fills this opening",
    "bounds": "which elements bound this room  [geometry, see below]",
    "enclosedBy": "which rooms this element bounds  [geometry, see below]",
    "opensTo": "which rooms this window/door opens into  [geometry, see below]",
    "connects": "which elements butt onto this one",
    "contains": "which elements sit in this storey or room",
    "containerOf": "which storey or room this element sits in",
    "adjacentSpaces": "which rooms border this room  [geometry, see below]",
    "elementsOfStorey": "every element of this storey, including those in rooms",
    "above": "what is directly ABOVE this element or room  [geometry, rays; furniture excluded]",
    "below": "what is directly BELOW it  [geometry, rays]",
}


#: The four relations that fall back to a geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the ordinary case.

GEOMETRIC_RELATIONS = frozenset({"bounds", "enclosedBy", "opensTo", "adjacentSpaces", "above", "below"})


#: measure → what it answers.

MEASURES: dict[str, str] = {
    "extent": "width, depth, height and centroid of one element",
    "floorArea": (
        "a room's floor area FROM THE GEOMETRY — available even when the export publishes no "
        "quantity. When it publishes one, both routes are compared and a contradiction is reported"
    ),
    "sillAndHead": "Brüstungs- und Sturzhöhe of a window/door above ITS OWN storey",
    "elevation": "underside and top, absolute and above the element's own storey",
    "clearHeight": (
        "lichte Raumhöhe — floor to the LOWEST thing hanging into the room (suspended ceiling, "
        "downstand, duct). NOT the height of the space solid, which is what 'extent' gives and what "
        "a Raumhöhennachweis must not use"
    ),
    "azimuth": "which way a facade faces. Undecidable without TrueNorth in the file",
    "lightEntryArea": (
        "a ROOM's light-entry area and what percent of its floor area that is — the number an OIB 3 "
        "daylight check comes down to. Sums only the EXTERNAL openings (an internal door lights "
        "nothing) and measures the structural clear opening, not the glazed area. Applies no "
        "threshold: the percentage is in the Bestimmung, not in the model"
    ),
    "egressPath": (
        "a ROOM's shortest WALKABLE route to the outside through doors, with the rooms, the doors "
        "and a length. Adjacency is not walkability — two rooms sharing a wall with no door between "
        "them are adjacent and unreachable. The length is a polyline through room and door centres, "
        "so it is a LOWER BOUND and explicitly not a Fluchtweglänge under OIB 2"
    ),
    "reachableFrom": (
        "every room reachable from this one through doors, with door counts. Answers 'which rooms are "
        "behind this door', and finds rooms with no way out at all — itself a finding"
    ),
    "clearWidth": (
        "the LICHTE Breite and Höhe of an opening, measured on the aperture itself. THIS is what a "
        "door-width or escape-route-width check needs — 'distance' measures centroids and boxes and "
        "gives an Achsabstand"
    ),
    "orientedExtent": (
        "length/width/height along the ELEMENT's own axes plus its bearing from north. Use for anything "
        "skewed to the model grid, where 'extent' is axis-aligned and systematically too large"
    ),
    "roomDepth": (
        "how deep a room runs back from its daylight facade, the width along that facade, and the ratio "
        "to the clear height. Names which facade it chose and, for a corner room, the runner-up"
    ),
    "stairGeometry": (
        "riser height, tread depth, riser count and the NUTZBREITE of a stair flight — plus the SPREAD "
        "of the risers, because a stair can be right on average and still unwalkable. Declared values "
        "are checked against the geometry and a contradiction is reported"
    ),
    "rampSlope": "a ramp's slope as a percentage AND as a ratio, with run, rise and clear width",
    "headroom": (
        "clear height over a stair flight or ramp, measured PERPENDICULAR to the pitch rather than "
        "vertically — a vertical ray from the tread misses the tight point (1.35 m vs 1.65 m measured)"
    ),
    "stepsOf": "the flights and landings a stair is made of, so one flight can be asked about",
    "turningCircle": (
        "the largest circle that fits on a ROOM's free floor — what a Wendekreis check comes down to. "
        "Counts fixed built-ins only; furniture is reported beside it, because a permit is granted on "
        "the building and not on the chairs. Applies no threshold"
    ),
    "thresholdHeight": (
        "the step at a door. Where the export models no floor build-up this is a STRUCTURAL number and "
        "the answer says so — screed, covering and seal are what make the step, so 0 mm on raw slabs "
        "says nothing about the finished threshold"
    ),
    "balustrade": (
        "where there is a fall at an opening, how far, and what stands there. Undecidable when the "
        "export contains no IfcRailing at all — no railing in the model is not no railing on site"
    ),
    "clearApproach": "the free floor in front of a door on each side, and what ends it",
}


# NONE of these is a clear dimension, and saying otherwise was a defect. The
# entry for 'horizontal' read "what a lichte Breite check needs"; the operator
# measures CENTROID to CENTROID in plan, which is an Achsabstand. On a 1.00 m
# opening between two 30 cm walls that is 1.30 m — too large by half of each
# element, in the direction that turns a failed escape-route width into a passing
# one. A clear width is `measure` + `clearWidth`, measured on the aperture.

DISTANCE_MODES = {
    "min": (
        "gap between the two axis-aligned BOUNDING BOXES. 0 means the boxes overlap — it does NOT "
        "prove the solids touch, and on a skewed element the true gap is larger"
    ),
    "centroid": "centre to centre in 3D (Achsabstand). NOT a clear dimension",
    "horizontal": (
        "centre to centre in plan, Z ignored (Achsabstand) — what a plan drawing scales off. NOT a "
        "lichte Breite: for a clear width use measure/clearWidth on the opening"
    ),
    "vertical": (
        "difference in centre HEIGHT — what a section scales off. NOT a lichte Höhe: for that use "
        "measure/clearHeight on the room"
    ),
}


#: `what` on the `fire` operation — the OIB 2 geometry, in one place.

FIRE_ASPECTS = {
    "escape_level": (
        "height of the topmost occupied floor above the lowest adjoining ground — the number the "
        "Gebäudeklasse hangs on. Returns a HEIGHT and never a class"
    ),
    "compartmentArea": "floor area of a fire compartment across several rooms, each room listed",
    "separatingElements": (
        "what lies BETWEEN two rooms — wall, slab, and the doors in them — each with its DECLARED "
        "FireRating, and explicitly with its absence"
    ),
    "siteBoundary": (
        "distance to the site boundary (Brandübertragung). Undecidable on most exports, because a "
        "parcel boundary is rarely exported — and it is not guessed here"
    ),
    "doorGraph": (
        "the WHOLE building's walkable graph: rooms as nodes, OUTSIDE as its own node, doors as edges "
        "— plus the doors that became NEITHER (unbestimmt, ausgeschlossen). A room with no edge has no "
        "way out; an unresolved door is a hole in EVERY route through this building. measure/egressPath "
        "gives one route, this says how sound the basis of all routes is. Takes no global_id"
    ),
}


#: `what` on the `envelope` operation — the OIB 6 geometry.
#:
#: Carried on `kind`, the same field `fire` uses, because both are "one subject
#: asked several ways" and a third field spelling would make the model choose a
#: parameter name instead of a question.

ENVELOPE_ASPECTS = {
    "thermalEnvelope": (
        "which elements form the boundary between heated inside and outside, grouped by kind, each "
        "with its area and its DECLARED U-value. Every entry says which rung decided it — declared "
        "IsExternal and inferred from room contact are not the same claim — and the two lists that "
        "make the total checkable come back with it: interior (decided, left out) and "
        "unbestimmt (not decided, so neither counted nor discarded)"
    ),
    "areaByOrientation": (
        "envelope area per compass bearing, opaque and transparent apart, with the window-to-wall "
        "ratio per facade. Needs a declared TrueNorth; without one the bearing is refused, not guessed"
    ),
    "compactness": (
        "A/V in 1/m, with the characteristic length (V over A) beside it. A and V come back separately, "
        "because a ratio whose inputs are invisible cannot be checked by whoever signs it. V is the "
        "NET volume (the sum of the IfcSpace solids)"
    ),
}


#: `mode` on view. A SECOND vocabulary on the same field, which is worth naming
#: rather than leaving inline: `mode` already carries the distance senses, and a
#: model that reads DISTANCE_MODES and then meets `mode="highlight"` has to work
#: out for itself that the field is operation-scoped. Spelling both sets out —
#: and pinning both in the skill test — is what keeps that from being a guess.

VIEW_MODES = {
    "highlight": "mark these elements red on the full plan — 'where is this in the building'",
    "only": "draw nothing but these elements — 'what does this look like'",
}


#: `kind` on find_elements — the spatial role, not the IFC type.

KINDS = ("project", "site", "building", "storey", "space", "element", "opening", "group")


#: `room_kind` on room_inventory.

ROOM_KINDS = ("habitable_room", "ancillary_room", "circulation")


#: `ifc_spatial.tools.MAX_BATCH` — the most GlobalIds one `measure` may carry.
#: Mirrored for the same reason the vocabularies above are, and pinned against
#: the package by the same test.

MAX_BATCH = 50


#: The one value `kind` takes on `element_profile`, where it is an opt-in to the
#: expensive measures rather than a vocabulary.

PROFILE_KINDS = ("expensive",)


def _enum_lines(entries: dict[str, str], indent: str = "    ") -> str:
    return "\n".join(f"{indent}{name} — {meaning}" for name, meaning in entries.items())


# ── the input schema ─────────────────────────────────────────────────────────
#
# The schema is what the model reads a vocabulary from, so the enums are BUILT
# from the vocabularies above rather than retyped beside them, and the model is
# FLAT rather than a discriminated union: a `RootModel[Union[...]]` reaches the
# wire as one property called `root`, a wrapper the model cannot learn about.
# Measured, not assumed — `packages/agent/tests/tools/bim/test_ifc_measure_tool.py`
# keeps the measurement. Why the schema was tightened at all, and what it buys
# (fewer bad calls EMITTED, not turns refunded): ``docs/roadmap/spatial-review-findings.md``.


def _literal(*groups) -> Any:
    """A ``Literal`` over these vocabularies, in the order they were written.

    Order is part of the contract: the tuple becomes the ``enum`` array in the
    schema the model is handed, and an enum that reshuffles between restarts
    invalidates every prefix cache in front of it.
    """
    names = dict.fromkeys(name for group in groups for name in group)
    return Literal[tuple(names)]  # type: ignore[valid-type]


#: Which vocabulary a bad `kind` is recorded AGAINST — the ledger entry, not the
#: check. `kind` is one field over four vocabularies, and the `Literal` accepts
#: the union of all of them because the call builders are the layer that
#: knows which applies: `element_profile` ignores a `kind` that is not
#: 'expensive', and narrowing the type here would turn that shrug into a
#: refusal. What IS scoped is the backlog line: „fire kind='brandabschnitt'" and
#: „find_elements kind='brandabschnitt'" are different requests, and a ledger
#: that merged them would rank neither.

_KIND_FIELD: dict[str, str] = {
    "fire": "fire.kind",
    "envelope": "envelope.kind",
    "element_profile": "element_profile.kind",
}


#: Every spelling `kind` accepts, across all four of its vocabularies.

_ALL_KINDS: tuple[str, ...] = (*KINDS, *FIRE_ASPECTS, *ENVELOPE_ASPECTS, *PROFILE_KINDS)


#: The fields this tool has always matched case-insensitively, and their
#: canonical spellings. A `Literal` is case-SENSITIVE, and kind='Compactness'
#: has always been a working call. `measure` and `relation` are absent on
#: purpose: those have always been required exact.

_CASE_FOLDED: dict[str, tuple[str, ...]] = {
    "operation": OPERATIONS,
    "room_kind": ROOM_KINDS,
    "kind": _ALL_KINDS,
    "mode": (*DISTANCE_MODES, *VIEW_MODES),
}


#: German tokens these fields used to take, per field. Remove after one release.

_LEGACY_TOKENS: dict[str, dict[str, str]] = {
    "room_kind": {"aufenthaltsraum": "habitable_room", "nebenraum": "ancillary_room", "erschliessung": "circulation"},
    "kind": {"fluchtniveau": "escape_level"},
}


def _canonical(asked: str, vocabulary: Sequence[str]) -> str:
    """The vocabulary's own spelling of ``asked``, or ``asked`` unchanged when it is in no vocabulary."""
    wanted = asked.strip().lower()
    return next((known for known in vocabulary if known.lower() == wanted), asked)


def _record_misses(data: dict[str, Any]) -> None:
    """Write every value that is in no vocabulary to the capability ledger."""
    operation = str(data.get("operation") or "").strip().lower()
    checks = (
        ("operation", VALID_OPERATIONS),
        ("measure", MEASURES),
        ("relation", RELATIONS),
        ("room_kind", ROOM_KINDS),
        # Against the WHOLE of `kind`, because that is what the field accepts:
        # `element_profile kind='space'` is a shrug, not a missing capability.
        (_KIND_FIELD.get(operation, "kind"), _ALL_KINDS),
    )
    for name, known in checks:
        asked = data.get(name.split(".")[-1])
        wanted = asked.strip() if isinstance(asked, str) else ""
        if wanted and wanted not in known:
            measure_register.record_gap(surface="ifc_measure", field=name, asked_for=wanted, known=known)
