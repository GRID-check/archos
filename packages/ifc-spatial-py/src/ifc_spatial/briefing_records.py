"""The frozen records the briefing is built from: storeys, counts, coverage, dialect, room uses and blind spots."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from typing import Literal

from ifc_spatial.briefing_constants import RoomUseKind

# ── The briefing, as data ───────────────────────────────────────────────────


@dataclass(frozen=True)
class BriefingStorey:
    global_id: str
    name: str | None
    #: Metres. ``None`` when the file declares no elevation for this storey.
    elevation: float | None
    #: Structural storey-to-storey height in metres — the NEXT storey's
    #: elevation minus this one. ``None`` for the topmost storey and wherever an
    #: elevation is missing, never a fallback value: a guessed room height is
    #: the input to a clear-height check, and a wrong one passes silently.
    height: float | None
    #: Elements that resolve to this storey by containment or aggregation.
    element_count: int
    space_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "elevation": self.elevation,
            "height": self.height,
            "elementCount": self.element_count,
            "spaceCount": self.space_count,
        }


@dataclass(frozen=True)
class BriefingCount:
    """A count, for ``byKind`` / ``byType`` tables."""

    key: str
    count: int

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "count": self.count}


@dataclass(frozen=True)
class Coverage:
    """How far a relation actually reaches, as ``n of m``.

    Both numbers travel together because either alone lies. ``n`` alone hides
    that the model has 300 windows and resolved 4 of them; ``of`` alone hides
    that the export wrote the relation at all. ``relation`` names the IFC
    construct that would supply the missing part, so a shortfall can be blamed
    on the export in the export's own vocabulary rather than reported as a
    property of the building.
    """

    id: Literal[
        "oeffnungenMitWand",
        "raeumeMitBegrenzung",
        "raeumeMitNamen",
        "geschosseMitHoehenlage",
        "bauteileMitGeschoss",
    ]
    #: German label for the population, printable as-is.
    what: str
    #: Members for which the fact resolves.
    n: int
    #: Members it could resolve for. ``0`` means the population itself is empty.
    of: int
    #: The IFC relation or attribute that supplies it.
    relation: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "what": self.what, "n": self.n, "of": self.of, "relation": self.relation}


@dataclass(frozen=True)
class BriefingDialectEntry:
    set: str
    property: str
    #: Elements carrying a non-null value, within the scanned set.
    filled: int
    #: Elements scanned — NOT elements that could carry the property.
    #:
    #: The distinction matters because ``filled / scanned`` looks like a fill
    #: rate and is not one: a FireRating found on 5 of 400 scanned elements is
    #: "5 elements publish it", not "1 % of walls do", and the second sentence
    #: would be wrong by however many of those 400 were windows.
    scanned: int
    #: German gloss when this property answers a question the rules ask.
    concept: str | None
    sample: list[Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "set": self.set,
            "property": self.property,
            "filled": self.filled,
            "scanned": self.scanned,
            "concept": self.concept,
            "sample": list(self.sample),
        }


@dataclass(frozen=True)
class BriefingRoomUse:
    habitable_room: int
    ancillary_room: int
    circulation: int
    #: Spaces whose name matched no lexicon entry — including unnamed ones.
    unclassified: int
    #: False when the model publishes no spaces; the counts are then meaningless.
    decidable: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "habitable_room": self.habitable_room,
            "ancillary_room": self.ancillary_room,
            "circulation": self.circulation,
            "unclassified": self.unclassified,
            "decidable": self.decidable,
        }


@dataclass(frozen=True)
class BlindSpot:
    what: str
    consequence: str
    remedy: str

    def to_dict(self) -> dict[str, Any]:
        return {"what": self.what, "consequence": self.consequence, "remedy": self.remedy}


@dataclass(frozen=True)
class Briefing:
    """The machine-readable précis.

    :func:`render_briefing` is a projection of this and adds no facts of its
    own, so anything a caller reads in the text block it can also read here
    without re-parsing German.
    """

    #: sha256 of the source bytes — the identity of everything below.
    content_hash: str
    schema: str
    source_name: str | None
    originating_system: str | None
    totals: dict[str, int]
    storeys: list[BriefingStorey]
    #: Whether storey heights could be derived at all. See :func:`storey_heights`.
    storey_heights_decidable: bool
    by_kind: list[BriefingCount]
    by_type: list[BriefingCount]
    #: IFC types not in ``by_type`` because the list is capped.
    types_omitted: int
    coverage: list[Coverage]
    room_use: BriefingRoomUse
    dialect: list[BriefingDialectEntry]
    dialect_omitted: int
    #: Elements the dialect measurement looked at.
    properties_scanned: int
    #: Decisive properties NOT found anywhere in this file.
    #:
    #: The dialect can only list what exists, so absence is invisible in it —
    #: and absence is exactly what makes a filter return nothing. Naming the gap
    #: here turns "no wall has a fire rating" into "this export publishes no
    #: fire rating", which is the true statement and the actionable one.
    absent_properties: list[dict[str, str]]
    blind_spots: list[BlindSpot]

    def to_dict(self) -> dict[str, Any]:
        return {
            "contentHash": self.content_hash,
            "schema": self.schema,
            "sourceName": self.source_name,
            "originatingSystem": self.originating_system,
            "totals": dict(self.totals),
            "storeys": [s.to_dict() for s in self.storeys],
            "storeyHeightsDecidable": self.storey_heights_decidable,
            "byKind": [c.to_dict() for c in self.by_kind],
            "byType": [c.to_dict() for c in self.by_type],
            "typesOmitted": self.types_omitted,
            "coverage": [c.to_dict() for c in self.coverage],
            "roomUse": self.room_use.to_dict(),
            "dialect": [d.to_dict() for d in self.dialect],
            "dialectOmitted": self.dialect_omitted,
            "propertiesScanned": self.properties_scanned,
            "absentProperties": [dict(entry) for entry in self.absent_properties],
            "blindSpots": [s.to_dict() for s in self.blind_spots],
        }


@dataclass(frozen=True)
class RoomProposal:
    global_id: str
    name: str | None
    confidence: float
    because: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "confidence": self.confidence,
            "because": list(self.because),
        }


# ── the lexicon ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LexiconEntry:
    #: Normalised search term — lower case, umlauts transliterated.
    term: str
    kind: RoomUseKind
    #: A term that is suggestive but not decisive on its own (``halle``,
    #: ``gang``). Caps confidence, because a "Halle" is a foyer in one plan and a
    #: workshop in the next.
    weak: bool = False
    #: A qualification that belongs in this room's ``because`` when it matches.
    note: str | None = None


@dataclass(frozen=True)
class ClassifiedRoom:
    global_id: str
    name: str | None
    kind: str | None
    confidence: float
    because: list[str]


# ── the dialect, measured on this file ──────────────────────────────────────


@dataclass(frozen=True)
class DialectEntry:
    set: str
    property: str
    filled: int
    candidates: int
    sample: list[Any]
