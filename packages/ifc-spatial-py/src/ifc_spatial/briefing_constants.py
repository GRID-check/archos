"""Limits, match thresholds and the room-use vocabulary the briefing shares, each named once."""

from __future__ import annotations

from typing import Literal

#: IFC types printed in the type table before it is capped.
MAX_TYPES = 15
#: Property lines printed in the DIALEKT block.
MAX_DIALECT = 10
#: Storeys printed in the GESCHOSSE block.
MAX_STOREYS = 12
#: Blind spots printed; the builder emits a handful, a cap guards the budget.
MAX_BLIND_SPOTS = 8
#: Elements whose property sets are read for the DIALEKT block. Same default as
#: the TS builder. ``get_psets`` is an entity walk rather than an index lookup,
#: so the sample matters more here than it did there.
DIALECT_SAMPLE_SIZE = 4000

#: Properties that decide a question somebody actually asks, with the German
#: word the question is asked in.
#:
#: Two jobs: promote these to the front of the DIALEKT block when present (a
#: list sorted purely by fill count is dominated by exporter boilerplate), and
#: report them in ``absent_properties`` when not. Deliberately short — every
#: entry costs tokens in every briefing for every model.
DECISIVE_PROPERTIES: tuple[tuple[str, str], ...] = (
    ("Feuerwiderstand", "FireRating"),
    ("Brennbarkeit", "Combustible"),
    ("U-Wert", "ThermalTransmittance"),
    ("Schallschutz", "AcousticRating"),
    ("tragend", "LoadBearing"),
    ("außenliegend", "IsExternal"),
    ("Raumfläche", "NetFloorArea"),
    ("Höhe", "Height"),
    ("Brüstungshöhe", "SillHeight"),
)


# ── inventory() ─────────────────────────────────────────────────────────────

RoomUseKind = Literal["habitable_room", "ancillary_room", "circulation"]


#: The German tokens ``room_inventory`` used to take. Remove after one release.
LEGACY_ROOM_USE_KINDS: dict[str, str] = {
    "aufenthaltsraum": "habitable_room",
    "nebenraum": "ancillary_room",
    "erschliessung": "circulation",
}

KIND_LABEL: dict[str, str] = {
    "habitable_room": "Aufenthaltsraum",
    "ancillary_room": "Nebenraum",
    "circulation": "Erschließungsfläche",
}

_FREIBEREICH = "Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn"

#: Confidence by how the term was found. Exact beats word beats substring.
MATCH_CONFIDENCE = {"exact": 0.9, "word": 0.8, "part": 0.65}

#: Terms shorter than this are only matched on a word boundary.
#:
#: ``wc`` and ``bad`` as substrings hit room codes and foreign words
#: (``BAD-03`` is fine, ``Badminton`` is not, and a Revit room named ``WCB2`` is
#: a code). A short term inside a longer word carries almost no signal, and the
#: false positives are exactly the confident-wrong kind.
MIN_SUBSTRING_TERM = 4

QUALITY_TEXT = {"exact": "exakter Name", "word": "als ganzes Wort", "part": "als Wortbestandteil"}


_HASHES: dict[tuple[str, int, int], str] = {}


#: Pack cells into lines of at most this many characters after the label column.
WRAP_WIDTH = 104
