"""The ranked search's browse path: the candidate counts per collection, the literal-word filter, and the search
itself over the collections a turn may read.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.source_kinds import canonical_shelf_value

from .browse_matches import MAX_MATCH_CHUNKS
from .browse_matches import group_matches
from .browse_matches import pick_passages
from .browse_messages import match_snippets
from .browse_messages import match_table
from .browse_messages import no_match_message
from .browse_messages import search_failed_message
from .browse_patterns import _CAPPED_WITHOUT_OWN_MATCH
from .browse_patterns import _TOO_COSTLY
from .browse_patterns import _TOO_COSTLY_SCAN
from .browse_scope import _STEMMED_NOTE
from .browse_scope import ShelfScope
from .browse_turn import _entry_shelf

# Logs under the name browse always had, so a filter on that name still catches these records.
logger = logging.getLogger("knowledge_layer.browse")

#: ``shelf=`` of a literal search as the person-facing word, and the stored shelf it means.
SEARCH_SHELVES = {
    "project": "project",
    "office": "office_shelf",
    "office_shelf": "office_shelf",
    "session": "session",
    "base": "base",
}


def _has_literal_word(pattern: str) -> bool:
    """True when a person's regex names a word the full-text index can narrow the scan with."""
    from .qdrant.retrieval import user_literal_tokens

    return bool(user_literal_tokens(pattern))


def _collection_filter(
    collection: str,
    *,
    base: str,
    search_config: Any,
    caller_filters: dict[str, Any] | None,
    files: Sequence[str] | None,
    folder_key: str | None = None,
) -> dict[str, Any] | None:
    """The store filter for one collection: the narrowing, and on the base corpus its standing filter.

    The base corpus holds text that is not evidence (cover and Impressum page
    chunks) and editions the deployment excludes; the ranked search keeps both
    out with ``search_scope.base_collection_filters``, and a literal search that
    skipped it returned exactly those as citable passages. User collections are
    never filtered beyond the narrowing, as in the ranked search. The narrowing
    is a file list and/or the folder condition; ``scope_filter`` ANDs it onto the tenancy condition.
    """
    from .qdrant.prefilter import FOLDER_FIELD

    clauses = [
        clause
        for clause in (
            {"file_name": {"$in": sorted(files)}} if files is not None else None,
            {FOLDER_FIELD: folder_key} if folder_key else None,
        )
        if clause
    ]
    narrowing = None if not clauses else clauses[0] if len(clauses) == 1 else {"$and": clauses}
    if collection != base:
        return narrowing
    from .search_scope import base_collection_filters

    extra = [clause for clause in (caller_filters, narrowing) if clause]
    combined = extra[0] if len(extra) == 1 else ({"$and": extra} if extra else None)
    return base_collection_filters(search_config, combined)


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
    from aiq_agent.knowledge.restricted_use import note_collections_read

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


async def _candidate_counts(
    retriever: Any,
    capped: Sequence[Any],
    pattern: str,
    filters_by_collection: Mapping[str, dict[str, Any] | None],
    *,
    regex_mode: bool,
) -> dict[str, int] | None:
    """Per file, the passages that hold the pattern's words, over the collections whose scan hit its limit.

    One Qdrant facet each, under the filter the scan used. A retriever without the facet, or a
    pattern with no word to count by, gives None: the table then says "at least" and nothing more.
    """
    counter = getattr(retriever, "candidate_counts", None)
    if counter is None or not capped:
        return None
    totals: dict[str, int] = {}
    for entry in capped:
        try:
            counts = await counter(
                entry.collection, pattern, filters_by_collection.get(entry.collection), user_regex=regex_mode
            )
        except Exception:  # noqa: BLE001 — the counts are an addition to an answer the scan already gave
            logger.warning("exact search: candidate counts for %s failed", entry.collection, exc_info=True)
            continue
        for name, count in (counts or {}).items():
            totals[name] = totals.get(name, 0) + count
    return totals or None


def entries_on_shelf(entries: Sequence[Any], shelf: str | None) -> tuple[list[Any], str]:
    """The ``entries`` on the asked shelf, or all when none is asked; a refusal when the word is unknown or empty.

    The empty case is said as a scope fact: the shelf is out of THIS turn's reach, which is not a "no".
    """
    entries = list(entries)
    asked = (shelf or "").strip().lower()
    if not asked:
        return entries, ""
    wanted = SEARCH_SHELVES.get(canonical_shelf_value(asked))
    if wanted is None:
        return [], f"`shelf` must be one of project, office, base (or omitted for every shelf), got {shelf!r}."
    kept = [entry for entry in entries if _entry_shelf(entry) == wanted]
    if not kept:
        return [], (
            f"The shelf {asked!r} is not part of this question's scope, so it was not searched. That says nothing "
            "about what lies there; only the user changes the selection."
        )
    return kept, ""
