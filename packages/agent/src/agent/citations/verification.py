"""``verify_citations``: every citation in an answer checked against the sources the turn retrieved.

Usage::

    result = verify_citations(report_text, registry)
    clean_report = result.verified_report

The ANSWER side is text, because the model writes text and a citation key in prose is all there is to read.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field

from agent.citations.binding import source_origin_token
from agent.citations.citation_keys import parse_citation_key
from agent.citations.citation_keys import path_in_citation
from agent.citations.entries import DUPLICATE_REASON_PREFIX
from agent.citations.entries import LOCUS_MISMATCH_REASON
from agent.citations.entries import NO_SOURCE_REASON
from agent.citations.entries import CitationVerificationResult
from agent.citations.entries import SourceEntry
from agent.citations.extraction import URL_TRIM_CHARS
from agent.citations.references import CITATION_LINE_RE
from agent.citations.references import INLINE_CITATION_RE
from agent.citations.references import REFERENCE_SECTION_RE
from agent.citations.references import URL_IN_LINE_RE
from agent.citations.references import document_identity
from agent.citations.references import drop_url
from agent.citations.references import is_digest_shaped_line
from agent.citations.references import is_knowledge_citation
from agent.citations.registry import SourceRegistry
from agent.citations.report_layout import ORIGIN_TOKEN_RE
from agent.citations.report_layout import drop_inline_citations_not_in
from agent.citations.report_layout import format_registry_reference
from agent.citations.report_layout import inject_origin_token
from agent.citations.report_layout import inline_citation_numbers
from agent.citations.report_layout import label_inline_citations_not_in
from agent.citations.report_layout import label_locus_mismatches
from agent.citations.report_layout import normalize_citation_syntax
from agent.citations.report_layout import normalize_source_section_layout

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _LineSource:
    """What one source line resolves to in the registry: a URL, a citation key, or why neither.

    ``line_url`` is the link the line carried: garbled when it differs from
    ``url``, and dropped when the line resolved by its key instead.
    """

    url: str | None = None
    citation_key: str | None = None
    line_url: str | None = None
    reason: str | None = None

    def entry(self, registry: SourceRegistry) -> SourceEntry | None:
        if self.url:
            return registry.entry_for_url(self.url)
        return registry.entry_for_citation_key(self.citation_key) if self.citation_key else None


def resolve_source_line(match_text: str, registry: SourceRegistry) -> _LineSource:
    """Resolve one source line's text (origin token stripped) the way ``verify_citations`` accepts it.

    The one reading of a source line: the verifier keeps or drops the line on
    it, and the quote check reads which source a ``[N]`` names off it, so the
    passage a quote is patched from is the one its citation was verified
    against (ADR-0067).
    """
    # A digest line cites the conversation's read-index, not a retrieved
    # passage (see ``is_digest_shaped_line``): rejected before either the
    # URL or the filename scan can accept it on a fragment it contains.
    if is_digest_shaped_line(match_text):
        return _LineSource(reason="digest_line_not_citable")
    url_match = URL_IN_LINE_RE.search(match_text)
    if url_match:
        url = url_match.group(0).rstrip(URL_TRIM_CHARS)
        if canonical := registry.resolve_url(url):
            return _LineSource(url=canonical, line_url=url)
        # A source cited by its key can still arrive with a link: the prompt
        # asks for ``Title - URL``, the model copies a link from a tool's
        # source line (``ris_search`` prints ``Source: <url>``; ``ris_lookup``
        # printed ``Source URL:`` beside ``Citation:`` until 2026-09-24), and
        # the registry deliberately files RIS by key. The key decides; the
        # link it cannot vouch for is dropped.
        is_kl, citation_key = is_knowledge_citation(drop_url(match_text, url), registry)
        if is_kl and citation_key and registry.has_citation_key(citation_key):
            return _LineSource(citation_key=citation_key, line_url=url)
        return _LineSource(reason="url_not_in_registry")
    # Knowledge-layer citation key (lenient: the registry allows a fuzzy filename match).
    is_kl, citation_key = is_knowledge_citation(match_text, registry)
    if not (is_kl and citation_key):
        return _LineSource(reason="unverifiable")
    if not registry.has_citation_key(citation_key):
        return _LineSource(reason="citation_key_not_in_registry")
    return _LineSource(citation_key=citation_key)


def _rewrite_numbers(body: str, rewrites: dict[int, int]) -> str:
    """Each inline ``[old]`` rewritten to ``[new]``: a duplicate source line's marker to the line it duplicates."""
    for old_num, canonical_num in rewrites.items():
        body = re.sub(rf"\[{old_num}\]", f"[{canonical_num}]", body)
    return body


def _label_without_sources(report_text: str) -> CitationVerificationResult:
    """Nothing was retrieved: every inline number is unresolvable, and the model's source list names nothing real."""
    ref_match = REFERENCE_SECTION_RE.search(report_text)
    body = report_text[: ref_match.start()].rstrip() if ref_match else report_text
    numbers = sorted({int(number) for number in INLINE_CITATION_RE.findall(body)})
    if not numbers and ref_match is None:
        return CitationVerificationResult(verified_report=report_text)
    removed = [{"number": number, "line": "", "reason": NO_SOURCE_REASON} for number in numbers]
    return CitationVerificationResult(
        verified_report=label_inline_citations_not_in(body, set()), removed_citations=removed
    )


def verify_citations(
    report_text: str,
    registry: SourceRegistry,
    *,
    reference_sources: Sequence[SourceEntry | None] | None = None,
    label_dropped: bool = False,
    check_locus: bool = False,
) -> CitationVerificationResult:
    """Verify cited source identities against the captured source registry.

    This function decides whether each cited source line maps to a real captured
    URL or citation key. It may normalize source-section layout enough to parse
    common writer variants, but final Markdown hygiene belongs to
    ``sanitize_report``.

    Algorithm:
    1. Find the source section
    2. Parse each [N] source line
    3. Validate URL or citation_key against registry
    4. Remove invalid source lines and orphaned inline citations

    Renumbering is NOT done here — it is deferred to sanitize_report()
    which always runs after this function and handles it in a single pass.

    Args:
        report_text: The full report text with citations.
        registry: SourceRegistry populated from tool call results.
        reference_sources: Optional writer-facing source list, in the same
            numbering order the writer saw, ``None`` where a number names
            nothing. Used only to synthesize a missing source section.
        label_dropped: Put :data:`DROPPED_CITATION_MARKER` where an
            unresolvable inline citation stood instead of deleting it silently
            (chat, ADR-0125). Also applies to an empty registry: every number
            the answer wrote is then unresolvable, and the model's own source
            list goes with them.
        check_locus: Hold a § or Punkt written beside a resolved ``[N]`` to
            the passage it resolves to (``common/citation_locus``); an
            occurrence whose locus is not there is labelled like an
            unresolvable one.

    Returns:
        CitationVerificationResult with cleaned report and audit trail.
    """
    # Normalize citation syntax variants before validation.
    report_text = normalize_citation_syntax(report_text)

    # Early exit: nothing to validate against
    all_sources = registry.all_sources()
    if not all_sources:
        logger.debug("[CitationVerify] Skipping — registry is empty (no tool calls captured)")
        if label_dropped:
            return _label_without_sources(report_text)
        return CitationVerificationResult(verified_report=report_text)

    logger.info(
        "[CitationVerify] Starting verification against %d registered source(s)",
        len(all_sources),
    )
    logger.debug(
        "[CitationVerify] Registered URLs: %s",
        [s.url for s in all_sources if s.url],
    )

    located = _locate_source_section(report_text, reference_sources, label_dropped=label_dropped)
    if isinstance(located, CitationVerificationResult):
        return located
    report_text, ref_start = located
    body = report_text[:ref_start]
    ref_section = normalize_source_section_layout(report_text[ref_start:])

    lines = _parse_source_lines(ref_section, registry)
    duplicate_rewrites = lines.dedupe()

    # Duplicates are rewritten to the canonical number first, so the locus
    # check below reads every marker under the number its source line keeps.
    body = _rewrite_numbers(body, duplicate_rewrites)
    removed_numbers_for_locus: set[int] = set()
    if check_locus:
        body, removed_numbers_for_locus = lines.check_locus(body, registry)

    ref_section = _repair_urls(ref_section, lines.url_replacements)

    # A locus record names an occurrence, not a line: only a number with no
    # occurrence left loses its source line.
    removed_numbers = {
        c["number"] for c in lines.removed if c.get("reason") != LOCUS_MISMATCH_REASON
    } | removed_numbers_for_locus
    cleaned_ref_section = lines.clean_section(ref_section, removed_numbers)
    if label_dropped and not CITATION_LINE_RE.search(cleaned_ref_section):
        # Every line went: a „## Quellen" with nothing under it reads as a
        # rendering fault, and the labels in the prose already say why.
        cleaned_ref_section = ""
        body = body.rstrip()

    # Body fixups:
    #  * Duplicate citations get rewritten to the canonical number — the
    #    cited source is real, only the [N] label is wrong.
    #  * Genuinely invalid citations get stripped — the source is fabricated
    #    or unverifiable.
    valid_numbers = {c["number"] for c in lines.valid}
    cleaned_body = drop_inline_citations_not_in(body, valid_numbers, label=label_dropped)

    # Note: renumbering is deferred to sanitize_report() which always runs after
    # this function and handles renumbering in a single pass.
    logger.debug("[CitationVerify] Result: kept %d, removed %d", len(lines.valid), len(lines.removed))
    return CitationVerificationResult(
        verified_report=cleaned_body + cleaned_ref_section,
        removed_citations=lines.removed,
        valid_citations=lines.valid,
    )


def _locate_source_section(
    report_text: str, reference_sources: Sequence[SourceEntry | None] | None, *, label_dropped: bool
) -> tuple[str, int] | CitationVerificationResult:
    """Where the source section starts, synthesizing one from the writer's list when the answer has none.

    Returns the (possibly extended) report and the section's offset, or the final result when there is
    nothing to verify.
    """
    ref_match = REFERENCE_SECTION_RE.search(report_text)
    if ref_match:
        return report_text, ref_match.start()
    if not INLINE_CITATION_RE.search(report_text):
        logger.warning("[CitationVerify] No source section found in report; skipping")
        return CitationVerificationResult(verified_report=report_text)

    if reference_sources is None:
        logger.warning(
            "[CitationVerify] No source section found; cannot safely synthesize sources "
            "without the writer-facing source list"
        )
        return CitationVerificationResult(verified_report=report_text)

    writer_sources = list(reference_sources)
    cited_numbers = sorted(inline_citation_numbers(report_text))
    reference_lines = [
        line
        for i in cited_numbers
        if 1 <= i <= len(writer_sources)
        if (entry := writer_sources[i - 1]) is not None and (line := format_registry_reference(i, entry))
    ]
    if not reference_lines:
        logger.warning("[CitationVerify] No source section found and no renderable writer-facing sources")
        return CitationVerificationResult(
            verified_report=drop_inline_citations_not_in(report_text, set(), label=label_dropped)
        )

    logger.warning(
        "[CitationVerify] No source section found; appending %d inline-cited registered source(s)",
        len(reference_lines),
    )
    report_text = report_text.rstrip() + "\n\n## Sources\n" + "\n".join(reference_lines)
    ref_match = REFERENCE_SECTION_RE.search(report_text)
    if ref_match is None:
        return CitationVerificationResult(verified_report=report_text)
    return report_text, ref_match.start()


@dataclass
class _SourceLines:
    """What the parse of a source section found, line by line, and what each kept line will be rewritten to."""

    valid: list[dict] = field(default_factory=list)
    removed: list[dict] = field(default_factory=list)
    url_replacements: dict[str, str] = field(default_factory=dict)  # garbled_url -> canonical_url
    # Origin token per validated citation number, e.g. {1: "[Web]", 3: "[KB]"}.
    # Applied AFTER the [N] marker in ``clean_section`` so the LLM-written
    # source section gains the same deterministic labels the
    # fallback-synthesized and chat paths already carry. Lines that
    # already start with a token are left as-is (idempotent).
    origin_tokens: dict[int, str] = field(default_factory=dict)
    dropped_urls: dict[int, str] = field(default_factory=dict)  # key-verified line -> the link it carried
    # key-verified line -> (the path it named, the file name)
    cited_paths: dict[int, tuple[str, str]] = field(default_factory=dict)

    def dedupe(self) -> dict[int, int]:
        """Collapse source lines that resolve to the same registry source; returns ``{duplicate: kept}``.

        The model often makes the same tool call twice (e.g.
        ``mcp_time__get_current_time`` for two timezones) and emits a separate
        ``[N] tool_name`` line for each call; without this pass both lines
        survive verification because each is independently valid. We keep the
        lowest-numbered occurrence and rewrite later inline citations to that
        number so the prose still cites the source.
        """
        seen_keys: dict[str, int] = {}  # canonical_key -> kept citation number
        duplicate_rewrites: dict[int, int] = {}  # duplicate_num -> canonical_num
        deduped_valid: list[dict] = []
        for c in self.valid:
            key = c["url"] or c["citation_key"]
            if key is None:
                # Defensive: a valid citation must have one of url/citation_key.
                # If neither is set we cannot dedup, so keep the entry.
                deduped_valid.append(c)
                continue
            canonical_num = seen_keys.get(key)
            if canonical_num is None:
                seen_keys[key] = c["number"]
                deduped_valid.append(c)
                continue
            duplicate_rewrites[c["number"]] = canonical_num
            self.removed.append(
                {"number": c["number"], "line": c["line"], "reason": f"{DUPLICATE_REASON_PREFIX}{canonical_num}"}
            )
            logger.debug("[CitationVerify]   [%d] REMOVE — duplicate of [%d]: %s", c["number"], canonical_num, key)
        self.valid = deduped_valid
        return duplicate_rewrites

    def check_locus(self, body: str, registry: SourceRegistry) -> tuple[str, set[int]]:
        """Label the occurrences whose § or Punkt is not in the passage; returns the body and the numbers gone."""
        body, locus_removed, locus_gone = label_locus_mismatches(body, self.valid, registry)
        self.removed.extend(
            {**record, "line": next((c["line"] for c in self.valid if c["number"] == record["number"]), "")}
            for record in locus_removed
        )
        self.valid = [c for c in self.valid if c["number"] not in locus_gone]
        return body, locus_gone

    def clean_section(self, ref_section: str, removed_numbers: set[int]) -> str:
        """The source section without the removed lines, each kept line rewritten.

        Removes invalid (and duplicate) source lines, and injects the origin token
        (``[KB]``/``[RIS]``/``[Web]``) after the ``[N]`` marker of each kept,
        validated line. Injection is idempotent and only touches numbers recorded
        during the parse, so url-repair and dedup are undisturbed.
        """
        cleaned_ref_lines: list[str] = []
        for line in ref_section.split("\n"):
            line_match = CITATION_LINE_RE.match(line)
            if line_match:
                num = int(line_match.group(1))
                if num in removed_numbers:
                    continue
                if (dropped := self.dropped_urls.get(num)) is not None:
                    line = drop_url(line, dropped)
                if (cited := self.cited_paths.get(num)) is not None:
                    line = line.replace(*cited, 1)
                if (token := self.origin_tokens.get(num)) is not None:
                    line = inject_origin_token(line, token)
            cleaned_ref_lines.append(line)
        return "\n".join(cleaned_ref_lines)


def _parse_source_lines(ref_section: str, registry: SourceRegistry) -> _SourceLines:
    """Resolve each ``[N]`` line of the source section against the registry."""
    lines = _SourceLines()
    for line_match in CITATION_LINE_RE.finditer(ref_section):
        num = int(line_match.group(1))
        ref_text = line_match.group(2).strip()
        full_line = line_match.group(0)

        # Strip any pre-existing origin token before identity matching so it
        # never leaks into fuzzy filename comparison (``[KB] file.pdf`` must
        # still resolve to ``file.pdf``). ``already_tokenized`` suppresses
        # re-injection so replayed/synthesized lines are not double-prefixed.
        token_match = ORIGIN_TOKEN_RE.match(ref_text)
        already_tokenized = token_match is not None
        match_text = ref_text[token_match.end() :] if token_match else ref_text

        source = resolve_source_line(match_text, registry)
        if source.reason is not None:
            log = logger.info if source.reason == "url_not_in_registry" else logger.debug
            log("[CitationVerify]   [%d] REMOVE — %s: %s", num, source.reason, ref_text[:80])
            lines.removed.append({"number": num, "line": full_line, "reason": source.reason})
            continue
        logger.debug("[CitationVerify]   [%d] VALID  — %s", num, source.url or source.citation_key)
        lines.valid.append({"number": num, "url": source.url, "citation_key": source.citation_key, "line": full_line})
        if source.url and source.line_url and source.line_url != source.url:
            lines.url_replacements[source.line_url] = source.url
        if source.citation_key and source.line_url:
            lines.dropped_urls[num] = source.line_url
        if source.citation_key and (cited_path := path_in_citation(match_text)):
            # The line shows the file's name, as its chip does, never the path the model copied.
            lines.cited_paths[num] = (cited_path, parse_citation_key(source.citation_key)[0])
        if not already_tokenized and (entry := source.entry(registry)):
            if token := source_origin_token(entry):
                lines.origin_tokens[num] = token
    return lines


def _repair_urls(ref_section: str, url_replacements: dict[str, str]) -> str:
    """Each garbled URL in the source section replaced by the registered one it resolved to.

    Bounded match: a plain str.replace would also rewrite a *different*
    reference whose URL merely starts with the garbled one (e.g. ?id=1
    vs ?id=10), corrupting a valid citation into a dead link.
    """
    for garbled, canonical in url_replacements.items():
        ref_section = re.sub(
            re.escape(garbled) + r"(?![\w\-./?=&%#~+])",
            lambda _m, url=canonical: url,
            ref_section,
        )
    return ref_section


def cited_document_entries(text: str, registry: SourceRegistry) -> list[SourceEntry]:
    """Registry documents the answer's SOURCE SECTION lists, in registry order.

    The document-key counterpart to :meth:`SourceRegistry.has_url`: it answers
    "which of the documents we retrieved does this answer cite?" without needing
    a URL. Each source line is resolved by :func:`resolve_source_line`, the one
    reading of a source line the verifier keeps or drops it on, so a document
    is cited here exactly when ``verify_citations`` would keep its line. A
    filename scan of the section did not: ``Bauordnung.pdf`` is a substring of
    ``NÖ Bauordnung.pdf``, and the other Land's document counted as cited.

    Deep research had no such path — its "cited" signal was URL-only, so a
    knowledge-base source could never be marked cited and was dropped from the
    provenance row the moment any web source WAS cited.

    A document is `(collection, filename)`, so the shelf a source line names is
    part of what it cites: a line reading `Plan.pdf (Büroablage), p.3` marks the
    Archiv document, not the project upload that happens to share the name and
    to sit earlier in the registry. Unqualified lines keep the fail-open
    reading (the first same-named entry), because a bare filename is proof the
    document was retrieved but says nothing about which copy. A line that
    names the document by its TITLE cites it just as much.

    Only the source section is scanned, NEVER the prose. Citing is a claim the
    answer makes in its source list; a filename appearing in body text is not
    that claim, and may well be the opposite of it ("Ich konnte oib-rl_2.pdf
    nicht abrufen"). This matters because the caller runs on intermediate agent
    output too, where documents are discussed far more often than cited — the
    URL path gets away with the looser rule only because URLs rarely appear in
    prose, while filenames routinely do. No source section means no citation
    claim yet, so nothing is marked. Fail-open: returns an empty list rather
    than raising.
    """
    if not text:
        return []
    normalized = normalize_citation_syntax(text)
    section_match = REFERENCE_SECTION_RE.search(normalized)
    if section_match is None:
        return []
    section = normalize_source_section_layout(normalized[section_match.start() :])
    cited: dict[tuple[str | None, str], SourceEntry] = {}
    for line in CITATION_LINE_RE.finditer(section):
        ref_text = line.group(2).strip()
        token = ORIGIN_TOKEN_RE.match(ref_text)
        source = resolve_source_line(ref_text[token.end() :] if token else ref_text, registry)
        # A line resolved by its link is the URL path's (``has_url``), not a document.
        if source.url or not source.citation_key:
            continue
        entry = registry.entry_for_citation_key(source.citation_key)
        if entry is not None:
            cited.setdefault(document_identity(entry), entry)
    order = {id(entry): index for index, entry in enumerate(registry._citation_keys)}
    return sorted(cited.values(), key=lambda entry: order.get(id(entry), len(order)))
