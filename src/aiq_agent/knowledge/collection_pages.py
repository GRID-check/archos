"""A document's indexed text, page by page, read back from its collection's chunks.

The permit backfill and the project-experience route both read a document that was
ingested long ago without re-parsing it: the chunks Chroma holds carry the text and
the page label. One reader, so the two cannot drift in how they order pages.
"""

from __future__ import annotations

from typing import Any


def page_sort_key(item: tuple[Any, str]) -> int:
    """Numeric page order; a chunk without a readable page label sorts first (Python sorts stably)."""
    try:
        return int(item[0] or 0)
    except (TypeError, ValueError):
        return 0


def read_pages(client: Any, collection: str, file_name: str) -> list[tuple[Any, str]] | None:
    """``(page_label, chunk text)`` of one file in reading order, or None when the collection or file has none."""
    try:
        result = client.get_collection(name=collection).get(
            where={"file_name": file_name}, include=["documents", "metadatas"]
        )
    except Exception:  # noqa: BLE001 - a missing collection or file is a per-document gap, not a failure
        return None
    documents = (result or {}).get("documents") or []
    metadatas = (result or {}).get("metadatas") or [None] * len(documents)
    pages = [((meta or {}).get("page_label"), text) for text, meta in zip(documents, metadatas, strict=False) if text]
    return sorted(pages, key=page_sort_key) or None


def read_chunks(client: Any, collection: str, file_name: str) -> list[tuple[str, dict[str, Any]]] | None:
    """``(chunk text, metadata)`` of one file, as stored; None when the collection or file has none.

    The compare of two Fassungen (``fassung_diff``) needs what ``read_pages``
    drops: the ``content_type`` that tells printed text from a drawing reading,
    and the ``drawing_data`` that holds the reading's structure.
    """
    try:
        result = client.get_collection(name=collection).get(
            where={"file_name": file_name}, include=["documents", "metadatas"]
        )
    except Exception:  # noqa: BLE001 - a missing collection or file is a gap, not a failure
        return None
    documents = (result or {}).get("documents") or []
    metadatas = (result or {}).get("metadatas") or [None] * len(documents)
    chunks = [(text, dict(meta or {})) for text, meta in zip(documents, metadatas, strict=False) if text]
    return chunks or None
