"""Whether a quoted span is in a passage: normalisation, coverage and closeness."""

from __future__ import annotations

import difflib
import logging
import re
import unicodedata
from dataclasses import dataclass
from dataclasses import field

from agent.citations.entries import SourceEntry
from agent.common.quote_polarity import polarity_agrees

logger = logging.getLogger(__name__)


# Fuzzy-match threshold: a quoted span counts as "verified" when at least this
# fraction of it is found (as ordered matching subsequences) in some source's
# chunk text. 0.90 tolerates minor OCR/whitespace/hyphenation noise while still
# rejecting a wholesale fabrication. TUNABLE — see module note; wants calibration
# against real transcripts (cannot be tuned live here).
QUOTE_MATCH_THRESHOLD = 0.90


# Minimum length (characters, on the normalized quote) a span must reach before
# it is verified. Short spans ("§ 3", "OIB", a bare term) are too common and too
# generic to fuzzy-match reliably and are skipped. TUNABLE — see module note.
MIN_QUOTE_LEN = 20


# Minimum padding (characters) added around a candidate match window so a genuine
# verbatim quote whose length drifted under OCR (inserted/removed chars) still
# fits inside the window. Kept small on purpose: a large pad would re-admit the
# scattered-splice fragments the locality window is meant to exclude. The window
# length is ``len(quote) + max(_QUOTE_WINDOW_PAD_MIN, len(quote) // 10)``.
_QUOTE_WINDOW_PAD_MIN = 4


# Absolute budget (characters) for the CHUNK text a verified quote may skip over,
# accumulated across the matched region. This is the non-contiguity penalty that
# separates a lightly-noisy verbatim quote from a splice of two real clauses:
#
# - OCR/whitespace/hyphenation/„…"-mark noise perturbs the alignment by only a
#   char or two at a time (a substitution advances the quote and the chunk by the
#   same amount, so its NET elided chunk text is ~0), keeping the cumulative total
#   well under budget → the quote stays verified.
# - A splice that merges two adjacent clauses (dropping a connective and the
#   material between them, e.g. "…Kosten [der Massnahme. Der] Nachbar…") leaves a
#   run of chunk text with no counterpart in the quote; its NET elided total
#   (≳10 chars even when coincidental re-matches fragment it into pieces) exceeds
#   the budget, splitting the matched region so no single contiguous-enough run
#   reaches the threshold → the quote is flagged.
#
# An ABSOLUTE constant (not ``len(quote)//k``) is essential: the defeat in the
# prior metric was that every tolerance scaled with the quote, so a longer quote
# bought a proportionally larger elision. 6 is chosen empirically — noisy
# verbatim fixtures net ≤4 elided chars, clause splices net ≥7. TUNABLE.
_QUOTE_MAX_ELIDED_GAP = 6


# The elision budget above is a LENGTH budget, calibrated on OCR noise, and
# length is the wrong axis for what a quote can lose: dropping one short word
# from „Bauteile müssen nicht brennbar sein" turns a prohibition into a
# permission while staying inside a budget sized for a hyphen or a swapped
# letter (quote-verification-calibration-2026-07.md, T2-CIT1: elisions of ≤6
# characters were caught 0% of the time). Tuning the budget down accuses
# correct answers; the calibration doc says so and is right.
#
# So the matcher also asks WHAT it is skipping, structurally: OCR noise is
# sub-word (a hyphenation remnant, a swapped character, an inflection ending),
# whereas a skipped or inserted run that contains a whole word is a different
# sentence, whichever word it is. No vocabulary is consulted — which word
# changes the meaning is the model's judgement to make when it writes, and the
# verifier's job is only to refuse to call an edited sentence verbatim.
# Three letters is the floor at which a run is a word and not an ending.
_WHOLE_WORD_RE = re.compile(r"(?<![^\W\d_])[^\W\d_]{3,}(?![^\W\d_])")


def _skips_a_word(text: str) -> bool:
    """True when ``text`` (a skipped or inserted run, already casefolded) holds a whole word.

    The run's own edges count as word boundaries: a gap of exactly ``"nicht "``
    is the whole word, and the character before it belongs to a matched block
    that is by construction the same in quote and passage.
    """
    return bool(text) and _WHOLE_WORD_RE.search(text) is not None


# Quoted-span matcher: German „…“ (also lenient „…”), guillemets »…«, curly
# “…”, and plain ASCII "…". Each alternative captures the inner text in its own
# group; the first non-None group of a match is the quote. German „…“ is tried
# before the curly “…” form so the shared U+201C is read as a German closing
# mark when it opened with „. Inner text may not contain the relevant quote
# characters, so quotes do not run across sentence boundaries.
QUOTED_SPAN_RE = re.compile(
    r"„([^„“”\"]+)[“”\"]"  # German low-9 opening; closing „…“/„…”/„…" (models mix them)
    r"|»([^»«]+)«"  # guillemets
    r"|“([^“”]+)”"  # curly double
    r"|\"([^\"]+)\""  # ASCII straight
)


# Quote marks stripped from the edges of a normalized span before matching.
_QUOTE_EDGE_CHARS = "„“”»«\"'‚‘’ "


@dataclass
class UnverifiedQuote:
    """A quoted span in the answer body that no source chunk text supports."""

    # Inner quoted text, exactly as it appeared in the answer (no quote marks).
    quote: str
    # The full matched span INCLUDING its quote marks. The quote repair
    # (``quote_patch.accept``) checks its correction against it.
    span: str
    # Character offsets of the span within the scanned answer text, so the
    # annotation can be inserted immediately after the closing quote mark.
    start: int
    end: int
    # Best coverage achieved against any source chunk text (0.0–1.0). Below
    # ``QUOTE_MATCH_THRESHOLD`` by construction; retained for diagnostics.
    best_coverage: float
    # WHY the span was flagged: ``"not_verbatim"`` (the fuzzy match failed),
    # ``"too_long"`` (over ``_QUOTE_MAX_WORDS`` — a passage pasted as a quote),
    # ``"uncited"`` (no ``[N]`` in its sentence). Combined with ``"+"`` when
    # several fire. The annotation is the same either way; the reason tells the
    # repair which failure it is looking at.
    reason: str = "not_verbatim"
    # The closest passage (by `closeness`) among the sources the quote's sentence CITES (None
    # when it cites none the registry holds): for a quote the model
    # misremembered, the passage it was quoting. What the quote patch corrects
    # the wording against, with no second search. Not the whole-registry best
    # (that is ``best_coverage``): a near-identical text from an uncited source
    # must never supply a cited quote's wording. Looked for only on a quote
    # the patch could correct (``not_verbatim``), and only when the caller
    # asked (``with_nearest``): each candidate page costs a closeness pass.
    nearest: SourceEntry | None = field(default=None, compare=False, repr=False)
    # ``closeness(quote, nearest.chunk_text)``, the score ``nearest`` was chosen
    # by, kept so the patch gates on it without a second pass. 0.0 with no
    # ``nearest``.
    nearest_closeness: float = field(default=0.0, compare=False)


def normalize_for_quote_match(text: str) -> str:
    """Normalize a quote or chunk body for fuzzy comparison.

    Applies (in order): Unicode NFKC; join hyphenated line-wraps (``Bau-\\nordnung``
    → ``Bauordnung``); strip leading blockquote ``> `` markers; collapse all
    whitespace to single spaces; strip surrounding quote marks; ``casefold()``.
    Both the quoted span and each source chunk text pass through this so the
    comparison ignores formatting, OCR line-wrapping and casing differences.
    """
    text = unicodedata.normalize("NFKC", text)
    # Join hyphenated line-wraps before whitespace is collapsed.
    text = re.sub(r"-\n", "", text)
    # Strip leading Markdown blockquote markers.
    text = re.sub(r"(?m)^[ \t]*>[ \t]?", "", text)
    # Collapse whitespace.
    text = re.sub(r"\s+", " ", text).strip()
    # Strip surrounding quote marks.
    text = text.strip(_QUOTE_EDGE_CHARS)
    return text.casefold()


def normalized_coverage(norm_quote: str, norm_chunk: str) -> float:
    """Fraction of ``norm_quote`` covered by a CONTIGUOUS-enough run of the chunk.

    Two earlier metrics were both defeatable:

    - A whole-chunk subsequence match (sum of every matching block, anywhere in
      the chunk) scored a phrase-splice — real fragments pulled from DIFFERENT
      clauses — at 1.0 even though the quote is not a substring.
    - Restricting the sum to a single window sized to the quote length still let
      an ADJACENT-clause splice through: when the quote merges two neighbouring
      sentences (dropping a short connective), the whole spliced span is about as
      long as the quote, so it fits one window and the summed blocks stay above
      threshold — even though the quote skipped over real chunk text in between.

    The fix penalizes NON-CONTIGUITY directly. Within each candidate window we
    walk the matching blocks in order and accumulate the NET chunk text the quote
    skips between consecutive blocks (``chunk_gap - quote_gap``, floored at 0 so a
    same-length substitution — the shape of OCR/casing noise — costs ~nothing).
    Once that cumulative elision exceeds an ABSOLUTE budget
    (``_QUOTE_MAX_ELIDED_GAP``) the region is cut and a fresh run begins; the
    score is the longest single run divided by ``len(quote)``.

    - A genuine verbatim quote is one uninterrupted run → ~1.0. Light
      OCR/whitespace/hyphenation/„…"-mark noise perturbs the alignment by only a
      char or two at a time and nets far under budget, so it too scores ~1.0.
    - A splice — adjacent OR scattered, short gap OR long — leaves an elided run
      of chunk text with no quote counterpart; the budget is exceeded, the region
      is split, and no surviving run reaches the threshold → low score.

    The budget is a fixed constant rather than a fraction of the quote, so a
    longer quote can no longer buy a proportionally larger silent elision.
    Candidate windows are anchored at the diagonals of the matching blocks
    (window start = ``block.b - block.a``), so only a handful are scored per
    quote×chunk. Pure stdlib (``difflib``), fail-open, and cheap.
    """
    quote_len = len(norm_quote)
    if quote_len == 0:
        return 0.0
    pad = max(_QUOTE_WINDOW_PAD_MIN, quote_len // 10)
    window_len = quote_len + pad
    base = difflib.SequenceMatcher(None, norm_quote, norm_chunk, autojunk=False)
    # Anchor one window per matching-block diagonal; dedup collapses blocks that
    # share an alignment offset. Empty when nothing matches at all → coverage 0.
    window_starts = {max(0, block.b - block.a) for block in base.get_matching_blocks() if block.size}
    if not window_starts:
        return 0.0
    best = 0.0
    for start in window_starts:
        window = norm_chunk[max(0, start - pad) : start + window_len]
        matcher = difflib.SequenceMatcher(None, norm_quote, window, autojunk=False)
        # Longest run of matching blocks whose cumulative net elided chunk text
        # stays within budget. A block gap that skips real chunk text the quote
        # never covers pushes the running elision up; crossing the budget cuts the
        # run so a spliced-together quote cannot bank credit across the elision.
        run = 0
        best_run = 0
        elided = 0
        prev_a_end: int | None = None
        prev_b_end: int | None = None
        run_start = (0, 0)
        best_span = (0, 0, 0, 0)
        for block in matcher.get_matching_blocks():
            if not block.size:
                continue
            if prev_b_end is not None:
                chunk_gap = block.b - prev_b_end
                quote_gap = block.a - prev_a_end
                elided += max(0, chunk_gap - quote_gap)
                # A gap that skips or inserts a whole word cuts the run whatever
                # its length: „muss nicht brennbar" quoted as „muss brennbar" is
                # a different sentence, not a noisy one.
                edited = _skips_a_word(window[prev_b_end : block.b]) or _skips_a_word(norm_quote[prev_a_end : block.a])
                if elided > _QUOTE_MAX_ELIDED_GAP or edited:
                    run = 0
                    elided = 0
            if run == 0:
                run_start = (block.a, block.b)
            run += block.size
            if run > best_run:
                best_run = run
                best_span = (*run_start, block.a + block.size, block.b + block.size)
            prev_a_end = block.a + block.size
            prev_b_end = block.b + block.size
        score = best_run / quote_len
        # An edit inside a word that flips or narrows the sentence („keine" →
        # „eine", „unzulässig" → „zulässig") is below the word-skip floor above.
        # The aligned stretches must carry the same negations (``quote_polarity``).
        if score >= QUOTE_MATCH_THRESHOLD and not _aligned_polarity_agrees(norm_quote, window, best_span):
            score = 0.0
        best = max(best, score)
    return best


def _aligned_polarity_agrees(norm_quote: str, window: str, span: tuple[int, int, int, int]) -> bool:
    """Whether the whole quote and the passage stretch it aligns to negate the same things.

    ``span`` is ``(quote start, window start, quote end, window end)`` of the
    best run. The passage side is the run widened by whatever of the quote the
    run left unmatched at either end, then to whole words, so a run that stops
    inside „keine" compares the whole word.
    """
    a_start, b_start, a_end, b_end = span
    start = max(0, b_start - a_start)
    end = min(len(window), b_end + (len(norm_quote) - a_end))
    return polarity_agrees(norm_quote, _whole_words(window, start, end))


def _whole_words(text: str, start: int, end: int) -> str:
    """``text[start:end]`` widened left and right to the nearest word boundary."""
    while start > 0 and text[start - 1].isalpha():
        start -= 1
    while end < len(text) and text[end].isalpha():
        end += 1
    return text[start:end]


def quote_coverage(quote: str, passage: str) -> float:
    """How much of ``quote`` one contiguous run of ``passage`` holds (0-1): the verifier's own test.

    :func:`normalized_coverage` on raw text. A quote at or above
    ``QUOTE_MATCH_THRESHOLD`` is one the prose may keep between quote marks,
    and the same bar is what stamps a quote line „Wortlaut belegt"
    (``common/quote_stamps.py``).
    """
    return normalized_coverage(normalize_for_quote_match(quote), normalize_for_quote_match(passage))


def closeness(quote: str, passage: str) -> float:
    """How closely ``quote`` matches the most similar stretch of ``passage`` (0-1).

    Not the verifier's coverage, which scores the longest CONTIGUOUS run and
    so drops a quote with two words changed to ~0.4, the same as an invented
    one. This compares the quote with each quote-sized window of the passage
    and keeps the best ratio, so scattered small edits cost little and a
    different sentence costs a lot. What the quote patch gates on
    (``quote_patch.PATCH_FLOOR``), and what picks the passage it patches from.
    """
    return normalized_closeness(normalize_for_quote_match(quote), normalize_for_quote_match(passage))


def normalized_closeness(norm_quote: str, norm_passage: str) -> float:
    """:func:`closeness` on text already through :func:`normalize_for_quote_match`."""
    length = len(norm_quote)
    if not length or not norm_passage:
        return 0.0
    step, width, best = max(1, length // 8), length + length // 5, 0.0
    for start in range(0, max(1, len(norm_passage) - length + step), step):
        matcher = difflib.SequenceMatcher(None, norm_quote, norm_passage[start : start + width])
        if matcher.real_quick_ratio() > best and matcher.quick_ratio() > best:
            best = max(best, matcher.ratio())
    return best
