"""The office's documents as a read-only filesystem: Piloti's estate backend (ADR-0133).

``ls``, ``glob``, ``grep`` and ``read_file`` serve one namespace
(``aiq_agent.common.estate_paths``): ``/project/``, ``/office/``, ``/chat/`` and
``/law/oib/`` are the shelves the turn's scope names, and ``/drafts/`` is the
conversation's working directory, which the tool layer routes to the draft store
before anything here is asked. This module is everything below the tool layer
for the four estate mounts: which files exist, which path names which document,
and what a read or a search returns.

**Tenant and scope come from the turn, never from an argument.** The rows are the
turn's inventory (``browse._turn_rows``), the collections its signed scope names
(``search_scope.resolve_scoped_collections``, narrowed to the turn's shelves), read
from the per-turn context like every other knowledge-layer tool. The same
backend instance therefore serves every turn of every tenant.

**Listing hides, reading admits (ADR-0088).** A restricted folder's document is
never listed and never suggested. A path to it resolves only once this turn may
name its collection (:func:`may_name`, i.e. a search returned it and the round
admitted it); before that, a guessed path gets exactly the answer a path that
does not exist gets. The text then goes through the round's admission like any
other result.

**Every read is a grounding block.** One block per page, rendered by
``render_grounding_block`` (ADR-0061), so citation capture, quote verification
and the Herleitung read a ``read_file`` exactly as they read a ``read_passage``;
the citation key stays ``<file>, p.N``. Pages come from the stored page text
(ADR-0134, ``stored_pages``) when the document has it, else from its chunks.
"""

from __future__ import annotations

import asyncio
import difflib
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from dataclasses import replace
from typing import TYPE_CHECKING
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.backends.protocol import EditResult
from deepagents.backends.protocol import FileInfo
from deepagents.backends.protocol import GlobResult
from deepagents.backends.protocol import GrepResult
from deepagents.backends.protocol import LsResult
from deepagents.backends.protocol import ReadResult
from deepagents.backends.protocol import WriteResult

from aiq_agent.common.citation_collector import note_citations
from aiq_agent.common.estate_paths import ESTATE_MOUNTS
from aiq_agent.common.estate_paths import MOUNT_ROOTS
from aiq_agent.common.estate_paths import SHELF_MOUNTS
from aiq_agent.common.estate_paths import TEXT_EXTENSIONS
from aiq_agent.common.estate_paths import EstatePath
from aiq_agent.common.estate_paths import Mount
from aiq_agent.common.estate_paths import PathRefused
from aiq_agent.common.estate_paths import action_place
from aiq_agent.common.estate_paths import asked_document
from aiq_agent.common.estate_paths import estate_path
from aiq_agent.common.estate_paths import file_name_candidates
from aiq_agent.common.estate_paths import parse_estate_path

from . import stored_pages
from .browse import FileRow
from .browse import file_rows
from .browse import fold

if TYPE_CHECKING:
    from .estate_listing import Listing

logger = logging.getLogger(__name__)

#: The tool names, spelled once: the hits' lane stamp and the Herleitung read them.
READ_FILE_TOOL = "read_file"
LS_TOOL = "ls"
GLOB_TOOL = "glob"
GREP_TOOL = "grep"

#: Characters one read returns (about 6k tokens), today's ``read_passage._MAX_READ_CHARS``. A read stops at
#: a page boundary past it and names the next call.
MAX_READ_CHARS = 24_000

#: Pages one ``pages=`` may ask for, today's ``read_passage._MAX_RANGE_PAGES``.
MAX_READ_PAGES = 30

#: Lines a text file read returns by default, the stock ``read_file``'s default.
DEFAULT_LINE_LIMIT = 100

#: How many paths a miss suggests, and how alike a name must be to be suggested.
MAX_SUGGESTIONS = 3
SUGGESTION_CUTOFF = 0.6

#: Image files: served as their caption, page-less (agent-filesystem.md §2).
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif")

#: An IFC model is a measurement source, not a passage: it gets no citable block.
MODEL_EXTENSIONS = (".ifc",)

_PAGES_ITEM = re.compile(r"^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$")


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EstateFile:
    """One document as the estate serves it: its row, its mount and its path."""

    row: FileRow
    mount: Mount
    path: str
    #: A restricted folder's document; resolvable only once its collection may be named.
    restricted: bool = False

    @property
    def leaf(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    @property
    def paged(self) -> bool:
        """Whether the document has pages to address; a text file has lines, an image has neither."""
        name = self.row.file_name.lower()
        return not name.endswith((*TEXT_EXTENSIONS, *IMAGE_EXTENSIONS, *MODEL_EXTENSIONS))


def estate_file(row: FileRow, *, restricted: bool = False) -> EstateFile | None:
    """``row`` placed in the namespace, or ``None`` when its shelf has no mount."""
    shelf = row.shelf or ""
    mount = SHELF_MOUNTS.get(shelf)
    path = estate_path(shelf, row.folder, row.file_name)
    if mount is None or path is None:
        return None
    return EstateFile(row=row, mount=mount, path=path, restricted=restricted)


@dataclass
class Resolution:
    """What a path resolved to: one file, or a miss with the names to suggest."""

    file: EstateFile | None
    #: A line the read says ahead of the text (the file has moved to another folder).
    note: str = ""
    suggestions: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# What a tool returns
# ---------------------------------------------------------------------------


@dataclass
class ToolOutput:
    """The text the model reads, and the passages in it."""

    text: str
    hits: tuple[Any, ...] = ()
    #: ``ok`` | ``empty`` | ``error``: the call's Herleitung outcome and whether the result is an error.
    status: str = "ok"


def no_such_file(path: str, suggestions: Sequence[str] = ()) -> str:
    """The one answer for a path that names nothing the turn may see: a miss and a restricted guess alike."""
    text = f'No file "{path}".'
    if suggestions:
        text += " Did you mean:\n" + "\n".join(f"- {name}" for name in suggestions[:MAX_SUGGESTIONS])
    return (
        text + "\n`ls` a folder or `glob` by name to see what exists; `grep` finds wording, `knowledge_search` meaning."
    )


# ---------------------------------------------------------------------------
# Page addresses
# ---------------------------------------------------------------------------


class PagesRefused(ValueError):
    """A ``pages=`` the reader cannot serve; the message is what the model reads."""


def parse_pages(raw: Any) -> list[int] | None:
    """``"3"``, ``"3-5"`` or ``"3,7,11"`` as the page numbers, in the order asked, without repeats. Pure.

    ``None`` for no ``pages``. More than :data:`MAX_READ_PAGES` pages, or an
    item that is not a page or a range, raises :class:`PagesRefused`.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    numbers: list[int] = []
    for item in text.split(","):
        found = _PAGES_ITEM.match(item.strip().lower().removeprefix("p.").removeprefix("s."))
        if found is None:
            raise PagesRefused(f'`pages` takes "3", "3-5" or "3,7,11"; got {text!r}.')
        first = int(found.group(1))
        last = int(found.group(2) or first)
        if first < 1 or last < first:
            raise PagesRefused(f"`pages` counts from 1, first page before last; got {text!r}.")
        numbers.extend(range(first, last + 1))
        if len(numbers) > MAX_READ_PAGES:
            raise PagesRefused(f"At most {MAX_READ_PAGES} pages per read; split {text!r} into several reads.")
    return list(dict.fromkeys(numbers))


def pages_label(numbers: Sequence[int]) -> str:
    """``[3, 4, 5, 9]`` as ``"3-5, 9"``. Pure."""
    ordered = sorted(set(numbers))
    parts: list[str] = []
    start = previous = None
    for number in ordered:
        if start is None:
            start = previous = number
            continue
        if number == previous + 1:
            previous = number
            continue
        parts.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = number
    if start is not None:
        parts.append(str(start) if start == previous else f"{start}-{previous}")
    return ", ".join(parts)


def pages_for_lines(pages: Sequence[stored_pages.Page], offset: int, limit: int) -> list[int]:
    """The pages a line window ``[offset, offset+limit)`` falls on, counting the pages' lines in order. Pure."""
    first_line = max(0, offset)
    last_line = first_line + max(1, limit)
    out: list[int] = []
    position = 0
    for page in pages:
        lines = max(1, page.text.count("\n") + 1)
        if position < last_line and position + lines > first_line:
            out.append(page.number)
        position += lines
    return out or ([pages[-1].number] if pages else [])


# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------


class EstateBackend(BackendProtocol):
    """The estate mounts, async and read-only, over the knowledge layer.

    ``search_config`` is the ``knowledge_retrieval`` instance whose scope the
    files are read through (the same one ``read_passage`` and ``list_files``
    read through, so the three cannot drift). The constructor reads nothing:
    the agent builds one at boot and every turn reads its own scope.

    The protocol methods (``als``, ``aread``, ``aglob``, ``agrep``) answer in
    the protocol's types, for any caller that holds a ``BackendProtocol``; the
    tools call the richer methods (:meth:`read_file` and the others), which
    return the text the model reads. Writes are refused: nothing under the
    estate is writable through a filesystem verb
    (``piloti-filesystem-design.md`` §2).
    """

    def __init__(
        self,
        search_config: Any,
        *,
        page_reader: Any = None,
        rows_loader: Any = None,
        restricted_loader: Any = None,
        retriever: Any = None,
    ) -> None:
        self.search_config = search_config
        self._page_reader = page_reader or stored_pages.read_pages
        self._rows_loader = rows_loader
        self._restricted_loader = restricted_loader
        #: ``None``: the knowledge layer's active retriever, looked up per call.
        self._retriever = retriever

    # -- scope -----------------------------------------------------------------

    def entries(self) -> list[Any]:
        """The collections this turn may read, with their shelves, narrowed to the turn's shelves."""
        from .browse import _session_collection
        from .search_scope import resolve_base_collection
        from .search_scope import resolve_scoped_collections
        from .search_scope import restrict_scope_to_turn

        config = self.search_config
        return list(
            restrict_scope_to_turn(
                resolve_scoped_collections(config, _session_collection(), resolve_base_collection(config))
            )
        )

    async def listable_files(self) -> list[EstateFile]:
        """Every document the turn may LIST: never one of a restricted folder (listing is not use)."""
        rows = await (self._rows_loader() if self._rows_loader is not None else self._load_rows())
        files = [estate_file(row) for row in rows]
        return [file for file in files if file is not None]

    async def readable_files(self) -> list[EstateFile]:
        """The listable documents, plus those of restricted folders this turn may already name."""
        listable = await self.listable_files()
        restricted = await (
            self._restricted_loader() if self._restricted_loader is not None else self._load_restricted_rows()
        )
        extra = [estate_file(row, restricted=True) for row in restricted]
        return listable + [file for file in extra if file is not None]

    async def _load_rows(self) -> list[FileRow]:
        """The turn's inventory rows, with the base corpus added when the inventory does not carry it."""
        from aiq_agent.knowledge.restricted_collections import is_restricted_collection

        from .browse import _turn_rows
        from .browse import restrict_rows_to_turn

        rows = restrict_rows_to_turn(await _turn_rows(self.search_config)).rows
        entries = self.entries()
        held = {row.collection for row in rows}
        missing = [
            entry
            for entry in entries
            if entry.collection not in held
            and _entry_shelf(entry) == "base"
            and not is_restricted_collection(entry.collection)
        ]
        rows = list(rows) + await _rows_of(missing)
        in_scope = {entry.collection for entry in entries}
        return [row for row in rows if row.collection in in_scope]

    async def _load_restricted_rows(self) -> list[FileRow]:
        """Rows of the restricted folders in scope that this turn may already name (:func:`may_name`)."""
        from aiq_agent.knowledge.restricted_collections import is_restricted_collection
        from aiq_agent.knowledge.restricted_use import may_name

        admitted = [
            entry
            for entry in self.entries()
            if is_restricted_collection(entry.collection) and may_name(entry.collection)
        ]
        return await _rows_of(admitted)

    # -- resolution ------------------------------------------------------------

    async def resolve(self, parsed: EstatePath) -> Resolution:
        """The document ``parsed`` names, or a miss (with suggestions drawn only from listable rows).

        The leaf identifies a document inside its mount; the folder part is a
        hint. A stale folder still resolves, with a note saying where the file
        is now. A restricted folder's document needs its folder named: without
        it the listable one of that name wins, and with none it is a miss.
        """
        files = await self.readable_files()
        return resolve_in(files, parsed)

    # -- read_file -------------------------------------------------------------

    async def read_file(
        self,
        file_path: str,
        *,
        pages: Any = None,
        clause: Any = None,
        offset: int = 0,
        limit: int = DEFAULT_LINE_LIMIT,
    ) -> ToolOutput:
        """``read_file`` on the estate: grounding blocks, one per page (agent-filesystem.md §3)."""
        from aiq_agent.common.turn_status import ActionRow
        from aiq_agent.common.turn_status import lane_tool_scope

        # Running, the row says what the model asked to read, in its own words; settled, what it may name.
        row = ActionRow("read", target=asked_document(file_path))
        try:
            with lane_tool_scope(READ_FILE_TOOL):
                output, facts = await self._read_body(file_path, pages, clause, offset, limit)
        except BaseException:
            row.finish("error")
            raise
        _settle_read(row, output, facts, asked=_pages_field(pages, clause))
        return output

    async def _read_body(
        self, file_path: str, pages: Any, clause: Any, offset: int, limit: int
    ) -> tuple[ToolOutput, ReadRowFacts]:
        """The read, and what its row may say: the resolved document only when ``may_name`` (ADR-0088)."""
        from aiq_agent.knowledge.restricted_use import may_name

        try:
            parsed = parse_estate_path(file_path)
        except PathRefused as refusal:
            return ToolOutput(str(refusal), status="error"), ReadRowFacts()
        if parsed.mount is None or parsed.leaf is None:
            return ToolOutput(_directory_message(parsed.path), status="error"), ReadRowFacts()
        if fold(parsed.leaf) == "readme.md":
            card = await self._folder_card(parsed)
            if card is not None:
                folder = parsed.path[: -len(parsed.leaf)]
                return ToolOutput(card.text), ReadRowFacts(card_folder=folder, card=card)
        resolution = await self.resolve(parsed)
        file = resolution.file
        if file is None:
            # A miss and a guessed restricted path alike: the name the model asked for, and nothing it did not.
            miss = ToolOutput(no_such_file(parsed.path, resolution.suggestions), status="error")
            return miss, ReadRowFacts(target=asked_document(parsed.path), missing=True)
        facts = ReadRowFacts(target=file.row.file_name if may_name(file.row.collection) else None, shelf=file.row.shelf)
        if file.row.file_name.lower().endswith(MODEL_EXTENSIONS):
            return ToolOutput(_model_message(file)), facts
        clause_text = str(clause).strip().strip(".") if clause is not None else ""
        if clause_text:
            return await self._read_clause(file, clause_text, resolution.note), facts
        try:
            wanted = parse_pages(pages)
        except PagesRefused as refusal:
            return ToolOutput(str(refusal), status="error"), replace(facts, refused_pages=True)
        output = await self._read_pages(file, wanted, offset, limit, resolution.note)
        return output, facts

    async def _page_text(self, file: EstateFile, wanted: set[int] | None) -> stored_pages.PageText | None:
        return await self._page_reader(file.row.collection, file.row.file_name, wanted=wanted)

    async def _read_pages(
        self, file: EstateFile, wanted: list[int] | None, offset: int, limit: int, note: str
    ) -> ToolOutput:
        try:
            text = await self._page_text(file, set(wanted) if wanted else None)
        except Exception:  # noqa: BLE001 - an outage is said as one, never as an empty document
            logger.warning("estate read: the store could not be read for a document", exc_info=True)
            return ToolOutput(_store_down(file), status="error")
        if text is None or (not text.pages and not (wanted and text.page_count)):
            return ToolOutput(_empty_message(file), status="empty")
        if not file.paged:
            return self._render_window(file, text, offset, limit, note)
        mapped_note = ""
        if wanted is None and (offset > 0 or limit != DEFAULT_LINE_LIMIT):
            wanted = pages_for_lines(text.pages, offset, limit)
            mapped_note = (
                f"This document has pages: offset/limit were read as lines and mapped to page(s) "
                f"{pages_label(wanted)}. Address pages with pages= next time."
            )
        outline = ""
        if wanted is None:
            first = next((page.number for page in text.pages if page.text.strip()), text.pages[0].number)
            wanted = [first]
            outline = await self._outline(file)
        return self._render_pages(file, text, wanted, note=note, extra_note=mapped_note, outline=outline)

    def _render_pages(
        self,
        file: EstateFile,
        text: stored_pages.PageText,
        wanted: list[int],
        *,
        note: str,
        extra_note: str,
        outline: str,
    ) -> ToolOutput:
        served: list[stored_pages.Page] = []
        missing: list[int] = []
        used = 0
        stopped_at: int | None = None
        for number in wanted:
            page = text.by_number.get(number)
            if page is None:
                missing.append(number)
                continue
            if served and used + len(page.text) > MAX_READ_CHARS:
                stopped_at = number
                break
            served.append(page)
            used += len(page.text)
        if not served:
            beyond = text.page_count and max(wanted) > text.page_count
            message = (
                f"{file.path} has {text.page_count} page(s); page(s) {pages_label(wanted)} do not exist."
                if beyond
                else f"Page(s) {pages_label(wanted)} of {file.path} hold no text."
            )
            return ToolOutput(message, status="empty")
        hits = tuple(_page_hit(file, page, budget=MAX_READ_CHARS) for page in served)
        preamble = _read_preamble(file, text, served)
        notices = [line for line in (note, extra_note, _older_revision_notice(file)) if line]
        trailer = _read_trailer(file, text, served, wanted, missing, stopped_at, outline)
        return _render(hits, preamble=preamble, notices=notices, trailer=trailer, tool=READ_FILE_TOOL)

    def _render_window(
        self, file: EstateFile, text: stored_pages.PageText, offset: int, limit: int, note: str
    ) -> ToolOutput:
        """A page-less file (text, image caption): one block of lines ``[offset, offset+limit)``."""
        lines = "\n\n".join(page.text for page in text.pages if page.text).split("\n")
        start = max(0, offset)
        end = min(len(lines), start + max(1, limit))
        if start >= len(lines):
            return ToolOutput(f"{file.path} has {len(lines)} line(s); offset {offset} is past the end.", status="empty")
        window = "\n".join(lines[start:end])
        page = stored_pages.Page(
            number=0, text=window, source=text.pages[0].source, content_types=text.pages[0].content_types
        )
        hit = _page_hit(file, page, budget=MAX_READ_CHARS, paged=False)
        preamble = (
            f"{file.path}, lines {start + 1}-{end} of {len(lines)}. The block is one citable passage; "
            "cite its Citation line."
        )
        trailer = f"Next: offset={end}." if end < len(lines) else "That is the whole file."
        notices = [line for line in (note, _rebuilt_line(text)) if line]
        return _render((hit,), preamble=preamble, notices=notices, trailer=trailer, tool=READ_FILE_TOOL)

    async def _outline(self, file: EstateFile) -> str:
        """The document's Gliederung, as ``read_passage`` builds it; empty when it has none or the read fails."""
        from .read_passage import PassageTarget
        from .read_passage import _outline_block
        from .read_passage import outline_for

        target = PassageTarget(collection=file.row.collection, file_name=file.row.file_name, shelf=file.row.shelf)
        try:
            outline = await outline_for([target], file.row.file_name)
        except Exception:  # noqa: BLE001 - the outline is an index beside the page, never worth the read
            logger.info("estate read: no outline for a document", exc_info=True)
            return ""
        return _outline_block(outline.entries) if outline.entries else ""

    async def _read_clause(self, file: EstateFile, clause: str, note: str) -> ToolOutput:
        """One Punkt: the chunks that carry it, as ``read_passage(clause=…)`` opens them."""
        from .read_passage import PassageTarget
        from .read_passage import _addresses
        from .read_passage import _clause_sort_key
        from .read_passage import _fetch_all
        from .read_passage import _passage_filters

        target = PassageTarget(collection=file.row.collection, file_name=file.row.file_name, shelf=file.row.shelf)
        fetched = await _fetch_all([target], lambda name: _passage_filters(name, clause, None), clause, 12)
        chunks = sorted((chunk for chunk in fetched.chunks if _addresses(chunk, clause, None)), key=_clause_sort_key)
        if fetched.failures and not chunks:
            return ToolOutput(_store_down(file), status="error")
        if not chunks:
            return ToolOutput(
                f'{file.path} has no Punkt "{clause}". `read_file` without `clause` returns its Gliederung.',
                status="empty",
            )
        hits = tuple(_chunk_hit(file, chunk) for chunk in chunks[:12])
        preamble = f"{file.path}, Punkt {clause}. Each block is one citable passage; cite its Citation line."
        notices = [line for line in (note, _older_revision_notice(file)) if line]
        return _render(hits, preamble=preamble, notices=notices, trailer="", tool=READ_FILE_TOOL)

    # -- ls, glob and the folder card ---------------------------------------------

    async def _abstracts(self, files: Sequence[EstateFile], mount: Mount | None) -> dict[str, list[str]]:
        """The written folder abstracts (tier 1) of ``mount``'s collections; empty off a chat turn or on any error."""
        from aiq_agent.knowledge.folder_cards import listing_abstracts

        from .estate_listing import abstracts_by_folder
        from .estate_listing import collections_of

        collections = collections_of([file for file in files if file.mount == mount])
        try:
            return abstracts_by_folder(await listing_abstracts(collections))
        except Exception:  # noqa: BLE001 - the abstract is a line beside the counts, never worth the listing
            logger.info("estate: no folder abstracts", exc_info=True)
            return {}

    async def _folder_card(self, parsed: EstatePath) -> Listing | None:
        """``<folder>/README.md`` as the folder's card, unless a real document holds that name there."""
        from .estate_listing import has_real_readme
        from .estate_listing import render_readme
        from .estate_listing import stored_folder

        files = await self.listable_files()
        if parsed.mount is None:
            return None
        folder = stored_folder(files, parsed.mount, "" if parsed.mount == "law" else parsed.folder)
        if folder is None or has_real_readme(files, parsed.mount, folder):
            return None
        return render_readme(files, parsed, abstracts=await self._abstracts(files, parsed.mount))

    async def ls(self, path: str | None, *, depth: int = 1, drafts: bool = False) -> ToolOutput:
        """``ls`` on the estate (agent-filesystem.md §3): a folder, or the tree as folder cards. An index."""
        from aiq_agent.common.turn_status import ActionRow

        from .estate_listing import render_folder
        from .estate_listing import render_root

        row = ActionRow("list", **action_place(path))
        try:
            try:
                parsed = parse_estate_path(path, directory=True)
            except PathRefused as refusal:
                row.finish("error")
                return ToolOutput(str(refusal), status="error")
            files = await self.listable_files()
            if parsed.mount is None and parsed.path == "/":
                listing = render_root(files, drafts=drafts)
            else:
                in_flight = await _in_flight([file for file in files if file.mount == parsed.mount])
                listing = render_folder(
                    files,
                    parsed,
                    abstracts=await self._abstracts(files, parsed.mount),
                    in_flight=in_flight,
                    depth=max(1, min(int(depth or 1), 4)),
                )
        except BaseException:
            row.finish("error")
            raise
        _settle_listing(row, listing)
        return ToolOutput(listing.text, status="error" if listing.error else "ok")

    async def glob(self, pattern: str, path: str | None = None) -> ToolOutput:
        """``glob`` on the estate: file names, ``* ** ? [abc] {a,b}``, folded. An index."""
        from aiq_agent.common.turn_status import ActionRow

        from .estate_listing import render_glob

        # A name pattern is what was looked for: the row's query, beside the place it was looked in.
        row = ActionRow("list", query=(pattern or "").strip(), **action_place(path))
        try:
            if path:
                try:
                    parse_estate_path(path, directory=True)
                except PathRefused as refusal:
                    row.finish("error")
                    return ToolOutput(str(refusal), status="error")
            listing = render_glob(await self.listable_files(), pattern, path)
        except BaseException:
            row.finish("error")
            raise
        row.finish("ok" if listing.files else "empty", counts={"files": listing.files})
        return ToolOutput(listing.text, status="ok")

    async def grep(
        self,
        pattern: str,
        *,
        path: str | None = None,
        glob: str | None = None,
        output_mode: str = "files_with_matches",
        max_count: int | None = None,
        mode: str = "exact",
        stemmed: bool = False,
        context: int = 0,
    ) -> ToolOutput:
        """``grep`` on the estate: wording in two stages, never a silent no (``estate_grep``)."""
        from .estate_grep import search

        return await search(
            self,
            pattern,
            path=path,
            glob=glob,
            output_mode=output_mode,
            max_count=max_count,
            mode=mode,
            stemmed=stemmed,
            context=context,
            retriever=self._retriever,
        )

    # -- the protocol ------------------------------------------------------------

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        """The protocol's read: the document's text as lines, pages marked ``<!-- page N -->``. Not evidence."""
        from deepagents.backends.utils import slice_read_response

        try:
            parsed = parse_estate_path(file_path)
        except PathRefused:
            return ReadResult(error="invalid_path")
        if parsed.mount is None or parsed.leaf is None:
            return ReadResult(error="is_directory")
        file = (await self.resolve(parsed)).file
        if file is None:
            return ReadResult(error="file_not_found")
        text = await self._page_text(file, None)
        if text is None:
            return ReadResult(error="file_not_found")
        body = "\n".join(f"<!-- page {page.number} -->\n{page.text}" for page in text.pages)
        return slice_read_response({"content": body, "encoding": "utf-8"}, offset, limit)

    async def als(self, path: str) -> LsResult:
        files = await self.listable_files()
        return LsResult(entries=[FileInfo(path=entry, is_dir=entry.endswith("/")) for entry in children(files, path)])

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        files = await self.listable_files()
        return GlobResult(matches=[FileInfo(path=file.path) for file in glob_files(files, pattern, path)])

    async def agrep(
        self, pattern: str, path: str | None = None, glob: str | None = None, *, max_count: int | None = None
    ) -> GrepResult:
        # The literal grep's verification needs the scope, the pre-filter and the page text; the tool calls
        # :meth:`grep` for it. A caller that holds only the protocol gets no matches rather than an error,
        # because one route's error aborts a CompositeBackend's whole fan-out (ADR-0133 trap 6).
        return GrepResult(matches=[], truncated=True)

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=f"{file_path} is read-only (permission denied); drafts are written under /drafts/")

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,  # noqa: FBT001, FBT002 - positional, to match the backend protocol
    ) -> EditResult:
        return EditResult(error=f"{file_path} is read-only (permission denied); drafts are edited under /drafts/")


# ---------------------------------------------------------------------------
# Resolution, pure
# ---------------------------------------------------------------------------


def _names_of(file: EstateFile) -> set[str]:
    names = {fold(file.leaf), fold(file.row.file_name), fold(file.row.file_name.rsplit("/", 1)[-1])}
    if file.row.display_title:
        names.add(fold(file.row.display_title))
    return names


def resolve_in(files: Sequence[EstateFile], parsed: EstatePath) -> Resolution:
    """:meth:`EstateBackend.resolve` over a given list of files. Pure."""
    if parsed.mount is None or parsed.leaf is None:
        return Resolution(file=None)
    wanted = {fold(name) for name in file_name_candidates(parsed.leaf)} | {fold(parsed.leaf)}
    in_mount = [file for file in files if file.mount == parsed.mount]
    matches = [file for file in in_mount if _names_of(file) & wanted]
    folder = fold(parsed.folder)
    same_folder = [file for file in matches if parsed.mount == "law" or fold(file.row.folder) == folder]
    listable = [file for file in matches if not file.restricted]
    chosen = (same_folder or listable or [None])[0]
    if chosen is None:
        return Resolution(file=None, suggestions=_suggestions(in_mount, parsed))
    note = ""
    if parsed.mount != "law" and fold(chosen.row.folder) != folder and folder:
        note = f"Moved: {parsed.path} is now {chosen.path}."
    return Resolution(file=chosen, note=note)


def _suggestions(files: Sequence[EstateFile], parsed: EstatePath) -> list[str]:
    """Up to three listable paths whose leaf is close to the asked one; never a restricted document's."""
    wanted = fold(parsed.leaf or "")
    scored: list[tuple[float, str]] = []
    for file in files:
        if file.restricted:
            continue
        ratio = difflib.SequenceMatcher(None, wanted, fold(file.leaf)).ratio()
        if ratio >= SUGGESTION_CUTOFF:
            scored.append((ratio, file.path))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [path for _ratio, path in scored[:MAX_SUGGESTIONS]]


def children(files: Sequence[EstateFile], path: str | None) -> list[str]:
    """The entries directly below ``path``: subfolders (ending in ``/``) and files, sorted. Pure."""
    try:
        parsed = parse_estate_path(path, directory=True)
    except PathRefused:
        return []
    if parsed.mount is None:
        return [MOUNT_ROOTS[mount] for mount in ESTATE_MOUNTS if any(file.mount == mount for file in files)]
    prefix = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
    out: set[str] = set()
    for file in files:
        if file.mount != parsed.mount or not fold(file.path).startswith(fold(prefix)):
            continue
        rest = file.path[len(prefix) :]
        head, _, tail = rest.partition("/")
        out.add(prefix + head + ("/" if tail else ""))
    return sorted(out)


def _glob_flags() -> int:
    """The glob dialect: ``*`` ``**`` ``?`` ``[abc]`` ``{a,b}``, as the stock ``glob`` tool reads it.

    Deep Agents matches with wcmatch too, so a pattern means here what it means
    to the stock tool. Case is folded by :func:`fold` on both sides, so no
    IGNORECASE flag is needed.
    """
    from wcmatch import glob as wcglob

    return wcglob.GLOBSTAR | wcglob.BRACE | wcglob.DOTGLOB


def glob_files(files: Sequence[EstateFile], pattern: str, path: str | None = None) -> list[EstateFile]:
    """The files ``pattern`` matches below ``path`` (default: every estate mount), in path order. Pure.

    A pattern without ``/`` matches the file's name at any depth, as the stock
    tool's does; one with ``/`` matches the path below the search root, and an
    absolute one (``/project/**/*.pdf``) the whole path. Names compare folded
    (case, NFC, ä/ae, ß/ss), and a document matches by its served leaf
    (``Plan.pdf.md``) or its file name (``Plan.pdf``), so ``*.pdf`` finds PDFs.
    """
    from wcmatch import glob as wcglob

    wanted = fold((pattern or "").strip())
    if not wanted:
        return []
    try:
        root = parse_estate_path(path, directory=True) if path else None
    except PathRefused:
        return []
    prefix = fold(root.path) if root is not None and root.mount is not None else ""
    flags = _glob_flags()
    out: list[EstateFile] = []
    for file in files:
        full = fold(file.path)
        if prefix and not full.startswith(prefix):
            continue
        names = {fold(file.leaf), fold(file.row.file_name.rsplit("/", 1)[-1])}
        stem = full[: -len(fold(file.leaf))]
        if "/" not in wanted:
            candidates = names
        elif wanted.startswith("/"):
            candidates = {stem + name for name in names}
        else:
            relative_stem = stem[len(prefix) :] if prefix else stem.lstrip("/")
            candidates = {relative_stem + name for name in names}
        if any(wcglob.globmatch(candidate, wanted, flags=flags) for candidate in candidates):
            out.append(file)
    return sorted(out, key=lambda file: file.path)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


async def _in_flight(files: Sequence[EstateFile]) -> list[str]:
    """Files of these collections still being read, by name (``browse._in_flight``); empty on any error."""
    from .browse import _in_flight as in_flight

    collections = sorted({file.row.collection for file in files if file.row.collection})
    if not collections:
        return []
    try:
        return await asyncio.to_thread(in_flight, collections)
    except Exception:  # noqa: BLE001 - a status read never costs the listing
        return []


def _settle_listing(row: Any, listing: Listing) -> None:
    """A listing's Herleitung row: ``list`` with its file and folder counts (ADR-0132).

    A folder that is not there is ``empty`` and ``missing`` („nicht gefunden“), not
    a failure; a restricted folder answers exactly so (listing is not use,
    ADR-0088). A folder that is there and holds nothing (a new project, a chat
    without uploads) is ``ok`` with its zeros: it was found, and it is empty.
    """
    if listing.error:
        row.finish("empty", missing=True)
        return
    row.finish("ok", counts={"files": listing.files, "folders": listing.folders})


@dataclass(frozen=True)
class ReadRowFacts:
    """What a ``read_file`` row may say about the read, beside the blocks it served (ADR-0132, ADR-0088)."""

    #: The document by name: the resolved one only when ``may_name``; on a miss, the leaf the model asked for.
    target: str | None = None
    shelf: str | None = None
    #: The path resolved to nothing (or to a restricted file, which answers the same).
    missing: bool = False
    #: The ``pages`` value was refused: the model's mistake, never printed on the row.
    refused_pages: bool = False
    #: A folder card (``<folder>/README.md``): the folder, and the listing it answered with.
    card_folder: str | None = None
    card: Listing | None = None


def _settle_read(row: Any, output: ToolOutput, facts: ReadRowFacts, *, asked: str | None) -> None:
    """A read's Herleitung row (ADR-0132): the document it may name, the pages it SERVED, what it found.

    The pages are the ones the blocks hold, not the ones asked for: a read without
    ``pages`` serves the opening page, and one cut at the character budget serves
    fewer than it was asked. A Punkt stays a Punkt; a refused ``pages`` value is
    the model's mistake, never printed. A miss is ``empty`` („nicht gefunden“).
    """
    if facts.card is not None:
        # A folder card is the folder's listing, and its row says so.
        counts = {"files": facts.card.files, "folders": facts.card.folders}
        row.finish("ok", counts=counts, verb="list", **action_place(facts.card_folder))
        return
    if facts.missing:
        row.finish("empty", missing=True, target=facts.target)
        return
    fields: dict[str, Any] = {key: value for key, value in (("target", facts.target), ("shelf", facts.shelf)) if value}
    served = sorted({hit.page for hit in output.hits if getattr(hit, "page", None)})
    if asked and asked.startswith("Pkt."):
        fields["pages"] = asked
    elif served:
        fields["pages"] = pages_label(served)
    elif asked and not facts.refused_pages:
        fields["pages"] = asked
    counts = {"hits": len(output.hits), "documents": 1} if output.hits else None
    row.finish(output.status, counts=counts, **fields)


def _store_down(file: EstateFile) -> str:
    return f"Could not read {file.path} just now: the store did not answer. Try again; this is not a no."


def _entry_shelf(entry: Any) -> str | None:
    from .browse import _entry_shelf as entry_shelf

    return entry_shelf(entry)


async def _rows_of(entries: Sequence[Any]) -> list[FileRow]:
    """The documents registered for ``entries``' collections, as rows with their shelves; a failed one gives none."""
    if not entries:
        return []
    from aiq_agent.knowledge import get_available_documents_async

    listings = await asyncio.gather(
        *(get_available_documents_async(entry.collection) for entry in entries), return_exceptions=True
    )
    rows: list[dict[str, Any]] = []
    for entry, docs in zip(entries, listings, strict=True):
        if isinstance(docs, BaseException):
            logger.warning("estate: no rows for a collection (%s)", type(docs).__name__)
            continue
        for doc in docs:
            data = doc.model_dump() if hasattr(doc, "model_dump") else dict(doc)
            rows.append({**data, "collection": entry.collection, "shelf": _entry_shelf(entry)})
    return file_rows(rows)


def _pages_field(pages: Any, clause: Any) -> str | None:
    if clause is not None and str(clause).strip():
        return f"Pkt. {str(clause).strip()}"
    return str(pages).strip() or None if pages is not None else None


def _directory_message(path: str) -> str:
    return f'"{path}" is a folder, not a file: `ls("{path}")` lists it, `glob` finds files by name.'


def _model_message(file: EstateFile) -> str:
    return (
        f"{file.path} is a building model (IFC), not a text: its numbers are measured, not read. "
        f'`ifc_query` and `ifc_measure` answer from it (document="{file.row.file_name}").'
    )


def _empty_message(file: EstateFile) -> str:
    return (
        f"{file.path} holds no readable text yet: it may still be being read, or nothing could be read from it. "
        "Not readable here is not the same as not in the project; say it could not be read."
    )


def _rebuilt_line(text: stored_pages.PageText) -> str:
    if not text.rebuilt:
        return ""
    return "Rebuilt from the index; page breaks inside a passage are approximate."


def _read_preamble(file: EstateFile, text: stored_pages.PageText, served: Sequence[stored_pages.Page]) -> str:
    numbers = [page.number for page in served]
    what = f"page {numbers[0]}" if len(numbers) == 1 else f"pages {pages_label(numbers)}"
    count = f" of {text.page_count}" if text.page_count else ""
    lines = [f"{file.path}, {what}{count}. Each block is one citable passage; cite its Citation line."]
    if rebuilt := _rebuilt_line(text):
        lines.append(rebuilt)
    scans = [page.number for page in served if page.source == stored_pages.SOURCE_OCR]
    if scans:
        lines.append(f"Page(s) {pages_label(scans)} are a scan, transcribed by a vision model.")
    drawings = [page.number for page in served if page.is_drawing]
    if drawings:
        lines.append(
            f"Page(s) {pages_label(drawings)} are a drawing: the text is a vision model's reading of the sheet, "
            "not its printed text. Read off, not measured; "
            f'`look(document="{file.row.file_name}", page={drawings[0]})` shows it.'
        )
    return "\n".join(lines)


def _read_trailer(
    file: EstateFile,
    text: stored_pages.PageText,
    served: Sequence[stored_pages.Page],
    wanted: Sequence[int],
    missing: Sequence[int],
    stopped_at: int | None,
    outline: str,
) -> str:
    numbers = [page.number for page in served]
    lines = [f"Read {('page ' + str(numbers[0])) if len(numbers) == 1 else 'pages ' + pages_label(numbers)}."]
    if stopped_at is not None:
        rest = [number for number in wanted if number >= stopped_at]
        lines.append(f'Stopped at the read limit. Next: pages="{pages_label(rest)}".')
    elif text.page_count and numbers[-1] < text.page_count:
        following = numbers[-1] + 1
        lines.append(f'Next: pages="{following}-{min(text.page_count, following + 2)}".')
    empty = [number for number in missing if not text.page_count or number <= text.page_count]
    if empty:
        lines.append(f"Page(s) {pages_label(empty)} hold no text.")
    if outline:
        lines.append(outline)
    elif not text.rebuilt and len(numbers) == 1 and len(wanted) == 1 and file.paged:
        lines.append("pages= reads further; clause= reads one Punkt.")
    return "\n".join(lines)


def _older_revision_notice(file: EstateFile) -> str:
    from aiq_agent.knowledge.restricted_use import may_name

    from .read_passage import older_revision_line

    current = file.row.superseded_by
    if not current or not may_name(file.row.collection):
        return ""
    return older_revision_line(file.row.file_name, current).strip()


def _content_type(page: stored_pages.Page) -> str:
    if page.is_drawing:
        return "drawing"
    for kind in ("table", "image", "chart"):
        if page.content_types and set(page.content_types) == {kind}:
            return kind
    return "text"


def _page_hit(file: EstateFile, page: stored_pages.Page, *, budget: int, paged: bool = True) -> Any:
    """One page as a grounding record: the page's text, the file's own row, the ``file, p.N`` key."""
    from aiq_agent.common.grounding_block import GroundingHit
    from aiq_agent.common.source_kinds import parse_shelf

    from .grounding_hits import _citation_key_for

    number = page.number if paged and page.number > 0 else None
    shelf = parse_shelf(file.row.shelf)
    body = page.text.strip()
    truncated = len(body) > budget
    return GroundingHit(
        citation_key=_citation_key_for(file.row.file_name, shelf, number, set()),
        file_name=file.row.file_name,
        page=number,
        shelf=shelf,
        collection=file.row.collection or None,
        doc_class=file.row.doc_class,
        display_title=file.row.display_title or file.row.file_name,
        folder_path=file.row.folder or None,
        clause=None,
        score=1.0,
        content_type=_content_type(page),
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=body[:budget] if truncated else body,
        body_truncated=truncated,
        path=file.path,
    )


def _chunk_hit(file: EstateFile, chunk: Any) -> Any:
    """A Punkt's chunk as a record, with the file's row and path."""
    from aiq_agent.common.grounding_block import GroundingHit
    from aiq_agent.common.source_kinds import parse_shelf

    from .grounding_hits import _CHUNK_TRUNCATE_CHARS
    from .grounding_hits import _citation_key_for
    from .grounding_hits import _hit_provenance

    shelf = parse_shelf(file.row.shelf)
    page = chunk.page_number if chunk.page_number and chunk.page_number > 0 else None
    content = chunk.content or ""
    truncated = len(content) > _CHUNK_TRUNCATE_CHARS
    clause = (chunk.metadata or {}).get("clause_id")
    return GroundingHit(
        citation_key=_citation_key_for(file.row.file_name, shelf, page, set()),
        file_name=file.row.file_name,
        page=page,
        shelf=shelf,
        collection=file.row.collection or None,
        doc_class=file.row.doc_class,
        display_title=file.row.display_title or file.row.file_name,
        folder_path=file.row.folder or None,
        clause=str(clause) if clause else None,
        score=1.0,
        content_type=getattr(chunk.content_type, "value", str(chunk.content_type)),
        provenance=_hit_provenance(chunk),
        stored_image_index=None,
        status_note=None,
        body=content[:_CHUNK_TRUNCATE_CHARS] if truncated else content,
        body_truncated=truncated,
        path=file.path,
    )


def _render(hits: tuple[Any, ...], *, preamble: str, notices: Sequence[str], trailer: str, tool: str) -> ToolOutput:
    """The block, rendered and filed (ADR-0061); the hits noted for the call's artifact."""
    from aiq_agent.common.grounding_block import GroundingBlock
    from aiq_agent.common.grounding_block import render_grounding_block

    from .trace_lanes import trace_lanes_for_hits

    banner = "".join(f"{line}\n\n" for line in notices if line)
    text = render_grounding_block(
        GroundingBlock(
            preamble=preamble,
            degraded_banner=banner,
            hits=hits,
            lanes=trace_lanes_for_hits(hits),
            tool=tool,
            trailer=trailer,
        )
    )
    note_citations(hits)
    return ToolOutput(text=text, hits=hits, status="ok")
