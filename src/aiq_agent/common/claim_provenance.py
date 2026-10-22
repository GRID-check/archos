"""Where each sentence of an answer comes from: one provenance class and one claim type per sentence.

The confidence an answer carries used to be decided for the whole answer by
floors (``agents/piloti/markers.surface_answer_confidence``): no verified
citation meant „low", whatever the answer rested on. That was right for a
question about the Bauordnung and wrong for most of what an office asks
Piloti now: „Anna hat drei offene Freigaben" rests on a server record stronger
than any passage, and still surfaced as „Antwort nicht durch Quellen belegt".
The unit that can tell the two apart is the sentence (ADR-0125, after Harvey's
BigLaw Bench, which scores per sentence that should carry a source).

Each sentence gets two independent labels.

*Provenance class*, the strongest one that applies, in this order:

1. ``cited_dropped``: it carries :data:`DROPPED_CITATION_MARKER`, the label the
   verifier puts where the model cited something that did not resolve.
2. ``quoted``: a quote line the server stamped ``verbatim``, or a sentence with
   an inline quotation of a cited passage the quote check passed.
3. ``cited``: a ``[N]`` that resolved to a retrieved passage.
4. ``action``: the turn filed a proposal and the sentence reports it.
5. ``record``: its names, numbers or states match a workspace record this
   turn read (``common/workspace_records.py``).
6. ``measured``: it states a value an IFC measurement produced this turn.
7. ``observed``: it states a number or code a ``look`` read off a drawing this
   turn (ADR-0125, amendment of 2026-10-21). A model's perception of a drawing,
   not a reproducible measurement: its ceiling is ``medium``, and it never
   grounds a normative claim. A ``[N]`` that resolves to a PLACE a look
   registered (``tools/look/place.py``) is also ``observed``; ``high`` when it
   cites a region crop and repeats the reading exactly (amendment of 2026-10-22).
8. ``reasoning``: no pointer, but its paragraph has a quoted or cited
   sentence it can be drawn from (an Einschätzung).
9. ``model_knowledge``: no pointer, and nothing in the answer to derive it from.

*Claim type*: ``normative`` (the normative-claim detector, run per sentence),
``value`` (a number, a class, a Frist), or ``descriptive``.

The ceiling a sentence allows (:func:`ceiling`) is ``high`` for evidence and
lower without it, and never lets a record, an action, a measurement or a
reading ground a normative claim: those three are evidence about the office and the building,
not about the law. That is the anti-laundering rule of
``agents/piloti/grounding.py``, now enforced per sentence rather than by
flooring the whole answer.

Pure: text and evidence in, stamps out. The caller supplies the normative
detector (it lives with Piloti) so this module has no agent dependency.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import MIN_QUOTE_LEN
from aiq_agent.common.citation_verification import UNVERIFIED_QUOTE_MARKER
from aiq_agent.common.quote_stamps import quote_lines
from aiq_agent.common.workspace_records import WorkspaceRecord

ProvenanceClass = Literal[
    "quoted",
    "cited",
    "cited_dropped",
    "record",
    "action",
    "measured",
    "observed",
    "reasoning",
    "model_knowledge",
]
ClaimType = Literal["normative", "value", "descriptive"]
Level = Literal["low", "medium", "high"]

PROVENANCE_CLASSES: tuple[ProvenanceClass, ...] = (
    "quoted",
    "cited",
    "cited_dropped",
    "record",
    "action",
    "measured",
    "observed",
    "reasoning",
    "model_knowledge",
)

#: The version of the confidence rule a turn's level was computed under. 1 is
#: the answer-level floors (absent on the wire: every turn stored before this
#: change); 2 is the per-sentence formula here. The reader renders a stored
#: turn under the rule it was computed with.
CONFIDENCE_RULE_VERSION = 2

_LEVELS: tuple[Level, ...] = ("low", "medium", "high")

#: The classes that ARE evidence. A normative claim needs a passage (quoted or
#: cited); the other three ground facts about the office or the building only.
_PASSAGE_CLASSES = frozenset({"quoted", "cited"})
_FACT_CLASSES = frozenset({"record", "action", "measured"})

#: Longest sentence text a stamp carries. The stamp names the sentence; the
#: answer text holds it whole.
_MAX_STAMP_TEXT = 300

_MARKER_RE = re.compile(r"\[(\d+)\]")
_CARD_MARKER_RE = re.compile(r"\[\[card:\d+\]\]|\[\[callout\]\]")
_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
_DIRECTIVE_RE = re.compile(r"^\s*:::")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s")
_TABLE_RULE_RE = re.compile(r"^\s*\|?\s*:?-{3,}")
_LIST_PREFIX_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_QUOTE_LINE_RE = re.compile(r"^\s*>")
_EMPHASIS_RE = re.compile(r"\*\*|__|==|`")

#: A sentence ends at „.", „!" or „?" before whitespace and a capital, a digit
#: or an opening quote, unless the period closes a number or an abbreviation.
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+(?=[A-ZÄÖÜ„\"(\[0-9])")
_ABBREVIATION_RE = re.compile(
    r"(?:\b(?:z|u|d|s|o|v|ggf|bzw|vgl|abs|nr|lit|pkt|ca|inkl|exkl|bspw|etc|gem|lt|max|min|mind|zzgl|abb|tab|kap|art)"
    r"|\d)\.$",
    re.IGNORECASE,
)

#: A quotation inside a sentence: „…“, »…«, “…”.
_INLINE_QUOTE_RE = re.compile(r"„([^„“”\"]+)[“”\"]|»([^»«]+)«|“([^“”]+)”")

#: A value: a number (with or without a unit), a class, a Frist or a date.
_VALUE_RE = re.compile(
    r"(?<![\w-])\d+(?:[.,]\d+)?(?!\w)|\bGK\s*\d|\bKlasse\s+\d|\bFrist\b|\bdeadline\b",
    re.IGNORECASE,
)

#: A sentence that reports a proposal rather than a fact.
_ACTION_RE = re.compile(
    r"vorgeschlagen|vorschlag|schlage\b.*\bvor\b|zur\s+(?:freigabe|bestätigung|bestaetigung)|"
    r"bestätigen|bestaetigen|annehmen|nichts\s+geändert|nichts\s+geaendert|"
    r"\bproposed?\b|\bproposal\b|\bnothing\s+(?:was\s+)?changed\b",
    re.IGNORECASE,
)

#: What a sentence reporting a proposal says about the proposed operation:
#: „…, Lea als Mitglied aufzunehmen", „…, die Dateien zu verschieben", „bitte
#: bestätigen Sie". The normative detector reads a zu-infinitive as a
#: prescription („ist einzuhalten"); in an action report it is the operation,
#: so it is left out of the ACTION CLAUSE before the claim type is decided
#: (:func:`_action_typed_text`). A zu-infinitive is a separable prefix, „zu"
#: and a verb, or „zu" and a verb as two words: „zulässigen", „zuständigen"
#: and „unzulässigen" start with or hold „zu" and are none of them.
_ACTION_INFINITIVE_RE = re.compile(
    r"\b(?:ab|an|auf|aus|bei|bereit|dar|durch|ein|fest|fort|frei|her|heraus|herein|hin|hinzu|hoch|los|mit|nach|"
    r"um|vor|voran|weg|weiter|wieder|zurück|zurueck|zusammen|zu)zu\w+en\b|\bzu\s+\w+en\b|\bbestätigen\b|\bbestaetigen\b",
    re.IGNORECASE,
)

#: Where an action report's clause ends: „;", „:", and a causal „, da / , weil /
#: , denn". What follows a cause connective is the REASON for the proposal
#: („…, weil pro Wohnung ein Stellplatz herzustellen ist"), and that is a
#: claim about the law in its own right.
_CLAUSE_SPLIT_RE = re.compile(r"(;|:|,\s+(?:da|weil|denn)\b)", re.IGNORECASE)

_NUMBER_RE = re.compile(r"(?<![\w-])\d+(?:[.,]\d+)?(?!\w)")
#: Words a record match may rest on: four letters or more, so „und", „die" and
#: „ist" never ground anything.
_WORD_RE = re.compile(r"[^\W\d_][^\W_]{3,}")
#: German function words that are long enough to pass the length floor and say
#: nothing about which record a sentence came from.
_STOPWORDS = frozenset(
    {
        "eine", "einer", "einen", "einem", "eines", "sind", "wird", "werden", "wurde", "wurden", "haben",
        "hat", "nicht", "noch", "auch", "aber", "oder", "dass", "diese", "dieser", "dieses", "diesem",
        "ihre", "ihren", "seine", "sowie", "beim", "über", "ueber", "unter", "nach", "dort", "hier", "alle",
        "allen", "derzeit", "aktuell", "insgesamt", "projekt", "projekts", "projektes", "with", "that",
        "this", "from", "have", "there", "their", "which",
    }
)  # fmt: skip


#: A sentence matches a record on two words shared with one of its items, or on one shared number.
_MIN_RECORD_HITS = 2

#: Counts the answer spells out, so „drei offene Freigaben" is checked like „3".
_NUMBER_WORDS = {
    "eins": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "fuenf": 5, "sechs": 6, "sieben": 7, "acht": 8,
    "neun": 9, "zehn": 10, "elf": 11, "zwölf": 12, "zwoelf": 12, "two": 2, "three": 3, "four": 4, "five": 5,
}  # fmt: skip


@dataclass(frozen=True)
class ClaimEvidence:
    """What this turn's answer can point at, besides its own words."""

    #: The ``[N]`` numbers that resolved to a retrieved passage, as the final text numbers them.
    cited_numbers: frozenset[int] = frozenset()
    #: The quote-line stamps (``common/quote_stamps.py``), in document order.
    quote_stamps: Sequence[dict[str, Any]] = ()
    #: The workspace records this turn read or proposed.
    records: Sequence[WorkspaceRecord] = ()
    #: The value texts this turn's measurements produced („2,70 m").
    measured_values: Sequence[str] = ()
    #: What this turn's looks read off the drawings the answer relies on (the
    #: ``reading`` of each ``look`` card item). A perception, not a measurement.
    readings: Sequence[str] = ()
    #: The cited ``[N]`` that resolved to a place a ``look`` read (ADR-0125,
    #: amendment of 2026-10-22), by number. Not in ``cited_numbers``: a place
    #: is no passage and grounds no claim about the law.
    looks: Mapping[int, LookPlace] = field(default_factory=dict)


@dataclass(frozen=True)
class LookPlace:
    """A cited place a look read: the reading text and whether it was a region crop (not an overview)."""

    read: str
    crop: bool = False
    #: No retrieved passage of the same page is merged into it. On a page that
    #: also holds a retrieved caption (``passage``), a sentence is classed by
    #: where its value appears: in the passage it is ``cited``, only in the
    #: reading it is ``observed`` (:func:`_merged_class`).
    place_only: bool = True
    #: The retrieved passage merged into the same entry; empty for a place only.
    passage: str = ""


@dataclass(frozen=True)
class ClaimStamp:
    """One sentence of the answer with where it comes from and what kind of claim it is."""

    text: str
    provenance: ProvenanceClass
    claim_type: ClaimType
    #: The ``[N]`` the sentence carries.
    numbers: tuple[int, ...] = ()
    #: For ``record`` and ``action``: the operation the matching record came from.
    operation: str | None = None
    #: For ``record``: numbers the sentence states that no record holds. A
    #: record sentence with one is a misread until shown otherwise.
    unmatched: tuple[str, ...] = ()
    #: Whether this sentence decides the answer's level (:func:`load_bearing`).
    load_bearing: bool = False
    #: ``observed`` only: it cites a region crop and repeats the reading exactly.
    exact: bool = False
    #: A level the sentence's look place caps it at, beside a passage pointer.
    cap: Level | None = None
    #: It reports an absence of evidence or marks itself an estimate (:data:`_HEDGE_RE`).
    hedged: bool = False
    #: ``reasoning`` + a value that a cited or observed-place sentence also states.
    value_supported: bool = False

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "text": self.text[:_MAX_STAMP_TEXT],
            "provenance": self.provenance,
            "claim_type": self.claim_type,
            "load_bearing": self.load_bearing,
        }
        if self.numbers:
            wire["numbers"] = list(self.numbers)
        if self.operation:
            wire["operation"] = self.operation
        if self.unmatched:
            wire["unmatched"] = list(self.unmatched)
        return wire


@dataclass(frozen=True)
class _Unit:
    """A sentence as found: its text, its paragraph, and whether it is a quote line."""

    text: str
    paragraph: int
    quote_line: bool = False
    quote_wording: str | None = None


# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------


def _clean(text: str) -> str:
    text = _CARD_MARKER_RE.sub("", text)
    text = _LIST_PREFIX_RE.sub("", text)
    return _EMPHASIS_RE.sub("", text).strip()


def _split_sentences(text: str) -> list[str]:
    """``text`` cut at sentence ends that are not abbreviations or numbers."""
    pieces: list[str] = []
    start = 0
    for match in _SENTENCE_END_RE.finditer(text):
        head = text[start : match.start()]
        if _ABBREVIATION_RE.search(head):
            continue
        pieces.append(head)
        start = match.end()
    pieces.append(text[start:])
    return [piece.strip() for piece in pieces if piece.strip()]


def _table_cells(line: str) -> str:
    return " · ".join(cell.strip() for cell in line.strip().strip("|").split("|") if cell.strip())


def _units(prose: str) -> Iterator[_Unit]:
    """The answer's sentences in order: prose split into sentences, list items and table rows one each.

    Skipped: code fences, directive lines, headings, a table's header and rule
    rows. A quote line is its own unit and keeps its wording for the stamp.
    """
    wordings = iter(quote_lines(prose))
    paragraph = 0
    fence: str | None = None
    table_header_pending = True
    for line in prose.split("\n"):
        fence_match = _FENCE_RE.match(line)
        if fence is not None:
            if fence_match and fence_match.group(1)[0] == fence[0]:
                fence = None
            continue
        if fence_match:
            fence = fence_match.group(1)
            continue
        if not line.strip():
            paragraph += 1
            table_header_pending = True
            continue
        if _DIRECTIVE_RE.match(line) or _HEADING_RE.match(line) or _TABLE_RULE_RE.match(line):
            continue
        if line.lstrip().startswith("|"):
            if table_header_pending:
                table_header_pending = False
                continue
            yield _Unit(_table_cells(line), paragraph)
            continue
        if _QUOTE_LINE_RE.match(line):
            wording = _next_wording(wordings, line)
            if wording is not None:
                yield _Unit(_clean(line.lstrip(" >")), paragraph, quote_line=True, quote_wording=wording)
                continue
            line = line.lstrip(" >")
        for sentence in _split_sentences(_clean(line)):
            yield _Unit(sentence, paragraph)


def _next_wording(wordings: Iterator[tuple[str, tuple[int, ...]]], line: str) -> str | None:
    """The quote line's wording when ``line`` is the next quote line ``quote_lines`` found; else None."""
    if not any(mark in line for mark in ("„", "»", "“", '"')):
        return None
    try:
        wording, _ = next(wordings)
    except StopIteration:
        return None
    return wording


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def claim_type(sentence: str, normative: Callable[[str], bool]) -> ClaimType:
    """``normative`` when the detector fires, ``value`` when it states a number, class or Frist, else descriptive."""
    without_markers = _MARKER_RE.sub("", sentence)
    if normative(without_markers):
        return "normative"
    if _VALUE_RE.search(without_markers):
        return "value"
    return "descriptive"


def _numbers(sentence: str) -> tuple[int, ...]:
    return tuple(dict.fromkeys(int(number) for number in _MARKER_RE.findall(sentence)))


def _has_verified_inline_quote(sentence: str) -> bool:
    if UNVERIFIED_QUOTE_MARKER in sentence:
        return False
    return any(
        len(next(group for group in match.groups() if group is not None).strip()) >= MIN_QUOTE_LEN
        for match in _INLINE_QUOTE_RE.finditer(sentence)
    )


def _stamp_for(wording: str, stamps: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    return next((stamp for stamp in stamps if stamp.get("text") == wording), None)


def _whole_word_in(token: str, haystack: str) -> bool:
    return re.search(rf"(?<![\w]){re.escape(token)}(?![\w])", haystack) is not None


def _record_match(sentence: str, records: Sequence[WorkspaceRecord]) -> tuple[WorkspaceRecord, tuple[str, ...]] | None:
    """The record a sentence was read from, and the numbers in it no record holds; None when none matches.

    A sentence matches a record on one of its numbers standing in the record's
    values (or equal to the length of a list it carried), or on two of its
    words (four letters or more, not a function word) standing in ONE item of
    it: one row of a list, or the values outside any list. Two words scattered
    over a long answer („Planung" in one task, „Fassade" in another) are a
    coincidence, not a sentence read off a row. The record with most matches
    wins.
    """
    folded = _MARKER_RE.sub("", sentence).casefold()
    words = {word for word in _WORD_RE.findall(folded) if word not in _STOPWORDS}
    numbers = _NUMBER_RE.findall(folded) + [
        str(_NUMBER_WORDS[word]) for word in re.findall(r"[^\W\d_]+", folded) if word in _NUMBER_WORDS
    ]
    best: tuple[int, WorkspaceRecord] | None = None
    for record in records:
        word_hits = max(
            (sum(1 for word in words if _whole_word_in(word, item)) for item in record.items or (record.haystack,)),
            default=0,
        )
        number_hits = sum(1 for number in numbers if _number_in(number, record))
        # One shared word is a coincidence („Schnitt" in a recommendation);
        # two in one row, or a number, is a sentence read off the record.
        hits = word_hits + 2 * number_hits
        if hits >= _MIN_RECORD_HITS and (best is None or hits > best[0]):
            best = (hits, record)
    if best is None:
        return None
    unmatched = tuple(number for number in numbers if not any(_number_in(number, rec) for rec in records))
    return best[1], unmatched


def _number_in(number: str, record: WorkspaceRecord) -> bool:
    plain = number.replace(",", ".")
    if plain.isdigit() and int(plain) in record.counts:
        return True
    return _whole_word_in(number, record.haystack) or _whole_word_in(plain, record.haystack)


def _as_number(text: str) -> tuple[float, int] | None:
    """A written number as a float and its count of decimals („2,70" → (2.7, 2)); None when it is not one."""
    plain = text.replace(",", ".")
    try:
        return float(plain), len(plain.partition(".")[2])
    except ValueError:
        return None


def _measured(sentence: str, values: Sequence[str]) -> bool:
    """Whether the sentence states a measured value, at the precision it writes („2,70 m" for 2.703 m)."""
    measured = [number for value in values for match in _NUMBER_RE.findall(value) if (number := _as_number(match))]
    for written in _NUMBER_RE.findall(_MARKER_RE.sub("", sentence)):
        parsed = _as_number(written)
        if parsed is None:
            continue
        number, decimals = parsed
        if any(round(value, decimals) == number for value, _ in measured):
            return True
    return False


#: A token a drawing reading can hold and a sentence can repeat: a number, or a
#: code that mixes letters and digits („EI30", „D1").
_CODE_RE = re.compile(r"(?<![\w-])(?=[\w.]*\d)(?=[\w.]*[^\W\d_])\w[\w.]*(?![\w-])")


#: A number and the word or unit written right after it („2,70 m" → „m", „3 Geschosse" → „geschosse").
_NUMBER_WITH_UNIT_RE = re.compile(r"(?<![\w-])(\d+(?:[.,]\d+)?)(?!\w)(?:\s?([^\W\d_]+[²³]?|%|°))?")


def _written_numbers(text: str) -> list[tuple[float, int, str]]:
    """Every number in ``text`` as (value, decimals written, the unit after it, casefolded or empty)."""
    numbers = []
    for match in _NUMBER_WITH_UNIT_RE.finditer(text):
        parsed = _as_number(match.group(1))
        if parsed is not None:
            numbers.append((parsed[0], parsed[1], (match.group(2) or "").casefold()))
    return numbers


def _reads_number(sentence: str, read: str) -> bool:
    """Whether the sentence repeats a number a look read, exactly.

    A reading is already rounded text, so nothing is rounded here: the value
    must be equal, and either the unit after it is the same on both sides
    („1 m" for a read „1,00 m") or the decimals are („2,70" for „2,70 m"). A
    bare whole number („3 Geschosse" beside a read „2,70 m" or a sheet „3")
    carries neither and is not a reading repeated.
    """
    read_numbers = _written_numbers(read)
    for value, decimals, unit in _written_numbers(sentence):
        for read_value, read_decimals, read_unit in read_numbers:
            if value != read_value:
                continue
            if unit and unit == read_unit:
                return True
            if decimals and decimals == read_decimals:
                return True
    return False


def _observed(sentence: str, readings: Sequence[str]) -> bool:
    """Whether the sentence states a number or a code a look read, exactly as it was read."""
    if not readings:
        return False
    text = _MARKER_RE.sub("", sentence)
    read = " ".join(readings)
    if _reads_number(text, read):
        return True
    read_codes = {code.rstrip(".").casefold() for code in _CODE_RE.findall(read)}
    return any(code.rstrip(".").casefold() in read_codes for code in _CODE_RE.findall(text))


def _is_place(number: int, evidence: ClaimEvidence) -> bool:
    """Whether ``[number]`` resolved to a place a look read and no retrieved passage."""
    place = evidence.looks.get(number)
    return place is not None and place.place_only


def _value_tokens_of(sentence: str) -> tuple[set[float], set[str]]:
    """The numbers and the codes a sentence states, markers left out."""
    text = _MARKER_RE.sub("", sentence)
    numbers = {value for value, _, _ in _written_numbers(text)}
    codes = {code.rstrip(".").casefold() for code in _CODE_RE.findall(text)}
    return numbers, codes


def _states_value(sentence: str, text: str) -> bool:
    """Whether ``text`` holds a number or code the sentence states (equal value, any unit or decimals)."""
    numbers, codes = _value_tokens_of(sentence)
    held_numbers, held_codes = _value_tokens_of(text)
    return bool(numbers & held_numbers or codes & held_codes)


def _merged_class(unit: _Unit, numbers: tuple[int, ...], evidence: ClaimEvidence) -> ProvenanceClass | None:
    """The class of a sentence whose every passage pointer is an entry holding a passage AND a reading.

    A look on a page that also holds a retrieved caption merges into that
    entry. The sentence is classed by where its value actually appears, so a
    value read off the drawing never borrows the caption's authority:
    in the passage → ``cited`` (None here, the pointer's own class), only in the
    reading → ``observed``, in neither → ``model_knowledge`` (an unsupported
    value). A sentence stating no value is ``cited`` as before.
    """
    pointed = [number for number in numbers if number in evidence.cited_numbers]
    merged = [evidence.looks.get(number) for number in pointed]
    if not merged or any(place is None or place.place_only for place in merged):
        return None
    numbers_stated, codes_stated = _value_tokens_of(unit.text)
    if not (numbers_stated or codes_stated):
        return None
    if _states_value(unit.text, " ".join(place.passage for place in merged if place)):
        return None
    if _observed(unit.text, [place.read for place in merged if place]):
        return "observed"
    return "model_knowledge"


def _place_level(unit: _Unit, evidence: ClaimEvidence, *, merged: bool = False) -> tuple[bool, Level | None]:
    """What the look places a sentence cites allow: (exact, level), or (False, None) when it cites none.

    ``high`` only when a cited place is a region crop (not an overview) and the
    sentence repeats a number or code of that place's reading exactly
    (:func:`_observed`); ``medium`` otherwise. A reading is a model's
    perception: no match, or an overview, is the weaker ground.
    """
    places = [
        evidence.looks[n]
        for n in _numbers(unit.text)
        if n in evidence.looks and (merged or evidence.looks[n].place_only)
    ]
    if not places:
        return False, None
    exact = any(place.crop and _observed(unit.text, [place.read]) for place in places)
    return exact, "high" if exact else "medium"


def _class_with_pointer(unit: _Unit, evidence: ClaimEvidence) -> ProvenanceClass | None:
    """The class a sentence's own pointer gives it (a label, a quote, a marker), or None when it has none."""
    if DROPPED_CITATION_MARKER in unit.text:
        return "cited_dropped"
    if unit.quote_line and unit.quote_wording is not None:
        stamp = _stamp_for(unit.quote_wording, evidence.quote_stamps)
        if stamp is not None and stamp.get("status") == "verbatim":
            return "quoted"
    numbers = _numbers(unit.text)
    if numbers and any(number in evidence.cited_numbers for number in numbers):
        merged = _merged_class(unit, numbers, evidence)
        if merged is not None:
            return merged
        # A quote line is judged by its stamp above, never by the inline check.
        return "quoted" if not unit.quote_line and _has_verified_inline_quote(unit.text) else "cited"
    if numbers and any(_is_place(number, evidence) for number in numbers):
        return "observed"
    if numbers:
        # A number nothing resolves: the verifier labels these, so this is a
        # marker that reached the text another way. It is not a pointer.
        return "cited_dropped"
    return None


def _classify(unit: _Unit, evidence: ClaimEvidence) -> tuple[ProvenanceClass, str | None, tuple[str, ...]]:
    """One sentence's class, the operation behind a record or action, and a record's unmatched numbers."""
    pointed = _class_with_pointer(unit, evidence)
    if pointed is not None:
        return pointed, None, ()
    proposals = [record for record in evidence.records if record.outcome == "proposed"]
    if proposals and _ACTION_RE.search(unit.text):
        return "action", proposals[0].operation, ()
    reads = [record for record in evidence.records if record.outcome == "read"]
    match = _record_match(unit.text, reads) if reads else None
    if match is not None:
        record, unmatched = match
        return "record", record.operation, unmatched
    if _measured(unit.text, evidence.measured_values):
        return "measured", None, ()
    if _observed(unit.text, evidence.readings):
        return "observed", None, ()
    return "model_knowledge", None, ()


#: A proposal input that says what the law requires is not a name, however short.
_PRESCRIPTIVE_WORD_RE = re.compile(
    r"\b(?:muss|müssen|muessen|darf|dürfen|duerfen|soll|sollen|erforderlich|zulässig|zulaessig|unzulässig|"
    r"unzulaessig|mindestens|höchstens|hoechstens|vorgeschrieben|must|shall|required)\b",
    re.IGNORECASE,
)
#: The most words a proposal input may have and still be a name (a folder, a file, a person).
_NAME_MAX_WORDS = 4


def _proposal_names(evidence: ClaimEvidence, operation: str | None) -> list[str]:
    """The short, non-prescriptive inputs of the proposal ``operation`` filed this turn, longest first.

    A work turn names what it proposed: „den Ordner Brandschutz". That name is
    the proposal's own data, and the normative detector reads „Brandschutz" as
    building law, so it is left out before the claim type is decided, the way
    the zu-infinitive is. Only a name: an input that is long or prescriptive
    („Fluchtweg muss 1,2 m breit sein") stays in, so a proposal can never carry
    a legal claim past the detector.
    """
    names: set[str] = set()
    for record in evidence.records:
        if record.outcome != "proposed" or record.operation != operation:
            continue
        for value in record.haystack.split("\n"):
            value = value.strip()
            if len(value) >= 3 and len(value.split()) <= _NAME_MAX_WORDS and not _PRESCRIPTIVE_WORD_RE.search(value):
                names.add(value)
    return sorted(names, key=len, reverse=True)


def _action_clause_span(pieces: Sequence[str]) -> range:
    """The indexes in ``pieces`` (clauses and their separators, as ``re.split`` keeps them) of the action clause.

    The action clause is the one holding the first :data:`_ACTION_RE` match.
    When it ends in a colon, the clause after the colon is what was proposed
    („Vorgeschlagen: Ordner Brandschutz") and belongs to it. Empty when no
    clause holds a match on its own (the match spans a separator).
    """
    for index in range(0, len(pieces), 2):
        if not _ACTION_RE.search(pieces[index]):
            continue
        end = index + 1
        if index + 2 < len(pieces) and pieces[index + 1] == ":":
            end = index + 3
        return range(index, end)
    return range(0)


def _without_names(clause: str, names: Sequence[str]) -> str:
    """``clause`` without each name as a whole word: „Bau" never eats „Bauordnung", „OIB" never „OIB-RL"."""
    for name in names:
        clause = re.sub(rf"(?<![\w-]){re.escape(name)}(?![\w-])", "", clause, flags=re.IGNORECASE)
    return clause


def _action_claim_type(
    text: str, evidence: ClaimEvidence, operation: str | None, normative: Callable[[str], bool]
) -> ClaimType:
    """An action sentence's claim type, read without the operation's infinitive and names in its action clause.

    Only the clause that reports the proposal loses them: the rest of the
    sentence (a reason after „, weil", a rule after „;") is read whole, and
    a sentence whose rest is normative is normative whatever the action
    clause says.
    """
    pieces = _CLAUSE_SPLIT_RE.split(text)
    span = _action_clause_span(pieces)
    rest = "".join(piece for index, piece in enumerate(pieces) if index not in span)
    if rest.strip() and normative(_MARKER_RE.sub("", rest)):
        return "normative"
    names = _proposal_names(evidence, operation)
    typed = "".join(
        _without_names(_ACTION_INFINITIVE_RE.sub("", piece), names) if index in span and index % 2 == 0 else piece
        for index, piece in enumerate(pieces)
    )
    return claim_type(typed, normative)


#: A sentence that reports the ABSENCE of evidence or marks itself an estimate
#: (ADR-0125, amendment of 2026-10-22). It is honest uncertainty, not a claim of
#: fact: it caps at ``medium`` and does not count as a legal claim without a
#: source. Narrow on purpose, German and English.
_HEDGE_RE = re.compile(
    r"\bin\s+(?:keinem|keiner)\s+(?:\w+\s+){0,2}(?:dokument|unterlage|plan|datei|grundriss|schnitt)\w*"
    r"|\bkeine[nr]?\s+(?:\w+\s+){0,2}(?:grundriss|unterlage|angabe|nachweis)\w*\s+(?:gibt|vor|vorhanden)"
    r"|\b(?:nicht|nirgends)\s+(?:\w+\s+)?(?:nachgewiesen|belegt|dokumentiert|angegeben|ersichtlich|bestätigt|bestaetigt)\b"
    r"|\b(?:kann|können|koennen|konnte)\s+(?:ich\s+)?(?:es\s+|das\s+|dies\s+)?(?:\w+\s+)?nicht\s+"
    r"(?:nachweisen|bestätigen|bestaetigen|belegen|prüfen|pruefen|verifizieren)"
    r"|\bnachweisen\s+kann\s+ich\b|\bweder\s+bestätigen\s+noch\s+widerlegen"
    r"|\bnach\s+meiner\s+(?:einschätzung|einschaetzung)|\bmeiner\s+(?:einschätzung|einschaetzung)\s+nach"
    r"|\büberschlägig|\bueberschlaegig|\bgeschätzt\b|\bgeschaetzt\b|\bschätzungsweise\b"
    r"|\bnot\s+(?:documented|stated|shown|established|evidenced|verifiable)\b"
    r"|\b(?:cannot|can't|could\s+not|am\s+unable\s+to)\s+(?:\w+\s+)?(?:verify|confirm|establish|prove)\b"
    r"|\b(?:no|none\s+of\s+the)\s+documents?\s+(?:state|show|establish|give|hold)"
    r"|\bin\s+my\s+(?:estimate|assessment)\b|\bi\s+estimate\b|\broughly\s+estimated\b",
    re.IGNORECASE,
)


def is_hedged(sentence: str) -> bool:
    """Whether the sentence reports an absence of evidence or marks itself an estimate."""
    return _HEDGE_RE.search(_MARKER_RE.sub("", sentence)) is not None


def _value_tokens(sentence: str) -> set[float]:
    return {value for value, _, _ in _written_numbers(_MARKER_RE.sub("", sentence))}


def _supported_values(stamps: Sequence[ClaimStamp]) -> list[ClaimStamp]:
    """Mark a ``reasoning`` value sentence whose value a cited or observed-place sentence of the answer also states."""
    evidence_values: set[float] = set()
    for stamp in stamps:
        if stamp.provenance in _PASSAGE_CLASSES or stamp.provenance == "observed":
            evidence_values |= _value_tokens(stamp.text)
    marked = []
    for stamp in stamps:
        supported = (
            stamp.provenance == "reasoning"
            and stamp.claim_type == "value"
            and bool(_value_tokens(stamp.text) & evidence_values)
        )
        marked.append(ClaimStamp(**{**stamp.__dict__, "value_supported": True}) if supported else stamp)
    return marked


def classify_claims(
    prose: str,
    evidence: ClaimEvidence,
    *,
    normative: Callable[[str], bool],
) -> list[ClaimStamp]:
    """One stamp per sentence of ``prose`` (the answer without its reference list), in document order."""
    classified = []
    for unit in _units(prose):
        provenance, operation, unmatched = _classify(unit, evidence)
        ctype = (
            _action_claim_type(unit.text, evidence, operation, normative)
            if provenance == "action"
            else claim_type(unit.text, normative)
        )
        classified.append((unit, ctype, provenance, operation, unmatched))
    supported = {unit.paragraph for unit, _, provenance, _, _ in classified if provenance in _PASSAGE_CLASSES}
    stamps = []
    for unit, ctype, provenance, operation, unmatched in classified:
        exact, _ = _place_level(unit, evidence, merged=provenance == "observed")
        _, level = _place_level(unit, evidence)
        # A place beside a passage pointer: the sentence is held to the weaker of the two.
        cap = level if provenance in _PASSAGE_CLASSES else None
        if provenance in _PASSAGE_CLASSES and cap is None and _observed(unit.text, evidence.readings):
            cap = "medium"
        stamps.append(
            ClaimStamp(
                text=unit.text,
                provenance=(
                    "reasoning" if provenance == "model_knowledge" and unit.paragraph in supported else provenance
                ),
                claim_type=ctype,
                numbers=_numbers(unit.text),
                operation=operation,
                unmatched=unmatched,
                exact=exact and provenance == "observed",
                cap=cap,
                hedged=is_hedged(unit.text),
            )
        )
    return mark_load_bearing(_supported_values(stamps))


def mark_load_bearing(stamps: list[ClaimStamp]) -> list[ClaimStamp]:
    """Mark the sentences the answer's level rests on: every normative or value one; all, when there is none."""
    marked = [stamp.claim_type != "descriptive" for stamp in stamps]
    if not any(marked):
        marked = [True] * len(stamps)
    return [
        ClaimStamp(**{**stamp.__dict__, "load_bearing": bearing}) for stamp, bearing in zip(stamps, marked, strict=True)
    ]


# ---------------------------------------------------------------------------
# The formula
# ---------------------------------------------------------------------------


def ceiling(
    provenance: ProvenanceClass,
    ctype: ClaimType,
    *,
    unmatched: bool = False,
    exact: bool = False,
    hedged: bool = False,
    value_supported: bool = False,
) -> Level:
    """The highest level one sentence allows.

    - ``high`` for a quoted or cited sentence of any type, and for a record,
      an action or a measurement that is not normative.
    - ``medium`` for a sentence read off a drawing (``observed``): a model's
      perception, whatever its type, and ``low`` when it is normative; ``high``
      only when it cites a region crop and repeats its reading exactly
      (``exact``). A ``hedged`` sentence (it reports an absence of evidence or
      marks itself an estimate) is ``medium`` whatever its class, as is a
      ``reasoning`` value that a cited sentence of the answer also states. Also
      for a record sentence stating a number no record holds (a
      misread until shown otherwise), for ``reasoning``, and for a descriptive
      sentence from model knowledge.
    - ``low`` for a normative sentence without a passage, a value sentence
      with no evidence of its own, and every ``cited_dropped`` sentence.
    """
    if provenance == "cited_dropped":
        return "low"
    if provenance in _PASSAGE_CLASSES:
        return "high"
    if hedged:
        # Honest absence or an estimate: not a claim of fact, so never below medium.
        return "medium"
    if provenance == "observed":
        if ctype == "normative":
            return "low"
        return "high" if exact else "medium"
    if provenance == "reasoning" and ctype == "value" and value_supported:
        return "medium"
    if provenance in _FACT_CLASSES:
        if ctype == "normative":
            return "low"
        return "medium" if unmatched else "high"
    if ctype != "descriptive":
        return "low"
    return "medium"


#: The ceiling of an answer with no sentence to stamp (a card marker, a code
#: block, a heading alone). Nothing in it can carry evidence, and rule 1 floors
#: an answer without a verified citation at ``low``; so does this, rather than
#: leaving the self-report unchecked.
NO_CLAIMS_CEILING: Level = "low"


def stamp_ceiling(stamp: ClaimStamp) -> Level:
    """:func:`ceiling` of one stamp, held to the level its look place caps it at."""
    level = ceiling(
        stamp.provenance,
        stamp.claim_type,
        unmatched=bool(stamp.unmatched),
        exact=stamp.exact,
        hedged=stamp.hedged,
        value_supported=stamp.value_supported,
    )
    return min(level, stamp.cap, key=_LEVELS.index) if stamp.cap else level


def claims_ceiling(stamps: Sequence[ClaimStamp]) -> Level:
    """The lowest ceiling among the load-bearing sentences; :data:`NO_CLAIMS_CEILING` when there is none."""
    bearing = [stamp for stamp in stamps if stamp.load_bearing]
    if not bearing:
        return NO_CLAIMS_CEILING
    return min((stamp_ceiling(stamp) for stamp in bearing), key=_LEVELS.index)


def weakest_claim(stamps: Sequence[ClaimStamp]) -> ClaimStamp | None:
    """The load-bearing sentence that set :func:`claims_ceiling`, the first of its level."""
    bearing = [stamp for stamp in stamps if stamp.load_bearing]
    if not bearing:
        return None
    return min(bearing, key=lambda stamp: _LEVELS.index(stamp_ceiling(stamp)))


def class_counts(stamps: Sequence[ClaimStamp]) -> dict[str, int]:
    """How many sentences of each class, in :data:`PROVENANCE_CLASSES` order, zeros left out."""
    counts = Counter(stamp.provenance for stamp in stamps)
    return {name: counts[name] for name in PROVENANCE_CLASSES if counts[name]}


def normative_uncited(stamps: Sequence[ClaimStamp]) -> int:
    """Normative sentences with no passage behind them: the claims a reader should check first."""
    return sum(
        1
        for stamp in stamps
        if stamp.claim_type == "normative" and stamp.provenance not in _PASSAGE_CLASSES and not stamp.hedged
    )
