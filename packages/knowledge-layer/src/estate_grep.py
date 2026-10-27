"""``grep`` over the estate: wording, not meaning, in two stages, and never a silent no (ADR-0133 slice 4).

1. **Candidates.** The index's literal scan (``retriever.find_text``, the same one
   ``knowledge_search(match="exact"|"regex")`` runs) proposes the chunks that
   hold the pattern, under the scope filter of every collection the call covers
   (ADR-0116). ``find_text`` narrows its scroll by a Qdrant ``MatchText`` on the
   pattern's whole-token words only when that cannot drop a match
   (``qdrant.retrieval.literal_tokens``); a pattern that is part of a token, has
   no literal word, or is a regex the reader cannot prove a superset for is read
   over every chunk in scope. So stage 1 is a superset of the chunks that hold a
   match, or it says it is not.
2. **Verification.** The pattern runs on the document's stored page text
   (ADR-0134) when it has some, page by page: a breadcrumb is not on a page, so it
   cannot match, and a page is counted once, so an overlap cannot double a count.
   Without stored text it runs on each chunk's own text (``chunk_positions``,
   ADR-0133 slice 1): breadcrumb stripped, overlap removed.

**Incomplete is never "no".** A collection whose scan failed, a regex scan that
ran out of time, and a scan that stopped at its cap are each named, with the
mount they cost; such a result never renders as "no match".

Restricted folders are searched like ``knowledge_search`` searches them (search
is use): their matches are reported for the round's admission
(``note_collections_read``) and the result is withheld at round end when they may
not be used. The denominators count only what the person may see listed.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from aiq_agent.common.estate_paths import MOUNT_ROOTS
from aiq_agent.common.estate_paths import SHELF_MOUNTS
from aiq_agent.common.estate_paths import EstatePath
from aiq_agent.common.estate_paths import Mount
from aiq_agent.common.estate_paths import PathRefused
from aiq_agent.common.estate_paths import parse_estate_path

from . import stored_pages
from .browse import MAX_CONTEXT_LINES
from .browse import MAX_MATCH_CHUNKS
from .browse import MAX_MATCH_PASSAGES
from .browse import fold
from .browse import group_matches
from .browse import phrase_pattern
from .browse import stemmed_pattern
from .browse import user_pattern
from .chunk_positions import own_matches
from .estate import EstateFile
from .estate import ToolOutput
from .estate import _page_hit
from .estate import _render
from .estate import estate_file
from .estate import glob_files
from .estate import pages_label

logger = logging.getLogger(__name__)

OutputMode = Literal["files_with_matches", "content", "count"]
OUTPUT_MODES: tuple[str, ...] = ("files_with_matches", "content", "count")

#: Documents whose stored page text one grep reads to verify on (a range of pages each), and the seconds
#: it may spend doing it; the rest are verified on their chunks' own text, which is still exact.
MAX_STORED_VERIFY = 20
STORED_VERIFY_SECONDS = 3.0

#: Characters of one page a content-mode passage shows, a window around its first match.
PASSAGE_CHARS = 2500
#: How much of the window comes before the first match.
PASSAGE_LEAD = 600

#: Files one ``files_with_matches`` or ``count`` answer lists.
MAX_LISTED_FILES = 50

#: Lines the content mode's "lines around the matches" index shows.
MAX_CONTEXT_INDEX_LINES = 40

FOLDED = "case, ä/ae, ß/ss and hyphenation folded"


@dataclass
class DocumentMatches:
    """One document's verified matches: occurrences per page (``None`` for a page-less file)."""

    collection: str
    file_name: str
    shelf: str | None
    file: EstateFile | None
    pages: dict[int | None, int] = field(default_factory=dict)
    #: ``stored`` (page text, ADR-0134) or ``chunks`` (own chunk text).
    verified_on: str = "chunks"
    #: The page texts the content mode shows, by page.
    texts: dict[int | None, str] = field(default_factory=dict)

    @property
    def occurrences(self) -> int:
        return sum(self.pages.values())

    @property
    def numbered(self) -> list[int]:
        return sorted(page for page in self.pages if page is not None)


@dataclass
class Gap:
    """What a grep could not serve, and where: the reason a result is incomplete."""

    mount: str
    reason: str
    documents: int | None = None


@dataclass
class Query:
    """A grep's arguments, checked."""

    pattern: str
    mode: str
    compiled: Any
    store_pattern: str
    phrases: list[str]
    stemmed: bool
    timeout: float | None


class GrepRefused(ValueError):
    """A grep the backend will not run; the message is what the model reads."""


def compile_query(pattern: str, mode: str, stemmed: bool) -> Query:
    """The pattern for the store and for verification, or :class:`GrepRefused` with the rule. Pure."""
    from .qdrant.retrieval import USER_REGEX_TIMEOUT

    text = (pattern or "").strip()
    mode = (mode or "exact").strip().lower()
    if mode not in ("exact", "regex"):
        raise GrepRefused('`mode` is "exact" (the default, the pattern literally) or "regex" (a regular expression).')
    if mode == "regex":
        compiled, refusal = user_pattern(text)
        if compiled is None:
            raise GrepRefused(refusal.replace("`query`", "`pattern`"))
        return Query(text, mode, compiled, text, [text], False, USER_REGEX_TIMEOUT)
    if len(text) < 2 or not re.search(r"\w", text):
        raise GrepRefused("Provide a `pattern` of at least 2 characters: the word, number or phrase to find.")
    store = stemmed_pattern([text]) if stemmed else phrase_pattern([text])
    if store is None:
        raise GrepRefused("`pattern` is too long for a literal search: a word or a short phrase, not a sentence.")
    return Query(text, mode, re.compile(store), store, [text], bool(stemmed), None)


def scope_entries(entries: Sequence[Any], parsed: EstatePath | None) -> list[Any]:
    """The collections a path covers: every one for no path or ``/``, else the mount's."""
    if parsed is None or parsed.mount is None:
        return list(entries)
    from .browse import _entry_shelf

    return [entry for entry in entries if SHELF_MOUNTS.get(_entry_shelf(entry) or "") == parsed.mount]


def _mount_of_entry(entry: Any) -> str:
    from .browse import _entry_shelf

    mount = SHELF_MOUNTS.get(_entry_shelf(entry) or "")
    return MOUNT_ROOTS[mount].rstrip("/") if mount else "the index"


async def search(
    backend: Any,
    pattern: str,
    *,
    path: str | None = None,
    glob: str | None = None,
    output_mode: str = "files_with_matches",
    max_count: int | None = None,
    mode: str = "exact",
    stemmed: bool = False,
    context: int = 0,
    retriever: Any = None,
) -> ToolOutput:
    """``grep`` on the estate, with its Herleitung row (verb ``search``, mode ``exact`` or ``regex``)."""
    from aiq_agent.common.action_outcome import ActionOutcome
    from aiq_agent.common.estate_paths import action_place
    from aiq_agent.common.turn_status import ActionRow
    from aiq_agent.common.turn_status import lane_tool_scope

    row = ActionRow("search", query=pattern, mode=(mode or "exact").strip().lower(), **action_place(path))
    outcome = ActionOutcome()
    try:
        with lane_tool_scope("grep"):
            result = await _search(
                backend, pattern, path, glob, output_mode, max_count, mode, stemmed, context, retriever, outcome
            )
    except BaseException:
        row.finish("error")
        raise
    outcome.failed = outcome.failed or result.status == "error"
    outcome.settle(row, default="ok")
    return result


async def _search(
    backend: Any,
    pattern: str,
    path: str | None,
    glob: str | None,
    output_mode: str,
    max_count: int | None,
    mode: str,
    stemmed: bool,
    context: int,
    retriever: Any,
    outcome: Any,
) -> ToolOutput:
    if output_mode not in OUTPUT_MODES:
        return ToolOutput('`output_mode` is "files_with_matches", "content" or "count".', status="error")
    try:
        context_lines = max(0, min(int(context or 0), MAX_CONTEXT_LINES))
        query = compile_query(pattern, mode, stemmed)
        parsed = parse_estate_path(path, directory=True) if path and path.strip() not in ("", "/") else None
    except (GrepRefused, PathRefused) as refusal:
        return ToolOutput(str(refusal), status="error")
    except TypeError, ValueError:
        return ToolOutput(f"`context` is a number of lines from 0 to {MAX_CONTEXT_LINES}.", status="error")
    if parsed is not None and parsed.mount is None:
        return ToolOutput(f'No place "{parsed.path}". `ls("/")` lists the places there are.', status="error")
    listable = await backend.listable_files()
    searchable = listable + [file for file in await _restricted_files(backend) if file not in listable]
    narrowed, refusal = _narrowing(searchable, listable, parsed, glob)
    if refusal:
        return ToolOutput(refusal, status="error")
    entries = scope_entries(backend.entries(), parsed)
    if narrowed is not None:
        entries = [entry for entry in entries if entry.collection in narrowed]
    where = parsed.path.rstrip("/") if parsed is not None else "every place"
    searched_files = _searched(listable, parsed, narrowed)
    outcome.searched = len(searched_files)
    if not entries:
        return ToolOutput(_no_match(query, where, len(searched_files), []), status="ok")
    chunks, gaps = await _candidates(retriever, entries, query, backend.search_config, parsed, narrowed)
    if isinstance(chunks, ToolOutput):
        return chunks
    # A place whose scan never answered was not searched: it leaves the denominator, and the gap says so.
    unsearched = {gap.mount for gap in gaps if gap.reason in ("failed", "unavailable")}
    searched_files = [file for file in searched_files if MOUNT_ROOTS[file.mount].rstrip("/") not in unsearched]
    outcome.searched = len(searched_files)
    # Whatever could not be served (a place, the deadline, the cap) leaves the row a floor, never a full count.
    outcome.incomplete = bool(gaps)
    matches = await _verify(chunks, query, searchable, backend)
    outcome.record(
        sum(doc.occurrences for doc in matches),
        documents=len(matches),
        collections=[doc.collection for doc in matches],
    )
    if not matches:
        # Most of the scope WAS searched: the row is "no hit, incomplete", not a failure (the text says the same).
        return ToolOutput(_no_match(query, where, len(searched_files), gaps), status="ok")
    from aiq_agent.knowledge.restricted_use import note_collections_read

    # The listing names every matching file and counts its matches, which is content of each file it names:
    # reported for the round's admission (ADR-0088), beside the passages a grounding block reports itself.
    note_collections_read(doc.collection for doc in matches)
    head = _summary(query, where, matches, len(searched_files), gaps)
    if output_mode == "content":
        return _content(head, matches, query, context_lines, max_count, gaps)
    return ToolOutput("\n".join([*head, *_file_lines(matches, output_mode, max_count), *_gap_lines(gaps), _next()]))


async def _restricted_files(backend: Any) -> list[EstateFile]:
    """The documents of the restricted folders in scope, to put a path on their matches. Never listed."""
    from aiq_agent.knowledge.restricted_collections import is_restricted_collection

    from .estate import _rows_of

    entries = [entry for entry in backend.entries() if is_restricted_collection(entry.collection)]
    loader = getattr(backend, "_restricted_search_loader", None)
    rows = await (loader() if loader is not None else _rows_of(entries))
    files = [estate_file(row, restricted=True) for row in rows]
    return [file for file in files if file is not None]


def _narrowing(
    searchable: Sequence[EstateFile], listable: Sequence[EstateFile], parsed: EstatePath | None, glob: str | None
) -> tuple[dict[str, list[str]] | None, str]:
    """Per collection, the files a folder, file path or ``glob`` narrows to; ``None`` when nothing narrows."""
    if parsed is None and not glob:
        return None, ""
    files = list(searchable)
    if parsed is not None and parsed.leaf is not None and parsed.mount is not None:
        from .estate import resolve_in

        hit = resolve_in(files, parsed).file
        if hit is None:
            from .estate import no_such_file

            return None, no_such_file(parsed.path)
        files = [hit]
    elif parsed is not None and parsed.mount is not None and parsed.folder:
        folder = fold(parsed.folder)
        files = [
            file
            for file in files
            if file.mount == parsed.mount
            and (fold(file.row.folder) == folder or fold(file.row.folder).startswith(folder + "/"))
        ]
        if not any(not file.restricted for file in files):
            # A folder nothing listable is filed in is a folder that does not exist, restricted or not.
            return None, f'No folder "{parsed.path}". `ls("{MOUNT_ROOTS[parsed.mount]}")` lists what is there.'
    elif parsed is not None and parsed.mount is not None:
        if parsed.mount and not glob:
            return None, ""
    if glob:
        files = glob_files(files, glob, None)
    narrowed: dict[str, list[str]] = {}
    for file in files:
        narrowed.setdefault(file.row.collection, []).append(file.row.file_name)
    return narrowed, ""


def _searched(listable: Sequence[EstateFile], parsed: EstatePath | None, narrowed: dict[str, list[str]] | None) -> list:
    """The listable documents the grep covered: the denominator the answer states."""
    out = []
    for file in listable:
        if parsed is not None and parsed.mount is not None and file.mount != parsed.mount:
            continue
        if narrowed is not None and file.row.file_name not in narrowed.get(file.row.collection, ()):
            continue
        out.append(file)
    return out


async def _candidates(
    retriever: Any,
    entries: Sequence[Any],
    query: Query,
    search_config: Any,
    parsed: EstatePath | None,
    narrowed: dict[str, list[str]] | None,
) -> tuple[list[Any] | ToolOutput, list[Gap]]:
    """Stage 1: the chunks the index's literal scan proposes, per collection, and what it could not serve."""
    from .browse import _collection_filter
    from .browse import _entry_shelf
    from .qdrant.retrieval import PatternTooCostly
    from .register import _resolve_base_collection

    if retriever is None:
        from aiq_agent.knowledge.factory import get_active_retriever

        retriever = get_active_retriever()
    base = _resolve_base_collection(search_config) if search_config is not None else ""
    options: dict[str, Any] = {"user_regex": True} if query.mode == "regex" else {}
    if query.stemmed:
        options["stem_phrases"] = list(query.phrases)

    async def one(entry: Any) -> list[Any] | None:
        filters = _collection_filter(
            entry.collection,
            base=base,
            search_config=search_config,
            caller_filters=None,
            files=None if narrowed is None else narrowed.get(entry.collection, []),
        )
        found = await retriever.find_text(
            entry.collection, query.store_pattern, filters=filters, limit=MAX_MATCH_CHUNKS, **options
        )
        for chunk in found or ():
            chunk.metadata.setdefault("collection", entry.collection)
            if (shelf := _entry_shelf(entry)) is not None:
                chunk.metadata.setdefault("shelf", shelf)
        return found

    results = await asyncio.gather(*(one(entry) for entry in entries), return_exceptions=True)
    chunks: list[Any] = []
    gaps: list[Gap] = []
    answered = 0
    for entry, result in zip(entries, results, strict=True):
        mount = _mount_of_entry(entry)
        if isinstance(result, PatternTooCostly):
            if not result.scan:
                return ToolOutput(
                    "`pattern` is too costly: the regex backtracks on a passage (nested repetition such as `(a+)+`), "
                    "and the search was stopped. This is NOT a result, neither a hit nor a no. Rewrite it without "
                    'nested repetition, or use mode="exact".',
                    status="error",
                ), []
            gaps.append(Gap(mount, "deadline"))
            continue
        if isinstance(result, BaseException):
            logger.warning("grep: a collection's scan failed (%s)", type(result).__name__)
            gaps.append(Gap(mount, "failed"))
            continue
        if result is None:
            gaps.append(Gap(mount, "unavailable"))
            continue
        answered += 1
        chunks.extend(result)
        if len(result) >= MAX_MATCH_CHUNKS:
            gaps.append(Gap(mount, "capped"))
    if not answered and gaps and all(gap.reason in ("failed", "unavailable") for gap in gaps):
        return ToolOutput(
            "The full-text search could not be read just now. This is NOT a no: nothing was searched. "
            "Try again, or use `knowledge_search`.",
            status="error",
        ), []
    return chunks, _merged(gaps)


def _merged(gaps: list[Gap]) -> list[Gap]:
    seen: dict[tuple[str, str], Gap] = {}
    for gap in gaps:
        seen.setdefault((gap.mount, gap.reason), gap)
    return list(seen.values())


async def _verify(
    chunks: list[Any], query: Query, searchable: Sequence[EstateFile], backend: Any
) -> list[DocumentMatches]:
    """Stage 2: the pattern on the stored page text where there is some, else on each chunk's own text."""
    by_key = {(file.row.collection, file.row.file_name): file for file in searchable}
    groups = group_matches(
        chunks, query.compiled, timeout=query.timeout, store_decides=query.stemmed, collect_strings=False
    )
    docs: list[DocumentMatches] = []
    for group in groups:
        doc = DocumentMatches(
            collection=group.collection,
            file_name=group.file_name,
            shelf=group.shelf,
            file=by_key.get((group.collection, group.file_name)),
        )
        for chunk in group.chunks:
            own = group.own.get(chunk.chunk_id)
            count = sum(1 for _ in own_matches(own, query.compiled, query.timeout)) if own is not None else 0
            page = chunk.page_number if getattr(chunk, "page_number", None) else None
            doc.pages[page] = doc.pages.get(page, 0) + max(count, 1 if query.stemmed else 0)
            if own is not None:
                text = (own.text[: own.repeat_start] + own.text[own.repeat_end :]).strip()
                doc.texts[page] = f"{doc.texts[page]}\n\n{text}" if page in doc.texts else text
        doc.pages = {page: n for page, n in doc.pages.items() if n}
        if doc.pages:
            docs.append(doc)
    if not query.stemmed:
        docs = await _verify_on_stored(docs, query, backend)
    return docs


async def _verify_on_stored(docs: list[DocumentMatches], query: Query, backend: Any) -> list[DocumentMatches]:
    """Recount each candidate on its stored pages (a bounded number of documents, within a deadline)."""
    deadline = time.monotonic() + STORED_VERIFY_SECONDS
    reader = getattr(backend, "_stored_reader", None) or stored_pages.read_stored
    candidates = [doc for doc in docs if doc.file is not None and doc.file.paged][:MAX_STORED_VERIFY]

    async def recount(doc: DocumentMatches) -> None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            text = await asyncio.wait_for(reader(doc.collection, doc.file_name), remaining)
        except Exception:  # noqa: BLE001 - verification on the chunks stands
            return
        if text is None or not text.pages:
            return
        pages: dict[int | None, int] = {}
        texts: dict[int | None, str] = {}
        for page in text.pages:
            found = _count(query, page.text)
            if found:
                pages[page.number] = found
                texts[page.number] = page.text
        doc.pages, doc.texts, doc.verified_on = pages, texts, "stored"

    await asyncio.gather(*(recount(doc) for doc in candidates))
    return [doc for doc in docs if doc.pages]


def _count(query: Query, text: str) -> int:
    if query.timeout is None:
        return sum(1 for match in query.compiled.finditer(text) if match.end() > match.start())
    try:
        return sum(1 for match in query.compiled.finditer(text, timeout=query.timeout) if match.end() > match.start())
    except TimeoutError:
        return 0


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _display_path(doc: DocumentMatches) -> str:
    if doc.file is not None:
        return doc.file.path
    from aiq_agent.common.estate_paths import estate_path

    return estate_path(doc.shelf, None, doc.file_name) or doc.file_name


def _pages_text(doc: DocumentMatches) -> str:
    numbered = doc.numbered
    return f"p.{pages_label(numbered)}" if numbered else "no pages"


def _summary(
    query: Query, where: str, docs: Sequence[DocumentMatches], searched: int, gaps: Sequence[Gap]
) -> list[str]:
    kind = "regex" if query.mode == "regex" else "exact"
    total = sum(doc.occurrences for doc in docs)
    folded = "" if query.mode == "regex" else f"; {FOLDED}"
    incomplete = "; INCOMPLETE, see below" if any(gap.reason != "capped" for gap in gaps) else ""
    return [
        f'grep ({kind}) "{query.pattern}" in {where}: {total} occurrence{"" if total == 1 else "s"} in '
        f"{len(docs)} file{'' if len(docs) == 1 else 's'} ({searched} files searched{folded}{incomplete})"
    ]


def _file_lines(docs: Sequence[DocumentMatches], output_mode: str, max_count: int | None) -> list[str]:
    limit = min(MAX_LISTED_FILES, max_count) if max_count else MAX_LISTED_FILES
    lines = []
    for doc in docs[:limit]:
        if output_mode == "count":
            lines.append(f"{_display_path(doc)}: {doc.occurrences}")
        else:
            lines.append(f"{_display_path(doc)}: {doc.occurrences}× {_pages_text(doc)}")
    if len(docs) > limit:
        lines.append(f"… {len(docs) - limit} more files with a match: narrow the path or the pattern.")
    return lines


def _gap_lines(gaps: Sequence[Gap]) -> list[str]:
    words = {
        "deadline": "not searched to the end (the regex scan ran out of time)",
        "failed": "not searched (the store did not answer)",
        "unavailable": "not searched (no full-text index here)",
        "capped": f"searched until {MAX_MATCH_CHUNKS} matching passages; there may be more",
    }
    lines = [f"incomplete: {gap.mount} {words.get(gap.reason, gap.reason)}." for gap in gaps]
    if any(gap.reason != "capped" for gap in gaps):
        lines.append("An incomplete search is NOT a no for what was not searched.")
    return lines


def _next() -> str:
    return (
        'An index, not a source: `read_file` the pages to cite them, or `grep` with output_mode="content" for '
        "citable passages."
    )


def _no_match(query: Query, where: str, searched: int, gaps: Sequence[Gap]) -> str:
    if any(gap.reason != "capped" for gap in gaps):
        return "\n".join(
            [
                f'No match for "{query.pattern}" in what could be searched of {where} ({searched} files).',
                *_gap_lines(gaps),
            ]
        )
    return (
        f'No match for "{query.pattern}" in {searched} files of {where}. A solid no for the WORDING, not the '
        "topic: `knowledge_search` finds it by meaning."
    )


def _window(text: str, query: Query) -> tuple[str, bool]:
    """The page, or a window of it around its first match when it is long: verbatim either way."""
    if len(text) <= PASSAGE_CHARS:
        return text, False
    first = next(iter(query.compiled.finditer(text)), None) if query.timeout is None else None
    start = max(0, (first.start() if first is not None else 0) - PASSAGE_LEAD)
    return text[start : start + PASSAGE_CHARS], True


def _content(
    head: list[str],
    docs: Sequence[DocumentMatches],
    query: Query,
    context: int,
    max_count: int | None,
    gaps: Sequence[Gap],
) -> ToolOutput:
    """Passages as grounding blocks, one per matching page, round-robin over the files; then the lines index."""
    limit = min(MAX_MATCH_PASSAGES, max_count) if max_count else MAX_MATCH_PASSAGES
    picked: list[tuple[DocumentMatches, int | None]] = []
    depth = 0
    queues = [sorted(doc.pages, key=lambda page: page or 0) for doc in docs]
    while len(picked) < limit and any(depth < len(queue) for queue in queues):
        for doc, queue in zip(docs, queues, strict=True):
            if depth < len(queue) and len(picked) < limit:
                picked.append((doc, queue[depth]))
        depth += 1
    hits = []
    for doc, page in picked:
        file = doc.file
        text = doc.texts.get(page, "")
        if file is None or not text:
            continue
        body, cut = _window(text, query)
        page_obj = stored_pages.Page(number=page or 0, text=body, source="text_layer")
        hit = _page_hit(file, page_obj, budget=PASSAGE_CHARS, paged=page is not None)
        hits.append(hit.model_copy(update={"body_truncated": cut}) if cut else hit)
    lines = [*head, *_file_lines(docs, "files_with_matches", max_count), *_gap_lines(gaps)]
    trailer = _context_index(picked, query, context)
    if not hits:
        return ToolOutput("\n".join([*lines, _next()]))
    return _render(tuple(hits), preamble="\n".join(lines), notices=[], trailer=trailer, tool="grep")


def _context_index(picked: Sequence[tuple[DocumentMatches, int | None]], query: Query, context: int) -> str:
    """``<path>#page=N`` lines with each match and ``context`` lines around it: an index under the passages."""
    out: list[str] = []
    for doc, page in picked:
        text = doc.texts.get(page, "")
        if not text:
            continue
        lines = text.split("\n")
        for number, line in enumerate(lines):
            if not _count(query, line):
                continue
            start, end = max(0, number - context), min(len(lines), number + context + 1)
            where = f"{_display_path(doc)}#page={page}" if page is not None else _display_path(doc)
            out.append(f"{where}:")
            out.extend(f"> {item}" for item in lines[start:end])
            if len(out) >= MAX_CONTEXT_INDEX_LINES:
                break
        if len(out) >= MAX_CONTEXT_INDEX_LINES:
            break
    if not out:
        return ""
    return (
        "## Lines around the matches\n"
        + "\n".join(out[:MAX_CONTEXT_INDEX_LINES])
        + "\nCite the passages above, not these lines."
    )


def mount_label(mount: Mount | None) -> str:
    return MOUNT_ROOTS[mount].rstrip("/") if mount else "every place"
