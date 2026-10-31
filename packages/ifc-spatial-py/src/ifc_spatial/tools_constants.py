"""The tool surface vocabulary: its relations, measures, fire and envelope aspects, and limits."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import accessibility as acc
from . import circulation as circ
from . import clearance as clr
from . import daylight as dl

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import operators as op
from . import relations as extra
from . import stairs as st
from .envelope import Answer
from .model import SpatialModel

#: The relation names ``relations`` accepts, and what each one answers.
RELATIONS: dict[str, str] = {
    "hostedIn": "Which wall carries this window / door? (derived from voids + fills)",
    "hosts": "Which openings are cut out of this element?",
    "fillerOf": "What fills this opening?",
    "bounds": "Which elements bound this room?",
    "enclosedBy": "Which rooms does this element bound?",
    "opensTo": "Into which rooms does this window / door open?",
    "connects": "Which elements connect to this one?",
    "contains": "Which elements lie in this storey or room?",
    "containerOf": "In which storey or room does this element lie?",
    "adjacentSpaces": "Which rooms adjoin this room?",
    "elementsOfStorey": "All elements of this storey (including those in rooms).",
    "above": "What lies directly above this element or room? (rays upwards, furniture excluded)",
    "below": "What lies directly below?",
}

RELATION_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "hostedIn": op.hosted_in,
    "hosts": op.hosts,
    "fillerOf": op.filler_of,
    "bounds": op.bounds,
    "enclosedBy": op.enclosed_by,
    "opensTo": op.opens_to,
    "connects": extra.connects,
    "contains": op.contains,
    "containerOf": op.container_of,
    "adjacentSpaces": op.adjacent_spaces,
    "elementsOfStorey": extra.elements_of_storey,
    "above": dl.above,
    "below": dl.below,
}

#: The relations that fall back to the geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the common case.
#:
#: Named as a set rather than left implicit because two things depend on it: the
#: warning in the ``relations`` description, and ``element``'s refusal to probe
#: them just to list what is available. A six-second contact map is a reasonable
#: price for an answer somebody asked for and an unreasonable one for a menu.
GEOMETRIC_RELATIONS = frozenset(
    {
        "bounds",
        "enclosedBy",
        "opensTo",
        "adjacentSpaces",
        # `above`/`below` cast rays, so they need the OCCT tree. Left out of this
        # set they were probed by `element` to build its "available relations"
        # menu — which ran the geometry pass on a model whose caller had only
        # asked what an element is called. That is the one rule this file has.
        "above",
        "below",
    }
)

#: The measurements ``measure`` exposes, and what each one answers.
MEASURES: dict[str, str] = {
    "extent": "Dimensions and centroid: width, depth, height, centre.",
    "floorArea": (
        "Floor area from the geometry — even when the model declares no room area. When the model declares "
        "one, both routes are checked against each other and a contradiction is reported."
    ),
    "sillAndHead": "Sill and head height of a window or door above ITS storey.",
    "elevation": "Bottom and top edge, absolute and above the element's own storey.",
    # NOT the TS wording. The TS operator returns the height of the space solid
    # and its own caveat says the real clear height needs an intersection test
    # it does not have; this engine has that test and measures the clear height
    # under the lowest obstruction. On the sample house the two differ by 30 cm
    # — under a suspended ceiling — and the TS number is the unsafe side of an
    # OIB minimum room height. Keeping the old sentence would describe an
    # operator that no longer exists.
    "clearHeight": (
        "Clear room height: from the floor straight up to the lowest element reaching in (suspended "
        "ceiling, downstand beam, duct). NOT the height of the room solid — extent() gives that. Furniture "
        "is excluded. Raster sampling, ~0.5 s."
    ),
    "azimuth": "Compass direction of the facade plane. Not decidable without TrueNorth in the file.",
    "lightEntryArea": (
        "Light entry area of a ROOM and its share of the floor area — the number a daylight proof under "
        "OIB 3 comes down to. Sums only the EXTERNAL openings (interior doors do not light a room) and "
        "measures the structural opening, not the glass area. No limit applied — the percentage is in the "
        "rulebook, not in the model."
    ),
    "egressPath": (
        "Shortest walkable route from a ROOM to the outside, through doors — rooms, doors and a length. "
        "Adjacency is not walkability: two rooms on the same wall without a door between them adjoin and "
        "are unreachable. The length is a polyline through room and door centres and therefore a LOWER "
        "BOUND, not an escape route length in the sense of OIB 2."
    ),
    "reachableFrom": (
        "All rooms reachable through doors, with the number of doors in between. Answers 'which rooms lie "
        "behind this door', and finds rooms with no exit at all — which is itself a finding."
    ),
    "clearWidth": (
        "CLEAR width and height of an opening, measured at the opening itself (structural opening) — the "
        "number a passage or escape route width asks for. NOT distance: its modes measure centroids and "
        "bounding boxes and return a centre-to-centre distance."
    ),
    "orientedExtent": (
        "Length, width and height along the element's OWN axes, plus its rotation against north. For "
        "anything set skewed in the model: extent() is axis-aligned and systematically reports values too "
        "large there, which are neither length nor thickness."
    ),
    "roomDepth": (
        "Room depth perpendicular to the lighting facade, plus the width along that facade and the ratio to "
        "the clear room height — for daylight questions where depth matters. The chosen facade is named; "
        "for a corner room the second best is given too."
    ),
    "stairGeometry": (
        "Riser height, tread depth, number of risers and the USABLE WIDTH of a stair flight — and the "
        "SPREAD of the risers along the flight. Uneven risers are themselves the finding: a stair can be "
        "right on average and still be unwalkable. Declared values are checked against the geometry and a "
        "contradiction is reported."
    ),
    "rampSlope": (
        "Slope of a ramp as a percentage AND as a ratio, plus run length, rise and clear width. Both forms, "
        "because a provision names one or the other."
    ),
    "headroom": (
        "Headroom above a stair flight or ramp, measured PERPENDICULAR TO THE PITCH LINE — not plumb. The "
        "pinch point is where the flight runs under the slab above, and a plumb ray from the tread misses it "
        "(1.35 m against 1.65 m in the test case)."
    ),
    "stepsOf": (
        "The flights and landings a stair is made of — to ask about a single flight instead of the assembly. "
        "Landings count, because provisions limit the number of risers per flight without a landing."
    ),
    "turningCircle": (
        "The largest circle that fits on a ROOM's free floor area — the number a turning circle comes down "
        "to. Only fixed fittings count; the furniture is reported separately under mitMoeblierung, because "
        "a building permit applies to the building and not to the chairs. No limit applied."
    ),
    "thresholdHeight": (
        "The step at a door: the level difference of the floors on both sides. When the export contains no "
        "floor build-up it is a STRUCTURAL dimension — the answer then says so, because screed, finish and "
        "seal make the step, and 0 mm on the structure says nothing about the finished threshold."
    ),
    "balustrade": (
        "Where there is a drop at an opening: the fall height and what stands there, with its height. When "
        "the export has no IfcRailing at all, the answer is not decidable — no railing in the model does not "
        "mean no railing on site."
    ),
    "clearApproach": (
        "The free floor area in front of a door, on both sides, and what bounds it — what someone needs to "
        "be able to open the door at all."
    ),
}

MEASURE_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "extent": op.extent,
    "floorArea": op.floor_area,
    "sillAndHead": op.sill_and_head,
    "elevation": op.elevation,
    "clearHeight": op.clear_height,
    "azimuth": op.azimuth,
    "lightEntryArea": op.light_entry_area,
    "egressPath": circ.egress_path,
    "reachableFrom": circ.reachable_from,
    "clearWidth": clr.clear_opening_width,
    "orientedExtent": clr.oriented_extent,
    "roomDepth": dl.room_depth,
    "stairGeometry": st.stair_geometry,
    "rampSlope": st.ramp_slope,
    "headroom": st.headroom,
    "stepsOf": st.steps_of,
    "turningCircle": acc.turning_circle,
    "thresholdHeight": acc.threshold_height,
    "balustrade": acc.balustrade_check,
    "clearApproach": acc.clear_approach,
}

#: Which IFC types each measure is ABOUT, read off the operators' own
#: signatures — `clear_height(model, space_global_id)` takes a space, and
#: `threshold_height(model, door_global_id)` takes a door.
#:
#: An empty tuple means the measure is about geometry as such and applies to
#: anything with a shape (`extent`, `elevation`, `orientedExtent`, `floorArea`).
#:
#: This is deliberately NOT wired into `measure` as a refusal. Asking for the
#: floor area of a wall is odd but answerable, and a guard here would turn a
#: type this table happens not to list — IfcSpatialZone, a proxy standing in for
#: a room — into a refusal for a measurement that would have worked. The table
#: exists to CHOOSE, in `profile`, not to forbid.
MEASURE_SUBJECT: dict[str, tuple[str, ...]] = {
    "extent": (),
    "elevation": (),
    "orientedExtent": (),
    "floorArea": (),
    "clearHeight": ("IfcSpace",),
    "lightEntryArea": ("IfcSpace",),
    "egressPath": ("IfcSpace",),
    "reachableFrom": ("IfcSpace",),
    "roomDepth": ("IfcSpace",),
    "turningCircle": ("IfcSpace",),
    "balustrade": ("IfcSpace",),
    "sillAndHead": ("IfcWindow", "IfcDoor"),
    "clearWidth": ("IfcOpeningElement", "IfcDoor", "IfcWindow"),
    "azimuth": ("IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcPlate", "IfcWindow", "IfcDoor"),
    "thresholdHeight": ("IfcDoor",),
    "clearApproach": ("IfcDoor",),
    "stairGeometry": ("IfcStair", "IfcStairFlight"),
    "rampSlope": ("IfcRamp", "IfcRampFlight"),
    "headroom": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
    "stepsOf": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
}

#: Measures that walk the door graph or sample a raster over the whole model.
#: `profile` runs them only when asked, because a profile is meant to be the
#: cheap „was ist das für ein Bauteil" call and these are seconds, not
#: milliseconds — the same budget argument that motivates `survey`.
MEASURE_EXPENSIVE: frozenset[str] = frozenset({"egressPath", "reachableFrom", "turningCircle", "clearApproach"})

#: A DIFFERENT expensive, and the distinction is the point.
#:
#: `MEASURE_EXPENSIVE` names measures with a large fixed setup — the door graph,
#: a raster over the model — which a profile pays once and a survey amortises
#: over the whole set. These are the opposite: cheap to start and costly PER
#: ELEMENT, so a survey multiplies them. Measured on AC20-Institute-Var-2:
#: `balustrade` over 50 rooms is 53 s and `headroom` over FOUR stairs is 50 s,
#: while `egressPath` — nominally the expensive one — is 0.03 s over 50 rooms.
#:
#: A tool call that takes a minute is a broken tool at a budget of five turns,
#: so the default set is smaller for these and the narrowing is stated. A caller
#: who wants all fifty says so with an explicit `limit`.
MEASURE_SLOW_PER_ELEMENT: frozenset[str] = frozenset({"balustrade", "headroom", "roomDepth", "thresholdHeight"})
SLOW_DEFAULT_LIMIT = 12

#: The one number a caller means when a measure returns a dict.
#:
#: Most measures answer with a structure — `clearWidth` returns width, height,
#: area and rectangularity — and a survey over fifty of them could report no
#: spread at all, because there was no single number to disperse. Eighteen of
#: the twenty measures were in that state: the tool sold „die Spanne ist der
#: Befund" and produced a Spanne for `floorArea` and `clearHeight` only.
#:
#: The key is NAMED in the output (`summary.spreadOf`) rather than assumed, so
#: „Spanne 0.13" cannot be read as being about the height when it is about the
#: width.
MEASURE_HEADLINE: dict[str, str] = {
    "clearWidth": "width",
    "turningCircle": "diameter",
    "lightEntryArea": "percent",
    "headroom": "headroom",
    "sillAndHead": "sill",
    "roomDepth": "depth",
    "thresholdHeight": "threshold",
    "azimuth": "degrees",
    "rampSlope": "percent",
    "elevation": "heightAboveStorey",
    "egressPath": "length",
}


#: Audit fields a profile drops. Not because they do not matter — they are the
#: reason this package exists — but because a profile is the ORIENTATION call,
#: and `from`/`method` for sixteen measures at once is several thousand tokens
#: of provenance for numbers the caller has not yet decided to care about. One
#: `measure` call brings the full answer back for the one that mattered.
_PROFILE_DROPS = ("from", "method", "because")
_PROFILE_LIST_CAP = 3


#: The `what` values `fire` accepts.
FIRE_ASPECTS: dict[str, str] = {
    "escape_level": (
        "Height of the topmost habitable storey above the lowest adjoining ground — the number the building "
        "class depends on. Which storeys were counted is in the answer"
    ),
    "compartmentArea": "Floor area of a fire compartment over several rooms, with each room individually",
    "separatingElements": (
        "What lies between two rooms — wall, slab, and the doors in them — each with its DECLARED "
        "FireRating, and explicitly with its absence"
    ),
    "siteBoundary": (
        "Distance to the site boundary (fire spread). Not decidable on most exports: a site boundary is "
        "rarely exported, and it is not guessed here"
    ),
    "doorGraph": (
        "The walkable graph of the WHOLE building: rooms as nodes, OUTSIDE as its own node, doors as edges "
        "— and explicitly the doors that became no edge (undetermined, excluded). A room without an edge has "
        "no exit, and an undetermined door is a hole in EVERY route of this building. measure/egressPath "
        "names ONE route; this says how complete the basis of all routes is. Shares its setup with "
        "egressPath and reachableFrom, so only the first of the three calls costs seconds"
    ),
}

#: The `what` values `envelope` accepts.
#:
#: Grouped for the same reason as `FIRE_ASPECTS`: one subject — the building as
#: a heat-loss problem — asked three ways. All three take the WHOLE model and no
#: GlobalId, which is what separates them from `measure`: an envelope is not a
#: property of an element, it is the set of elements that happens to bound the
#: heated volume, and asking about it one wall at a time is how the wall that
#: was left out stays invisible.
ENVELOPE_ASPECTS: dict[str, str] = {
    "thermalEnvelope": (
        "Which elements form the boundary between heated inside and outside, grouped by kind, each with "
        "area and DECLARED U-value. Every entry names WHAT the assignment follows from — IsExternal declared "
        "or derived from the room contacts is not the same statement. Plus the two lists that make the sum "
        "checkable: interior (decided and left out) and undetermined (not decided, so neither counted nor "
        "discarded)"
    ),
    "areaByOrientation": (
        "Envelope area per compass direction, opaque and transparent separately, with the window-to-wall "
        "ratio (WWR) per facade. Needs a declared TrueNorth — without one the direction is not guessed but "
        "refused"
    ),
    "compactness": (
        "A/V in 1/m, with the characteristic length l_c = V/A beside it. A and V come back individually, "
        "because a ratio whose inputs are invisible cannot be checked by the person who signs it. V is the "
        "NET volume (sum of the IfcSpace bodies)"
    ),
}

#: How many elements one `measure` call may take.
#:
#: The cap exists because the geometry is real work — a `clearHeight` is a
#: 25-ray raster per room — and an agent that pastes a whole building into
#: the field would sit inside one tool call for minutes with no way to see
#: progress. Fifty covers every storey in the corpus (the largest is 22
#: rooms) and refuses the paste.
MAX_BATCH = 50

KINDS = ["project", "site", "building", "storey", "space", "element", "opening", "group"]

#: Downloads are capped. A tool that will read whatever a URL hands it is a way
#: to fill a disk from a chat message.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

#: Set to ``1`` when the host KNOWS its own network and wants ``open_model(url=…)``
#: to reach it anyway — a presigned URL served by a MinIO on the same compose
#: network is the case this exists for.
#:
#: It is opt-in and not opt-out because the two failure modes are not
#: symmetric. A deployment that needed it and did not set it gets a refusal it
#: can read and fix in one environment variable; a deployment that did not need
#: it and was never asked gets an agent-controlled URL fetched from inside its
#: own perimeter, and nobody finds out.
ALLOW_PRIVATE_URLS_ENV = "IFC_SPATIAL_ALLOW_PRIVATE_URLS"

#: Every network failure that is not an HTTP status answers with THIS sentence
#: and no detail.
#:
#: „Connection refused" and „timed out" are different words for two ports on the
#: same host, which is a port scanner: the agent picks the URL, so the difference
#: between the two is a readout on a network the agent cannot otherwise see.
_UNREACHABLE_TEXT = (
    "Modell konnte nicht geladen werden: die URL war nicht abrufbar. "
    "Datei lokal ablegen und path verwenden, oder base64 übergeben."
)
