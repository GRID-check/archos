"""The rankings under comparison, each produced by the production code that serves it.

* :func:`postgres_lexical` — ``ChunkTextStore.search``: the German mirror the Chroma
  path reads, with the EN→DE glossary terms it is given in production.
* :func:`qdrant_bm25` — the BM25 prefetch of ``qdrant/search.py`` on its own: the
  same ``Document`` (``store.bm25``, so ``BM25_OPTIONS``), the same ``_bm25_text``
  input, the same per-scope IDF, the same scope filter. It is the only query here
  that drives ``qdrant_client`` directly, because production never runs BM25 alone;
  the objects it is built from are the package's.
* :func:`hybrid` — ``LlamaIndexRetriever._retrieve_sync``, under whichever
  ``AIQ_VECTOR_BACKEND`` the caller set: the full per-collection retrieval.
* :func:`exact_matches` — ``_find_text_sync``: Chroma ``$regex`` or Qdrant's scroll
  plus Python ``re``, for one ``browse.phrase_pattern``.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Any

from oib_retrieval_eval.qdrant_parity.stores import SCOPE

#: How much deeper the Postgres channel is read than the depth scored. Production
#: drops excluded files from its hits AFTER the SQL limit (the fetch-back from
#: Chroma applies the filter); reading deeper scores the channel's ranking rather
#: than that truncation, which favours Postgres and is stated in the report.
POSTGRES_OVERFETCH = 3

#: The base collection's filter, as ``register._base_collection_filters`` builds it.
NON_EVIDENCE_CHUNKING = "page"


def base_filters(excluded: Sequence[str]) -> dict[str, Any]:
    clauses: list[dict[str, Any]] = [{"chunking": {"$ne": NON_EVIDENCE_CHUNKING}}]
    if excluded:
        clauses.append({"file_name": {"$nin": sorted(set(excluded))}})
    return clauses[0] if len(clauses) == 1 else {"$and": clauses}


def postgres_lexical(store: Any, query: str, depth: int) -> list[str]:
    """Chunk ids from the German mirror, best first (deeper than ``depth``, see above)."""
    from aiq_agent.common.query_expansion import expansion_terms

    return store.search(SCOPE, query, limit=depth * POSTGRES_OVERFETCH, extra_terms=expansion_terms(query))


def qdrant_bm25(retriever: Any, query: str, depth: int, filters: dict[str, Any] | None) -> list[str]:
    """Chunk ids from Qdrant's server-side German BM25 alone, best first.

    The query text is the one the adapter sends (``_qdrant_lexical_inputs``: the
    question's terms priced against the collection), so an empty text, and an
    empty result, is the channel staying silent as it would in production.
    """
    from knowledge_layer.qdrant.schema import LEXICAL
    from knowledge_layer.qdrant.scope import scope_condition
    from knowledge_layer.qdrant.scope import scope_filter
    from knowledge_layer.qdrant.store import bm25
    from knowledge_layer.qdrant.store import get_store
    from qdrant_client import models

    store = get_store()
    text, _terms = retriever._qdrant_lexical_inputs(query, SCOPE)
    if not text.strip():
        return []
    idf = models.SearchParams(idf=models.IdfCorpusParams(corpus=models.Filter(must=[scope_condition([SCOPE])])))
    result = store.client.query_points(
        store.alias(SCOPE),
        query=bm25(text),
        using=LEXICAL,
        query_filter=scope_filter([SCOPE], filters),
        search_params=idf,
        limit=depth,
        with_payload=["chunk_id"],
    )
    return [str((point.payload or {}).get("chunk_id") or point.id) for point in result.points]


def hybrid(retriever: Any, query: str, depth: int, filters: dict[str, Any] | None) -> tuple[list[Any], float]:
    """The per-collection retrieval and its wall time in ms (no embedding inside it)."""
    started = time.perf_counter()
    result = retriever._retrieve_sync(query, SCOPE, depth, filters)
    elapsed = (time.perf_counter() - started) * 1000.0
    if not result.success:
        raise RuntimeError(f"retrieval failed for {query!r}: {result.error_message}")
    return list(result.chunks), elapsed


def exact_matches(retriever: Any, phrase: str, filters: dict[str, Any] | None, limit: int = 5000) -> set[str]:
    """Chunk ids ``find_text`` returns for one phrase (through ``browse.phrase_pattern``)."""
    from knowledge_layer.browse import phrase_pattern

    pattern = phrase_pattern([phrase])
    if pattern is None:
        return set()
    return {chunk.chunk_id for chunk in retriever._find_text_sync(SCOPE, pattern, filters, limit)}


def phrase_index_matches(phrase: str, filters: dict[str, Any] | None) -> set[str]:
    """Chunk ids the full-text index's ``MatchPhrase`` alone admits (design Q3: can it serve exact mode?)."""
    from knowledge_layer.qdrant.scope import scope_filter
    from knowledge_layer.qdrant.search import phrase as phrase_condition
    from knowledge_layer.qdrant.store import get_store

    store = get_store()
    found: set[str] = set()
    offset: Any = None
    while True:
        page, offset = store.client.scroll(
            store.alias(SCOPE),
            scroll_filter=scope_filter([SCOPE], filters, phrase_condition(phrase)),
            limit=512,
            offset=offset,
            with_payload=["chunk_id"],
            with_vectors=False,
        )
        found.update(str((record.payload or {}).get("chunk_id") or record.id) for record in page)
        if offset is None:
            return found
