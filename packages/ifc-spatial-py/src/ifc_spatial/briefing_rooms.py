"""Room classification: matching a room's name against the lexicon."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from ifc_spatial.briefing_constants import KIND_LABEL
from ifc_spatial.briefing_constants import MATCH_CONFIDENCE
from ifc_spatial.briefing_constants import MIN_SUBSTRING_TERM
from ifc_spatial.briefing_constants import QUALITY_TEXT
from ifc_spatial.briefing_lexicon import LEXICON
from ifc_spatial.briefing_records import ClassifiedRoom
from ifc_spatial.briefing_records import LexiconEntry

from .model import SpatialModel


def classify_rooms(model: SpatialModel) -> list[ClassifiedRoom]:
    """Run the lexicon over every space once.

    Shared by :func:`inventory` and :func:`briefing` so the counts in the text
    block and the lists a caller requests cannot disagree — two independent
    classifiers over one model is a contradiction waiting to be quoted.
    """
    lit_rooms = _window_assignment(model)
    out: list[ClassifiedRoom] = []

    for space in _spaces_of(model):
        global_id = space.GlobalId
        name = model.label(space)
        if name is None:
            out.append(
                ClassifiedRoom(
                    global_id=global_id,
                    name=None,
                    kind=None,
                    confidence=0.0,
                    because=[
                        "Der Raum trägt weder Name noch LongName — nichts, worauf sich eine Einstufung stützen könnte."
                    ],
                )
            )
            continue

        normalised = normalise(name)
        best: dict[str, tuple[LexiconEntry, str]] = {}
        for entry in LEXICON:
            quality = match_quality(normalised, entry.term)
            if quality is None:
                continue
            current = best.get(entry.kind)
            # Longest term wins within a kind too, so the `note` that travels
            # into the reasons is the one from the most specific match.
            if current is None or len(entry.term) > len(current[0].term):
                best[entry.kind] = (entry, quality)

        if not best:
            out.append(
                ClassifiedRoom(
                    global_id=global_id,
                    name=name,
                    kind=None,
                    confidence=0.0,
                    because=[f'Der Name „{name}" passt zu keinem Lexikoneintrag.'],
                )
            )
            continue

        ranked = sorted(best.items(), key=lambda item: (-len(item[1][0].term), -MATCH_CONFIDENCE[item[1][1]]))
        kind, (winner, quality) = ranked[0]
        runner_up = ranked[1] if len(ranked) > 1 else None

        because = [f'Name „{name}" enthält „{winner.term}" ({QUALITY_TEXT[quality]}) → {KIND_LABEL[kind]}.']
        confidence = MATCH_CONFIDENCE[quality]

        if winner.weak:
            confidence = min(confidence, 0.55)
            because.append(winner.note or f'„{winner.term}" ist ein schwaches Signal.')
        elif winner.note:
            because.append(winner.note)

        if runner_up is not None:
            other_kind, (other, _) = runner_up
            if len(other.term) == len(winner.term):
                confidence *= 0.85
                because.append(f'Mehrdeutig: „{other.term}" spricht gleich stark für {KIND_LABEL[other_kind]}.')
            else:
                because.append(
                    f'„{winner.term}" schlägt „{other.term}" ({KIND_LABEL[other_kind]}) als längerer Treffer.'
                )

        # The window signal is only evidence in a file that publishes the
        # relation at all. In a model with no window→room assignment, "this room
        # has no window" is a fact about the export — using it to lower a
        # confidence would let an export setting argue about a building.
        if lit_rooms is not None:
            if global_id in lit_rooms:
                confidence += 0.05
                because.append("Dem Raum ist mindestens ein Fenster zugeordnet (opensTo).")
            elif kind == "habitable_room":
                confidence -= 0.05
                because.append("Diesem Raum ist kein Fenster zugeordnet, obwohl das Modell Fensterzuordnungen führt.")

        out.append(
            ClassifiedRoom(
                global_id=global_id,
                name=name,
                kind=kind,
                confidence=round(min(0.95, max(0.3, confidence)) * 100) / 100,
                because=because,
            )
        )

    return out


def match_quality(normalised: str, term: str) -> str | None:
    if normalised == term:
        return "exact"
    if re.search(rf"(^| ){re.escape(term)}( |$)", normalised):
        return "word"
    if len(term) >= MIN_SUBSTRING_TERM and term in normalised:
        return "part"
    return None


def normalise(raw: str) -> str:
    """Fold a room name into the lexicon's alphabet.

    NFC first: an exporter may write ``ü`` as ``u`` + combining diaeresis, in
    which case the umlaut rules below would not see a ``ü`` at all and ``Küche``
    would fold to ``kuche`` while a differently-encoded sibling folded to
    ``kueche``. Same building, two classifications, depending on the exporter's
    Unicode habits.

    The umlaut expansion runs BEFORE the generic diacritic strip, so ``ü``
    becomes ``ue`` (matching a file that already spells it ``Kueche``) rather
    than ``u``.
    """
    text = unicodedata.normalize("NFC", raw).lower()
    for umlaut, expansion in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, expansion)
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


# ── shared helpers ──────────────────────────────────────────────────────────


def _by_type(model: SpatialModel, ifc_type: str) -> list[Any]:
    """Instances of a type, or an empty list when the SCHEMA has no such type.

    ``IfcSpatialZone`` and ``IfcMapConversion`` are IFC4 entities and raise on
    an IFC2X3 file rather than returning nothing. The distinction is real — "the
    schema cannot express this" is not "the file omitted it" — but for every
    count in this module the two produce the same number, and letting a
    RuntimeError escape would make the briefing refuse to render at all for an
    entire schema generation.
    """
    try:
        return list(model.file.by_type(ifc_type))
    except RuntimeError:
        return []


def _spaces_of(model: SpatialModel) -> list[Any]:
    """Spaces AND spatial zones — :func:`find_blind_spots` counts both, so this
    must too."""
    return [*_by_type(model, "IfcSpace"), *_by_type(model, "IfcSpatialZone")]


def _window_assignment(model: SpatialModel) -> set[str] | None:
    """Rooms with at least one window assigned, or ``None`` when this model
    cannot say.

    Three states, and the third is why this returns an ``Optional`` rather than
    a possibly-empty set:

      - the file declares ``IfcRelSpaceBoundary`` — read it;
      - it does not, but the geometric contact map has already been built by an
        earlier ``opens_to`` / ``bounds`` call — read that, at dictionary speed;
      - neither — return ``None``, and the classifier leaves the window signal
        out entirely.

    The third state is the one the TS version does not have, because its
    ``openModel`` derives boundaries eagerly during the geometry pass. Here the
    contact map costs 6 s for four rooms, and running it from a room-name
    lexicon would make the cheapest operator in the package the most expensive
    one. What must not happen is the silent version of that: treating "not
    computed" as "no window", which would push every Aufenthaltsraum's
    confidence down by 0.05 for a reason that has nothing to do with the file.

    Reads ``SpatialModel``'s contact cache directly because that module is the
    spike's frozen parity spec and may not be edited to expose an accessor.
    """
    lit: set[str] = set()
    boundaries = _by_type(model, "IfcRelSpaceBoundary")
    if boundaries:
        for rel in boundaries:
            element = rel.RelatedBuildingElement
            space = rel.RelatingSpace
            if element is not None and space is not None and element.is_a("IfcWindow"):
                lit.add(space.GlobalId)
        return lit

    contacts: dict[str, set[str]] = {}
    for cached in getattr(model, "_space_contacts", {}).values():
        for space_id, touching in cached.items():
            contacts.setdefault(space_id, set()).update(touching)
    if not contacts:
        return None
    for space_id, touching in contacts.items():
        for global_id in touching:
            try:
                element = model.file.by_guid(global_id)
            except RuntimeError, KeyError:
                continue
            if element.is_a("IfcWindow"):
                lit.add(space_id)
    return lit
