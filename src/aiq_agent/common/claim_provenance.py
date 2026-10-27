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
reading ground a verdict on the law (:func:`states_verdict`): those are
evidence about the office and the building, not about the law. A normative
sentence that concludes nothing („Gebäudeklasse · GK 5 (bestätigt)" off the
confirmed profile) is held like a value; a next step bears no load at all
(:func:`is_next_step`). That is the anti-laundering rule of
``agents/piloti/grounding.py``, now enforced per sentence rather than by
flooring the whole answer.

The answer's level is read off how many of its claims evidence carries
(rule 3, ADR-0139), not off the weakest one: a claim is a load-bearing
sentence, or a table under a lead-in as one (:func:`claim_supports`); ``high``
only when every claim is backed whole, ``low`` when most have nothing behind
them or an uncited verdict has no legal passage beside it, ``medium``
otherwise (:func:`claims_ceiling`). The normative
detector is a deliberately wide net, built as a brake on uncited answers; run
per sentence it catches a next step („muss im Einzelnen geöffnet werden") or a
fact about the corpus as readily as a verdict, and a minimum over twenty such
labels is decided by the noisiest one. An uncited claim about the law, hedged
or not, still counts nothing and keeps the answer below ``high``
(:func:`unsupported_claims`).

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
from dataclasses import replace
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
#: change); 2 held the answer to its weakest load-bearing sentence (ADR-0125);
#: rule 3 reads the count of backed sentences over the same stamps (ADR-0139).
#: The wire keeps saying 2 for rule 3: an open tab's bundle reads the field as
#: ``1 | 2`` and would refuse a 3, so the stamps' ``support`` is what tells
#: rule 3 apart (docs/design/chat-wire-v2.md, „Compatibility"). The reader
#: renders a stored turn under the rule it was computed with.
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
    #: The text of the passage each cited ``[N]`` resolved to, by number. A row
    #: or sentence drawn from a cited lead-in (``reasoning``) that states a
    #: number counts half only when the passage holds it (:func:`_drawn_from`).
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
    #: ``reasoning`` only: what it states is in the passage its paragraph cites
    #: (its numbers and most of its key words), or it states no number.
    drawn: bool = False
    #: It concludes something about the law (:func:`states_verdict`) and is no
    #: next step: only a passage grounds it. None derives it from the text, as
    #: for a stamp stored before it existed.
    verdict: bool | None = None
    #: A next step or an offer („muss im Einzelnen geöffnet werden", „Eine
    #: kurze Nachricht genügt"): never load-bearing. None derives it.
    next_step: bool | None = None
    #: It carried a pointer that did not hold (:data:`DROPPED_CITATION_MARKER`,
    #: or a number nothing resolves). Its class is what the sentence has
    #: without it: the chip names it, it zeroes nothing a record or a
    #: measurement stands behind.
    dropped: bool = False
    #: The rows of one table or list under a lead-in, with that lead-in, share
    #: a group: one claim (:func:`claim_supports`), not one per row.
    group: int | None = None

    @property
    def is_next_step(self) -> bool:
        return self.next_step if self.next_step is not None else is_next_step(self.text)

    @property
    def is_verdict(self) -> bool:
        if self.verdict is not None:
            return self.verdict
        return self.claim_type == "normative" and not self.is_next_step and states_verdict(self.text)

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


def _classify(unit: _Unit, evidence: ClaimEvidence) -> tuple[ProvenanceClass, str | None, tuple[str, ...]]:
    """One sentence's class, the operation behind a record or action, and a record's unmatched numbers.

    A pointer that did not hold is taken off first (:func:`_pointer_dropped`
    flags it): the sentence is then classed by what else stands behind it, so a
    file name read off this turn's listing stays a record whatever number the
    model put beside it.
    """
    if DROPPED_CITATION_MARKER in unit.text:
        unit = replace(unit, text=unit.text.replace(DROPPED_CITATION_MARKER, " ").strip())
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
#: fact: it caps at ``medium``. It is no source either: a hedged sentence about
#: the law with no passage counts nothing, like any other (ADR-0139). Narrow on
#: purpose, German and English.
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
    units = _with_lead_ins(list(_units(prose)))
    for unit in units:
        provenance, operation, unmatched = _classify(unit, evidence)
        ctype = (
            _action_claim_type(unit.text, evidence, operation, normative)
            if provenance == "action"
            else claim_type(unit.text, normative)
        )
        classified.append((unit, ctype, provenance, operation, unmatched))
    supported = {unit.paragraph for unit, _, provenance, _, _ in classified if provenance in _PASSAGE_CLASSES}
    cited_in: dict[int, list[int]] = {}
    for unit, _, provenance, _, _ in classified:
        if provenance in _PASSAGE_CLASSES:
            cited_in.setdefault(unit.paragraph, []).extend(_numbers(unit.text))
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
                dropped=_pointer_dropped(unit, evidence),
                group=unit.group,
                drawn=(
                    provenance == "model_knowledge"
                    and unit.paragraph in supported
                    and _drawn_from(unit.text, cited_in.get(unit.paragraph, ()), evidence)
                ),
            )
        )
    return mark_load_bearing(_supported_values(stamps))


def _with_lead_ins(units: list[_Unit]) -> list[_Unit]:
    """The units, the lead-in sentence of each grouped block joined to its group: one statement."""
    joined = list(units)
    for index, unit in enumerate(units):
        if unit.group is None or index == 0 or units[index - 1].group == unit.group:
            continue
        before = units[index - 1]
        if before.group is None and before.text.rstrip().rstrip("*_").endswith(":"):
            joined[index - 1] = replace(before, group=unit.group)
    return joined


#: Of a drawn sentence's key words, the share the passage must hold. Half, so a
#: German inflection („Fluchtwege" beside „Fluchtweglänge") does not undo a row
#: read off the passage, and an invented row of new terms does not pass.
_DRAWN_WORD_SHARE = 0.5


def _drawn_from(sentence: str, numbers: Sequence[int], evidence: ClaimEvidence) -> bool:
    """Whether a sentence with no pointer of its own states what the passage its paragraph cites holds.

    A sentence stating no number is drawn from it, as before: it restates or
    orders what the cited sentence says. One stating a number is drawn only
    when the passage text (:attr:`ClaimEvidence.passages`) holds every number
    it states and at least :data:`_DRAWN_WORD_SHARE` of its key words. A table
    of limits under „Die Grenzwerte lauten [1]:" that the passage does not
    hold is invented, however confidently it was introduced.
    """
    stated = _value_tokens(sentence)
    if not stated:
        return True
    passage = " ".join(evidence.passages.get(number, "") for number in numbers)
    if not passage.strip() or not stated <= _value_tokens(passage):
        return False
    words = {word.casefold() for word in _WORD_RE.findall(_MARKER_RE.sub("", sentence))} - _STOPWORDS
    if not words:
        return True
    held = passage.casefold()
    return sum(1 for word in words if word in held) >= _DRAWN_WORD_SHARE * len(words)


def mark_load_bearing(stamps: list[ClaimStamp]) -> list[ClaimStamp]:
    """Mark the sentences the answer's level rests on: every normative or value one; all, when there is none.

    A next step or an offer (:attr:`ClaimStamp.is_next_step`) never bears load:
    it asserts nothing the answer could be wrong about, and the wide normative
    net catching „muss im Einzelnen geöffnet werden" must not make a listing
    read „Rechtsaussage ohne Beleg".
    """
    marked = [stamp.claim_type != "descriptive" and not stamp.is_next_step for stamp in stamps]
    if not any(marked):
        marked = [not stamp.is_next_step for stamp in stamps]
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
    verdict: bool | None = None,
) -> Level:
    """The highest level one sentence allows.

    ``verdict`` says whether a normative sentence concludes something about
    the law (:func:`states_verdict`); None reads every normative sentence as
    one, the stricter reading. Only a verdict needs a passage: a normative
    sentence that concludes nothing („Gebäudeklasse · GK 5 (bestätigt)" off
    the confirmed project profile, „Die Höhen widersprechen sich") is held like
    a value, to the evidence it restates (ADR-0139).

    - ``high`` for a quoted or cited sentence of any type, and for a record,
      an action or a measurement that is not normative.
    - ``medium`` for a sentence read off a drawing (``observed``): a model's
      perception, whatever its type, and ``low`` when it is normative; ``high``
      only when it cites a region crop and repeats its reading exactly
      (``exact``). A ``hedged`` sentence (it reports an absence of evidence or
      marks itself an estimate) that is not normative is ``medium`` whatever
      its class, as is a
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
    law = ctype == "normative" and verdict is not False
    if hedged and not law:
        # Honest absence or an estimate: not a claim of fact, so never below
        # medium. About the law it is still a claim, and a hedge is no source.
        return "medium"
    if provenance == "observed":
        if law:
            return "low"
        return "high" if exact else "medium"
    if provenance == "reasoning" and ctype == "value" and value_supported:
        return "medium"
    if provenance in _FACT_CLASSES:
        if law:
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
        verdict=stamp.is_verdict,
    )
    return min(level, stamp.cap, key=_LEVELS.index) if stamp.cap else level


#: What one load-bearing sentence contributes to :func:`evidence_share`, by the
#: ceiling it allows: evidence of its own counts whole, an Einschätzung or an
#: honest hedge half, nothing behind it nothing.
_SUPPORT: dict[Level, float] = {"low": 0.0, "medium": 0.5, "high": 1.0}

#: The share of load-bearing sentences with NOTHING behind them (support 0)
#: above which an answer reads „low": a strict majority. A grounded answer with
#: one next step the normative net caught (one of two) is not floored by it.
UNBACKED_SHARE = 0.5

#: A legal conclusion: the sentence says a requirement is met, needed, allowed
#: or missed. Narrow on purpose: a next step („muss im Einzelnen geöffnet
#: werden") or a fact about the corpus („39 Dateien des OIB-Korpus") is caught
#: by the wide normative net but concludes nothing, and must not floor an
#: answer the way an uncited verdict does (:func:`claims_ceiling`).
_VERDICT_RE = re.compile(
    r"\b(?:erfüll|erfuell|eingehalten|einhält|einhaelt|unterschritten|überschritten|ueberschritten"
    r"|zulässig|zulaessig|unzulässig|unzulaessig|bewilligungsfähig|bewilligungsfaehig"
    r"|genehmigungsfähig|genehmigungsfaehig|bewilligungspflichtig|genehmigungspflichtig"
    r"|erforderlich|vorgeschrieben|entspricht|entsprechen|widerspricht|verstößt|verstoesst|ausreichend"
    r"|überschreit|ueberschreit|unterschreit|einzuhalten|bewilligt|genehmigt|einschlägig|einschlaegig"
    r"|anwendbar|greift|gilt\s+nicht|genügt|genuegt|ausreicht|reicht\s+(?:nicht|aus)|nötig|noetig|notwendig|vorzulegen|nachzuweisen"
    r"|zu\s+(?:schmal|gering|hoch|niedrig|klein|kurz|lang|breit|eng|steil|flach|weit|nah)\b"
    r"|complies|compliant|permitted|permissible|required|meets|satisf|applies|exceed|too\s+(?:narrow|low|high|small|short|steep))",
    re.IGNORECASE,
)
#: A requirement's modal („muss", „darf", „ist … zu", „vorzulegen"). Alone it
#: is a next step as often as a rule; beside a value or a named instrument it
#: states the rule.
_MODAL_RE = re.compile(
    r"\b(?:muss|müssen|muessen|darf|dürfen|duerfen|soll|sollen|gilt|gelten|must|shall|may\s+not)\b"
    r"|\b(?:ist|sind)\s+(?:\w+\s+){0,3}zu\s+\w+en\b"
    r"|\b\w+zu\w+en\b",
    re.IGNORECASE,
)
#: An instrument of the law named in the sentence: a paragraph, an OIB guideline, a code or a standard.
_INSTRUMENT_RE = re.compile(
    r"§|\bOIB\b|\bOIB-|richtlinie|bauordnung|bautechnikverordnung|\bÖNORM|\bOENORM|\bEN\s?\d|\bDIN\b|\bBO\b",
    re.IGNORECASE,
)
#: What a next step, a question left open or an offer reads like: it asserts
#: nothing the answer could be wrong about. „Ob GK 5 hier richtig ist, muss …
#: geprüft werden", „Als Nächstes wäre … auszuwerten", „muss im Einzelnen
#: geöffnet werden", „Eine kurze Nachricht genügt".
_NEXT_STEP_VERBS = (
    r"(?:prüf|klär|öffn|oeffn|abstimm|bestätig|bestaetig|auswert|les|kontrollier|verifizier|nachfrag|anfrag"
    r"|ermittel|entscheid|feststell|aufschlag|ergänz|ergaenz|nachreich|abklär|abklaer)"
)
_NEXT_STEP_RE = re.compile(
    r"^\s*(?:ob|welche[rsnm]?|wie|wann|wo|wer)\b[^.?!]*,\s*(?:muss|müssen|muessen|sollte|sollten|ist|sind|wäre|waere|bleibt)\b"
    r"|\bals\s+nächste[srnm]?\b|\bals\s+naechste[srnm]?\b|\bnächste[rn]?\s+schritt|\bnaechste[rn]?\s+schritt"
    r"|\b(?:muss|müssen|muessen|sollte|sollten|wäre|waere)\b[^.?!]*\b(?:ge)?"
    + _NEXT_STEP_VERBS
    + r"\w*\s*(?:werden|lassen)?\s*[.?!]?\s*$"
    r"|\b(?:ist|sind|wäre|waere)\b[^.?!]*\bzu\s+" + _NEXT_STEP_VERBS + r"\w*\b"
    r"|\b\w*zu" + _NEXT_STEP_VERBS + r"\w*en\b"
    r"|^\s*(?:ich\s+kann|wenn\s+sie\b|gerne\b|sagen\s+sie|eine\s+kurze\s+(?:nachricht|rückmeldung|rueckmeldung)"
    r"|i\s+can\b|if\s+you\b|let\s+me\s+know)"
    # The answer's account of its own reading: „Nicht gelesen habe ich …",
    # „… habe ich nicht geprüft", „… nenne ich erst nach dem Aufschlagen",
    # „Dafür brauche ich eine gezielte Abfrage". Scope, not a claim.
    r"|^\s*nicht\s+(?:\w+\s+)?(?:gelesen|geprüft|geprueft|geöffnet|geoeffnet|ausgezählt|ausgezaehlt)\s+habe\s+ich\b"
    r"|\b(?:habe|hab)\s+ich\b[^.?!]*\bnicht\b[^.?!]*\b(?:gelesen|geprüft|geprueft|geöffnet|geoeffnet|ausgezählt"
    r"|ausgezaehlt|ausgewertet|nachgeprüft|nachgeprueft)\b"
    r"|\b(?:nenne|liefere|prüfe|pruefe)\s+ich\s+erst\b|\b(?:brauche|bräuchte|braeuchte|benötige|benoetige)\s+ich\b"
    r"|\b(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:checked|verified|confirmed|clarified|opened|reviewed)\b"
    r"|\bnext\s+step\b|^\s*whether\b",
    re.IGNORECASE,
)


def is_next_step(sentence: str) -> bool:
    """Whether a sentence is a next step, a question left open or an offer (:data:`_NEXT_STEP_RE`)."""
    return _NEXT_STEP_RE.search(_MARKER_RE.sub("", sentence)) is not None


def states_verdict(sentence: str) -> bool:
    """Whether a sentence concludes something about the law: met, needed, allowed, or a requirement it states.

    A verdict word (:data:`_VERDICT_RE`: „erfüllt", „nötig", „zu schmal",
    „vorzulegen"), or a requirement's modal beside a value or a named
    instrument („muss mindestens 1,20 m breit sein", „muss nach § 5 bewilligt
    werden"). Never a next step (:func:`is_next_step`): „Ob ein zweiter
    Fluchtweg erforderlich ist, muss geprüft werden" leaves the question open.
    A modal alone („muss im Einzelnen geöffnet werden") is how a next step
    reads, and an instrument alone („die 39 Dateien des OIB-Korpus") is a fact
    about the corpus.
    """
    text = _MARKER_RE.sub("", sentence)
    if is_next_step(text):
        return False
    if _VERDICT_RE.search(text):
        return True
    return _MODAL_RE.search(text) is not None and (bool(_value_tokens(text)) or _INSTRUMENT_RE.search(text) is not None)


def support(stamp: ClaimStamp) -> float:
    """What one sentence contributes to the count of backed claims and the evidence share: 1, 0.5 or 0.

    Its own ceiling (:func:`stamp_ceiling`), with one difference: a
    ``reasoning`` sentence (no pointer, but its paragraph has a quoted or cited
    sentence) that is :attr:`~ClaimStamp.drawn` from that passage counts half,
    like a table row under a cited lead-in whose values the passage holds. One
    whose numbers the passage does not hold counts nothing. A normative
    sentence without a passage counts nothing, reasoning, hedged or not: a cited
    sentence beside it does not make it a claim the law backs.
    """
    level = stamp_ceiling(stamp)
    if stamp.provenance == "reasoning" and not stamp.is_verdict:
        if _value_tokens(stamp.text) and not (stamp.drawn or stamp.value_supported):
            return 0.0
        if level == "low":
            level = "medium"
    return _SUPPORT[level]


def _bearing(stamps: Sequence[ClaimStamp]) -> list[ClaimStamp]:
    return [stamp for stamp in stamps if stamp.load_bearing]


def claim_supports(stamps: Sequence[ClaimStamp]) -> list[float]:
    """The support of each claim the answer makes, in order: a load-bearing sentence, or a group as one.

    A table or a list under a lead-in is one statement (:attr:`ClaimStamp.group`):
    its rows and lead-in count once, with the mean of their supports. Nine
    rows of a table of contents must not outvote five cited sentences, nor be
    outvoted by them.
    """
    supports: list[float] = []
    groups: dict[int, list[float]] = {}
    slot: dict[int, int] = {}
    for stamp in _bearing(stamps):
        value = support(stamp)
        if stamp.group is None:
            supports.append(value)
            continue
        if stamp.group not in groups:
            groups[stamp.group] = []
            slot[stamp.group] = len(supports)
            supports.append(0.0)
        groups[stamp.group].append(value)
    for group, values in groups.items():
        supports[slot[group]] = sum(values) / len(values)
    return supports


def evidence_share(stamps: Sequence[ClaimStamp]) -> float | None:
    """The mean support of the answer's claims (:func:`claim_supports`): 0 to 1, None with no claim.

    Scored in Langfuse as ``claims-evidence-share``. The level does not
    threshold it (:func:`claims_ceiling` counts); it is the trend a calibration
    reads.
    """
    supports = claim_supports(stamps)
    if not supports:
        return None
    return sum(supports) / len(supports)


def _uncited_law(stamp: ClaimStamp) -> bool:
    return stamp.is_verdict and stamp.provenance not in _PASSAGE_CLASSES


def unsupported_claims(stamps: Sequence[ClaimStamp]) -> list[ClaimStamp]:
    """The load-bearing sentences the chip names: an uncited verdict on the law, and a pointer that did not hold.

    A verdict (:attr:`ClaimStamp.is_verdict`) without a quoted or cited
    passage, hedged or not: a hedge is no source. A next step is never one, nor
    a normative sentence that concludes nothing.
    """
    return [
        stamp
        for stamp in _bearing(stamps)
        if stamp.provenance == "cited_dropped" or stamp.dropped or _uncited_law(stamp)
    ]


def claims_ceiling(stamps: Sequence[ClaimStamp]) -> Level:
    """The level the answer's evidence allows (rule 3, ADR-0139); :data:`NO_CLAIMS_CEILING` with no claim.

    Counted over claims (:func:`claim_supports`: a load-bearing sentence, or a
    table under a lead-in as one):

    - ``high`` when every claim has support 1: „14 von 14 Aussagen belegt" is
      high, and nothing less is.
    - ``low`` when more than :data:`UNBACKED_SHARE` of them have nothing behind
      them, or when the answer concludes something about the law
      (:attr:`ClaimStamp.is_verdict`) and none of its normative sentences has a
      passage: a measurement or a record beside an uncited verdict does not
      lift it.
    - ``medium`` otherwise.

    Before (rule 2) this was the weakest load-bearing sentence's ceiling: one
    sentence the wide normative net caught floored an answer whose every other
    sentence was read off a record or a passage. Next steps bear no load at all
    (:func:`mark_load_bearing`).
    """
    bearing = _bearing(stamps)
    supports = claim_supports(bearing)
    if not supports:
        return NO_CLAIMS_CEILING
    if sum(1 for value in supports if value == 0.0) > UNBACKED_SHARE * len(supports):
        return "low"
    read_the_law = any(stamp.claim_type == "normative" and stamp.provenance in _PASSAGE_CLASSES for stamp in bearing)
    if any(_uncited_law(stamp) for stamp in bearing) and not read_the_law:
        return "low"
    if all(value == 1.0 for value in supports):
        return "high"
    return "medium"


def weakest_claim(stamps: Sequence[ClaimStamp]) -> ClaimStamp | None:
    """The load-bearing sentence that most explains a capped level: an uncited legal claim first, else the weakest.

    Read for the capped reason only: a normative sentence names
    ``normative_claim_uncited``, anything else ``ungrounded``.
    """
    unsupported = [stamp for stamp in _bearing(stamps) if _uncited_law(stamp)]
    if unsupported:
        return unsupported[0]
    bearing = _bearing(stamps)
    if not bearing:
        return None
    return min(bearing, key=support)


def class_counts(stamps: Sequence[ClaimStamp]) -> dict[str, int]:
    """How many sentences of each class, in :data:`PROVENANCE_CLASSES` order, zeros left out."""
    counts = Counter(stamp.provenance for stamp in stamps)
    return {name: counts[name] for name in PROVENANCE_CLASSES if counts[name]}


def normative_uncited(stamps: Sequence[ClaimStamp]) -> int:
    """Normative sentences with no passage behind them: the claims a reader should check first."""
    return sum(1 for stamp in stamps if _uncited_law(stamp))
