"""A document's indexed text, page by page, read back from its collection's chunks.

The permit backfill and the project-experience route both read a document that was
ingested long ago without re-parsing it: the chunks in Qdrant carry the text and
the page label. One reader, so the two cannot drift in how they order pages.
"""

from __future__ import annotations

from typing import Any

#: The most chunks one document's read takes. A guard, not a budget: the
#: structural fetch's own cap (``knowledge_layer.qdrant.reads.WHOLE_SET_CAP``).
MAX_CHUNKS = 4096


def page_sort_key(item: tuple[Any, str]) -> int:
    """Numeric page order; a chunk without a readable page label sorts first (Python sorts stably)."""
    try:
        return int(item[0] or 0)
    except (TypeError, ValueError):
        return 0


def read_pages(collection: str, file_name: str) -> list[tuple[Any, str]] | None:
    """``(page_label, chunk text)`` of one file in reading order, or None when the collection or file has none.

    A structural fetch (``knowledge_layer.qdrant.reads.fetch``): a filter on the
    file, no query vector, no ranking.
    """
    try:
        from knowledge_layer.qdrant import reads

        hits = reads.fetch(collection, {"file_name": file_name}, MAX_CHUNKS)
    except Exception:  # noqa: BLE001 - an unreadable file is a per-document gap, not a failure
        return None
    pages = [(hit.payload.get("page_label"), hit.text) for hit in hits if hit.text]
    return sorted(pages, key=page_sort_key) or None
