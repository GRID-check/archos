"""Looking at the files the way a person does: the listing and the exact search.

A person in the Files pane does two things before they read anything: they
LOOK at what is there (open a folder, sort by date, filter by name) and they
FIND where something is written (Ctrl+F across the project). The agent could do
neither. What it saw of the project was the prompt inventory, capped at fifty
rows, and what it could find was ``knowledge_search`` — a ranked top-k
similarity search that answers "what passage best matches this" and never
"which files say this". So on a project with three hundred files the agent
answered „welche Unterlagen liegen in Brandschutz/?“ from whichever fifty names the
cap kept, and „wo kommt BA-03 überall vor?“ from the three passages that ranked.

- ``list_files`` is ``ls`` / the Files pane: every file on the reader's own
  shelves, filtered by folder, name, Dokumentart and date, paged, with the
  subfolders and their counts. An INDEX, never evidence: a row proves a file
  exists, as the inventory does.
- ``knowledge_search(match="exact")`` is ``grep`` (:func:`exact_search`, here
  because it shares the rows): every chunk whose text contains a phrase, over
  every file in scope, counted per file — then the first passages of the
  best-covered files, rendered through the knowledge layer's own grounding
  block, so they are citable exactly like a search hit. One regex
  (:func:`phrase_pattern`) does the finding in the store and the counting
  here, and it reads the phrase the way a person does: case, ä/ae and ß/ss
  spellings, and a line break or hyphen between two words do not matter; a
  term of two or three characters is a whole word.

The exact search is a MODE of the search rather than a tool of its own: it is
the same verb over the same scope with the same narrowing arguments, and a
second tool would have been one more name for the model to choose between
(docs/architecture/agent-tool-surface.md).

Both are deterministic: no reranker, no judge, no LLM. Both read only what the
turn may read: the rows the turn's inventory resolved against the signed scope
(``knowledge.inventory.get_turn_documents``, uncapped), or — on a path that
bound none — the same scope ``knowledge_search`` resolves. Both then subtract
the shelves this turn did not ask for (``focus_file.get_turn_shelves``), the
way ``search_scope.restrict_scope_to_turn`` does for the ranked search, so a turn
about one upload lists and greps that upload, not the Büroablage. The exact
search reads the base corpus through the same store filter the ranked search
uses (``search_scope.base_collection_filters``): an excluded edition or a cover
page is not evidence in either mode.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any
from typing import Literal

from pydantic import Field

from agent.common.action_outcome import ActionOutcome
from agent.common.action_rows import ActionRow
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import register_function

from .browse_compare import _PREVIOUS_WORDS  # noqa: F401
from .browse_compare import _change_line_between  # noqa: F401
from .browse_compare import _stored_chunks  # noqa: F401
from .browse_compare import compare_revisions  # noqa: F401
from .browse_compare import resolve_compare  # noqa: F401
from .browse_matches import MAX_DISTINCT_CHARS  # noqa: F401
from .browse_matches import MAX_DISTINCT_FILES  # noqa: F401
from .browse_matches import MAX_DISTINCT_MATCHES  # noqa: F401
from .browse_matches import MAX_DISTINCT_PAGES  # noqa: F401
from .browse_matches import MAX_MATCH_CHUNKS  # noqa: F401
from .browse_matches import MAX_MATCH_PASSAGES  # noqa: F401
from .browse_matches import MAX_TRACKED_STRINGS  # noqa: F401
from .browse_matches import FileMatches  # noqa: F401
from .browse_matches import _distinct_lines  # noqa: F401
from .browse_matches import _matched_strings  # noqa: F401
from .browse_matches import _occurrences  # noqa: F401
from .browse_matches import distinct_matches  # noqa: F401
from .browse_matches import group_matches  # noqa: F401
from .browse_matches import pick_passages  # noqa: F401
from .browse_messages import MAX_CONTEXT_LINES  # noqa: F401
from .browse_messages import MAX_SNIPPET_LINES  # noqa: F401
from .browse_messages import _chunk_snippets  # noqa: F401
from .browse_messages import _context_lines  # noqa: F401
from .browse_messages import _context_ranges  # noqa: F401
from .browse_messages import _line_spans  # noqa: F401
from .browse_messages import match_snippets  # noqa: F401
from .browse_messages import match_table  # noqa: F401
from .browse_messages import no_match_message  # noqa: F401
from .browse_messages import search_failed_message  # noqa: F401
from .browse_patterns import _CAPPED_WITHOUT_OWN_MATCH  # noqa: F401
from .browse_patterns import _EQUIVALENT  # noqa: F401
from .browse_patterns import _INFLECTED_MIN_CHARS  # noqa: F401
from .browse_patterns import _INFLECTION_ENDINGS  # noqa: F401
from .browse_patterns import _NEEDS_A_ANCHOR  # noqa: F401
from .browse_patterns import _SEPARATOR  # noqa: F401
from .browse_patterns import _SEPARATOR_CHARS  # noqa: F401
from .browse_patterns import _STEM_MIN_CHARS  # noqa: F401
from .browse_patterns import _TOKEN  # noqa: F401
from .browse_patterns import _TOO_COSTLY  # noqa: F401
from .browse_patterns import _TOO_COSTLY_SCAN  # noqa: F401
from .browse_patterns import MAX_ALTERNATIVES  # noqa: F401
from .browse_patterns import MAX_PATTERN_CHARS  # noqa: F401
from .browse_patterns import MAX_USER_PATTERN_CHARS  # noqa: F401
from .browse_patterns import MIN_PHRASE_CHARS  # noqa: F401
from .browse_patterns import WHOLE_WORD_MAX_CHARS  # noqa: F401
from .browse_patterns import _phrase_pattern  # noqa: F401
from .browse_patterns import inflection_stem  # noqa: F401
from .browse_patterns import phrase_pattern  # noqa: F401
from .browse_patterns import split_alternatives  # noqa: F401
from .browse_patterns import stemmed_pattern  # noqa: F401
from .browse_patterns import user_pattern  # noqa: F401
from .browse_render import MAX_CHAIN_CHANGE_CHARS  # noqa: F401
from .browse_render import MAX_CHANGE_CHARS  # noqa: F401
from .browse_render import _change_bit  # noqa: F401
from .browse_render import _change_text  # noqa: F401
from .browse_render import _compared_with_own_upload  # noqa: F401
from .browse_render import _in_flight_line  # noqa: F401
from .browse_render import _row_line  # noqa: F401
from .browse_render import _scope_of  # noqa: F401
from .browse_render import render_listing  # noqa: F401
from .browse_revisions import _EXTENSION  # noqa: F401
from .browse_revisions import MAX_CHAIN_CANDIDATES  # noqa: F401
from .browse_revisions import MAX_CHAIN_LINES  # noqa: F401
from .browse_revisions import _by_title_block  # noqa: F401
from .browse_revisions import _chain_candidates  # noqa: F401
from .browse_revisions import _chain_line  # noqa: F401
from .browse_revisions import _chain_members  # noqa: F401
from .browse_revisions import _chain_order  # noqa: F401
from .browse_revisions import _name_order  # noqa: F401
from .browse_revisions import _resolve_chain  # noqa: F401
from .browse_revisions import _series_ident  # noqa: F401
from .browse_revisions import _sheet_order  # noqa: F401
from .browse_revisions import _with_supersedes  # noqa: F401
from .browse_revisions import render_revisions  # noqa: F401
from .browse_rows import _SHELF_LABELS  # noqa: F401
from .browse_rows import DEFAULT_PAGE_SIZE  # noqa: F401
from .browse_rows import KNOWN_SHELVES  # noqa: F401
from .browse_rows import MAX_FOLDER_LINES  # noqa: F401
from .browse_rows import MAX_PAGE_SIZE  # noqa: F401
from .browse_rows import MAX_ROW_FACTS  # noqa: F401
from .browse_rows import MAX_ROW_REFERENCES  # noqa: F401
from .browse_rows import MAX_SUMMARY_CHARS  # noqa: F401
from .browse_rows import MAX_TOPIC_COUNTS  # noqa: F401
from .browse_rows import MAX_TYPE_COUNTS  # noqa: F401
from .browse_rows import USER_SHELVES  # noqa: F401
from .browse_rows import FileRow  # noqa: F401
from .browse_rows import Listing  # noqa: F401
from .browse_rows import _attr  # noqa: F401
from .browse_rows import _check_shelf
from .browse_rows import _folder_matches  # noqa: F401
from .browse_rows import _in_folder  # noqa: F401
from .browse_rows import _reading_fields  # noqa: F401
from .browse_rows import _RowKey  # noqa: F401
from .browse_rows import _state_label  # noqa: F401
from .browse_rows import _subfolders  # noqa: F401
from .browse_rows import _topic_profile  # noqa: F401
from .browse_rows import _type_profile  # noqa: F401
from .browse_rows import confirmed_revision_marks  # noqa: F401
from .browse_rows import file_row  # noqa: F401
from .browse_rows import file_rows  # noqa: F401
from .browse_rows import on_shelves  # noqa: F401
from .browse_rows import revision_marks  # noqa: F401
from .browse_rows import select_files  # noqa: F401
from .browse_rows import title_block_marks  # noqa: F401
from .browse_scope import _STEMMED_NOTE  # noqa: F401
from .browse_scope import _TOLERATED  # noqa: F401
from .browse_scope import _TOLERATED_REGEX  # noqa: F401
from .browse_scope import ShelfScope  # noqa: F401
from .browse_scope import _candidate_lines  # noqa: F401
from .browse_scope import _collection_names  # noqa: F401
from .browse_scope import _failed_note  # noqa: F401
from .browse_scope import _scope_statement  # noqa: F401
from .browse_scope import _shelf_lines  # noqa: F401
from .browse_scope import _wanted  # noqa: F401
from .browse_scope import shelf_scopes  # noqa: F401
from .browse_search import SEARCH_SHELVES  # noqa: F401
from .browse_search import _candidate_counts  # noqa: F401
from .browse_search import _collection_filter  # noqa: F401
from .browse_search import _has_literal_word  # noqa: F401
from .browse_search import entries_on_shelf  # noqa: F401
from .browse_text import _FOLD  # noqa: F401
from .browse_text import _coerce_int
from .browse_text import _pages_label  # noqa: F401
from .browse_text import _shorten  # noqa: F401
from .browse_text import _words  # noqa: F401
from .browse_text import fold  # noqa: F401
from .browse_tool_text import _LIST_FILES_DESCRIPTION
from .browse_tree import DEFAULT_TREE_DEPTH  # noqa: F401
from .browse_tree import MAX_CARD_FILES  # noqa: F401
from .browse_tree import MAX_CARD_SUBFOLDERS  # noqa: F401
from .browse_tree import MAX_CURRENT_LINES  # noqa: F401
from .browse_tree import MAX_REPLACED_NAMES  # noqa: F401
from .browse_tree import MAX_TREE_CARDS  # noqa: F401
from .browse_tree import MAX_TREE_DEPTH  # noqa: F401
from .browse_tree import TREE_PARAGRAPH  # noqa: F401
from .browse_tree import FolderCard  # noqa: F401
from .browse_tree import _card_ancestors  # noqa: F401
from .browse_tree import _card_lines  # noqa: F401
from .browse_tree import _card_order  # noqa: F401
from .browse_tree import _confirmed_head  # noqa: F401
from .browse_tree import _count  # noqa: F401
from .browse_tree import _current_lines  # noqa: F401
from .browse_tree import _folder_card  # noqa: F401
from .browse_tree import _revision_series  # noqa: F401
from .browse_tree import _Series  # noqa: F401
from .browse_tree import _series_label  # noqa: F401
from .browse_tree import abstract_lines  # noqa: F401
from .browse_tree import folder_cards  # noqa: F401
from .browse_tree import render_tree  # noqa: F401
from .browse_turn import TurnRows  # noqa: F401
from .browse_turn import _entry_shelf  # noqa: F401
from .browse_turn import _readable_rows  # noqa: F401
from .browse_turn import _scope_entries  # noqa: F401
from .browse_turn import _session_collection  # noqa: F401
from .browse_turn import restrict_rows_to_turn  # noqa: F401
from .browse_turn import shelf_restricted_message  # noqa: F401

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# list_files
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# list_files(view="tree"): a card per folder
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# The Fassungen of one document (list_files revisions_of=)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# The exact search (knowledge_search match="exact")
# ---------------------------------------------------------------------------


_EQUIVALENT.update({"ae": _EQUIVALENT["ä"], "oe": _EQUIVALENT["ö"], "ue": _EQUIVALENT["ü"], "ss": _EQUIVALENT["ß"]})


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------


async def _turn_rows(search_config: Any) -> list[FileRow]:
    """The turn's inventory rows, uncapped; loaded from the scope when this path bound none.

    Never a row of a restricted folder's collection, whichever way the rows were
    found (ADR-0088): listing is not use, so a name, a title or a summary of
    such a file never reaches the model without an admission. The filter sits on
    the rows themselves rather than on one of the two sources, because the
    fallback below is the path a failed inventory load takes.
    """
    from agent.knowledge.restricted_collections import is_restricted_collection

    return [row for row in await _readable_rows(search_config) if not is_restricted_collection(row.collection)]


def _in_flight(collections: Sequence[str]) -> list[str]:
    from agent.knowledge import ingest_status_store

    try:
        pending = ingest_status_store.in_flight_files(list(collections))
    except Exception:  # noqa: BLE001 — a status read never costs the listing
        return []
    return list(dict.fromkeys(name for names in pending.values() for name in names))


# ---------------------------------------------------------------------------
# Descriptions
# ---------------------------------------------------------------------------


class ListFilesConfig(FunctionBaseConfig, name="list_files"):
    """``list_files`` reads the turn's inventory; the search instance names its scope when none is bound."""

    knowledge_search: FunctionRef = Field(
        default=FunctionRef("knowledge_search"),
        description="The `knowledge_retrieval` instance whose collection scope this browser shares.",
    )


@register_function(config_type=ListFilesConfig)
async def list_files(config: ListFilesConfig, _builder: Builder):
    """Browse the reader's files: folders, names, Dokumentart, dates. Deterministic; no LLM."""
    search_config = _builder.get_function_config(config.knowledge_search)

    async def _list(
        folder: str | None = None,
        name_contains: str | None = None,
        doc_class: str | None = None,
        added_since: str | None = None,
        shelf: str | None = None,
        sort: str | None = None,
        offset: int | str | None = None,
        limit: int | str | None = None,
        topic: str | None = None,
        revisions_of: str | None = None,
        compare_to: str | None = None,
        view: Literal["files", "tree"] | None = None,
        depth: int | str | None = None,
    ) -> str:
        """List the reader's files, like opening a folder in the Files pane.

        Args:
            folder (str | None): Folder path as a previous listing or the inventory printed it
                ("Brandschutz/Fluchtwege"); includes everything below it. Omit to list every file.
            name_contains (str | None): Words that must all appear in the file name or title.
            doc_class (str | None): One Dokumentart key (e.g. "oib_guideline", "law").
            added_since (str | None): Only files uploaded on or after this date, YYYY-MM-DD.
            shelf (str | None): project | office_shelf | session | base. Omit for the reader's own files.
            sort (str | None): folder (default) | name | newest.
            offset (int | None): Start of the page; the result names the next one.
            limit (int | None): Page size, default 40, at most 100.
            topic (str | None): A Thema Piloti recognised (e.g. "Attika", "Holzrahmenbau"); matches part of a topic.
            revisions_of (str | None): A file name; returns that document's chain of Fassungen instead of a listing.
            compare_to (str | None): With `revisions_of`: compare that Fassung with this one (a file name of the
                same chain, or "previous" for the one before) and return what changed, page by page.
            view (str | None): files (default) lists files; tree returns a card per folder instead.
            depth (int | None): With view=tree: folder levels below `folder` that get a card, 1 to 4, default 2.

        Returns:
            str: A count, the subfolders with counts, and one line per file with its exact name; as a tree,
                a card per folder.
        """
        outcome = ActionOutcome()
        row = ActionRow(
            "list",
            target=(revisions_of or "").strip() or (folder or "").strip().strip("/"),
            query=name_contains,
            shelf=shelf,
        )
        try:
            result = await _list_body(
                outcome,
                folder,
                name_contains,
                doc_class,
                added_since,
                shelf,
                sort,
                offset,
                limit,
                topic,
                revisions_of,
                compare_to,
                view,
                depth,
            )
        except BaseException:
            row.finish("error")
            raise
        # A refusal lists nothing and says so; a revisions chain is an answer with no file count.
        outcome.settle(row, default="ok" if outcome.completed else "error", target=outcome.target)
        return result

    async def _list_body(
        outcome: ActionOutcome,
        folder: str | None,
        name_contains: str | None,
        doc_class: str | None,
        added_since: str | None,
        shelf: str | None,
        sort: str | None,
        offset: int | str | None,
        limit: int | str | None,
        topic: str | None,
        revisions_of: str | None,
        compare_to: str | None,
        view: Literal["files", "tree"] | None,
        depth: int | str | None,
    ) -> str:
        shelf, refusal = _check_shelf(shelf)
        if refusal:
            return refusal
        if (revisions_of or "").strip():
            # A chain is not a listing: no other filter applies, so none is validated either.
            turn = restrict_rows_to_turn(await _turn_rows(search_config))
            if shelf and turn.allowed is not None and shelf not in turn.allowed:
                return shelf_restricted_message(shelf, turn.allowed)
            if compare_to is not None:
                older, newer, refusal = resolve_compare(
                    turn.rows, revisions_of or "", compare_to, shelf=shelf, default_shelves=turn.own_shelves
                )
                if refusal or older is None or newer is None:
                    return refusal
                return await compare_revisions(older, newer)
            outcome.completed = True
            return render_revisions(turn.rows, revisions_of or "", shelf=shelf, default_shelves=turn.own_shelves)
        sort = (sort or "folder").strip().lower()
        if sort not in ("folder", "name", "newest"):
            return "`sort` must be folder, name or newest."
        added_since = (added_since or "").strip() or None
        if added_since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", added_since):
            return "`added_since` must be a date written YYYY-MM-DD."
        doc_class = (doc_class or "").strip() or None
        if doc_class is not None:
            from agent.knowledge.document_classification import DOCUMENT_CLASSES
            from agent.knowledge.document_classification import canonical_doc_class

            current_doc_class = canonical_doc_class(doc_class)
            if current_doc_class is None:
                return f"Invalid doc_class {doc_class!r}. Valid values: {', '.join(DOCUMENT_CLASSES)}."
            doc_class = current_doc_class

        view = (view or "files").strip().lower()
        if view not in ("files", "tree"):
            return "`view` must be files or tree."
        turn = restrict_rows_to_turn(await _turn_rows(search_config))
        if shelf and turn.allowed is not None and shelf not in turn.allowed:
            return shelf_restricted_message(shelf, turn.allowed)
        rows = turn.rows
        tree = view == "tree"
        listing = select_files(
            rows,
            default_shelves=turn.own_shelves,
            shelf=shelf,
            folder=(folder or "").strip().strip("/") or None,
            name_contains=(name_contains or "").strip() or None,
            doc_class=doc_class,
            added_since=added_since,
            topic=(topic or "").strip() or None,
            sort=sort,
            # A tree is not paged: its rows all go into the cards.
            offset=0 if tree else _coerce_int(offset, 0, low=0, high=100_000),
            limit=len(rows) + 1 if tree else _coerce_int(limit, DEFAULT_PAGE_SIZE, low=1, high=MAX_PAGE_SIZE),
        )
        collections = sorted({row.collection for row in rows if row.shelf in listing.shelves and row.collection})
        in_flight = await asyncio.to_thread(_in_flight, collections) if collections else []
        logger.info("list_files: %d of %d row(s) selected, view=%s", listing.total, len(rows), view)
        outcome.completed = True
        outcome.target = listing.folder
        outcome.files = len(listing.rows)
        if not tree:
            outcome.folders = len(listing.subfolders)
            return render_listing(listing, in_flight=in_flight)
        cards = folder_cards(
            listing.rows,
            root=listing.folder,
            depth=_coerce_int(depth, DEFAULT_TREE_DEPTH, low=1, high=MAX_TREE_DEPTH),
            series_rows=on_shelves(rows, shelf=shelf, default_shelves=turn.own_shelves),
        )
        from agent.knowledge.folder_cards import listing_abstracts

        outcome.folders = len(cards)
        return render_tree(
            cards,
            total_rows=listing.total,
            notes=listing.notes,
            scope=_scope_of(listing),
            in_flight=in_flight,
            abstracts=abstract_lines(await listing_abstracts(collections)),
        )

    yield FunctionInfo.from_fn(_list, description=_LIST_FILES_DESCRIPTION)


async def _files_by_collection(
    search_config: Any,
    *,
    file_name: str | None,
    folder: str | None,
    doc_class: str | None,
    title_contains: str | None,
) -> dict[str, list[str]] | None:
    """The files a narrowed exact search may read, per collection; ``None`` when nothing narrows it.

    A Dokumentart and a title are not searchable on the chunks as a person
    types them (``doc_class`` is human-set and store-authoritative; a title is
    a substring), so they become the list of files they name. A folder is on
    every point since ADR-0116 (``folder_ancestors``): the exact search pushes
    it into the query (:func:`_folder_scope`), and only the ranked search still
    asks this function for the collections a folder reaches.
    """
    if not (file_name or folder or doc_class or title_contains):
        return None
    from .hit_metadata import _file_name_matches

    rows = await _turn_rows(search_config)
    if folder:
        resolved = _folder_matches(rows, folder)
        rows = [row for row in rows if resolved is not None and _in_folder(row, resolved)]
    if file_name:
        # The meaning mode's own test (either name contains the other, so
        # „Notiz“ is „Notiz.docx“), plus the title the reader sees in the pane.
        wanted = fold(file_name)
        rows = [
            row
            for row in rows
            if _file_name_matches(row.file_name, file_name) or wanted == fold(row.display_title or "")
        ]
    if doc_class:
        rows = [row for row in rows if row.doc_class == doc_class]
    if title_contains:
        needle = fold(title_contains)
        rows = [row for row in rows if needle in fold(f"{row.file_name} {row.display_title or ''}")]
    names: dict[str, list[str]] = {}
    for row in rows:
        names.setdefault(row.collection, []).append(row.file_name)
    return names


async def _folder_scope(search_config: Any, folder: str) -> tuple[set[str], str | None]:
    """The collections that hold files in ``folder`` or below, and the folder as the points spell it.

    The key is the folder in its stored spelling (so „Plaene“ finds „Pläne“) as
    :func:`prefilter.folder_key` writes it onto every point; ``(set(), None)`` when no file is filed there.
    """
    from .qdrant import prefilter

    rows = await _turn_rows(search_config)
    resolved = _folder_matches(rows, folder)
    if resolved is None:
        return set(), None
    return {row.collection for row in rows if _in_folder(row, resolved)}, prefilter.folder_key(resolved)


async def exact_search(
    entries: Sequence[Any],
    text: str,
    *,
    search_config: Any,
    retriever: Any,
    file_name: str | None = None,
    folder: str | None = None,
    doc_class: str | None = None,
    title_contains: str | None = None,
    filters: dict[str, Any] | None = None,
    regex_mode: bool = False,
    context: int | str | None = None,
    stemmed: bool = False,
    shelf: str | None = None,
    outcome: ActionOutcome | None = None,
) -> str:
    """``knowledge_search(match="exact"|"regex")``: every chunk in scope that contains the phrase or matches the regex.

    ``stemmed`` (exact only) also finds the inflected forms of each phrase through
    the German-stemmed index (``qdrant.retrieval.stem_condition``).

    ``entries`` is the scope the search already resolved and restricted to the
    turn, so the exact mode reads exactly what the meaning mode reads — and the
    base corpus through the same store filter (:func:`_collection_filter`).
    A folder narrows inside the query (``folder_ancestors``), the other narrowings by file list.

    ``shelf`` ("project" | "office" | "base" | "session") keeps one shelf of that scope. Omitted, the
    search reads every shelf the turn allows, the Basiswissen corpus included: a literal question about
    the law (a Frist, „EI 90“) must not get a false „no“ because the corpus was left out. The answer
    says per shelf how many documents were read and how many matched, so „not in our documents“ is
    read off the project and office lines and not off the corpus's hits.
    """
    entries, refusal = entries_on_shelf(entries, shelf)
    if refusal:
        return refusal
    context_lines, refusal = _context_lines(context)
    if refusal:
        return refusal
    if regex_mode:
        pattern = text.strip()
        phrases = [pattern]
        compiled, refusal = user_pattern(text)
        if compiled is None:
            return refusal
    else:
        phrases = split_alternatives(text)
        if not phrases:
            return f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the literal word or phrase to find."
        pattern = stemmed_pattern(phrases) if stemmed else phrase_pattern(phrases)
        if pattern is None:
            return (
                "`query` is too long for the exact search: it finds a word or a short phrase, not a sentence. "
                "Shorten it to the words that must appear literally."
            )
        compiled = re.compile(pattern)
    narrowed = await _files_by_collection(
        search_config, file_name=file_name, folder=None, doc_class=doc_class, title_contains=title_contains
    )
    folder_key: str | None = None
    if folder:
        in_folder, folder_key = await _folder_scope(search_config, folder)
        entries = [entry for entry in entries if entry.collection in in_folder]
    if narrowed is not None:
        # The rows name files on every shelf; the turn may have dropped some of
        # those shelves from ``entries``. Either way nothing in scope is left.
        entries = [entry for entry in entries if entry.collection in narrowed]
    if (narrowed is not None or folder) and not entries:
        return (
            "No file in scope matches that narrowing (`file_name`, `folder`, `doc_class`, "
            "`title_contains`). `list_files` shows what exists."
        )
    if regex_mode and not (narrowed is not None or folder_key) and not _has_literal_word(pattern):
        return _NEEDS_A_ANCHOR
    from .search_scope import resolve_base_collection

    base = resolve_base_collection(search_config)
    scopes = shelf_scopes(entries, await _searched_documents(search_config, narrowed, folder))
    outcome = outcome if outcome is not None else ActionOutcome()
    counted = [scope.documents for scope in scopes if scope.documents is not None]
    outcome.searched = sum(counted) if counted else None
    filters_by_collection = {
        entry.collection: _collection_filter(
            entry.collection,
            base=base,
            search_config=search_config,
            caller_filters=filters,
            files=None if narrowed is None else narrowed[entry.collection],
            folder_key=folder_key,
        )
        for entry in entries
    }
    return await _search(
        retriever,
        entries,
        phrases,
        pattern,
        filters_by_collection,
        compiled=compiled,
        regex_mode=regex_mode,
        context=context_lines,
        stemmed=stemmed and not regex_mode,
        scopes=scopes,
        outcome=outcome,
    )


async def _searched_documents(search_config: Any, narrowed: Mapping[str, Sequence[str]] | None, folder: str | None):
    """Per collection, the documents of the inventory that the search could read under its narrowing."""
    rows = await _turn_rows(search_config)
    resolved = _folder_matches(rows, folder) if folder else None
    counts: dict[str, int] = {}
    for row in rows:
        if resolved is not None and not _in_folder(row, resolved):
            continue
        if narrowed is not None and row.file_name not in narrowed.get(row.collection, ()):
            continue
        counts[row.collection] = counts.get(row.collection, 0) + 1
    return counts


async def _read_collection(
    retriever: Any,
    entry: Any,
    pattern: str,
    filters_by_collection: dict[str, dict[str, Any] | None],
    read_options: dict[str, Any],
) -> tuple[list[Any] | None, bool]:
    """One collection's matching chunks, each stamped with its collection and shelf, and whether the cap was hit."""
    chunks = await retriever.find_text(
        entry.collection,
        pattern,
        filters=filters_by_collection.get(entry.collection),
        limit=MAX_MATCH_CHUNKS,
        **read_options,
    )
    if chunks is None:
        return None, False
    for chunk in chunks:
        chunk.metadata.setdefault("collection", entry.collection)
        if (shelf := _entry_shelf(entry)) is not None:
            chunk.metadata.setdefault("shelf", shelf)
    return chunks, len(chunks) >= MAX_MATCH_CHUNKS


async def _search(
    retriever: Any,
    entries: Sequence[Any],
    phrases: Sequence[str],
    pattern: str,
    filters_by_collection: dict[str, dict[str, Any] | None],
    *,
    compiled: Any = None,
    regex_mode: bool = False,
    context: int | None = None,
    stemmed: bool = False,
    scopes: Sequence[ShelfScope] = (),
    outcome: ActionOutcome | None = None,
) -> str:
    from .qdrant.retrieval import USER_REGEX_SCAN_SECONDS
    from .qdrant.retrieval import USER_REGEX_TIMEOUT
    from .qdrant.retrieval import PatternTooCostly
    from .read_passage import _passage_result
    from .search_results import format_results

    # A person's regex is the only caller that asks for the timed, narrowed-by-its-words read; a store
    # that knows only the literal lookup is never handed the keyword.
    read_options: dict[str, Any] = {"user_regex": True} if regex_mode else {}
    if stemmed:
        read_options["stem_phrases"] = list(phrases)

    results = await asyncio.gather(
        *(_read_collection(retriever, entry, pattern, filters_by_collection, read_options) for entry in entries),
        return_exceptions=True,
    )
    chunks: list[Any] = []
    truncated = False
    capped: list[Any] = []
    answered = 0
    failed: list[str] = []
    for entry, result in zip(entries, results, strict=True):
        if isinstance(result, PatternTooCostly):
            return _TOO_COSTLY_SCAN if result.scan else _TOO_COSTLY
        if isinstance(result, BaseException):
            # An outage is not an empty collection: counted, and said, never
            # folded into „keine Fundstelle“.
            logger.warning("exact search: %s failed: %s", entry.collection, result)
            failed.append(entry.collection)
            continue
        found, hit_cap = result
        if found is None:
            continue
        answered += 1
        chunks.extend(found)
        truncated = truncated or hit_cap
        if hit_cap:
            capped.append(entry)
    if not answered:
        if failed:
            return search_failed_message(phrases, failed, regex_mode=regex_mode)
        return "Full-text search is not available in this environment. Use `knowledge_search`."

    timeout = USER_REGEX_TIMEOUT if regex_mode else None
    # Counting reads every matched chunk again; it gets a deadline of its own, as the scan did.
    deadline = time.monotonic() + USER_REGEX_SCAN_SECONDS if regex_mode else None
    try:
        groups = group_matches(
            chunks,
            compiled if regex_mode else pattern,
            timeout=timeout,
            store_decides=stemmed,
            deadline=deadline,
            collect_strings=regex_mode,
        )
    except TimeoutError:
        return _TOO_COSTLY_SCAN if deadline is not None and time.monotonic() >= deadline else _TOO_COSTLY
    if not groups and truncated:
        # Every passage the capped scan read held the words only in a breadcrumb or an overlap: what lies past
        # the cap was not read, so this is no „no“ (and no row count either).
        return _CAPPED_WITHOUT_OWN_MATCH
    if outcome is not None:
        # Hits are the literal matches (the table's count); documents are the files holding them, counted
        # only where the model may be told about them yet (ADR-0088). No match while a collection failed is
        # not a no, the message says so, and neither does the row: an error, never „keine Fundstelle“.
        outcome.record(
            sum(group.occurrences for group in groups),
            documents=len(groups),
            collections=[group.collection for group in groups],
        )
        outcome.failed = bool(failed) and not groups
    if not groups:
        return no_match_message(phrases, answered, failed, regex_mode=regex_mode, scopes=scopes)
    # The match table names every matching file and counts its matches, which
    # is content of each file it names, passages shown or not: reported for the
    # restricted-use admission (ADR-0088), beside the passages the grounding
    # block reports itself.
    from agent.knowledge.restricted_use import note_collections_read

    note_collections_read(group.collection for group in groups)
    passages = pick_passages(groups)
    query = " | ".join(phrases)
    candidates = await _candidate_counts(retriever, capped, pattern, filters_by_collection, regex_mode=regex_mode)
    trailer = match_table(
        groups, phrases, truncated=truncated, failed=failed, regex_mode=regex_mode, candidates=candidates, scopes=scopes
    )
    if stemmed:
        trailer = f"{_STEMMED_NOTE}\n{trailer}"
    if context is not None:
        try:
            snippets = match_snippets(groups, compiled if regex_mode else re.compile(pattern), context, timeout=timeout)
        except TimeoutError:
            return _TOO_COSTLY
        trailer = f"{trailer}\n\n{snippets}" if snippets else trailer
    formatted = await asyncio.to_thread(format_results, _passage_result(passages, query), query, trailer=trailer)
    logger.info("exact search: %r matched %d file(s)", query, len(groups))
    return formatted
