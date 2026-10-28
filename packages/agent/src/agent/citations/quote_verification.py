"""Quote verification over an answer.

Each quoted span is checked against the sources it cites, and marked when unverified.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from collections.abc import Sequence
from dataclasses import dataclass

from agent.citations.entries import UNVERIFIED_QUOTE_MARKER
from agent.citations.entries import SourceEntry
from agent.citations.entries import normalize_url
from agent.citations.markdown_code import code_spans
from agent.citations.markdown_code import inside
from agent.citations.quote_matching import MIN_QUOTE_LEN
from agent.citations.quote_matching import QUOTE_MATCH_THRESHOLD
from agent.citations.quote_matching import QUOTED_SPAN_RE
from agent.citations.quote_matching import UnverifiedQuote
from agent.citations.quote_matching import normalize_for_quote_match
from agent.citations.quote_matching import normalized_closeness
from agent.citations.quote_matching import normalized_coverage
from agent.citations.references import CITATION_LINE_RE
from agent.citations.references import INLINE_CITATION_RE
from agent.citations.references import REFERENCE_SECTION_RE
from agent.citations.references import document_identity
from agent.citations.registry import SourceRegistry
from agent.citations.report_layout import ORIGIN_TOKEN_RE
from agent.citations.report_layout import normalize_citation_syntax
from agent.citations.verification import resolve_source_line

logger = logging.getLogger(__name__)


#: A quote longer than this is a pasted passage, not a quotation — flagged
#: whatever the fuzzy match says. Forty words is roughly three German legal
#: sentences; anything a reader should check belongs in the cited channel
#: (the passage snippet on the wire), not between quote marks in the prose.
QUOTE_MAX_WORDS = 40


#: What ends the sentence a quote sits in, for the citation-proximity check. A
#: period between digits is a decimal point (``2.50 m``), not an end — the same
#: guard ``piloti.grounding`` uses. Single newlines count: a list item is its
#: own sentence for attribution purposes. Deliberately NOT abbreviation-aware
#: (``vgl.``, ``z. B.`` split the window): the one-sentence lookahead below
#: absorbs exactly that shape, and a closed abbreviation list would be a second
#: thing to keep in sync with the language the models actually write.
_QUOTE_SENTENCE_END_RE = re.compile(r"(?<!\d)\.(?!\d)|[!?…]|\n")


def _quote_sentence_windows(body: str, start: int, end: int) -> tuple[tuple[int, int], tuple[int, int] | None]:
    """The sentence holding ``[start, end)`` and the one right after it.

    Returns ``(containing, following_or_None)`` as half-open offsets. A
    boundary strictly INSIDE the span (``Pkt.`` in the quoted text) does not
    split its window: the quote is one unit, and only the text around it is
    judged. The lookahead exists for the two shapes that put the marker one
    segment late — a citation trailing its sentence (``… Satz. [1] …``) and an
    abbreviation split (``… „Quote" vgl. … [1].``). A quote two sentences from
    any marker is unattributed under either window and is flagged.
    """
    ends = list(_QUOTE_SENTENCE_END_RE.finditer(body))
    win_start = 0
    for match in ends:
        if match.end() <= start:
            win_start = match.end()
        else:
            break
    win_end = len(body)
    following: tuple[int, int] | None = None
    for match in ends:
        if match.start() >= end:
            win_end = match.start()
            after = next((later for later in ends if later.start() >= match.end()), None)
            following = (match.end(), after.start() if after is not None else len(body))
            break
    return (win_start, win_end), following


def _quote_cited_numbers(body: str, start: int, end: int) -> set[int]:
    """The ``[N]`` numbers in the quote's sentence, or in the next one when its own has none.

    Empty is what makes a quote ``uncited``; the numbers are the sources its
    nearest passage may come from.
    """
    (win_start, win_end), following = _quote_sentence_windows(body, start, end)
    numbers = {int(n) for n in INLINE_CITATION_RE.findall(body, win_start, win_end)}
    if not numbers and following is not None:
        numbers = {int(n) for n in INLINE_CITATION_RE.findall(body, following[0], following[1])}
    return numbers


@dataclass(frozen=True)
class _CitedSources:
    """What some of the answer's source lines name: registry documents, and links the registry holds.

    A document is its ``(collection, filename)``, page aside; a link is kept as
    the registry's own URL, normalised, so a cited ``?id=5&utm_source=x``
    matches the entry filed as ``?id=5``.
    """

    documents: frozenset[tuple[str | None, str]] = frozenset()
    urls: frozenset[str] = frozenset()

    def holds(self, source: SourceEntry) -> bool:
        if document_identity(source) in self.documents:
            return True
        return bool(source.url) and normalize_url(source.url or "") in self.urls


class _CitedLookup:
    """The sources a set of ``[N]`` names, read off ``answer_text``'s source lines.

    Read with the same matchers as the source section, one line at a time, so
    ``[1]`` resolves to what its line says and not to a neighbour's document.
    The section is parsed once, on the first question, and each number set is
    resolved once: only flagged quotes ask, and several share a sentence.
    """

    def __init__(self, answer_text: str, registry: SourceRegistry) -> None:
        self._answer_text = answer_text
        self._registry = registry
        self._lines: dict[int, list[str]] | None = None
        self._memo: dict[frozenset[int], _CitedSources] = {}

    def _source_lines(self) -> dict[int, list[str]]:
        if self._lines is None:
            normalized = normalize_citation_syntax(self._answer_text)
            section = REFERENCE_SECTION_RE.search(normalized)
            self._lines = {}
            if section is not None:
                for number, text in CITATION_LINE_RE.findall(normalized[section.start() :]):
                    self._lines.setdefault(int(number), []).append(text)
        return self._lines

    def __call__(self, numbers: set[int]) -> _CitedSources:
        key = frozenset(numbers)
        if key not in self._memo:
            lines = [line for number in sorted(key) for line in self._source_lines().get(number, ())]
            self._memo[key] = self._resolve(lines)
        return self._memo[key]

    def _resolve(self, lines: Sequence[str]) -> _CitedSources:
        """The sources ``lines`` resolve to, resolved as ``verify_citations`` resolved them.

        Not a filename scan of the line: ``Bauordnung.pdf`` is a substring of
        ``NÖ Bauordnung.pdf``, and a scan would count the other Bundesland's
        document as cited (ADR-0067).
        """
        documents: set[tuple[str | None, str]] = set()
        urls: set[str] = set()
        for line in lines:
            text = line.strip()
            token = ORIGIN_TOKEN_RE.match(text)
            source = resolve_source_line(text[token.end() :] if token else text, self._registry)
            if source.url:
                urls.add(normalize_url(source.url))
            elif (entry := source.entry(self._registry)) is not None:
                documents.add(document_identity(entry))
        return _CitedSources(frozenset(documents), frozenset(urls))


def _nearest_cited(
    norm_quote: str, cited: _CitedSources, normalized_chunks: Sequence[tuple[str, SourceEntry]]
) -> tuple[SourceEntry | None, float]:
    """The passage, among the sources the quote's sentence cites, its wording comes closest to.

    Ranked by :func:`closeness`, the measure the quote patch gates on, not by
    ``normalized_coverage``: coverage scores the longest contiguous run, so a quote
    with two words changed scores like an invented one, and a neighbouring
    page that shares one long phrase would outrank the page actually quoted.
    Every page of a cited document is a candidate; the closest one is it.
    Returns ``(passage, its closeness)``, ``(None, 0.0)`` when none is cited.
    """
    best, nearest = -1.0, None
    for chunk, source in normalized_chunks:
        if not cited.holds(source):
            continue
        score = normalized_closeness(norm_quote, chunk)
        if score > best:
            best, nearest = score, source
    return nearest, max(best, 0.0)


def _flag_reason(too_long: bool, uncited: bool) -> str:
    """``too_long`` / ``uncited`` joined with ``+``, or ``not_verbatim`` when neither fired."""
    return "+".join(name for name, hit in (("too_long", too_long), ("uncited", uncited)) if hit) or "not_verbatim"


def _answer_body_before_sources(answer_text: str) -> str:
    """Return the answer prose before the ``## Sources``/references section.

    Quote scanning must not touch the source section (source lines legitimately
    quote titles/URLs). Falls back to the whole text when no section is present.
    Positions in the returned prefix are valid offsets into ``answer_text``
    because it is a leading substring.
    """
    ref_match = REFERENCE_SECTION_RE.search(answer_text)
    return answer_text[: ref_match.start()] if ref_match else answer_text


def _quoted_spans(body: str, min_quote_len: int) -> Iterator[tuple[re.Match[str], str, str]]:
    """Each quotation in ``body`` long enough to check: ``(match, inner text, normalised inner)``.

    Code is not prose and carries nothing to verify (see `code_spans`). It is
    skipped by OFFSET rather than stripped out, so every match still indexes
    the text `annotate_unverified_quotes` will be handed.
    """
    code = code_spans(body)
    for match in QUOTED_SPAN_RE.finditer(body):
        if inside(match.start(), code):
            continue
        inner = next((group for group in match.groups() if group is not None), None)
        if inner is None:
            continue
        norm_quote = normalize_for_quote_match(inner)
        if len(norm_quote) >= min_quote_len:
            yield match, inner, norm_quote


def verify_quoted_spans(
    answer_text: str,
    registry: SourceRegistry,
    *,
    threshold: float = QUOTE_MATCH_THRESHOLD,
    min_quote_len: int = MIN_QUOTE_LEN,
    with_nearest: bool = True,
) -> list[UnverifiedQuote]:
    """Return the quoted spans in the answer body not supported by any chunk text.

    Whole-registry match: a span is "verified" when its normalized form is
    fuzzily present (coverage ≥ ``threshold``) in the normalized chunk text of
    ANY knowledge-layer source in the registry. Spans shorter than
    ``min_quote_len`` (normalized) are skipped. Only the answer BODY is scanned
    (never the source section). Fail-open: when no source carries chunk text
    (e.g. URL-only web sources), there is nothing to verify against and an empty
    list is returned — nothing is ever flagged on a best-effort miss.

    Mechanical gates run first, on every span the fuzzy match would see: a span
    over ``QUOTE_MAX_WORDS`` words, or with no ``[N]`` in its sentence, is
    flagged (``reason="too_long"`` / ``"uncited"``) even when it IS verbatim —
    verbatim is not attributable. Flagged means annotated downstream, never
    stripped: the sentence stays, the marker names the doubt.

    ``with_nearest`` fills ``UnverifiedQuote.nearest`` for the quote patch, on
    a ``not_verbatim`` quote only: the patch never corrects the others, and
    each page of each cited document costs a closeness pass. A caller that
    never patches (deep research) passes ``False``.
    """
    body = _answer_body_before_sources(answer_text)
    normalized_chunks = [
        (norm, source)
        for source in registry.all_sources()
        if source.chunk_text
        if (norm := normalize_for_quote_match(source.chunk_text))
    ]
    if not normalized_chunks:
        return []

    cited_lookup = _CitedLookup(answer_text, registry)
    unverified: list[UnverifiedQuote] = []
    for match, inner, norm_quote in _quoted_spans(body, min_quote_len):
        too_long = len(inner.split()) > QUOTE_MAX_WORDS
        cited_numbers = _quote_cited_numbers(body, match.start(), match.end())
        uncited = not cited_numbers
        best_coverage = max(normalized_coverage(norm_quote, chunk) for chunk, _ in normalized_chunks)
        if not (too_long or uncited or best_coverage < threshold):
            continue
        # The passage a correction may come from: the closest one of a source
        # the quote's own sentence CITES. The closest in the whole registry
        # could be another Bundesland's near-identical text, and a patch from
        # it would put that text under this citation (ADR-0067).
        nearest, score = None, 0.0
        if with_nearest and not (too_long or uncited):
            nearest, score = _nearest_cited(norm_quote, cited_lookup(cited_numbers), normalized_chunks)
        unverified.append(
            UnverifiedQuote(
                quote=inner,
                span=match.group(0),
                start=match.start(),
                end=match.end(),
                best_coverage=best_coverage,
                reason=_flag_reason(too_long, uncited),
                nearest=nearest,
                nearest_closeness=score,
            )
        )
    return unverified


def annotate_unverified_quotes(answer_text: str, unverified: Sequence[UnverifiedQuote]) -> str:
    """Insert ``UNVERIFIED_QUOTE_MARKER`` immediately after each unverified span.

    Fail-open and non-destructive: the quoted sentence is never stripped or
    altered — the marker is inserted after the closing quote mark. Offsets come
    from ``verify_quoted_spans`` on the SAME ``answer_text``; insertions run
    right-to-left so earlier offsets stay valid. Idempotent: a span already
    followed by the marker is left untouched.
    """
    if not unverified:
        return answer_text
    result = answer_text
    for uq in sorted(unverified, key=lambda item: item.end, reverse=True):
        insert_at = uq.end
        if result[insert_at:].lstrip().startswith(UNVERIFIED_QUOTE_MARKER):
            continue
        result = f"{result[:insert_at]} {UNVERIFIED_QUOTE_MARKER}{result[insert_at:]}"
    return result
