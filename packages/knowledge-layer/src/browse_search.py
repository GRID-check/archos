"""The ranked search's browse path: the candidate counts per collection, the literal-word filter, and the search
itself over the collections a turn may read.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from agent.common.source_kinds import canonical_shelf_value

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
