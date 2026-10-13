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


def read_chunks(collection: str, file_name: str) -> list[tuple[str, dict[str, Any]]] | None:
    """``(chunk text, metadata)`` of one file in reading order; None when the collection or file has none.

    The compare of two Fassungen (``fassung_diff``) needs what ``read_pages``
    drops: the ``content_type`` that tells printed text from a drawing reading,
    and the ``drawing_data`` that holds the reading's structure. The same
    structural fetch, with the chunk's own metadata (``chunk_metadata``: the
    payload without the fields only the store adds).
    """
    try:
        from knowledge_layer.qdrant import reads
        from knowledge_layer.qdrant.payload import chunk_metadata

        hits = reads.fetch(collection, {"file_name": file_name}, MAX_CHUNKS)
    except Exception:  # noqa: BLE001 - an unreadable file is a per-document gap, not a failure
        return None
    return [(hit.text, chunk_metadata(hit.payload)) for hit in hits if hit.text] or None
