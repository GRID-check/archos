"""Fetching the stored chunks of a read: the structural and text fetches, and the query each one runs."""

from __future__ import annotations

import asyncio
from typing import Any

from .read_passage_models import Fetched
from .read_passage_models import PassageTarget
from .read_passage_ranges import _locus_label


def _fetch_query(document: str, clause: str | None, page: int | None) -> str:
    """The probe text handed to the store.

    The filter has already decided which chunks exist, so this only orders a set
    the caller is taking whole — it is never a search. It still names the locus
    rather than being empty, because an empty string embeds to nothing useful and
    some stores refuse it. A backend that reads by filter (``BaseRetriever.fetch``)
    never sees it; it is then only the label the result names itself by.
    """
    return _locus_label(document, clause, page)


async def _structural_fetch(
    retriever: Any,
    collection: str,
    filters: dict[str, Any],
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> list[Any] | None:
    """The chunks by filter alone, in reading order, when the backend reads that way; else ``None``.

    No probe, no embedding, no ranking (``BaseRetriever.fetch``). The cut is in
    reading order and never splits a tie, so every sort below keeps what it
    would have kept from the whole set. With ``start_from`` the read continues after that
    :func:`_chunk_position` instead (a ranged read's cursor).
    """
    from aiq_agent.knowledge.base import READING_ORDER

    fetch = getattr(retriever, "fetch", None)
    if fetch is None:
        return None
    if start_from is not None:
        return await fetch(collection_name=collection, filters=filters, limit=top_k, start_from=start_from)
    return await fetch(collection_name=collection, filters=filters, limit=top_k, order_by=READING_ORDER)


async def _fetch(
    target: PassageTarget,
    filters: dict[str, Any],
    query: str,
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> tuple[list[Any], bool]:
    """One filtered fetch against one collection, stamped with where it came from.

    The second value says whether it was a structural fetch. A backend that
    cannot read by filter is asked through ``retrieve`` with the probe text.
    """
    from aiq_agent.knowledge.factory import get_active_retriever

    retriever = get_active_retriever()
    chunks = await _structural_fetch(retriever, target.collection, filters, top_k, start_from)
    structural = chunks is not None
    if chunks is None:
        result = await retriever.retrieve(
            query=query,
            collection_name=target.collection,
            top_k=top_k,
            filters=filters,
        )
        chunks = list(getattr(result, "chunks", None) or [])
    # Same stamping the search's per-collection fan-out does: this is the
    # last point at which the stratum is known for free, and nothing
    # downstream may recover a shelf from a collection id (ADR-0047).
    for chunk in chunks:
        chunk.metadata.setdefault("collection", target.collection)
        if target.shelf:
            chunk.metadata.setdefault("shelf", target.shelf)
    return chunks, structural


async def _fetch_all(
    targets: list[PassageTarget],
    filters_for,
    query: str,
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> Fetched:
    """One filtered fetch per target, gathered. Failures are returned, not raised:
    one unreachable collection must not refuse the document that did answer."""
    fetched = await asyncio.gather(
        *(_fetch(target, filters_for(target.file_name), query, top_k, start_from) for target in targets),
        return_exceptions=True,
    )
    answered = [group for group in fetched if not isinstance(group, BaseException)]
    return Fetched(
        chunks=[chunk for chunks, _structural in answered for chunk in chunks],
        failures=[group for group in fetched if isinstance(group, BaseException)],
        structural=bool(answered) and all(structural for _chunks, structural in answered),
    )
