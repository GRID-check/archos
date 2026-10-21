"""Where each sentence of an answer comes from: one provenance class and one claim type per sentence.

The confidence an answer carries used to be decided for the whole answer by
floors (``agents/piloti/markers.surface_answer_confidence``): no verified
citation meant „low", whatever the answer rested on. That was right for a
question about the Bauordnung and wrong for most of what an office asks
Piloti now: „Anna hat drei offene Freigaben" rests on a server record stronger
than any passage, and still surfaced as „Antwort nicht durch Quellen belegt".
The unit that can tell the two apart is the sentence (ADR-0124, after Harvey's
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
7. ``reasoning``: no pointer, but its paragraph has a quoted or cited
   sentence it can be drawn from (an Einschätzung).
8. ``model_knowledge``: no pointer, and nothing in the answer to derive it from.

*Claim type*: ``normative`` (the normative-claim detector, run per sentence),
``value`` (a number, a class, a Frist), or ``descriptive``.

The ceiling a sentence allows (:func:`ceiling`) is ``high`` for evidence and
lower without it, and never lets a record, an action or a measurement ground a
normative claim: those three are evidence about the office and the building,
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
from collections.abc import Sequence
from dataclasses import dataclass
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
#: so it is left out before the claim type is decided. Everything else in the
#: sentence („weil OIB 4 1,00 m verlangt") is still read.
_ACTION_INFINITIVE_RE = re.compile(r"\b\w*zu\w+en\b|\bzu\s+\w+en\b|\bbestätigen\b|\bbestaetigen\b", re.IGNORECASE)

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


#: A sentence matches a record on two shared words, or on one shared number.
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

    A sentence matches a record when one of its words (four letters or more,
    not a function word) or one of its numbers stands in the record's values,
    or a number equals the length of a list it carried. The record with most
    matches wins.
    """
    folded = _MARKER_RE.sub("", sentence).casefold()
    words = {word for word in _WORD_RE.findall(folded) if word not in _STOPWORDS}
    numbers = _NUMBER_RE.findall(folded) + [
        str(_NUMBER_WORDS[word]) for word in re.findall(r"[^\W\d_]+", folded) if word in _NUMBER_WORDS
    ]
    best: tuple[int, WorkspaceRecord] | None = None
    for record in records:
        word_hits = sum(1 for word in words if _whole_word_in(word, record.haystack))
        number_hits = sum(1 for number in numbers if _number_in(number, record))
        # One shared word is a coincidence („Schnitt" in a recommendation);
        # two, or a number, is a sentence read off the record.
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
        # A quote line is judged by its stamp above, never by the inline check.
        return "quoted" if not unit.quote_line and _has_verified_inline_quote(unit.text) else "cited"
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


def _action_typed_text(text: str, evidence: ClaimEvidence, operation: str | None) -> str:
    """An action sentence without the proposed operation's infinitive and the names it was proposed with."""
    typed = _ACTION_INFINITIVE_RE.sub("", text)
    for name in _proposal_names(evidence, operation):
        typed = re.sub(re.escape(name), "", typed, flags=re.IGNORECASE)
    return typed


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
        typed_text = _action_typed_text(unit.text, evidence, operation) if provenance == "action" else unit.text
        classified.append((unit, claim_type(typed_text, normative), provenance, operation, unmatched))
    supported = {unit.paragraph for unit, _, provenance, _, _ in classified if provenance in _PASSAGE_CLASSES}
    stamps = [
        ClaimStamp(
            text=unit.text,
            provenance=("reasoning" if provenance == "model_knowledge" and unit.paragraph in supported else provenance),
            claim_type=ctype,
            numbers=_numbers(unit.text),
            operation=operation,
            unmatched=unmatched,
        )
        for unit, ctype, provenance, operation, unmatched in classified
    ]
    return mark_load_bearing(stamps)


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


def ceiling(provenance: ProvenanceClass, ctype: ClaimType, *, unmatched: bool = False) -> Level:
    """The highest level one sentence allows.

    - ``high`` for a quoted or cited sentence of any type, and for a record,
      an action or a measurement that is not normative.
    - ``medium`` for a record sentence stating a number no record holds (a
      misread until shown otherwise), for ``reasoning``, and for a descriptive
      sentence from model knowledge.
    - ``low`` for a normative sentence without a passage, a value sentence
      with no evidence of its own, and every ``cited_dropped`` sentence.
    """
    if provenance == "cited_dropped":
        return "low"
    if provenance in _PASSAGE_CLASSES:
        return "high"
    if provenance in _FACT_CLASSES:
        if ctype == "normative":
            return "low"
        return "medium" if unmatched else "high"
    if ctype != "descriptive":
        return "low"
    return "medium"


def claims_ceiling(stamps: Sequence[ClaimStamp]) -> Level | None:
    """The lowest ceiling among the load-bearing sentences; None when the answer has no sentence."""
    bearing = [stamp for stamp in stamps if stamp.load_bearing]
    if not bearing:
        return None
    return min(
        (ceiling(stamp.provenance, stamp.claim_type, unmatched=bool(stamp.unmatched)) for stamp in bearing),
        key=_LEVELS.index,
    )


def weakest_claim(stamps: Sequence[ClaimStamp]) -> ClaimStamp | None:
    """The load-bearing sentence that set :func:`claims_ceiling`, the first of its level."""
    bearing = [stamp for stamp in stamps if stamp.load_bearing]
    if not bearing:
        return None
    return min(
        bearing,
        key=lambda stamp: _LEVELS.index(ceiling(stamp.provenance, stamp.claim_type, unmatched=bool(stamp.unmatched))),
    )


def class_counts(stamps: Sequence[ClaimStamp]) -> dict[str, int]:
    """How many sentences of each class, in :data:`PROVENANCE_CLASSES` order, zeros left out."""
    counts = Counter(stamp.provenance for stamp in stamps)
    return {name: counts[name] for name in PROVENANCE_CLASSES if counts[name]}


def normative_uncited(stamps: Sequence[ClaimStamp]) -> int:
    """Normative sentences with no passage behind them: the claims a reader should check first."""
    return sum(1 for stamp in stamps if stamp.claim_type == "normative" and stamp.provenance not in _PASSAGE_CLASSES)
