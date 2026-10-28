"""From a tool result to ``SourceEntry`` records: the structured reader first, then the registered text parsers.

The TOOL side is structured: an evidence tool states
:class:`~agent.common.grounding_block.GroundingHit` records and this module reads the fields (ADR-0061).
The text parsers serve a replayed turn, whose result is only text.
"""

from __future__ import annotations

import logging
import re
from html import unescape
from typing import Any

from agent.citations.entries import SourceEntry
from agent.citations.entries import is_look_tool
from agent.citations.entries import normalize_url
from agent.citations.registry import MAX_REGIONS_PER_SOURCE
from agent.citations.text_parsers import parser_for
from agent.common.grounding_block import GroundingHit
from agent.common.grounding_block import get_grounding_block
from agent.common.source_kinds import TOOL_RESULT_SOURCE_TYPE

logger = logging.getLogger(__name__)


def extract_sources_from_tool_result(
    tool_name: str,
    content: str,
    source_id: str | None = None,
    artifact: Any = None,
) -> list[SourceEntry]:
    """Extract sources from a tool's output.

    Strategy:
    00. If the result carries its records on ``ToolMessage.artifact``
       (``common.citation_collector``, the filesystem tools, ADR-0133), copy
       their fields. The artifact travels with the message, so it holds for a
       message whose text the turn's capture no longer knows.
    0. If this exact text was rendered from a grounding block during this turn,
       copy the fields off the records the producer stated (ADR-0061). No
       parsing, and nothing the passage body can forge.
    1. If a registered parser matches the tool name, use it (for special
       formats like knowledge layer citation keys). Its answer is final,
       including an empty one: a knowledge, RIS or read_passage text with no
       ``Citation:`` line states no source, and the URLs it happens to contain
       belong to a passage body or to an error message.
    2. For a tool with no registered parser (web search and anything new), fall
       back to the generic URL extractor, which finds all URLs in any tool
       output regardless of format.
    3. If neither produces entries, register the tool result itself as a
       non-URL citation source.

    Step 0 misses for everything that holds the text without the records: a
    turn replayed from Postgres, a registry hydrated from the shared cache, the
    job runner's callback. Those fall through to the text parsers below, which
    is what the parsers are still there for.

    This means new sources (Bing, Perplexity, etc.) work automatically
    without any parser registration — as long as their output contains URLs.

    The non-URL fallback is permissive on purpose: callers (Piloti and
    deep researchers) are responsible for deciding which tool calls are
    eligible to contribute sources, typically by limiting capture to the
    agent's loaded tool set. The optional ``source_id`` is stored on the
    returned entries when callers have resolved this tool to a configured
    data source via
    :func:`agent.common.data_source_registry.get_source_id_for_tool`,
    but it does not gate the fallback.
    """
    from agent.common.citation_collector import hits_from_artifact

    carried = hits_from_artifact(artifact)
    if carried is not None:
        return [_entry_from_hit(hit, tool_name) for hit in carried]

    block = get_grounding_block(content)
    if block is not None:
        # Block order is load-bearing: ``SourceRegistry.add`` merges a repeated
        # (collection, filename, page) onto the entry that arrived first.
        return [_entry_from_hit(hit, tool_name) for hit in block.hits]

    # An error or a no-result report is not evidence, whatever it links to.
    # Checked before the parsers and the URL extractor. Until 2026-09-24 it ran
    # after them, and "Error: Web search is unavailable ... Get an API key from
    # https://tavily.com/" registered tavily.com as a citable source (answer suite).
    if _is_non_citable_status_output(content):
        return []

    parser_fn = parser_for(tool_name)
    if parser_fn is not None:
        try:
            return parser_fn(content, tool_name)
        except Exception:
            logger.warning("Parser failed for tool %s, falling back to generic", tool_name, exc_info=True)
    # Generic fallback: extract all URLs from content
    entries = _parse_generic_urls(content, tool_name)
    if entries:
        return entries

    # Non-URL fallback: register the tool result itself as a source whenever
    # the tool produced non-empty output. The caller has already decided
    # this tool is eligible to contribute sources (typically by limiting
    # capture to the agent's loaded tool set).
    if content.strip():
        return [SourceEntry(citation_key=tool_name, source_type=TOOL_RESULT_SOURCE_TYPE, tool_name=tool_name)]

    return []


# Batch source-tool output format (see deep_researcher's
# _format_batch_tool_output): "## Query: <q>\n<body>" sections joined by
# "\n\n---\n\n".
_BATCH_SECTION_SEPARATOR_RE = re.compile(r"\n\s*---\s*\n")


_BATCH_QUERY_HEADING_RE = re.compile(r"\A\s*##\s*Query:[^\n]*\n?", re.IGNORECASE)


def _split_batch_output_bodies(content: str) -> list[str] | None:
    """Split batch source-tool output into per-query bodies.

    Returns None when content is not batch-formatted (i.e. any section does
    not start with a "## Query:" heading).
    """
    sections = _BATCH_SECTION_SEPARATOR_RE.split(content.strip())
    bodies: list[str] = []
    for section in sections:
        heading_match = _BATCH_QUERY_HEADING_RE.match(section)
        if heading_match is None:
            return None
        bodies.append(section[heading_match.end() :])
    return bodies or None


def _is_non_citable_status_output(content: str) -> bool:
    """Return whether content is a tool status/error message, not evidence.

    Understands the batched source-tool output format: a batch whose items ALL
    errored (or returned nothing) is a status report, not citable evidence.
    A batch with at least one substantive item stays citable.
    """
    batch_bodies = _split_batch_output_bodies(content)
    if batch_bodies is not None:
        return all(not body.strip() or _is_status_message(body) for body in batch_bodies)
    return _is_status_message(content)


def _is_status_message(content: str) -> bool:
    """Return whether a single tool output (or batch item body) is a status message."""
    stripped = content.strip()
    normalized = re.sub(r"\s+", " ", stripped).rstrip(".").lower()
    if not normalized:
        return False
    if normalized.startswith("error:"):
        return True
    if normalized == "search returned no results" or normalized.endswith(" search returned no results"):
        return True
    # No-result outputs from source tools (e.g. the RIS adapter's
    # "No RIS documents found for query ...") are status reports, not evidence,
    # and must not become citations. The known no-result prefixes only qualify
    # when the body actually has the shape of a terse status line — a SINGLE,
    # reasonably SHORT line, matching the real RIS no-result output. A multi-line
    # or long body that merely LEADS with one of these phrases (e.g. "No results
    # found for the exact phrase, however: <records>") carries substantive
    # content and must survive as citable evidence.
    is_terse_status_line = "\n" not in stripped and len(normalized) <= 300
    return is_terse_status_line and normalized.startswith(
        (
            "no ris documents found",
            "no documents found",
            "no results found",
        )
    )


def _look_entry(hit: GroundingHit, tool_name: str) -> SourceEntry:
    """A look's hit as a PLACE: the reading in ``read``, no passage, no score."""
    entry = _entry_from_hit_fields(hit, tool_name)
    entry.read = hit.body.strip() or None
    entry.chunk_text = None
    entry.score = None
    return entry


def _entry_from_hit(hit: GroundingHit, tool_name: str) -> SourceEntry:
    if is_look_tool(tool_name):
        return _look_entry(hit, tool_name)
    return _entry_from_hit_fields(hit, tool_name)


def _entry_from_hit_fields(hit: GroundingHit, tool_name: str) -> SourceEntry:
    """One captured grounding hit as a registry entry, by field copy.

    The structured twin of :func:`_kl_entry`, and the reason the text parsers
    below no longer run on a live turn. Every value here is the one the
    producer stated, so the only work left is the registry's emptiness
    convention: ``""`` and ``None`` mean the same thing to every reader
    downstream, and the entry states ``None``.

    ``url`` stays unset: a hit states no URL, and a RIS passage is cited by its
    key, not by its link. Giving it one would move it onto the registry's URL
    identity and out of the document dedup.
    """
    return SourceEntry(
        citation_key=hit.citation_key.strip(),
        title=hit.display_title.strip() or None,
        source_type="knowledge_layer",
        tool_name=tool_name,
        collection=(hit.collection or "").strip() or None,
        shelf=str(hit.shelf) if hit.shelf is not None else None,
        doc_class=(hit.doc_class or "").strip() or None,
        authored_by=hit.authored_by,
        # The body as EVIDENCE: no truncation marker (the renderer adds it) and
        # no surrounding blank lines, so ``verify_quoted_spans`` matches an
        # answer's quote against the passage and nothing else.
        chunk_text=hit.body.strip() or None,
        clause=(hit.clause or "").strip() or None,
        score=hit.score,
        regions=list(hit.regions[:MAX_REGIONS_PER_SOURCE]),
        page_end=hit.page_end if hit.page_end and hit.page and hit.page_end > hit.page else None,
        project_id=hit.project.id if hit.project else None,
        project_name=hit.project.name if hit.project else None,
        project_status=hit.project.status if hit.project else None,
        project_federal_state_note=hit.project.federal_state_note if hit.project else None,
    )


# Generic URL extractor — works for any tool output format.
# Commas are valid URL path characters (RFC 3986 sub-delim) and appear in real
# URLs like https://weathercams.faa.gov/map/-122.31167,47.22287,10/...; we
# include them in the match and rely on URL_TRIM_CHARS below to strip any
# comma that's actually sentence punctuation. ``]`` stays excluded here
# because it almost always terminates a markdown link rather than appearing
# in a path.
_GENERIC_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")


# Trailing characters to strip from a captured URL.  Covers sentence
# punctuation and the closing chars of common Markdown wrappers — ``]`` for
# ``[https://...]`` and ``>`` for ``<https://...>``.  Used at every site that
# captures a URL via a permissive regex (registration and verification).
URL_TRIM_CHARS = ".,;)]>"


# Patterns for extracting titles near URLs in common tool output formats
_TITLE_NEAR_URL_PATTERNS = [
    # Tavily: <title>\nSome Title\n</title>
    re.compile(r"<title>\s*\n?(.*?)\n?\s*</title>", re.DOTALL | re.IGNORECASE),
    # Paper search: N. **Title** (Year)
    re.compile(r"^\d+\.\s+\*\*(.+?)\*\*", re.MULTILINE),
    # Additional title patterns: --- Title ---
    re.compile(r"^---\s+(.+?)\s+---$", re.MULTILINE),
    # Key-value: Title: Some Title
    re.compile(r"^Title:\s*(.+)$", re.MULTILINE),
]


def _extract_title_for_url(content: str, url: str, blocks: list[str] | None = None) -> str | None:
    """Try to extract a title associated with a URL from the surrounding content.

    Finds the title pattern **closest to** (and preceding) the URL within its
    text block.  This prevents a single block containing multiple search
    results from assigning the first result's title to every URL.

    ``blocks`` may be supplied pre-split (by the same
    ``re.split(r"\\n\\n---\\n\\n|\\n\\n\\n", content)``) so a URL-heavy caller
    splits the content once instead of once per URL; when ``None`` the content
    is split here, preserving standalone callers' behaviour.
    """
    # Find the block of text containing this URL (split by --- or double newlines)
    if blocks is None:
        blocks = re.split(r"\n\n---\n\n|\n\n\n", content)
    for block in blocks:
        if url not in block:
            continue
        url_pos = block.index(url)
        best_title: str | None = None
        best_distance = float("inf")
        for pattern in _TITLE_NEAR_URL_PATTERNS:
            for title_match in pattern.finditer(block):
                title = title_match.group(1).strip()
                if not title or title == url:
                    continue
                # Prefer titles that appear before (and closest to) the URL
                distance = url_pos - title_match.end()
                if distance < 0:
                    # Title appears after the URL — use large penalty
                    distance = abs(distance) + 10000
                if distance < best_distance:
                    best_distance = distance
                    best_title = title
        if best_title:
            return best_title
    return None


def _parse_generic_urls(content: str, tool_name: str) -> list[SourceEntry]:
    """Extract all URLs from any tool output, regardless of format.

    This is the universal fallback. It finds every URL in the content
    and registers it. Works for Tavily XML, paper search markdown,
    plain text with links, or any future source format. Also attempts to
    extract titles from common patterns near each URL.
    """
    seen: set[str] = set()
    entries: list[SourceEntry] = []
    # Split the content into blocks ONCE here (same regex as
    # ``_extract_title_for_url``) so title extraction is O(content) rather than
    # O(urls × content) on URL-heavy tool outputs (e.g. large ris_fetch results).
    blocks = re.split(r"\n\n---\n\n|\n\n\n", content)
    for match in _GENERIC_URL_RE.finditer(content):
        url = unescape(match.group(0)).rstrip(URL_TRIM_CHARS)
        normalized = normalize_url(url)
        if normalized not in seen:
            seen.add(normalized)
            title = _extract_title_for_url(content, url, blocks)
            entries.append(SourceEntry(url=url, title=title, source_type="generic", tool_name=tool_name))
    return entries
