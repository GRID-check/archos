"""What a document points at: norms, laws, plans and other documents (Verweise).

A Baubeschreibung says "gem. Brandschutzkonzept", a plan says "siehe EP-05", a
Bescheid cites "§ 33 BayBO" and "ÖNORM B 1600". Until now ingestion kept only the
bare ``§`` number (``qdrant.payload.paragraph_refs``) and the rest was invisible:
the agent found a reference only if a question happened to contain it, and nobody
could say which documents a project is missing although its own documents name
them. This module reads them at ingest, with patterns and no model, from the
text every chunk already carries (a drawing's chunk text holds its annotations
verbatim), so the cost is a regex pass over text the pipeline holds anyway.

Four kinds, each a record ``{kind, key, label, pages}``:

``norm``
    DIN, EN, ISO, ÖNORM, OIB-Richtlinie, VDI, TRVB. ``key`` is the designation
    case-folded with single spaces (``önorm en 1992-1-1``), so two spellings of
    one standard are one record.
``law``
    A ``§`` followed by the abbreviation of the law it belongs to (``§ 33
    BayBO``, ``§ 62 Abs. 2 BO für Wien``). A bare ``§`` stays the payload's
    concern: without its law it cannot be resolved to anything.
``plan``
    A plan number the text points at: after ``Plan``, ``Plan-Nr.``, ``Blatt``,
    ``Zeichnung``, ``Detail``, or after ``siehe``/``vgl.``/``gem.`` when the
    token looks like a sheet number (letters, a hyphen, digits: ``EP-05``).
    ``key`` is case-folded with separators as hyphens, the form the BFF matches
    against every Plankopf ``document_number`` and file name in the project.
``document``
    A named kind of document after a word that points at it ("gem.", "laut",
    "siehe", "im", "Beilage"): ``key`` is the dossier's ``document_type``
    (``fire_safety_concept``). A word standing alone is not a reference: the
    cue is what separates "lt. Statik" from a heading that says "Statik".

Precision over recall: every pattern is anchored on a designator or a cue, so a
reference that is found is one; what is missed is missed the way it was before.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field

#: Records kept per document. A long specification cites hundreds of standards;
#: the first 60 in order of appearance are what a person reads in a side panel.
MAX_REFERENCES = 60

KINDS = ("norm", "law", "plan", "document")

_PART = r"\d{1,5}(?:[-‑]\d{1,4})*(?:\s?[A-Z](?![A-Za-z]))?"

#: Standards, longest designator first so "DIN EN ISO 13788" is one record, not three.
_NORMS = re.compile(
    rf"""
    \b(?P<designation>
        (?:ÖNORM|ONORM|OENORM|DIN)(?:\s+(?:EN|ISO|IEC|SPEC|CEN/TS))*\s+(?:[A-Z]\s?)?{_PART}
      | (?:EN|ISO)(?:\s+(?:ISO|IEC))*\s+{_PART}
      | OIB[-\s]?(?:Richtlinie|RL)\s*\d(?:\.\d)?
      | VDI\s+\d{{4}}(?:\s+Blatt\s+\d{{1,2}})?
      | TRVB\s+(?:[A-Z]\s?)?\d{{2,3}}(?:\s?[A-Z](?![a-z]))?
    )
    """,
    re.VERBOSE,
)

#: A ``§`` (or ``§§``) with its number, optional subdivisions, then the law's abbreviation.
_LAWS = re.compile(
    r"""
    §§?\s*(?P<number>\d{1,4}[a-z]?)
    (?:\s*(?:Abs\.?|Absatz)\s*\d{1,3}[a-z]?)?
    (?:\s*(?:Z\.?|Ziff\.?|Nr\.?|lit\.?|Satz)\s*[\w.]{1,4})*
    \s+(?P<law>
        (?:[A-ZÄÖÜ][A-Za-zÄÖÜäöü]*)?
        (?:BauO|BO|BauG|BauGB|BauNVO|LBO|BauKG|BTV|TBO|ROG|WBTV|VO|G)
        (?:\s+(?:NRW|für\s+Wien|Bln|BW))?
    )\b
    """,
    re.VERBOSE,
)

_PLAN_TOKEN = r"(?:\d{1,3}\s?/\s?)?[A-Z]{1,4}[-_ .]?\d{1,4}(?:[-_./]\d{1,4})?[a-z]?"

#: A plan number after a designator ("Plan Nr. EP-05", "Detail 3/A-501").
_PLANS_DESIGNATED = re.compile(
    rf"\b(?:Plan(?:-?\s?Nr\.?)?|Blatt(?:-?Nr\.?)?|Zeichnung(?:s-?Nr\.?)?|Detail)\s*:?\s*(?:Nr\.?\s*)?"
    # Not a scale: "Plan M 1:100" names no plan.
    rf"(?P<token>{_PLAN_TOKEN})\b(?![:\d])"
)
#: A sheet-number-shaped token after a pointing word ("siehe EP-05").
_PLANS_CUED = re.compile(
    r"\b(?:siehe|s\.|vgl\.|gem\.|gemäß|lt\.|laut)\s+(?P<token>(?:\d{1,3}/)?[A-Z]{1,4}-\d{1,4}(?:[-./]\d{1,4})?[a-z]?)\b"
)

#: Words that name a kind of document, as the dossier's ``document_type`` keys.
_DOCUMENT_WORDS: dict[str, str] = {
    r"Brandschutz(?:konzept|gutachten|nachweis)": "fire_safety_concept",
    r"(?:statische[nrs]?\s+(?:Berechnung|Nachweis|Vorbemessung)|Statik)": "structural_analysis",
    r"Energieausweis": "energy_certificate",
    r"(?:Bauphysik|bauphysikalische[nrs]?\s+(?:Gutachten|Nachweis)|Wärmeschutznachweis|Schallschutznachweis)": (
        "building_physics"
    ),
    r"(?:Boden|Baugrund)gutachten|geotechnische[nrs]?\s+(?:Gutachten|Bericht)": "soil_report",
    r"Baubeschreibung": "building_description",
    r"Lageplan": "site_plan",
    r"(?:Bebauungsplan|Flächenwidmungs(?:-\s?und\s+Bebauungs)?plan)": "zoning_plan",
    r"Leistungsverzeichnis": "specification",
    r"(?:Bau)?[Bb]escheid": "permit",
    r"(?:Besprechungs|Bau)?[Pp]rotokoll": "meeting_minutes",
}

#: What must stand just before a document word for it to be a reference to one.
_DOCUMENT_CUE = (
    r"(?:gem\.|gemäß|lt\.|laut|siehe|s\.|vgl\.|nach|im|in\s+der|in\s+dem|des|der|dem|beiliegende[nrs]?|"
    r"beigelegte[nrs]?|Beilage|Anlage|Anhang|aktuelle[nrs]?|vorliegende[nrs]?)"
)
_DOCUMENTS = re.compile(
    rf"\b{_DOCUMENT_CUE}\s+(?:[\w.\-]+\s+)?(?P<word>{'|'.join(f'(?:{p})' for p in _DOCUMENT_WORDS)})\b",
)
_DOCUMENT_KEYS = [(re.compile(rf"^(?:{pattern})$"), key) for pattern, key in _DOCUMENT_WORDS.items()]


@dataclass
class Reference:
    """One thing a document points at, and every page it does so on."""

    kind: str
    key: str
    label: str
    pages: list[int] = field(default_factory=list)

    def as_record(self) -> dict[str, object]:
        return {"kind": self.kind, "key": self.key, "label": self.label, "pages": sorted(set(self.pages))}


def _spaced(text: str) -> str:
    return " ".join(text.replace("‑", "-").split())


def norm_key(designation: str) -> str:
    """A standard's designation as one key: spaces single, ``ÖNORM`` however it was typed, case folded."""
    spaced = _spaced(designation)
    spaced = re.sub(r"^(?:ONORM|OENORM)\b", "ÖNORM", spaced)
    spaced = re.sub(r"^OIB[-\s]?(?:Richtlinie|RL)\s*", "OIB-RL ", spaced)
    return spaced.casefold()


def plan_key(token: str) -> str:
    """A plan number as one key: case folded, spaces and underscores as hyphens, ``3 / A-501`` as ``3/a-501``."""
    token = re.sub(r"\s*/\s*", "/", token.strip())
    return re.sub(r"[\s_]+", "-", token).casefold()


def _document_type(word: str) -> str | None:
    folded = _spaced(word)
    return next((key for pattern, key in _DOCUMENT_KEYS if pattern.match(folded)), None)


def _found(text: str) -> Iterable[tuple[str, str, str]]:
    """``(kind, key, label)`` for every reference in one passage, in order of appearance."""
    hits: list[tuple[int, str, str, str]] = []
    for match in _NORMS.finditer(text):
        label = _spaced(match.group("designation"))
        hits.append((match.start(), "norm", norm_key(label), label))
    for match in _LAWS.finditer(text):
        law = _spaced(match.group("law"))
        label = f"§ {match.group('number')} {law}"
        hits.append((match.start(), "law", label.casefold(), label))
    plan_spans: list[tuple[int, int]] = []
    for pattern in (_PLANS_DESIGNATED, _PLANS_CUED):
        for match in pattern.finditer(text):
            span = match.span("token")
            if any(start <= span[0] < end for start, end in plan_spans):
                continue
            token = match.group("token").strip()
            if not any(char.isdigit() for char in token) or not any(char.isalpha() for char in token):
                continue
            plan_spans.append(span)
            hits.append((match.start("token"), "plan", plan_key(token), _spaced(token)))
    for match in _DOCUMENTS.finditer(text):
        word = match.group("word")
        document_type = _document_type(word)
        if document_type:
            hits.append((match.start("word"), "document", document_type, _spaced(word)))
    for _, kind, key, label in sorted(hits, key=lambda hit: hit[0]):
        yield kind, key, label


def extract_references(
    passages: Iterable[tuple[str, int | None]], *, own_document_type: str | None = None
) -> list[dict[str, object]]:
    """Every reference in ``passages`` (``(text, page)``), merged by kind and key, at most :data:`MAX_REFERENCES`.

    ``own_document_type`` drops the document's references to its own kind: a
    Brandschutzkonzept that says "im vorliegenden Brandschutzkonzept" points at itself.
    """
    merged: dict[tuple[str, str], Reference] = {}
    for text, page in passages:
        if not text:
            continue
        for kind, key, label in _found(text):
            if kind == "document" and key == own_document_type:
                continue
            reference = merged.get((kind, key))
            if reference is None:
                if len(merged) >= MAX_REFERENCES:
                    continue
                reference = merged[(kind, key)] = Reference(kind, key, label)
            if page is not None:
                reference.pages.append(page)
    return [reference.as_record() for reference in merged.values()]


def drop_own_type(records: list[dict[str, object]], own_document_type: str | None) -> list[dict[str, object]]:
    """``records`` without the document references to the document's own type (known only after the dossier)."""
    if not own_document_type:
        return records
    return [r for r in records if not (r.get("kind") == "document" and r.get("key") == own_document_type)]


def reference_keys_for(text: str) -> list[tuple[str, str]]:
    """``(kind, key)`` pairs a search for documents referring to ``text`` matches. Pure.

    ``text`` is what a person or the model names: "ÖNORM B 1600", "§ 33 BayBO",
    "EP-05", "Plan Nr. EP-05", "Brandschutzkonzept". A norm, a law or a plan with its
    designator or pointing word is read with the same patterns as the documents; a
    document word maps to its type; anything else is taken as a bare plan number,
    which is how a sheet is named. Several readings may match ("Lageplan" is a
    document type, never a plan number), so every one found is returned.
    """
    text = " ".join((text or "").split())
    if not text:
        return []
    found = [(kind, key) for kind, key, _ in _found(text) if kind in ("norm", "law", "plan")]
    document_type = _document_type(text)
    if document_type:
        found.append(("document", document_type))
    if not found and any(char.isdigit() for char in text):
        found.append(("plan", plan_key(text)))
    return list(dict.fromkeys(found))
