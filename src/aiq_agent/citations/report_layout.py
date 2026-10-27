"""Normalising the answer's citation syntax and Quellen layout, and renumbering citations to match."""

from __future__ import annotations

import logging
import re

from aiq_agent.citations.binding import source_origin_token
from aiq_agent.citations.entries import DROPPED_CITATION_MARKER
from aiq_agent.citations.entries import LOCUS_MISMATCH_REASON
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.references import CITATION_LINE_RE
from aiq_agent.citations.references import COLLAPSED_SOURCE_BOUNDARY_RE
from aiq_agent.citations.references import FOOTNOTE_INLINE_CITATION_RE
from aiq_agent.citations.references import FOOTNOTE_REFERENCE_LINE_RE
from aiq_agent.citations.references import GERMAN_REFERENCE_HEADING_LABEL_RE
from aiq_agent.citations.references import INLINE_CITATION_RE
from aiq_agent.citations.references import KL_CITATION_PATTERN_RE
from aiq_agent.citations.references import ORDERED_REFERENCE_LINE_RE
from aiq_agent.citations.references import REFERENCE_HEADING_LINE_RE
from aiq_agent.citations.references import SOURCE_LOCATION_CITATION_RE
from aiq_agent.citations.references import URL_IN_LINE_RE
from aiq_agent.citations.registry import SourceRegistry

logger = logging.getLogger(__name__)


# A leading origin token on the post-``[N]`` text of a source line, e.g. the
# ``[KB]`` in ``- [1] [KB] file.pdf, p.3``. Kept in sync with
# ``source_origin_token`` and the frontend ``SOURCE_KIND_TOKEN_RE`` parser.
# Used to (a) make token injection idempotent and (b) strip a pre-existing
# token before registry identity-matching so it never pollutes the fuzzy
# filename comparison in ``is_knowledge_citation`` / ``has_citation_key``.
ORIGIN_TOKEN_RE = re.compile(r"^(\[(?:KB|RIS|Web)\])\s*", re.IGNORECASE)


def inject_origin_token(line: str, token: str) -> str:
    """Insert ``token`` immediately after the ``[N]`` marker of a source line.

    The token must sit AFTER the number (``- [1] [KB] file.pdf``) so it does
    not break ``CITATION_LINE_RE`` parsing or the ``[N]`` renumbering in
    ``sanitize_report``. Idempotent: a line already carrying a recognized
    origin token is returned unchanged.
    """
    line_match = CITATION_LINE_RE.match(line)
    if line_match is None:
        return line
    ref_text = line_match.group(2)
    if ORIGIN_TOKEN_RE.match(ref_text):
        return line
    prefix = line[: line_match.start(2)]
    return f"{prefix}{token} {ref_text}"


def format_registry_reference(num: int, entry: SourceEntry) -> str | None:
    """Render a registered source as a source-section line."""
    title = entry.title or entry.tool_name or entry.source_type or "Source"
    token = source_origin_token(entry)
    prefix = f"{token} " if token else ""
    if entry.url:
        return f"[{num}] {prefix}{title}: {entry.url}"
    if entry.citation_key:
        return f"[{num}] {prefix}{entry.citation_key}"
    return None


def normalize_citation_syntax(report_text: str) -> str:
    """Normalize citation bracket variants before verification/sanitization."""
    report_text = report_text.replace("【", "[").replace("】", "]")
    report_text = SOURCE_LOCATION_CITATION_RE.sub(r"[\1]", report_text)
    report_text = FOOTNOTE_REFERENCE_LINE_RE.sub(r"[\1] ", report_text)
    return FOOTNOTE_INLINE_CITATION_RE.sub(r"[\1]", report_text)


def _normalize_ordered_reference_lines(ref_section: str) -> str:
    """Convert ordered-list source lines to canonical [N] form."""
    return ORDERED_REFERENCE_LINE_RE.sub(r"\1[\2] \3", ref_section)


def _reference_segment_has_target(segment: str) -> bool:
    """Return true when a source segment already contains a verifiable target."""
    line_match = CITATION_LINE_RE.match(segment)
    if line_match is None:
        return False

    ref_text = line_match.group(2).strip()
    if URL_IN_LINE_RE.search(ref_text):
        return True

    cleaned = re.sub(r"\*+", "", ref_text).strip()
    return bool(KL_CITATION_PATTERN_RE.match(cleaned))


def _split_collapsed_source_line(line: str) -> str:
    """Split only truly collapsed source entries on one line.

    Avoid splitting bracketed numbers that are part of a title, such as
    ``[1] Semiconductor outlook [2024] update: https://...``.
    """
    first_line_match = CITATION_LINE_RE.match(line)
    if first_line_match is None:
        return line

    current_num = int(first_line_match.group(1))
    segment_start = 0
    segments: list[str] = []
    for boundary_match in COLLAPSED_SOURCE_BOUNDARY_RE.finditer(line):
        next_num = int(boundary_match.group(1))
        current_segment = line[segment_start : boundary_match.start()]
        if next_num <= current_num or next_num >= 1000 or not _reference_segment_has_target(current_segment):
            continue

        segments.append(current_segment.rstrip())
        segment_start = boundary_match.end()
        current_num = next_num

    if not segments:
        return line

    segments.append(line[segment_start:].lstrip())
    return "\n".join(segments)


def normalize_source_section_layout(ref_section: str) -> str:
    """Normalize source-section presentation before parsing or final cleanup.

    This is report hygiene, not source-identity verification. ``verify_citations``
    calls it only so common writer variants are parseable; ``sanitize_report``
    owns the final display normalization.
    """
    ref_section = _normalize_ordered_reference_lines(ref_section)
    lines = ref_section.split("\n")
    if lines and REFERENCE_HEADING_LINE_RE.match(lines[0]):
        # Keep German reports German: a "Quellen"-style heading is normalized
        # to "## Quellen" instead of being anglicized to "## Sources". This
        # German-or-else binary mirrors the writer's contract, which allows the
        # label exactly two forms: "**Quellen:**" for a German answer and
        # "**References:**" for an answer in any other language, never a label
        # translated into a third language (see piloti_static.md, CITATIONS
        # in <answer_envelope>). A translated label would land on "## Sources".
        lines[0] = "## Quellen" if GERMAN_REFERENCE_HEADING_LABEL_RE.search(lines[0]) else "## Sources"
        ref_section = "\n".join(lines)
    return "\n".join(_split_collapsed_source_line(line) for line in ref_section.split("\n"))


def inline_citation_numbers(text: str) -> set[int]:
    """Return numeric inline citation labels present in text."""
    return {int(match.group(1)) for match in INLINE_CITATION_RE.finditer(text)}


def _strip_inline_citations_not_in(text: str, valid_numbers: set[int]) -> str:
    """Remove inline citations whose labels are not in valid_numbers."""
    return INLINE_CITATION_RE.sub(
        lambda match: match.group(0) if int(match.group(1)) in valid_numbers else "",
        text,
    )


def label_inline_citations_not_in(text: str, valid_numbers: set[int]) -> str:
    """Put :data:`DROPPED_CITATION_MARKER` where each inline citation outside ``valid_numbers`` stood.

    Adjacent dropped markers (``[3][4]``, ``[3], [4]``) become one label: the
    reader is told once that this claim's pointer did not hold.
    """
    labelled = INLINE_CITATION_RE.sub(
        lambda match: match.group(0) if int(match.group(1)) in valid_numbers else DROPPED_CITATION_MARKER,
        text,
    )
    repeated = re.escape(DROPPED_CITATION_MARKER)
    return re.sub(rf"{repeated}(?:\s*,?\s*{repeated})+", DROPPED_CITATION_MARKER, labelled)


def drop_inline_citations_not_in(text: str, valid_numbers: set[int], *, label: bool) -> str:
    """Remove (``label=False``) or label (``label=True``) every inline citation outside ``valid_numbers``."""
    if label:
        return label_inline_citations_not_in(text, valid_numbers)
    return _strip_inline_citations_not_in(text, valid_numbers)


def label_locus_mismatches(
    body: str, valid_citations: list[dict], registry: SourceRegistry
) -> tuple[str, list[dict], set[int]]:
    """Label each marker whose § / Punkt the resolved passage does not hold (``common/citation_locus``).

    Returns the body, one removal record per labelled occurrence, and the
    numbers that have no occurrence left: those lose their source line too.
    """
    from aiq_agent.common.citation_locus import locus_mismatches

    entries = {
        citation["number"]: entry
        for citation in valid_citations
        if (
            entry := (
                registry.entry_for_citation_key(citation["citation_key"])
                if citation.get("citation_key")
                else registry.entry_for_url(citation["url"])
                if citation.get("url")
                else None
            )
        )
        is not None
    }
    mismatches = locus_mismatches(body, entries)
    if not mismatches:
        return body, [], set()
    removed = [
        {"number": miss.number, "reason": LOCUS_MISMATCH_REASON, "locus": str(miss.locus), "line": ""}
        for miss in mismatches
    ]
    for miss in sorted(mismatches, key=lambda item: item.start, reverse=True):
        body = body[: miss.start] + DROPPED_CITATION_MARKER + body[miss.end :]
    left = {int(number) for number in INLINE_CITATION_RE.findall(body)}
    gone = {miss.number for miss in mismatches if miss.number not in left}
    return body, removed, gone


def renumber_citations(body: str, ref_section: str) -> tuple[str, str, dict[int, int]]:
    """Renumber [N] citations sequentially, closing any gaps.

    Scans the source section for citation numbers, builds a mapping
    from old to new sequential numbers, and applies it to both body and
    source lines via collision-safe placeholders.

    Returns:
        (body, ref_section, renumber_map) where renumber_map maps every
        old citation number to its new sequential number.
    """
    remaining = sorted(int(m.group(1)) for m in CITATION_LINE_RE.finditer(ref_section))
    renumber_map: dict[int, int] = {old: new for new, old in enumerate(remaining, 1)}

    # Nothing to do if already sequential
    if all(old == new for old, new in renumber_map.items()):
        return body, ref_section, renumber_map

    # Apply renumbering via placeholders (descending order avoids [1] matching inside [10])
    for old_num in sorted(renumber_map, reverse=True):
        new_num = renumber_map[old_num]
        if old_num != new_num:
            placeholder = f"__CITE_{new_num}__"
            body = body.replace(f"[{old_num}]", placeholder)
            ref_section = ref_section.replace(f"[{old_num}]", placeholder)

    for new_num in sorted(renumber_map.values()):
        placeholder = f"__CITE_{new_num}__"
        body = body.replace(placeholder, f"[{new_num}]")
        ref_section = ref_section.replace(placeholder, f"[{new_num}]")

    return body, ref_section, renumber_map
