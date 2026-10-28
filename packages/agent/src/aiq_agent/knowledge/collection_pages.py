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


def read_pages(collection: str, file_name: str) -> list[tuple[Any, str]] | None:
    """``(page_label, chunk text)`` of one file in reading order, or None when the collection or file has none.

    The text is the document's (:func:`own_page_texts`): a chunk's breadcrumb and the overlap it
    repeats are left out, so a reader of the pages reads each sentence once.

    Raises when the store cannot be read: an outage is not evidence that a
    file has no chunks, so it never reads as None (``read_passage`` does the same).

    A structural fetch (``knowledge_layer.qdrant.reads.fetch``): a filter on the
    file, no query vector, no ranking. Reading order is page, then the section
    structure ``read_passage`` sorts by, then the chunk's place in the file
    (``reads.in_document_order``); point ids, which a scroll returns them by,
    are random.
    """
    hits = _document_hits(collection, file_name)
    return [(hit.payload.get("page_label"), text) for hit, text in zip(hits, own_page_texts(hits)) if text] or None


def own_page_texts(hits: list[Any]) -> list[str]:
    """Each hit's text as the document reads there: no breadcrumb, no overlap repeated from the chunk before.

    A section or Punkt chunk opens with its heading breadcrumb and repeats about 96 tokens of its
    predecessor (``knowledge_layer.chunk_positions``); read back as stored, every ancestor heading
    stood before every chunk and the overlap twice. The section's own heading stays, once, at the
    head of its first part. ``hits`` are one file's, in reading order; a point without
    ``chunk_ordinal`` keeps its overlap unless a chunk of its own page holds it.
    """
    from types import SimpleNamespace

    from knowledge_layer.chunk_positions import own_texts

    views = [
        SimpleNamespace(
            chunk_id=str(getattr(hit, "chunk_id", "") or ""),
            content=hit.text or "",
            metadata=hit.payload or {},
            file_name=(hit.payload or {}).get("file_name"),
            content_type=(hit.payload or {}).get("content_type"),
            page_number=(hit.payload or {}).get("page_label"),
        )
        for hit in hits
    ]
    return [(own.text[: own.repeat_start] + own.text[own.repeat_end :].lstrip()).strip() for own in own_texts(views)]


def read_chunks(collection: str, file_name: str) -> list[tuple[str, dict[str, Any]]] | None:
    """``(chunk text, metadata)`` of one file in reading order; None when the collection or file has none.

    The compare of two Fassungen (``revision_diff``) needs what ``read_pages``
    drops: the ``content_type`` that tells printed text from a drawing reading,
    and the ``drawing_data`` that holds the reading's structure. The same
    structural fetch and order, with the chunk's own metadata
    (``chunk_metadata``: the payload without the fields only the store adds).
    Raises when the store cannot be read, as ``read_pages`` does.
    """
    from knowledge_layer.qdrant.payload import chunk_metadata

    hits = _document_hits(collection, file_name)
    return [(hit.text, chunk_metadata(hit.payload)) for hit in hits if hit.text] or None


def _document_hits(collection: str, file_name: str) -> list[Any]:
    """Every chunk of one file, in reading order (``reads.in_document_order``)."""
    from knowledge_layer.qdrant import reads

    return reads.in_document_order(reads.fetch(collection, {"file_name": file_name}, MAX_CHUNKS))
