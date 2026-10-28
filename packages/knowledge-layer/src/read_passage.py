"""NAT function for opening a NAMED passage: the locator beside the search.

`knowledge_search` is the only way this agent could reach a passage, and it is
a semantic search. So a second round that already knows what it wants — "the
Herleitung concluded that OIB-Richtlinie 2 Pkt. 3.5.2 decides this, and I have
not read it" — had to ask the corpus to *find* that passage again, by
similarity, competing with every neighbouring requirement. The model paid one
more search, one more reranker pass and one more requery judge for a lookup it
could already address.

This tool is that lookup. Given a document the inventory knows and a Punkt or a
page, it fetches exactly the chunks carrying that Punkt (``clause_id``, the
identifier the Punkt chunker verified against the corpus's own contents pages)
or that page, and returns them in the SAME grounding block ``knowledge_search``
returns — same ``Citation:`` keys, same ``Punkt:`` line, same ``## Trace-Lanes``
fan-out under the same round stamp. Everything downstream (citation
verification, the Herleitung spine, the source registry) therefore treats a
located passage exactly as it treats a searched one, which is the point: this
adds a way to REACH evidence, not a second kind of evidence.

Three properties are load-bearing, and they hold for the same lookup one
granularity up: ``document=`` with neither Punkt nor page is the OUTLINE, which
answers "what is in this document at all?" with the document's opening passage
plus a ``## Gliederung`` of its top-level Punkte. That question has no Punkt and
no page to name, and refusing it sent the model to a search that returns cover
pages and then to a Punkt number it had guessed.

**It never guesses a document.** The name is resolved against the documents
registered for the collections this turn may read — exact file name, stored
display title, or the derived OIB title — and an unresolved name is refused
with the two ways to recover plus up to three verbatim guesses from this
turn's inventory when anything is close. A locator that fuzzy-matches is a
search with worse recall and a confident label.

**It is deterministic.** No reranker, no requery judge, no LLM. The metadata
filter admits only the chunks of the named document that carry the named Punkt
or page, so the SET is whatever is stored; the order is by page and then Punkt
and then chunk id, which is stable across calls rather than across editions.
(The corpus stores no ordinal within a Punkt: the 11 Punkte of 946 long enough
for ``SentenceSplitter`` to cut carry only the parent's metadata on each piece.
Chunk id is the tie-break because it is stable, not because it is the reading
order.)

**It costs one call.** ``knowledge_search`` fans out across every collection in
scope, drafts, reranks and may re-query; this issues one filtered fetch per
collection the named document actually lives in — normally exactly one. It is
still charged to the research budget, because it reads evidence and the budget
is what bounds evidence-gathering; it is simply the cheapest thing that budget
can buy.

Scope and exclusions are NOT restated here: the tool reads them off the
``knowledge_search`` instance it is configured against
(:class:`~knowledge_layer.register.KnowledgeRetrievalConfig`), so the two can
never drift into reading different corpora.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pydantic import Field

from agent.common.action_outcome import ActionOutcome
from agent.common.action_rows import ActionRow
from nat.plugin_api import Builder
from nat.plugin_api import Context
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import register_function

from .read_passage_cursor import _PAGES_PATTERN  # noqa: F401
from .read_passage_cursor import RangeRefused  # noqa: F401
from .read_passage_cursor import ReadCursor  # noqa: F401
from .read_passage_cursor import _coerce_page  # noqa: F401
from .read_passage_cursor import _cursor_check  # noqa: F401
from .read_passage_cursor import _cursor_refusal  # noqa: F401
from .read_passage_cursor import _is_int  # noqa: F401
from .read_passage_cursor import _next_cursor  # noqa: F401
from .read_passage_cursor import _parse_pages  # noqa: F401
from .read_passage_cursor import decode_cursor  # noqa: F401
from .read_passage_cursor import encode_cursor  # noqa: F401
from .read_passage_family import _MAX_FAMILY_SCOPE_CHUNKS  # noqa: F401
from .read_passage_family import FamilyMember  # noqa: F401
from .read_passage_family import FamilyOverview  # noqa: F401
from .read_passage_family import FamilyUnreadable  # noqa: F401
from .read_passage_family import _corpus_families  # noqa: F401
from .read_passage_family import _family_trailer  # noqa: F401
from .read_passage_family import _member_title  # noqa: F401
from .read_passage_family import _read_member  # noqa: F401
from .read_passage_family import family_overview  # noqa: F401
from .read_passage_fetch import _fetch  # noqa: F401
from .read_passage_fetch import _fetch_all  # noqa: F401
from .read_passage_fetch import _fetch_query  # noqa: F401
from .read_passage_fetch import _structural_fetch  # noqa: F401
from .read_passage_models import Fetched  # noqa: F401
from .read_passage_models import PassageTarget  # noqa: F401
from .read_passage_models import ReadPassageInput  # noqa: F401
from .read_passage_outline import _EXCERPT_CHARS  # noqa: F401
from .read_passage_outline import _MAX_OUTLINE_CHUNKS  # noqa: F401
from .read_passage_outline import _MAX_OUTLINE_LINES  # noqa: F401
from .read_passage_outline import _NO_CLAUSES_LINE  # noqa: F401
from .read_passage_outline import _OUTLINE_DEPTHS  # noqa: F401
from .read_passage_outline import _OUTLINE_INSTRUCTION  # noqa: F401
from .read_passage_outline import Outline  # noqa: F401
from .read_passage_outline import OutlineEntry  # noqa: F401
from .read_passage_outline import _addresses  # noqa: F401
from .read_passage_outline import _clause_depth  # noqa: F401
from .read_passage_outline import _clause_number  # noqa: F401
from .read_passage_outline import _clause_of  # noqa: F401
from .read_passage_outline import _clause_sort_key  # noqa: F401
from .read_passage_outline import _covers_page  # noqa: F401
from .read_passage_outline import _document_order  # noqa: F401
from .read_passage_outline import _excerpt_of  # noqa: F401
from .read_passage_outline import _is_outline_chunk  # noqa: F401
from .read_passage_outline import _outline_block  # noqa: F401
from .read_passage_outline import _outline_entries  # noqa: F401
from .read_passage_outline import _outline_filters  # noqa: F401
from .read_passage_outline import _outline_lines  # noqa: F401
from .read_passage_outline import _scope_chunks  # noqa: F401
from .read_passage_outline import _table_part  # noqa: F401
from .read_passage_outline import _whole_document_filters  # noqa: F401
from .read_passage_outline import outline_for  # noqa: F401
from .read_passage_ranges import _FILTER_KINDS  # noqa: F401
from .read_passage_ranges import _MAX_PASSAGE_CHUNKS  # noqa: F401
from .read_passage_ranges import _MAX_RANGE_PAGES  # noqa: F401
from .read_passage_ranges import _MAX_READ_CHARS  # noqa: F401
from .read_passage_ranges import _PAGE_SPAN_WINDOW  # noqa: F401
from .read_passage_ranges import LABEL_FILTERS  # noqa: F401
from .read_passage_ranges import ORDER_FILTERS  # noqa: F401
from .read_passage_ranges import _chunk_ordinal  # noqa: F401
from .read_passage_ranges import _chunk_position  # noqa: F401
from .read_passage_ranges import _clause_spellings  # noqa: F401
from .read_passage_ranges import _filters_for  # noqa: F401
from .read_passage_ranges import _in_range  # noqa: F401
from .read_passage_ranges import _is_range_text  # noqa: F401
from .read_passage_ranges import _is_text  # noqa: F401
from .read_passage_ranges import _locus_label  # noqa: F401
from .read_passage_ranges import _meets_range  # noqa: F401
from .read_passage_ranges import _neighbours  # noqa: F401
from .read_passage_ranges import _page_range_text  # noqa: F401
from .read_passage_ranges import _page_span  # noqa: F401
from .read_passage_ranges import _page_window  # noqa: F401
from .read_passage_ranges import _passage_filters  # noqa: F401
from .read_passage_ranges import _range_filters  # noqa: F401
from .read_passage_ranges import _range_label_filters  # noqa: F401
from .read_passage_ranges import _range_order  # noqa: F401
from .read_passage_ranges import _range_trailer  # noqa: F401
from .read_passage_ranges import _within_budget  # noqa: F401
from .read_passage_ranges import _without_overlap  # noqa: F401
from .read_passage_revisions import _current_revision  # noqa: F401
from .read_passage_revisions import _older_revision_notice  # noqa: F401
from .read_passage_revisions import older_revision_line  # noqa: F401
from .read_passage_suggestions import _DID_YOU_MEAN_CUTOFF  # noqa: F401
from .read_passage_suggestions import _MAX_DID_YOU_MEAN  # noqa: F401
from .read_passage_suggestions import _NOT_READABLE_IS_NOT_ABSENT  # noqa: F401
from .read_passage_suggestions import _count  # noqa: F401
from .read_passage_suggestions import _empty_document_message  # noqa: F401
from .read_passage_suggestions import _nameable  # noqa: F401
from .read_passage_suggestions import _no_passage_message  # noqa: F401
from .read_passage_suggestions import _note_target  # noqa: F401
from .read_passage_suggestions import _read_row_fields  # noqa: F401
from .read_passage_suggestions import _store_silent_message  # noqa: F401
from .read_passage_suggestions import _suggestion_names  # noqa: F401
from .read_passage_suggestions import _unknown_document_message  # noqa: F401
from .read_passage_targets import _document_names  # noqa: F401
from .read_passage_targets import _documents_in  # noqa: F401
from .read_passage_targets import _matches  # noqa: F401
from .read_passage_targets import _resolve_targets  # noqa: F401

logger = logging.getLogger(__name__)


# Agent-facing contract: what it does, its inputs, what it returns and where it stops.
_READ_PASSAGE_DESCRIPTION = (
    "Opens a document by name: `document=` alone returns its OUTLINE, the document's opening passage plus a "
    "Gliederung of its top-level Punkte, and `document=` with `clause=` or `page=` returns exactly that passage. "
    "A lookup, not a search: no ranking, and it cannot find a document from a topic (`knowledge_search` does).\n"
    "Inputs: `document`, the exact name or display title as the inventory or a hit printed it "
    "(e.g. 'OIB-Richtlinie 2, Ausgabe Mai 2023' or 'oib-rl_2_ausgabe_mai_2023.pdf'). `clause`, the number alone "
    "('3.5.2', no 'Pkt.') or a table's caption ('Tabelle 3'), or for a project document what a hit's `Punkt:` "
    "line printed ('§ 4', 'Zeilen 2-41'); with `clause=`, `page=` is ignored. `page`, one page number. "
    "`pages`, a range ('4-6', at most 30 pages) in reading order without the overlap between neighbouring "
    "chunks, up to about 6k tokens; a read that stopped early ends with a `cursor` to pass back with the same "
    "`document=`.\n"
    "Returns: the passages, each with Source, Citation (copy verbatim), Dokumentart, Punkt and page. The "
    "Gliederung is an index, not evidence: only passages carry a Citation; a Punkt it lists, or one an outline "
    "in a `knowledge_search` result lists, opens here by its number (`clause=`). An unknown document name is refused, "
    "with up to three labelled guesses from this turn's readable inventory when anything is close.\n"
    "`conclusion=` is optional: one line on what you are looking for; it has no effect on the call."
)


class ReadPassageConfig(FunctionBaseConfig, name="read_passage"):
    """Configuration for the ``read_passage`` locator.

    One field, on purpose. Which collections a turn may read, which base corpus
    it points at and which files are excluded are the SEARCH's contract; this
    tool reads the same index through the same scope and so reads them off the
    ``knowledge_search`` instance rather than restating them, which is the only
    way the two cannot end up pointed at different corpora.
    """

    knowledge_search: FunctionRef = Field(
        default=FunctionRef("knowledge_search"),
        description=(
            "The `knowledge_retrieval` function instance whose collection scope, base "
            "corpus and file exclusions this locator shares."
        ),
    )


# ---------------------------------------------------------------------------
# A whole Richtlinien-Familie at once
#
# "Was weißt du über die OIB 2?" is a question about four documents. Search
# ranks passages, so it answered with the two that scored best and the model
# opened the rest one round at a time, when it knew they existed at all.
# `knowledge_search` detects the question (`norm_registry.family_query_number`)
# and asks for this: every member's scope passage and every member's
# Gliederung, in the block it was going to render anyway. One round, then one
# round of Punkt opens.
#
# Membership is DERIVED from what is indexed, never listed (`oib_families`): a
# deployment whose corpus holds no 2.3 must not be told it has one.
# ---------------------------------------------------------------------------


@register_function(config_type=ReadPassageConfig)
async def read_passage(config: ReadPassageConfig, _builder: Builder):
    """Open a named passage of a named document, or its outline. Deterministic; no LLM."""
    from .search_scope import resolve_base_collection
    from .search_scope import resolve_scoped_collections
    from .search_scope import restrict_scope_to_turn

    search_config = _builder.get_function_config(config.knowledge_search)

    def _entries() -> list[Any]:
        return restrict_scope_to_turn(
            resolve_scoped_collections(search_config, _session_collection(), resolve_base_collection(search_config))
        )

    async def _unknown(document: str) -> str:
        """The refusal for a name nothing nameable carries, with its guesses.

        Counts and guesses come only from collections whose documents may be
        named to the model (:func:`may_name`): a restricted folder's file is
        neither suggested nor counted until this turn admitted its collection,
        because listing is not use (ADR-0088).
        """
        from agent.knowledge.restricted_use import may_name

        nameable = [entry for entry in _entries() if may_name(entry.collection)]
        listings = await asyncio.gather(*(_documents_in(entry.collection) for entry in nameable))
        known = sum(len(docs) for docs in listings)
        scoped = [doc for docs in listings for doc in docs]
        # Full candidate list: the message shows the first three and names
        # how many more clear the bar, so truncating never hides the count.
        return _unknown_document_message(document, known, _suggestion_names(document, scoped, limit=1000))

    async def _resolve_or_refuse(document: str) -> tuple[list[PassageTarget], str]:
        """The (collection, file) targets this name resolves to, or the refusal."""
        targets = await _resolve_targets(_entries(), document)
        if targets:
            return targets, ""
        return [], await _unknown(document)

    async def _miss(document: str, targets: list[PassageTarget], message: str, outcome: ActionOutcome) -> str:
        """``message`` for a read that returned no passage, unless it would confirm a hidden document.

        A document only restricted folders hold, none of them admitted this
        turn, is answered as if it did not exist: "no such Punkt" or "registered
        but empty" would tell the model it is there (ADR-0088). Its row says the
        same: an error over the name the model asked for, no file name, no count.
        """
        if _nameable(targets) is not None:
            return message
        outcome.hits = None
        outcome.target = None
        return await _unknown(document)

    async def _read(arguments: ReadPassageInput) -> str:
        """Open a document you can name: one clause (Punkt) or page of it, or its outline.

        With neither `clause` nor `page`, the document's OUTLINE is returned: its
        opening passage plus a `## Gliederung` of its top-level Punkte with
        their pages. That is what to call when you know the document but not yet
        which Punkt holds the answer — never guess a Punkt number.
        Several documents or several Punkte are one call each, issued in the
        same round: a round costs one however many calls it holds.

        Arguments (``ReadPassageInput``):
            document: The document's exact indexed file name or display
                title, as the inventory or a previous hit printed it. Never
                invented, never a fragment.
            clause: Optional. The Punkt number alone, e.g. "3.5.2" — no
                "Pkt.", no title — or a table's caption, "Tabelle 3". A
                top-level Punkt often arrives as a number (`3`) and is read as
                its digits, the way `page` accepts a numeric string. Omit it,
                and `page`, for the outline. ``punkt`` is accepted as the
                former name of this argument.
            page: Optional. The page number, 1-based. Ignored when `clause` is
                given: the clause alone names the passage. ``''`` is treated as
                omitted (#656: providers send empty string for "no page"). Omit
                it, and `clause`, for the outline.
            pages: Optional. A page range such as "4-6" (or one page, "4"; at most
                30 pages): those pages in reading order, up to about 6k tokens,
                without the overlap between neighbouring chunks. Ignored when
                `clause` is given. Request every range you need in one round.
            cursor: Optional. The `cursor` a ranged read ended with, passed back with
                the same `document` to continue where it stopped. Opaque: copy it.
            conclusion: Optional. One line on what you are looking for;
                no effect on the call.

        Returns:
            str: The passages, in the same grounding-block format
            `knowledge_search` returns, with Citation keys to copy verbatim —
            followed by the Gliederung when no clause and no page was named.
        """
        outcome = ActionOutcome()
        row = ActionRow("read", **_read_row_fields(arguments))
        try:
            result = await _read_body(arguments, outcome)
        except BaseException:
            row.finish("error")
            raise
        # A read that returned without fetching (an unknown name, a refused range) found nothing to count: an error row.
        outcome.settle(row, default="error", target=outcome.target)
        return result

    async def _read_body(arguments: ReadPassageInput, outcome: ActionOutcome) -> str:
        from agent.common.tool_calls import READ_PASSAGE_TOOL
        from agent.common.turn_status import lane_tool_scope

        # `conclusion` is unread here on purpose — see the note in
        # `register.search`. It is a checkpoint channel read off the tool CALL,
        # never an input to what gets opened.
        document = (arguments.document or "").strip()
        clause = str(arguments.clause if arguments.clause is not None else "").strip().strip(".") or None
        pages_argument = arguments.pages
        page = _coerce_page(arguments.page)
        if pages_argument is None and _is_range_text(arguments.page):
            # `page="4-6"` is a range spelled with the old argument's name; a plain number stays a page.
            pages_argument, page = arguments.page, None
        if clause is not None and page is not None:
            # A Punkt (or „Tabelle 3") names one passage in a document, and
            # every chunk of it is filed under its FIRST page. A page beside it
            # can only repeat that page or empty the read: a Tabelle filed
            # under p. 30 and asked for as „page 29" (the printed page number)
            # came back empty, and the agent searched for it for two more rounds
            # (September 2026 census). The number decides; the page is dropped.
            page = None
        if not document:
            return (
                "Provide `document=` the exact name or display title of the document to open "
                "(from the inventory or a previous hit). To find out WHICH document holds a "
                "fact, call `knowledge_search` instead."
            )
        # Every branch below renders through `search_results.format_results`, which
        # is where lane hits are recorded — and it is the SAME renderer
        # `knowledge_search` uses, so the hit cannot say which tool fetched it
        # unless the tool says so here. The scope wraps the awaits rather than
        # sitting inside them: `format_results` runs in `asyncio.to_thread`,
        # which copies the context at call time.
        with lane_tool_scope(READ_PASSAGE_TOOL):
            if clause is None and (str(pages_argument or "").strip() or (arguments.cursor or "").strip()):
                return await _open_range(document, pages_argument, arguments.cursor, outcome)
            if clause is None and page is None:
                return await _outline(document, outcome)
            return await _open(document, clause, page, outcome)

    async def _open(document: str, clause: str | None, page: int | None, outcome: ActionOutcome) -> str:
        from .search_results import format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        _note_target(outcome, targets)
        query = _fetch_query(document, clause, page)
        # A page read fetches the window's chunks and keeps those covering the
        # page, so it may not stop at the passage bound before filtering.
        top_k = _MAX_PASSAGE_CHUNKS if page is None else _MAX_OUTLINE_CHUNKS
        fetched = await _fetch_all(targets, lambda file_name: _passage_filters(file_name, clause, page), query, top_k)
        chunks = [chunk for chunk in fetched.chunks if _addresses(chunk, clause, page)]
        if fetched.failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", query, exc_info=fetched.failures[0])
            return await _miss(document, targets, _store_silent_message(query), outcome)
        if not chunks:
            outcome.hits = 0
            return await _miss(document, targets, _no_passage_message(document, clause, page), outcome)

        chunks.sort(key=_clause_sort_key)
        merged = _passage_result(chunks[:_MAX_PASSAGE_CHUNKS], query)
        _count(outcome, len(merged.chunks), targets)
        formatted = await asyncio.to_thread(
            format_results,
            merged,
            query,
            notice=_older_revision_notice(targets),
            reading_of=_locus_label(document, clause, page),
        )
        logger.info("read_passage: %s returned %d chunk(s)", query, len(merged.chunks))
        return formatted

    async def _open_range(document: str, pages_argument: Any, cursor_token: str | None, outcome: ActionOutcome) -> str:
        """Pages ``first``-``last`` of a document in reading order, or the rest of a read that stopped early."""
        from .search_results import format_results

        try:
            span = _parse_pages(pages_argument, document)
        except RangeRefused as refusal:
            return str(refusal)
        targets, refusal_text = await _resolve_or_refuse(document)
        if refusal_text:
            return refusal_text

        _note_target(outcome, targets)
        cursor = decode_cursor(cursor_token) if (cursor_token or "").strip() else None
        if (cursor_token or "").strip():
            targets = [
                target
                for target in targets
                if cursor is not None
                and target.file_name == cursor.file_name
                and (not cursor.collection or target.collection == cursor.collection)
            ]
            if not targets:
                return _cursor_refusal(document, span)
        # `pages` beside a cursor only says where the read ends; the cursor says where it starts.
        first = cursor.page if cursor is not None else span[0]
        last = span[1] if span is not None else (cursor.last_page if cursor is not None else None)
        start = cursor.position if cursor is not None else None
        kind = cursor.filters if cursor is not None else ORDER_FILTERS

        query = _fetch_query(document, None, None)
        fetched = await _fetch_all(targets, _filters_for(kind, first, last), query, _MAX_OUTLINE_CHUNKS, start)
        if start is None and not fetched.chunks and not fetched.failures and last is not None:
            # A document written before `reading_order` existed has no value for the range to compare.
            # The cursor records the family, so the continuation reads the same set.
            kind = LABEL_FILTERS
            fetched = await _fetch_all(targets, _filters_for(kind, first, last), query, _MAX_OUTLINE_CHUNKS)
        chunks = _in_range(fetched.chunks, first, last, start)
        if start is None and not chunks and not fetched.failures and len(fetched.chunks) >= _MAX_OUTLINE_CHUNKS:
            # The look-back pages alone filled the fetch: read again from the first page itself.
            fetched = await _fetch_all(targets, _filters_for(kind, first, last, 0), query, _MAX_OUTLINE_CHUNKS)
            chunks = _in_range(fetched.chunks, first, last, start)
        label = _locus_label(document, None, None, (first, last) if last is not None else (first, first))
        if fetched.failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", label, exc_info=fetched.failures[0])
            return await _miss(document, targets, _store_silent_message(label), outcome)
        if not chunks:
            outcome.hits = 0
        if not chunks and start is not None:
            return f"Nothing is left after that cursor in {document}: the read is complete."
        if not chunks:
            return await _miss(document, targets, _no_passage_message(document, None, None, span), outcome)

        ordered = await asyncio.to_thread(lambda: _without_overlap(_range_order(chunks)))
        kept, more = _within_budget(ordered, _MAX_READ_CHARS)
        capped = len(fetched.chunks) >= _MAX_OUTLINE_CHUNKS
        next_cursor = _next_cursor(kept, last, kind) if more or capped else None
        trailer = _range_trailer(document, kept, first, last, next_cursor)
        merged = _passage_result(kept, label)
        _count(outcome, len(kept), targets)
        formatted = await asyncio.to_thread(
            format_results,
            merged,
            label,
            notice=_older_revision_notice(targets),
            trailer=trailer,
            reading_of=label,
        )
        logger.info("read_passage: %s returned %d chunk(s), cursor=%s", label, len(kept), bool(next_cursor))
        return formatted

    async def _outline(document: str, outcome: ActionOutcome) -> str:
        """The same lookup at document granularity: scope passage plus Gliederung."""
        from .search_results import format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        query = _fetch_query(document, None, None)
        _note_target(outcome, targets)
        outline = await outline_for(targets, query)
        entries = outline.entries
        if not outline.chunks:
            return await _opening_passages(document, targets, query, outline.failures, outcome)

        passages = _scope_chunks(outline.chunks)[:_MAX_PASSAGE_CHUNKS]
        _count(outcome, len(passages), targets)
        # The Gliederung travels as the block's trailer rather than being glued
        # on here: the renderer files the records under the hash of the bytes it
        # returns, and a byte added afterwards costs this tool the structured
        # read on its most common call (ADR-0061).
        formatted = await asyncio.to_thread(
            format_results,
            _passage_result(passages, query),
            query,
            notice=_older_revision_notice(targets),
            trailer=_outline_block(entries),
            reading_of=document,
        )
        logger.info("read_passage: %s outlined %d Punkt(e)", query, len(entries))
        return formatted

    async def _opening_passages(
        document: str, targets: list[PassageTarget], query: str, failures: list[BaseException], outcome: ActionOutcome
    ) -> str:
        """The outline of a document with no Punkt metadata: its opening passages.

        Those chunks ARE the passages — there is no heading structure to index,
        so the block carries no Gliederung and says so in one line. Nothing is
        re-checked here beyond the document itself: the fetch narrows to the
        file and the document-order sort decides which chunks open it, because
        a second clause on ``page_label`` would exclude every store that fills
        it with something other than a page number.
        """
        from .search_results import format_results

        whole = await _fetch_all(targets, _whole_document_filters, query, _MAX_OUTLINE_CHUNKS)
        fetched = whole.chunks
        broke = failures + whole.failures
        if not fetched and broke:
            logger.warning("read_passage: every outline fetch failed for %r", query, exc_info=broke[0])
            return await _miss(document, targets, _store_silent_message(query), outcome)
        if not fetched:
            outcome.hits = 0
            return await _miss(document, targets, _empty_document_message(document), outcome)

        merged = _passage_result(sorted(fetched, key=_clause_sort_key)[:_MAX_PASSAGE_CHUNKS], query)
        _count(outcome, len(merged.chunks), targets)
        # The line that replaces the Gliederung rides the same trailer, and for
        # the same reason: the hash is over the whole text.
        formatted = await asyncio.to_thread(
            format_results,
            merged,
            query,
            notice=_older_revision_notice(targets),
            trailer=_NO_CLAUSES_LINE,
            reading_of=document,
        )
        logger.info("read_passage: %s outlined %d opening chunk(s)", query, len(merged.chunks))
        return formatted

    yield FunctionInfo.from_fn(_read, input_schema=ReadPassageInput, description=_READ_PASSAGE_DESCRIPTION)


def _session_collection() -> str | None:
    """This conversation's own collection, when a NAT context states one."""
    try:
        ctx = Context.get()
        return ctx.conversation_id if ctx else None
    except Exception:  # noqa: BLE001 — no context is a valid standalone run
        return None


def _passage_result(chunks: list[Any], query: str):
    """The located chunks as the ``RetrievalResult`` the formatter expects."""
    from agent.knowledge.schema import RetrievalResult

    return RetrievalResult(chunks=chunks, query=query, backend="read_passage", success=True)
