"""Where each sentence of an answer comes from, and whether that evidence says what the sentence says.

The confidence an answer carries used to be decided for the whole answer by
floors (``agents/piloti/markers.surface_answer_confidence``): no verified
citation meant „low", whatever the answer rested on. „Anna hat drei offene
Freigaben" rests on a server record stronger than any passage, and still
surfaced as „Antwort nicht durch Quellen belegt". The unit that can tell the
two apart is the sentence (ADR-0125, after Harvey's BigLaw Bench).

*Provenance class*, deterministic, the strongest one that applies:

1. ``cited_dropped``: a stamp stored before the dropped flag (below).
2. ``quoted``: a quote line the server stamped ``verbatim``, or a sentence with
   an inline quotation of a cited passage the quote check passed.
3. ``cited``: a ``[N]`` that resolved to a retrieved passage.
4. ``action``: the turn filed a proposal and the sentence reports it.
5. ``record``: its words and numbers stand in ONE item of a workspace record
   this turn read: a listing line, a profile row, an inventory line
   (``common/workspace_records.py``).
6. ``measured``: it states a value an IFC measurement produced this turn.
7. ``observed``: it states a number or code a ``look`` read off a drawing, or
   cites a place a look registered (ADR-0125, amendments of 2026-10-21/22).
8. ``reasoning``: no pointer, but its paragraph cites a passage.
9. ``model_knowledge``: no pointer, and nothing in the answer behind it.

A pointer that did not hold is a flag (``dropped``), not a class. The class
fixes the *evidence* a sentence is held to (:attr:`ClaimStamp.evidence`): the
passage text, the record item, the measured values or the reading.

*Whether the evidence says it* is not decided here. Four rounds of German word
lists (ADR-0139) never told a verdict from a next step, or „zulässig" from
„unzulässig", in both directions at once. ``common/claim_judge.py`` asks one
small model, once per answer, whether each sentence's evidence supports,
contradicts or does not address it, and whether the sentence is a verdict on
the law, a fact, an assessment or a next step (:func:`with_judgements`). Two
rules stay deterministic: only a passage grounds a verdict (a record, a
measurement or a reading never does, the anti-laundering rule of
``agents/piloti/grounding.py``), and a sentence with no evidence counts
nothing whatever the judge says.

The answer's level (rule 3, :func:`claims_ceiling`): ``high`` when every
load-bearing claim is supported, ``low`` when a verdict is contradicted or no
claim is supported, ``medium`` otherwise; ``medium`` too when the judge could
not run. A table under a lead-in is one claim (:func:`claim_supports`).

Pure: text and evidence in, stamps out. The caller supplies the normative
detector for the wire's claim type, a label the level no longer reads.
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
from dataclasses import replace
from typing import Any
from typing import Literal

from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import MIN_QUOTE_LEN
from aiq_agent.common.citation_verification import UNVERIFIED_QUOTE_MARKER
from aiq_agent.common.claim_judge import Judgement
from aiq_agent.common.claim_judge import Kind
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
#: What the judge found, or ``unavailable`` when it could not run.
Judged = Literal["supported", "contradicted", "not_addressed", "unavailable"]

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
#: change); 2 held the answer to its weakest load-bearing sentence (ADR-0125);
#: rule 3 judges each sentence against its evidence (ADR-0139). The wire keeps
#: saying 2 for rule 3: an open tab's bundle reads the field as ``1 | 2`` and
#: would refuse a 3, so the stamps' ``support`` is what tells rule 3 apart
#: (docs/design/chat-wire-v2.md, „Compatibility").
CONFIDENCE_RULE_VERSION = 2

#: The classes whose evidence is a passage: the only ones that ground a verdict.
_PASSAGE_CLASSES = frozenset({"quoted", "cited", "reasoning"})

#: Longest sentence text a stamp carries. The stamp names the sentence; the
#: answer text holds it whole.
_MAX_STAMP_TEXT = 300
#: Longest evidence text a stamp carries to the judge.
_MAX_EVIDENCE = 2000

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
    #: The text each cited ``[N]`` may name, by number: the passage it resolved
    #: to, and for an answer with no source list every passage of the turn
    #: printed under that number (``citation_verification.unlisted_candidates``).
    #: What the judge reads the sentence against.
    passages: Mapping[int, str] = field(default_factory=dict)


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
    """One sentence of the answer, where it comes from, and what its evidence says about it."""

    text: str
    provenance: ProvenanceClass
    claim_type: ClaimType
    #: The ``[N]`` the sentence carries.
    numbers: tuple[int, ...] = ()
    #: For ``record`` and ``action``: the operation the matching record came from.
    operation: str | None = None
    #: For ``record``: numbers the sentence states that no record holds.
    unmatched: tuple[str, ...] = ()
    #: Whether this sentence decides the answer's level: every verdict and fact
    #: the judge found; every sentence while it has not judged.
    load_bearing: bool = True
    #: ``observed`` only: it cites a region crop and repeats the reading exactly.
    exact: bool = False
    #: A level the sentence's look place caps it at, beside a passage pointer.
    cap: Level | None = None
    #: It carried a pointer that did not hold (:data:`DROPPED_CITATION_MARKER`,
    #: or a number nothing resolves): it counts half at most.
    dropped: bool = False
    #: The rows of one table or list under a lead-in, with that lead-in, share
    #: a group: one claim (:func:`claim_supports`), not one per row.
    group: int | None = None
    #: The sentence that introduces its group („Die Grenzwerte lauten [1]:").
    lead_in: bool = False
    #: The text the sentence is held to; empty when nothing stands behind it.
    evidence: str = field(default="", repr=False, compare=False)
    #: What the judge found (:func:`with_judgements`); None before it ran.
    judged: Judged | None = None
    #: The judge's reading of the sentence; None before it ran.
    kind: Kind | None = None

    @property
    def is_verdict(self) -> bool:
        return self.kind == "verdict"

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
        wire["support"] = support(self)
        wire["verdict"] = self.is_verdict
        if self.judged is not None:
            wire["judged"] = self.judged
        if self.dropped:
            wire["dropped"] = True
        if self.group is not None:
            wire["group"] = self.group
        return wire


@dataclass(frozen=True)
class _Unit:
    """A sentence as found: its text, its paragraph, and whether it is a quote line."""

    text: str
    paragraph: int
    quote_line: bool = False
    quote_wording: str | None = None
    #: The lead-in block this row or list item stands under, if any.
    group: int | None = None
    lead_in: bool = False


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

    A table or a list that a sentence ending in „:" introduces belongs to that
    sentence's paragraph, across the blank line before it: „Die Richtlinie
    gliedert sich wie folgt [1]:" and the rows under it are one statement, and a
    row read off the passage the lead-in cites is an Einschätzung drawn from it
    (``reasoning``), not knowledge from nowhere. The lead-in ends at the first
    blank line after its block: a later list or table is a paragraph of its own.
    """
    wordings = iter(quote_lines(prose))
    paragraph = 0
    fence: str | None = None
    table_header_pending = True
    gap = False
    lead_in = False
    in_lead_block = False
    group = 0
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
            gap = True
            table_header_pending = True
            if in_lead_block:
                lead_in = in_lead_block = False
            continue
        if _DIRECTIVE_RE.match(line) or _HEADING_RE.match(line):
            lead_in = False
            continue
        if _TABLE_RULE_RE.match(line):
            continue
        is_row = line.lstrip().startswith("|")
        is_block = is_row or _LIST_PREFIX_RE.match(line) is not None
        if gap and not (lead_in and is_block):
            paragraph += 1
        gap = False
        if is_block:
            if lead_in and not in_lead_block:
                group += 1
            in_lead_block = lead_in
        else:
            lead_in = line.rstrip().rstrip("*_").endswith(":")
            in_lead_block = False
        if is_row:
            if table_header_pending:
                table_header_pending = False
                continue
            yield _Unit(_table_cells(line), paragraph, group=group if in_lead_block else None)
            continue
        if _QUOTE_LINE_RE.match(line):
            wording = _next_wording(wordings, line)
            if wording is not None:
                yield _Unit(_clean(line.lstrip(" >")), paragraph, quote_line=True, quote_wording=wording)
                continue
            line = line.lstrip(" >")
        for sentence in _split_sentences(_clean(line)):
            yield _Unit(sentence, paragraph, group=group if is_block and in_lead_block else None)


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


def _record_match(
    sentence: str, records: Sequence[WorkspaceRecord]
) -> tuple[WorkspaceRecord, str, tuple[str, ...]] | None:  # noqa: E501
    """The record a sentence was read from, the item it matched, and numbers no record holds; None when none.

    A sentence matches ONE item of a record (a listing line, a profile row, an
    inventory line) on two of its words (four letters or more, not a function
    word), or on a word and a number standing in that same item. A number alone
    matches nothing: „3 Stiegenhäuser" against a profile that holds a 3
    somewhere is no reading of it. The item with most matches wins.
    """
    folded = _MARKER_RE.sub("", sentence).casefold()
    words = {word for word in _WORD_RE.findall(folded) if word not in _STOPWORDS}
    numbers = _NUMBER_RE.findall(folded) + [
        str(_NUMBER_WORDS[word]) for word in re.findall(r"[^\W\d_]+", folded) if word in _NUMBER_WORDS
    ]
    best: tuple[int, WorkspaceRecord, str] | None = None
    for record in records:
        for item in record.items or (record.haystack,):
            item_words = sum(1 for word in words if _whole_word_in(word, item))
            if not item_words:
                continue
            hits = item_words + 2 * sum(1 for number in numbers if _whole_word_in(number, item))
            hits += 2 * sum(1 for number in numbers if number.isdigit() and int(number) in record.counts)
            if hits >= _MIN_RECORD_HITS and (best is None or hits > best[0]):
                best = (hits, record, item)
    if best is None:
        return None
    unmatched = tuple(number for number in numbers if not any(_number_in(number, rec) for rec in records))
    return best[1], best[2], unmatched


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
    """The class a sentence's own pointer gives it (a quote, a marker that resolved), or None when it has none."""
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
    return None


def _pointer_dropped(unit: _Unit, evidence: ClaimEvidence) -> bool:
    """Whether the sentence carried a pointer that did not hold: the label, or a number nothing resolves."""
    if DROPPED_CITATION_MARKER in unit.text:
        return True
    numbers = _numbers(unit.text)
    return bool(numbers) and not any(n in evidence.cited_numbers or _is_place(n, evidence) for n in numbers)


def _classify(unit: _Unit, evidence: ClaimEvidence) -> tuple[ProvenanceClass, str | None, tuple[str, ...], str]:
    """One sentence's class, the operation behind a record or action, a record's unmatched numbers, the item matched.

    A pointer that did not hold is taken off first (:func:`_pointer_dropped`
    flags it): the sentence is then classed by what else stands behind it.
    """
    if DROPPED_CITATION_MARKER in unit.text:
        unit = replace(unit, text=unit.text.replace(DROPPED_CITATION_MARKER, " ").strip())
    pointed = _class_with_pointer(unit, evidence)
    if pointed is not None:
        return pointed, None, (), ""
    proposals = [record for record in evidence.records if record.outcome == "proposed"]
    if proposals and _ACTION_RE.search(unit.text):
        return "action", proposals[0].operation, (), proposals[0].haystack
    reads = [record for record in evidence.records if record.outcome == "read"]
    match = _record_match(unit.text, reads) if reads else None
    if match is not None:
        record, item, unmatched = match
        return "record", record.operation, unmatched, item
    if _measured(unit.text, evidence.measured_values):
        return "measured", None, (), ""
    if _observed(unit.text, evidence.readings):
        return "observed", None, (), ""
    return "model_knowledge", None, (), ""


def _evidence_for(
    unit: _Unit, provenance: ProvenanceClass, item: str, evidence: ClaimEvidence, paragraph_numbers: Sequence[int]
) -> str:
    """The text a sentence is held to: what its class points at, deterministic, bounded."""
    if provenance in ("quoted", "cited"):
        numbers = _numbers(unit.text)
        texts = [evidence.passages.get(n, "") for n in numbers] + [
            evidence.looks[n].read for n in numbers if n in evidence.looks
        ]
    elif provenance == "reasoning":
        texts = [evidence.passages.get(n, "") for n in dict.fromkeys(paragraph_numbers)]
    elif provenance in ("record", "action"):
        texts = [item]
    elif provenance == "measured":
        texts = list(evidence.measured_values)
    elif provenance == "observed":
        texts = [*evidence.readings, *(evidence.looks[n].read for n in _numbers(unit.text) if n in evidence.looks)]
    else:
        texts = []
    return "\n\n".join(text for text in texts if text and text.strip())[:_MAX_EVIDENCE]


def classify_claims(
    prose: str,
    evidence: ClaimEvidence,
    *,
    normative: Callable[[str], bool],
) -> list[ClaimStamp]:
    """One stamp per sentence of ``prose`` (the answer without its reference list), in document order, unjudged."""
    classified = [(unit, *_classify(unit, evidence)) for unit in _with_lead_ins(list(_units(prose)))]
    cited_in: dict[int, list[int]] = {}
    for unit, provenance, *_ in classified:
        if provenance in ("quoted", "cited"):
            cited_in.setdefault(unit.paragraph, []).extend(_numbers(unit.text))
    stamps = []
    for unit, provenance, operation, unmatched, item in classified:
        exact, _ = _place_level(unit, evidence, merged=provenance == "observed")
        _, level = _place_level(unit, evidence)
        # A place beside a passage pointer: the sentence is held to the weaker of the two.
        cap = level if provenance in ("quoted", "cited") else None
        if provenance in ("quoted", "cited") and cap is None and _observed(unit.text, evidence.readings):
            cap = "medium"
        if provenance == "model_knowledge" and unit.paragraph in cited_in:
            provenance = "reasoning"
        stamps.append(
            ClaimStamp(
                text=unit.text,
                provenance=provenance,
                claim_type=claim_type(unit.text, normative),
                numbers=_numbers(unit.text),
                operation=operation,
                unmatched=unmatched,
                exact=exact and provenance == "observed",
                cap=cap,
                dropped=_pointer_dropped(unit, evidence),
                group=unit.group,
                lead_in=unit.lead_in,
                evidence=_evidence_for(unit, provenance, item, evidence, cited_in.get(unit.paragraph, ())),
            )
        )
    return stamps


def _with_lead_ins(units: list[_Unit]) -> list[_Unit]:
    """The units, the lead-in sentence of each grouped block joined to its group: one statement."""
    joined = list(units)
    for index, unit in enumerate(units):
        if unit.group is None or index == 0 or units[index - 1].group == unit.group:
            continue
        before = units[index - 1]
        if before.group is None and before.text.rstrip().rstrip("*_").endswith(":"):
            joined[index - 1] = replace(before, group=unit.group, lead_in=True)
    return joined


# ---------------------------------------------------------------------------
# The judgement and the level
# ---------------------------------------------------------------------------


def judge_items(stamps: Sequence[ClaimStamp]) -> list[tuple[str, str]]:
    """What the judge is asked, one ``(sentence, evidence)`` per stamp, in order (``claim_judge.JudgeFn``)."""
    return [(stamp.text, stamp.evidence) for stamp in stamps]


def with_judgements(stamps: Sequence[ClaimStamp], judgements: Sequence[Judgement | None] | None) -> list[ClaimStamp]:
    """The stamps with what the judge found; ``None`` (it could not run) marks every evidenced one ``unavailable``.

    A verdict and a fact bear load; an assessment or a next step does not. A
    stamp the judge did not answer keeps bearing load, ``unavailable``.
    """
    judged = []
    for index, stamp in enumerate(stamps):
        found = judgements[index] if judgements is not None and index < len(judgements) else None
        if found is None:
            judged.append(replace(stamp, judged="unavailable" if stamp.evidence else None, load_bearing=True))
            continue
        judged.append(
            replace(
                stamp,
                judged=found.support,
                kind=found.kind,
                load_bearing=found.kind in ("verdict", "fact"),
            )
        )
    return judged


#: The ceiling of an answer with no sentence to stamp (a card marker, a code
#: block, a heading alone). Nothing in it can carry evidence, and rule 1 floors
#: an answer without a verified citation at ``low``; so does this.
NO_CLAIMS_CEILING: Level = "low"

_JUDGED_SUPPORT: dict[str, float] = {"supported": 1.0, "contradicted": 0.0, "not_addressed": 0.0}


def support(stamp: ClaimStamp) -> float:
    """What one sentence contributes to the count of backed claims: 1, 0.5 or 0.

    Nothing behind it, or a verdict on the law with no passage behind it,
    counts nothing whatever the judge says. Otherwise the judge's finding:
    supported 1, contradicted or not addressed 0, unjudged half. A reading off a
    drawing that is not an exact region crop, a passage beside such a place, a
    pointer that did not hold, and a record sentence stating a number no record
    holds count half at most.
    """
    if stamp.provenance == "cited_dropped" or not stamp.evidence:
        return 0.0
    if stamp.is_verdict and stamp.provenance not in _PASSAGE_CLASSES:
        return 0.0
    value = _JUDGED_SUPPORT.get(stamp.judged or "", 0.5)
    capped = stamp.provenance == "observed" and not stamp.exact
    if capped or stamp.cap == "medium" or stamp.dropped or stamp.unmatched:
        value = min(value, 0.5)
    return value


def _bearing(stamps: Sequence[ClaimStamp]) -> list[ClaimStamp]:
    return [stamp for stamp in stamps if stamp.load_bearing]


def claim_supports(stamps: Sequence[ClaimStamp]) -> list[float]:
    """The support of each claim the answer makes, in order: a load-bearing sentence, or a group as one.

    A table or a list under a lead-in is one statement (:attr:`ClaimStamp.group`)
    with the mean of its rows' supports; the lead-in is not a row, so a cited
    lead-in lifts no invented row.
    """
    supports: list[float] = []
    groups: dict[int, list[ClaimStamp]] = {}
    slot: dict[int, int] = {}
    for stamp in _bearing(stamps):
        if stamp.group is None:
            supports.append(support(stamp))
            continue
        if stamp.group not in groups:
            groups[stamp.group] = []
            slot[stamp.group] = len(supports)
            supports.append(0.0)
        groups[stamp.group].append(stamp)
    for group, members in groups.items():
        rows = [stamp for stamp in members if not stamp.lead_in] or members
        supports[slot[group]] = sum(support(stamp) for stamp in rows) / len(rows)
    return supports


def evidence_share(stamps: Sequence[ClaimStamp]) -> float | None:
    """The mean support of the answer's claims, 0 to 1, None with no claim: ``claims-evidence-share``."""
    supports = claim_supports(stamps)
    return sum(supports) / len(supports) if supports else None


def claims_ceiling(stamps: Sequence[ClaimStamp]) -> Level:
    """The level the answer's evidence allows (rule 3, ADR-0139); :data:`NO_CLAIMS_CEILING` with no claim.

    - ``low`` when a verdict on the law is contradicted by its evidence, or no
      claim has any support.
    - ``high`` when every claim is supported.
    - ``medium`` otherwise: some support, or support the judge could not check
      (``unavailable`` counts half, so an unchecked answer with evidence is
      medium, one with none still low).
    """
    bearing = _bearing(stamps)
    if not bearing:
        return NO_CLAIMS_CEILING
    if any(stamp.is_verdict and stamp.judged == "contradicted" for stamp in bearing):
        return "low"
    supports = claim_supports(bearing)
    if all(value == 1.0 for value in supports):
        return "high"
    return "medium" if any(supports) else "low"


def weakest_claim(stamps: Sequence[ClaimStamp]) -> ClaimStamp | None:
    """The load-bearing sentence that most explains a capped level: a contradicted or unbacked verdict first."""
    bearing = _bearing(stamps)
    verdicts = [stamp for stamp in bearing if stamp.is_verdict and support(stamp) == 0.0]
    if verdicts:
        return verdicts[0]
    return min(bearing, key=support) if bearing else None


def class_counts(stamps: Sequence[ClaimStamp]) -> dict[str, int]:
    """How many sentences of each class, in :data:`PROVENANCE_CLASSES` order, zeros left out."""
    counts = Counter(stamp.provenance for stamp in stamps)
    return {name: counts[name] for name in PROVENANCE_CLASSES if counts[name]}


def normative_uncited(stamps: Sequence[ClaimStamp]) -> int:
    """Load-bearing verdicts on the law that nothing backs: the claims a reader should check first."""
    return sum(1 for stamp in _bearing(stamps) if stamp.is_verdict and support(stamp) == 0.0)
