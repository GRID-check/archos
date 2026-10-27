"""Whether a retrieved text passage is OCR debris rather than text a reader can use.

A scanned drawing in a PDF's text layer comes out as debris: labels rotated
ninety degrees read one glyph group per line, mirrored (``06`` / ``IE`` / ``/`` /
``06`` / ``IER`` / ``dnaW`` is "Wand REI 60 / EI 60" written vertically), and a
label set in spaced capitals reads one letter per token
(``2 i n n A sg n e z s . a W m H t G s . 4 / 0 0 B E m 2 · : c < C > : U``).
The chunker keeps it, because it is content type ``text`` and carries a real
page and citation, and the ranked search then spends a hit on it.

The judgement is pure and line based. Each line is one of:

``fragment``
    at most :data:`MAX_FRAGMENT_GLYPHS` glyphs: a rotated label's piece (``06``,
    ``dnaW``), a dimension tick (``1 1``), a stray mark (``~``).
``symbolic``
    less than :data:`MIN_ALNUM_SHARE` of its glyphs letters, digits or value
    marks (``≤``, ``%``, ``²``):
    ``:::,``, ``l=:=========::t--~-=-- +22,00``.
``shredded``
    at least :data:`MIN_SHREDDED_TOKENS` tokens, and at least
    :data:`MIN_SINGLE_GLYPH_SHARE` of them a single glyph that is not a digit:
    the spaced-capitals label above.
``text``
    everything else, a table row included.

A passage is debris when :data:`MIN_DEBRIS_SHARE` of its glyphs sit on debris
lines, or when its text is garbled in the sense page triage already measures
(``page_triage.text_quality``: glyph ids, mojibake, a missing vowel structure).
Glyph-weighted on purpose: the drawings in the OIB Erläuterungen sit between
paragraphs, and a chunk with forty lines of ``06``/``IE`` and one paragraph
about Brandabschnitte in Wohnnutzung holds that paragraph. A line count would
drop it; a glyph count keeps it.

Only ``text`` passages are judged. A drawing, chart, image or table passage is
the vision model's prose or a structured table, never a raw text layer.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .llamaindex.page_triage import MIN_JUDGEABLE_CHARS
from .llamaindex.page_triage import text_quality

#: Thresholds, measured 2026-10 on passages captured from a live knowledge_search
#: ("Brandabschnitt Gebäudeklasse 5 Wohngebäude", OIB-RL 2 and its Erläuterungen)
#: in ``tests/fixtures/ocr_noise``. Debris shares: a span of rotated wall labels
#: 1.00, the spaced-capitals Gebäudeklassen labels 0.66. Text: OIB prose and
#: lists at most 0.01, tables as text at most 0.04. Between them, the chunks the
#: debris sits in: 0.08 and 0.16 where a paragraph answers the question, 0.40 for
#: three sentences on Balkonplatten ahead of a page of drawing debris. All three
#: are kept, on purpose: half the glyphs is where a passage stops being text.
MIN_DEBRIS_SHARE = 0.5
MAX_FRAGMENT_GLYPHS = 4
MIN_ALNUM_SHARE = 0.5
MIN_SHREDDED_TOKENS = 4
#: A table row of values (``R 30 R 30 R 30 R 60``) sits at 0.5: one letter per value.
MIN_SINGLE_GLYPH_SHARE = 0.6
#: Below this many glyphs a passage is a heading or a table cell, too short to judge:
#: the same floor page triage judges a page's text by.
MIN_JUDGEABLE_GLYPHS = MIN_JUDGEABLE_CHARS
#: Marks a value is written with in a table row (``≤ 400``, ``30 %``, ``m²``): they
#: count with the letters and digits, so a row of limits is not a row of symbols.
_VALUE_MARKS = frozenset("≤≥±×÷%°²³‰")

_JUDGED_CONTENT_TYPES = frozenset({"text"})


@dataclass(frozen=True)
class NoiseVerdict:
    """How much of one passage is debris, and whether that makes it debris."""

    glyphs: int
    debris_glyphs: int
    garbled: bool = False

    @property
    def debris_share(self) -> float:
        return self.debris_glyphs / self.glyphs if self.glyphs else 0.0

    @property
    def is_noise(self) -> bool:
        if self.glyphs < MIN_JUDGEABLE_GLYPHS:
            return False
        return self.garbled or self.debris_share >= MIN_DEBRIS_SHARE


def _is_debris_line(tokens: list[str], glyphs: int) -> bool:
    """A line of a drawing's text layer: a fragment, mostly symbols, or one glyph per token."""
    if glyphs <= MAX_FRAGMENT_GLYPHS:
        return True
    alnum = sum(ch.isalnum() or ch in _VALUE_MARKS for token in tokens for ch in token)
    if alnum / glyphs < MIN_ALNUM_SHARE:
        return True
    if len(tokens) < MIN_SHREDDED_TOKENS:
        return False
    single = sum(1 for token in tokens if len(token) == 1 and not token.isdigit())
    return single / len(tokens) >= MIN_SINGLE_GLYPH_SHARE


def judge_text(text: str | None) -> NoiseVerdict:
    """Measure one passage's text. Pure; empty text is clean."""
    glyphs = 0
    debris = 0
    for line in (text or "").splitlines():
        tokens = line.split()
        line_glyphs = sum(len(token) for token in tokens)
        glyphs += line_glyphs
        if line_glyphs and _is_debris_line(tokens, line_glyphs):
            debris += line_glyphs
    return NoiseVerdict(glyphs=glyphs, debris_glyphs=debris, garbled=text_quality(text).garbled)


def _content_type(chunk) -> str:
    value = getattr(chunk, "content_type", None)
    return str(getattr(value, "value", value) or "")


def is_noise_chunk(chunk) -> bool:
    """Whether a retrieved chunk is OCR debris. Only text chunks are judged."""
    if _content_type(chunk) not in _JUDGED_CONTENT_TYPES:
        return False
    return judge_text(getattr(chunk, "content", None)).is_noise


def without_noise(chunks) -> tuple[list, int]:
    """``chunks`` minus the debris, in order, and how many were left out."""
    kept = [chunk for chunk in chunks if not is_noise_chunk(chunk)]
    return kept, len(chunks) - len(kept)


def noise_notice(dropped: int) -> str:
    """The line the model reads when the ranked search left debris out, or ``""``."""
    if dropped <= 0:
        return ""
    return (
        f"Left out {dropped} passage(s) whose text is OCR debris from a drawing's text layer; "
        "a literal search still returns every passage.\n\n"
    )


# @environment_variable GRID_DROP_OCR_NOISE
# @category Knowledge Layer
# @type bool
# @default false
# @required false
# Leave OCR debris passages out of knowledge_search's ranked pool before the
# reranker and the per-document cap. Off until the answer suite has measured it.
DROP_OCR_NOISE_ENV = "GRID_DROP_OCR_NOISE"

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def noise_filter_enabled(configured: bool | None) -> bool:
    """The config's choice when it makes one, else ``GRID_DROP_OCR_NOISE``; off by default."""
    if configured is not None:
        return configured
    return os.environ.get(DROP_OCR_NOISE_ENV, "").strip().lower() in _TRUE_VALUES
