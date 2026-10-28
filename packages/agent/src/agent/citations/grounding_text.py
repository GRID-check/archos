"""The legacy path: reading a grounding block back out of its text, for a replayed turn that has no records."""

from __future__ import annotations

import logging
import math
import re

from agent.citations.entries import SourceEntry
from agent.citations.registry import MAX_REGIONS_PER_SOURCE
from agent.common.grounding_block import PROJECT_STATUS_LABELS
from agent.common.grounding_block import SourceRegion
from agent.common.source_kinds import parse_shelf

logger = logging.getLogger(__name__)


# --- The LEGACY path: reading a grounding block back out of its text --------
#
# Everything from here to ``parse_knowledge_layer`` reconstructs hits from the
# rendered block. On a live turn it does not run: the producer's records are
# captured by the renderer and read by ``_entry_from_hit`` (ADR-0061). It stays
# for the callers that hold the text and never had the records: a registry
# hydrated from the shared cache, a turn replayed out of Postgres, and the job
# runner's callback, which can run outside the tool's context.
#
# It is not deprecated and it is not allowed to rot: those callers are real, and
# the pipeline contract test asserts that both paths produce the same entries.
#
# Knowledge layer is the only source that needs a specific parser because
# it uses citation keys (e.g., "report.pdf, p.15") instead of URLs.
_KL_CITATION_RE = re.compile(r"^Citation:\s*(.+)$", re.MULTILINE)


_KL_SOURCE_RE = re.compile(r"^Source:\s*(.+)$", re.MULTILINE)


_KL_COLLECTION_RE = re.compile(r"^Collection:\s*(.+)$", re.MULTILINE)


# The shelf the hit came from, stated by the producer (ADR-0047). Absent from
# output produced before the shelf travelled — absent means unknown.
_KL_SHELF_RE = re.compile(r"^Shelf:\s*(.+)$", re.MULTILINE)


# Machine-readable doc_class field emitted by the knowledge layer's
# `_format_results` (``Dokumentart: <doc_class_key>``). ``Doc-Class:`` is
# accepted as an alias for robustness.
_KL_DOC_CLASS_RE = re.compile(r"^(?:Dokumentart|Doc-Class):\s*(.+)$", re.MULTILINE)


# WHO WROTE the document, stated by ``_format_results`` as a ``Herkunft:`` line
# whose value BEGINS with the frozen ``Piloti-Dokument`` token
# (``source_kinds.AGENT_AUTHORED_LANE_LABEL``) and continues with the German
# approval clause. Only the leading token is read here: it is an identity in
# this position, the way a shelf qualifier is inside a citation key, and the
# rest of the line is rendering. The machine-readable approval fields travel
# structured, in the Trace-Lanes ``provenance`` object — never re-derived from
# this sentence.
_KL_PROVENANCE_RE = re.compile(r"^Herkunft:\s*(.+)$", re.MULTILINE)


# The Punkt the excerpt belongs to, as the chunker established it
# (``clause_chunking.py``, measured 946/946 against the corpus's contents
# pages) and ``_format_results`` states it. This is the citation form Austrian
# building law actually uses ("OIB-RL 2, Pkt. 3.5.2"); until it was parsed here
# the number reached the model as prose and died before the citation the reader
# sees. Absent for page-fallback chunks and web documents. The value is the
# rest of the line, not one token: the corpus form is ``3.5.2``, a RIS passage
# states its locus the way a lawyer reads it, ``§ 63 Abs 1``, and squeezing that
# to ``§63Abs1`` to fit a one-token rule put an unreadable locus on every chip.
#: ``Projekt: Name — abgeschlossen (project_id …)`` (``grounding_block._project_line``, ADR-0094).
_KL_PROJECT_RE = re.compile(r"^Projekt:\s*(.+?)\s+—\s+(\S+)\s+\(project_id\s+([^\s)]+)\)\s*$", re.MULTILINE)


_KL_CLAUSE_RE = re.compile(r"^Punkt:\s*(.+?)\s*$", re.MULTILINE)


#: ``Bundesland: …`` under the ``Projekt:`` line (``grounding_block._header_lines``), when the project's Land is stated.
_KL_FEDERAL_STATE_RE = re.compile(r"^Bundesland:\s*(.+?)\s*$", re.MULTILINE)


# The retrieval score ``_format_results`` prints, a true cosine similarity since
# the audit's F6 fix. Parsed from the WHOLE block rather than the header region:
# the header is defined as everything above this very line. A body could in
# principle contain the same words, but the header's line precedes it and
# ``_first`` takes the first match.
_KL_SCORE_RE = re.compile(r"^Relevance Score:\s*(-?\d+(?:\.\d+)?)\s*$", re.MULTILINE)


# Per-hit block/body markers, mirroring register.py:_format_results layout: each
# hit is a ``--- Result N ---`` block whose passage body follows the
# ``Relevance Score:`` header line + a blank line, running until the next block
# / the ``## Trace-Lanes`` fan-out summary / end. A very long body is truncated
# with a trailing ``... [truncated]`` marker we strip back off.
_KL_RESULT_BLOCK_RE = re.compile(r"^--- Result \d+ ---[^\S\n]*$", re.MULTILINE)


_KL_RELEVANCE_LINE_RE = re.compile(r"^Relevance Score:.*$", re.MULTILINE)


_KL_TRACE_LANES_MARKER = "## Trace-Lanes"


_KL_TRUNCATED_SUFFIX_RE = re.compile(r"\s*\.\.\.\s*\[truncated\]\s*$")


def _split_kl_result_blocks(content: str) -> list[str]:
    """Split KB tool output into one text span per ``--- Result N ---`` block.

    Each span runs from just after its block marker to the start of the next
    marker (or the ``## Trace-Lanes`` fan-out summary / end of content), so a
    block contains exactly one hit's header fields AND its passage body. The
    leading "Found N relevant document(s):" preamble is not a block and is
    dropped. Returns ``[]`` when the output carries no block markers.
    """
    block_matches = list(_KL_RESULT_BLOCK_RE.finditer(content))
    blocks: list[str] = []
    for idx, block_match in enumerate(block_matches):
        block_start = block_match.end()
        block_end = block_matches[idx + 1].start() if idx + 1 < len(block_matches) else len(content)
        block = content[block_start:block_end]
        # The trailing Trace-Lanes JSON belongs to the whole result set, not to
        # the last hit — cut it off so it can pollute neither the body nor the
        # header-field scan below.
        trace_lanes_at = block.find(_KL_TRACE_LANES_MARKER)
        if trace_lanes_at != -1:
            block = block[:trace_lanes_at]
        blocks.append(block)
    return blocks


def _kl_block_body(block: str) -> str:
    """The retrieved passage body of one result block.

    ``_format_results`` puts the body after the ``Relevance Score:`` header line
    and a blank line. Returns ``""`` when that header is absent (nothing to
    anchor the body to). A very long body is truncated by the producer with a
    trailing ``... [truncated]`` marker, which is stripped back off.
    """
    relevance_match = _KL_RELEVANCE_LINE_RE.search(block)
    if relevance_match is None:
        return ""
    return _KL_TRUNCATED_SUFFIX_RE.sub("", block[relevance_match.end() :].strip()).strip()


def _kl_block_header(block: str) -> str:
    """The HEADER region of one result block — everything above the passage body.

    Header fields must be read from here, never from the whole block, because
    the block also contains RETRIEVED DOCUMENT TEXT. ``_format_results`` omits
    ``Dokumentart:``/``Collection:``/``Page:`` for a hit that has none, so a
    passage whose own text contains such a line would otherwise supply the
    missing field — and a scanned Einreichplan or Bescheid whose title block
    carries a metadata table plausibly does. The result is the same user-visible
    failure as positional misalignment: a private project plan classified as an
    OIB Richtlinie, because ``doc_class`` is first priority in ``lane_for_hit``.

    ``Source:``/``Citation:`` happen to be safe (the header always emits them,
    so the header's own match wins), but scoping the region is what makes that
    true by construction rather than by luck.

    A block with no ``Relevance Score:`` line has no body to confuse us with, so
    the whole block is its header.
    """
    relevance_match = _KL_RELEVANCE_LINE_RE.search(block)
    return block[: relevance_match.start()] if relevance_match else block


def _extract_kl_chunk_bodies(content: str) -> list[str]:
    """Retrieved passage body per ``--- Result N ---`` block, in document order."""
    return [_kl_block_body(block) for block in _split_kl_result_blocks(content)]


def _first(pattern: re.Pattern[str], text: str) -> str | None:
    """First capture of ``pattern`` in ``text``, stripped; ``None`` when absent."""
    match = pattern.search(text)
    return match.group(1).strip() or None if match else None


def _parse_kl_doc_class(raw: str | None) -> str | None:
    """Machine doc_class key from a ``Dokumentart:`` value.

    The line is emitted as ``<doc_class_key> — <German label>``; keep only the
    leading machine key so lane placement gets a valid key.
    """
    if not raw:
        return None
    key = raw.split("—")[0].split(" - ")[0].strip() or None
    if not key:
        return None
    from agent.knowledge.document_classification import canonical_doc_class

    # A tool result kept in an older conversation names the German key.
    return canonical_doc_class(key) or key


def _parse_kl_authored_by(raw: str | None) -> str | None:
    """``"agent"`` when a ``Herkunft:`` value names a Piloti document, else None.

    Fails CLOSED: an unrecognised, reworded or absent value leaves the author
    unknown rather than claiming a human wrote it — unknown and human are the
    same for every reader downstream, and only this exact token buys the
    document its Piloti lane and its verdict ban.
    """
    from agent.common.provenance import AGENT_AUTHOR
    from agent.common.source_kinds import AGENT_AUTHORED_LANE_LABEL

    value = (raw or "").strip()
    return AGENT_AUTHOR if value.startswith(AGENT_AUTHORED_LANE_LABEL) else None


def _kl_entry(
    *,
    citation_key: str,
    title: str | None,
    collection: str | None,
    shelf: str | None = None,
    doc_class: str | None,
    authored_by: str | None = None,
    chunk_text: str | None,
    tool_name: str,
    clause: str | None = None,
    score: float | None = None,
    project: tuple[str, str, str] | None = None,
    project_federal_state_note: str | None = None,
) -> SourceEntry:
    """Build a knowledge-layer :class:`SourceEntry` from one hit's fields.

    ``project`` is the ``Projekt:`` line read back, ``(name, status label, id)``.
    """
    parsed_shelf = parse_shelf(shelf)
    project_name, status_label, project_id = project if project else (None, None, None)
    return SourceEntry(
        citation_key=citation_key.strip(),
        title=title,
        source_type="knowledge_layer",
        tool_name=tool_name,
        collection=collection or None,
        shelf=str(parsed_shelf) if parsed_shelf else None,
        doc_class=doc_class or None,
        authored_by=authored_by or None,
        chunk_text=chunk_text or None,
        clause=(clause or "").strip() or None,
        score=score,
        project_id=project_id,
        project_name=project_name,
        project_status=_PROJECT_STATUS_BY_LABEL.get(status_label, status_label) if status_label else None,
        project_federal_state_note=project_federal_state_note,
    )


#: The ``Projekt:`` line's status labels back to the wire's status.
_PROJECT_STATUS_BY_LABEL = {label: status for status, label in PROJECT_STATUS_LABELS.items()}


def _parse_kl_project(header: str) -> tuple[str, str, str] | None:
    """The ``Projekt:`` line of one block's header, or None when the hit named no project."""
    match = _KL_PROJECT_RE.search(header)
    return (match.group(1).strip(), match.group(2), match.group(3)) if match else None


def _parse_kl_score(value: str | None) -> float | None:
    """The ``Relevance Score:`` value as a float, or None when absent or malformed."""
    if not value:
        return None
    try:
        score = float(value)
    except ValueError:
        return None
    return score if math.isfinite(score) else None


def parse_knowledge_layer(content: str, tool_name: str) -> list[SourceEntry]:
    """Parse knowledge layer retrieval output. THE LEGACY PATH; see the banner above.

    Extracts citation keys (filename + page), the retrieval ``Collection:``
    each hit came from (threaded by the KB tool so ``source_lane`` can place
    the hit deterministically), the explicit ``Dokumentart:`` classification,
    and the retrieved passage body. A text with no ``Citation:`` field carries
    no sources, and says so with an empty list.

    Fields are read PER ``--- Result N ---`` BLOCK, never by zipping separate
    whole-document ``findall`` lists. ``_format_results`` emits ``Collection:``
    and ``Dokumentart:`` only when the hit HAS one, so a result set mixing a
    classified hit (OIB corpus) with an unclassified one (a project upload)
    shifts every later value up by one under positional zipping — and because
    ``doc_class`` is the FIRST-priority signal in ``lane_for_hit``, that
    silently rendered a project plan as an OIB Richtlinie. Block-scoped parsing
    makes the association structural rather than coincidental.
    """
    blocks = _split_kl_result_blocks(content)
    entries: list[SourceEntry] = []

    if blocks:
        for block in blocks:
            # Header fields come from the header region ONLY; the rest of the
            # block is retrieved document text and must never be able to supply
            # a field the producer omitted. See ``_kl_block_header``.
            header = _kl_block_header(block)
            citation_key = _first(_KL_CITATION_RE, header)
            if not citation_key:
                # A block without a Citation: field identifies nothing citable.
                continue
            entries.append(
                _kl_entry(
                    citation_key=citation_key,
                    title=_first(_KL_SOURCE_RE, header),
                    collection=_first(_KL_COLLECTION_RE, header),
                    shelf=_first(_KL_SHELF_RE, header),
                    doc_class=_parse_kl_doc_class(_first(_KL_DOC_CLASS_RE, header)),
                    authored_by=_parse_kl_authored_by(_first(_KL_PROVENANCE_RE, header)),
                    chunk_text=_kl_block_body(block),
                    tool_name=tool_name,
                    clause=_first(_KL_CLAUSE_RE, header),
                    project=_parse_kl_project(header),
                    project_federal_state_note=_first(_KL_FEDERAL_STATE_RE, header),
                    # The score line is the header's last line by definition of
                    # ``_kl_block_header``, so it is read off the whole block.
                    score=_parse_kl_score(_first(_KL_SCORE_RE, block)),
                )
            )
    else:
        # No block markers (a non-``_format_results`` producer whose tool name
        # still matches "knowledge"). Nothing delimits the hits, so fall back to
        # the historical positional pairing rather than dropping the sources.
        citations = _KL_CITATION_RE.findall(content)
        sources = _KL_SOURCE_RE.findall(content)
        collections = _KL_COLLECTION_RE.findall(content)
        doc_classes = _KL_DOC_CLASS_RE.findall(content)
        for i, citation_key in enumerate(citations):
            entries.append(
                _kl_entry(
                    citation_key=citation_key,
                    title=sources[i].strip() if i < len(sources) else None,
                    collection=collections[i].strip() if i < len(collections) else None,
                    doc_class=_parse_kl_doc_class(doc_classes[i] if i < len(doc_classes) else None),
                    chunk_text=None,
                    tool_name=tool_name,
                )
            )

    # No Citation: line, no sources. A URL in a passage body is part of the
    # retrieved text, and a knowledge tool that FAILED returns an error message
    # whose links are nobody's evidence. Both used to register as web sources
    # through the generic URL extractor, which is why a turn that tripped a
    # pydantic validation error showed a source card for errors.pydantic.dev.
    return entries


_KL_REGION_RE = re.compile(r"^Region:\s*\[([^\]]+)\]\s*(?:„(.*?)“)?\s*$", re.MULTILINE)


def _regions_from_header(header: str) -> list[SourceRegion]:
    """The ``Region: [x, y, w, h]`` lines of a header as boxes (``x0, y0, x1, y1``); malformed lines are skipped."""
    regions: list[SourceRegion] = []
    for match in _KL_REGION_RE.finditer(header):
        try:
            x, y, w, h = (float(part) for part in match.group(1).split(","))
        except ValueError:
            continue
        regions.append(SourceRegion(box=(x, y, round(x + w, 4), round(y + h, 4)), label=match.group(2) or None))
    return regions[:MAX_REGIONS_PER_SOURCE]


def parse_look(content: str, tool_name: str) -> list[SourceEntry]:
    """``look``'s grounding block read back from TEXT: a replayed turn's places (ADR-0125, 2026-10-22).

    The text twin of :func:`_look_entry`. Without it a replayed turn falls
    through to the URL extractor and the look's citation vanishes.
    """
    entries: list[SourceEntry] = []
    for block in _split_kl_result_blocks(content):
        header = _kl_block_header(block)
        citation_key = _first(_KL_CITATION_RE, header)
        if not citation_key:
            continue
        entry = _kl_entry(
            citation_key=citation_key,
            title=_first(_KL_SOURCE_RE, header),
            collection=_first(_KL_COLLECTION_RE, header),
            shelf=_first(_KL_SHELF_RE, header),
            doc_class=None,
            chunk_text=None,
            tool_name=tool_name,
        )
        entry.read = _kl_block_body(block) or None
        entry.regions = _regions_from_header(header)
        entries.append(entry)
    return entries
