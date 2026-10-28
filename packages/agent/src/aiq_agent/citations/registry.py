"""``SourceRegistry``: every source the turn's tools returned, by URL and by citation key."""

from __future__ import annotations

import logging
from urllib.parse import parse_qs
from urllib.parse import urlparse

from aiq_agent.citations.citation_keys import ParsedURL
from aiq_agent.citations.citation_keys import entry_shelf
from aiq_agent.citations.citation_keys import key_file_names
from aiq_agent.citations.citation_keys import parse_citation_key
from aiq_agent.citations.citation_keys import parse_citation_ref
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.entries import normalize_url
from aiq_agent.common.grounding_block import SourceRegion

logger = logging.getLogger(__name__)


#: How many boxes one page's source carries. A sheet analysed into more
#: depictions than this is marked on its best-scoring ones, which arrive first.
MAX_REGIONS_PER_SOURCE = 6


def _merge_regions(entry: SourceEntry, regions: list[SourceRegion]) -> None:
    """Fold ``regions`` into ``entry``'s, dropping repeats and holding the cap."""
    for region in regions:
        if len(entry.regions) >= MAX_REGIONS_PER_SOURCE:
            return
        if region not in entry.regions:
            entry.regions.append(region)


class SourceRegistry:
    """Registry of sources captured from tool call results.

    Not thread-safe — this is intentional.  All access happens on a single
    asyncio event loop (cooperative concurrency), and Python's GIL already
    protects the underlying dict/list/set operations from corruption.
    The module-level ``_session_registries`` dict *is* lock-protected because
    it is accessed across event loops when creating/looking up sessions.
    """

    def __init__(self) -> None:
        self._urls: dict[str, SourceEntry] = {}
        self._parsed_urls: dict[str, ParsedURL] = {}
        self._citation_keys: list[SourceEntry] = []
        # Dedup key is (collection, filename, page).
        #
        # `page`: two chunks from the SAME document at DIFFERENT pages are
        # distinct evidence and must both become chips. Keying on filename alone
        # silently dropped every page after the first (and mismatched the
        # page-aware Trace-Lanes fan-out — see ADR-0026).
        #
        # `collection`: a document is `(collection, filename)` — the PRIMARY KEY
        # of `document_metadata`, and the only pair that is unique. One search
        # fans out across the base corpus, the session collection and the project
        # collections at once, so a project `Plan.pdf` and an Archiv `Plan.pdf`
        # can land in the same result set. Keying on the filename alone collapsed
        # them onto whichever chunk arrived first and discarded the other
        # document's evidence entirely.
        self._citation_key_files: set[tuple[str | None, str, int | None]] = set()
        self._all: list[SourceEntry] = []

    @staticmethod
    def _identity(entry: SourceEntry) -> tuple[str | None, str, int | None]:
        """The `(collection, filename, page)` a document entry is unique under.

        The collection is kept RAW (not reduced to its scope): two projects'
        `Plan.pdf` really are two documents, and dedup must never merge them even
        though a citation key can only ever name the coarser scope.
        """
        filename, page = parse_citation_key(entry.citation_key or "")
        collection = (entry.collection or "").strip().lower() or None
        return (collection, filename.lower(), page)

    def add(self, entry: SourceEntry) -> None:
        """Register a source entry. One entry per logical URL (dedup by normalized form).

        Raw URL = entry.url (exactly as the tool returned it); that is what we
        retain in the report. Normalized URL is used only as a key for dedup
        and matching. Both raw and normalized are stored as keys to the same
        entry so we never have duplicate entries and lookups find the tool URL.
        """
        added = False
        if entry.url:
            raw = entry.url
            normalized = normalize_url(raw)
            if normalized not in self._urls:
                self._urls[normalized] = entry
                parsed = urlparse(normalized)
                self._parsed_urls[normalized] = ParsedURL(
                    host=parsed.netloc,
                    path=parsed.path,
                    path_segments=[s for s in parsed.path.split("/") if s],
                    query=parse_qs(parsed.query, keep_blank_values=True),
                    entry=entry,
                )
                added = True
            if raw != normalized:
                self._urls[raw] = self._urls[normalized]
        if entry.citation_key:
            dedup_key = self._identity(entry)
            if dedup_key not in self._citation_key_files:
                self._citation_key_files.add(dedup_key)
                self._citation_keys.append(entry)
                if not added:
                    added = True
            else:
                # A single page may hold >1 retrieved chunk; dedup collapses them
                # onto one (collection, filename, page) entry, but each chunk's
                # body is distinct evidence for quote verification. Append the new
                # body to the surviving entry so the whole-registry fuzzy match
                # sees every chunk of the page rather than only the first. The
                # provenance fields fold the same way: the first stated Punkt
                # survives, and the page keeps the best score any chunk earned.
                for existing in self._citation_keys:
                    if self._identity(existing) == dedup_key:
                        if entry.chunk_text:
                            if not existing.chunk_text:
                                existing.chunk_text = entry.chunk_text
                            elif entry.chunk_text not in existing.chunk_text:
                                existing.chunk_text = f"{existing.chunk_text}\n\n{entry.chunk_text}"
                        if existing.clause is None and entry.clause:
                            existing.clause = entry.clause
                        if entry.score is not None and (existing.score is None or entry.score > existing.score):
                            existing.score = entry.score
                        _merge_regions(existing, entry.regions)
                        if entry.read and entry.read not in (existing.read or ""):
                            existing.read = f"{existing.read}\n{entry.read}" if existing.read else entry.read
                        break
        if added:
            self._all.append(entry)

    def has_url(self, url: str) -> bool:
        """Check if a URL (after normalization) is in the registry."""
        return normalize_url(url) in self._urls

    @staticmethod
    def _pick_unique(candidates: list[SourceEntry], strategy: str, url: str) -> str | None:
        """Return the registry URL when exactly one candidate matches.

        The source section can only show one URL per citation. If multiple
        registry URLs match (e.g. same path, different query), we cannot know
        which one the author meant, so we reject.
        """
        if len(candidates) == 1:
            logger.debug("[CitationVerify] %s match: '%s' → '%s'", strategy, url, candidates[0].url)
            return candidates[0].url
        if len(candidates) > 1:
            logger.debug(
                "[CitationVerify] Ambiguous %s match for '%s' — %d candidates, rejecting",
                strategy,
                url,
                len(candidates),
            )
        return None

    def resolve_url(self, url: str) -> str | None:
        """Return the registry URL (full, as returned by the tool) when the report URL matches.

        Matching strategy (first unambiguous match wins):
        1. Exact match — raw or normalized
        2. Truncation — report URL is a prefix of exactly one registry URL (raw)
        3. Prefix — report normalized is prefix of registry normalized
        4. Child-path — report path is a subpath of exactly one registry URL
        5. Query-subset — same host+path, report params subset of one registry URL

        Always returns the tool's URL (with query params etc.). If multiple
        registry URLs match, we reject (ambiguous).
        """
        # 1. Exact match — raw or normalized; retain the tool's URL
        if url in self._urls:
            return self._urls[url].url
        normalized = normalize_url(url)
        if normalized in self._urls:
            return self._urls[normalized].url

        # 2. Truncation — report URL is a prefix of exactly one registry URL (raw).
        #    Normalized match fails when the report is cut mid-query (param order differs).
        truncation_entries = [e for e in self._urls.values() if e.url and e.url.startswith(url)]
        result = self._pick_unique(list({e.url: e for e in truncation_entries}.values()), "truncation", url)
        if result:
            return result

        # 3. Prefix match — report normalized is prefix of registry normalized
        #    Deduplicate by url to avoid raw+normalized keys for the same entry
        #    being counted as ambiguous.
        prefix_entries = [e for n, e in self._urls.items() if n.startswith(normalized)]
        result = self._pick_unique(
            list({e.url: e for e in prefix_entries}.values()),
            "prefix",
            url,
        )
        if result:
            return result

        parsed = urlparse(normalized)
        host, path = parsed.netloc, parsed.path
        same_host = [p for p in self._parsed_urls.values() if p.host == host]

        # 4. Child-path match — report path extends a registry path (subpage)
        #    Use rstrip("/") + "/" to enforce segment boundaries (prevents
        #    /us/benefits matching /us/benefitsOther).
        result = self._pick_unique(
            [
                p.entry
                for p in same_host
                if len(p.path_segments) >= 2 and path != p.path and path.startswith(p.path.rstrip("/") + "/")
            ],
            "child-path",
            url,
        )
        if result:
            return result

        # 5. Query-subset match — same host+path, report params are a subset of registry params
        report_qs = parse_qs(parsed.query, keep_blank_values=True)
        if report_qs:
            result = self._pick_unique(
                [
                    p.entry
                    for p in same_host
                    if p.path == path and p.query and all(p.query.get(k) == v for k, v in report_qs.items())
                ],
                "query-subset",
                url,
            )
            if result:
                return result

        return None

    def _entries_for_key(self, key: str) -> tuple[list[SourceEntry], int | None]:
        """Registry entries a citation key names, plus the page it asked for.

        Filename (case-insensitive) is the match. A key that carries a shelf
        qualifier — `Plan.pdf (Projektwissen), p.3`, emitted only when one
        filename was retrieved from several shelves in the same turn — narrows
        to the entries actually on that shelf.

        The narrowing is FAIL-OPEN: a qualifier that matches no entry is
        ignored rather than rejecting the key. Verification only ever removes
        citations, so a stricter reading here would silently cost an answer its
        source over a qualifier the model mistyped, and the unqualified filename
        was already proof enough that the document was retrieved.
        """
        target_file, target_shelf, target_page = parse_citation_ref(key)
        named = [(parse_citation_key(e.citation_key)[0].lower(), e) for e in self._citation_keys]
        matches: list[SourceEntry] = []
        for name in key_file_names(key, target_file):
            matches = [entry for entry_name, entry in named if entry_name == name.lower()]
            if matches:
                break
        if target_shelf:
            scoped = [entry for entry in matches if entry_shelf(entry) == target_shelf]
            if scoped:
                return scoped, target_page
        return matches, target_page

    def has_citation_key(self, key: str) -> bool:
        """Lenient match of a citation key against registry entries.

        Matches if filename (case-insensitive) matches ANY registry entry.
        Page numbers are not required to match — the LLM may cite a different
        page than what the knowledge layer returned, and that's acceptable
        since the document itself was verified as a real source.
        """
        return bool(self._entries_for_key(key)[0])

    def entry_for_url(self, url: str) -> SourceEntry | None:
        """Return the registry entry for a URL already resolved via ``resolve_url``.

        ``resolve_url`` returns the registry's canonical URL string, which is
        stored (raw and normalized) as a key to its entry, so an exact lookup
        recovers the owning :class:`SourceEntry` for origin-token labeling.
        """
        entry = self._urls.get(url)
        if entry is not None:
            return entry
        return self._urls.get(normalize_url(url))

    def entry_for_citation_key(self, key: str) -> SourceEntry | None:
        """Return the registry entry best matching ``key`` (lenient on the page).

        Identity matches :meth:`has_citation_key` — same filename match, same
        fail-open scope narrowing — but when the SAME document was retrieved at
        several pages, the entry whose page the citation actually names wins.
        The entry this returns is what supplies the wire's ``page``, and
        therefore the page the UI opens the PDF at; returning "whichever chunk
        landed in the registry first" made a citation to p.30 open at p.12
        whenever both were retrieved. Falls back to the first match (so a page
        the retrieval never returned still resolves to a real, retrieved page
        rather than to nothing).
        """
        matches, target_page = self._entries_for_key(key)
        if target_page is not None:
            for entry in matches:
                if parse_citation_key(entry.citation_key)[1] == target_page:
                    return entry
        return matches[0] if matches else None

    def all_sources(self) -> list[SourceEntry]:
        """Return all registered sources."""
        return list(self._all)

    def clear(self) -> None:
        """Reset the registry."""
        self._urls.clear()
        self._parsed_urls.clear()
        self._citation_keys.clear()
        self._citation_key_files.clear()
        self._all.clear()
