"""The office's documents as a read-only filesystem: Piloti's estate backend (ADR-0133).

``ls``, ``glob``, ``grep`` and ``read_file`` serve one namespace
(``agent.common.estate_paths``): ``/project/``, ``/office/``, ``/chat/`` and
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
import logging
from collections.abc import Sequence
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

from agent.common.estate_paths import EstatePath
from agent.common.estate_paths import Mount
from agent.common.estate_paths import PathRefused
from agent.common.estate_paths import action_place
from agent.common.estate_paths import asked_document
from agent.common.estate_paths import parse_estate_path

from . import stored_pages
from .browse import FileRow
from .browse import file_rows
from .browse import fold
from .estate_constants import _PAGES_ITEM  # noqa: F401
from .estate_constants import DEFAULT_LINE_LIMIT  # noqa: F401
from .estate_constants import GLOB_TOOL  # noqa: F401
from .estate_constants import GREP_TOOL  # noqa: F401
from .estate_constants import IMAGE_EXTENSIONS  # noqa: F401
from .estate_constants import LS_TOOL  # noqa: F401
from .estate_constants import MAX_READ_CHARS  # noqa: F401
from .estate_constants import MAX_READ_PAGES  # noqa: F401
from .estate_constants import MAX_SUGGESTIONS  # noqa: F401
from .estate_constants import MODEL_EXTENSIONS  # noqa: F401
from .estate_constants import READ_FILE_TOOL  # noqa: F401
from .estate_constants import SUGGESTION_CUTOFF  # noqa: F401
from .estate_files import EstateFile  # noqa: F401
from .estate_files import Resolution  # noqa: F401
from .estate_files import ToolOutput  # noqa: F401
from .estate_files import _content_type  # noqa: F401
from .estate_files import estate_file  # noqa: F401
from .estate_files import no_such_file  # noqa: F401
from .estate_glob import _glob_flags  # noqa: F401
from .estate_glob import _names_of  # noqa: F401
from .estate_glob import _suggestions  # noqa: F401
from .estate_glob import children  # noqa: F401
from .estate_glob import glob_files  # noqa: F401
from .estate_glob import resolve_in  # noqa: F401
from .estate_pages import PagesRefused  # noqa: F401
from .estate_pages import pages_for_lines  # noqa: F401
from .estate_pages import pages_label  # noqa: F401
from .estate_pages import parse_pages  # noqa: F401
from .estate_render import ReadRowFacts  # noqa: F401
from .estate_render import _chunk_hit  # noqa: F401
from .estate_render import _directory_message  # noqa: F401
from .estate_render import _empty_message  # noqa: F401
from .estate_render import _model_message  # noqa: F401
from .estate_render import _older_revision_notice  # noqa: F401
from .estate_render import _page_hit  # noqa: F401
from .estate_render import _pages_field  # noqa: F401
from .estate_render import _read_preamble  # noqa: F401
from .estate_render import _read_trailer  # noqa: F401
from .estate_render import _rebuilt_line  # noqa: F401
from .estate_render import _render  # noqa: F401
from .estate_render import _settle_listing  # noqa: F401
from .estate_render import _settle_read  # noqa: F401
from .estate_render import _store_down  # noqa: F401

if TYPE_CHECKING:
    from .estate_listing import Listing

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# What a tool returns
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Page addresses
# ---------------------------------------------------------------------------


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
    (``filesystem-design.md`` §2).
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
        from agent.knowledge.restricted_collections import is_restricted_collection

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
        from agent.knowledge.restricted_collections import is_restricted_collection
        from agent.knowledge.restricted_use import may_name

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
        from agent.common.action_rows import ActionRow
        from agent.common.turn_status import lane_tool_scope

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
        from agent.knowledge.restricted_use import may_name

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
        from agent.knowledge.folder_cards import listing_abstracts

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
        from agent.common.action_rows import ActionRow

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
        from agent.common.action_rows import ActionRow

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


def _entry_shelf(entry: Any) -> str | None:
    from .browse import _entry_shelf as entry_shelf

    return entry_shelf(entry)


async def _rows_of(entries: Sequence[Any]) -> list[FileRow]:
    """The documents registered for ``entries``' collections, as rows with their shelves; a failed one gives none."""
    if not entries:
        return []
    from agent.knowledge import get_available_documents_async

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
