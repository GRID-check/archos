"""Ranked reads: one Query API call per search, fused on the server.

A search runs these channels as prefetches over the same scope filter and
fuses them by reciprocal rank (k=60, the paper's constant; Qdrant's own
default is 2, so it is always set):

* the dense vector, the production embedder's;
* BM25 over the chunk text, analysed in German by Qdrant itself, with
  document frequencies counted over the searched scopes only, so one office's
  vocabulary never decides another's rarity;
* per exact term (``§ 3``, ``OIB-RL 2``), the dense ranking restricted to
  chunks containing that phrase.

This replaces three things the Chroma path did by hand: the ``$contains``
passes, the Postgres German mirror with its fetch-back by id, and the RRF in
Python. Fusion stays rank-only, so the two score scales never need to agree.

A fused score is a rank statistic, not a relevance. Every hit therefore also
carries its true cosine to the query, which every consumer of ``Chunk.score``
expects (the grounding block prints it, thresholds compare against it); it
comes from one exact dense query over the fused hits' ids, no vectors shipped.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from qdrant_client import models

from .boost import Boost
from .boost import boosted
from .boost import likeness_formula
from .schema import DENSE
from .schema import LEXICAL
from .schema import TEXT_FIELD
from .schema import physical_for_scope
from .scope import scope_condition
from .scope import scope_filter
from .store import QdrantStore
from .store import bm25

#: Reciprocal rank fusion constant (Cormack, Clarke & Buettcher, SIGIR 2009),
#: the value the Python fusion in ``llamaindex/hybrid.py`` has always used.
RRF_K = 60


@dataclass
class Hit:
    """One ranked chunk."""

    chunk_id: str
    text: str
    payload: dict[str, Any]
    #: The fused rank score: comparable within one result list only.
    fused: float
    #: Cosine similarity between the query and the chunk's dense vector.
    cosine: float


def phrase(term: str) -> models.FieldCondition:
    """Chunks whose text contains ``term`` as a phrase (tokenized, lowercased, umlauts folded)."""
    return models.FieldCondition(key=TEXT_FIELD, match=models.MatchPhrase(phrase=term))


def _alias(store: QdrantStore, scopes: Sequence[str]) -> str:
    physicals = {physical_for_scope(scope) for scope in scopes}
    if len(physicals) != 1:
        raise ValueError(f"One search reads one physical collection; scopes {list(scopes)!r} span {physicals}")
    return store.alias(scopes[0])


def _prefetches(
    scopes: Sequence[str],
    query_filter: models.Filter,
    vector: Sequence[float],
    lexical_text: str,
    exact_terms: Sequence[str],
    candidates: int,
) -> list[models.Prefetch]:
    idf = models.SearchParams(idf=models.IdfCorpusParams(corpus=models.Filter(must=[scope_condition(scopes)])))
    prefetch = [models.Prefetch(query=list(vector), using=DENSE, limit=candidates, filter=query_filter)]
    if lexical_text.strip():
        prefetch.append(
            models.Prefetch(query=bm25(lexical_text), using=LEXICAL, limit=candidates, filter=query_filter, params=idf)
        )
    for term in exact_terms:
        restricted = models.Filter(must=[query_filter, phrase(term)])
        prefetch.append(models.Prefetch(query=list(vector), using=DENSE, limit=candidates, filter=restricted))
    return prefetch


def _cosines(
    store: QdrantStore, alias: str, scopes: Sequence[str], vector: Sequence[float], ids: Sequence[Any]
) -> dict[str, float]:
    """True cosine of each point to the query, by point id; exact, over these points only."""
    if not ids:
        return {}
    result = store.client.query_points(
        alias,
        query=list(vector),
        using=DENSE,
        query_filter=scope_filter(scopes, None, models.HasIdCondition(has_id=list(ids))),
        search_params=models.SearchParams(exact=True),
        limit=len(ids),
        with_payload=False,
    )
    return {str(point.id): float(point.score) for point in result.points}


def _hit(point: Any, cosines: dict[str, float]) -> Hit:
    payload = dict(point.payload or {})
    return Hit(
        chunk_id=str(payload.get("chunk_id") or point.id),
        text=str(payload.get(TEXT_FIELD) or ""),
        payload=payload,
        fused=float(point.score),
        cosine=cosines.get(str(point.id), 0.0),
    )


def hybrid_search(
    store: QdrantStore,
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    limit: int,
    filters: dict[str, Any] | None = None,
    exact_terms: Sequence[str] = (),
    candidates: int | None = None,
) -> list[Hit]:
    """The fused ranking over ``scopes``, best first."""
    if limit <= 0 or not store.exists(scopes[0]):
        return []
    alias = _alias(store, scopes)
    query_filter = scope_filter(scopes, filters)
    result = store.client.query_points(
        alias,
        prefetch=_prefetches(scopes, query_filter, vector, lexical_text, exact_terms, candidates or limit),
        query=models.RrfQuery(rrf=models.Rrf(k=RRF_K)),
        limit=limit,
        with_payload=True,
    )
    cosines = _cosines(store, alias, scopes, vector, [point.id for point in result.points])
    return [_hit(point, cosines) for point in result.points]


def grouped_search(
    store: QdrantStore,
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    group_by: str,
    groups: int,
    group_size: int,
    filters: dict[str, Any] | None = None,
    boost: Boost | None = None,
    candidates: int = 200,
) -> list[tuple[str, list[Hit]]]:
    """The fused ranking over ``scopes``, grouped by a payload field, best group first.

    Cross-project search groups by ``scope``: one call ranks every reachable
    project's documents together, instead of one search per project merged
    on scores that are not comparable across indexes.

    ``filters`` narrow every channel inside the scope (tags, project facts):
    a pre-filter, so nothing is fetched to be dropped afterwards. ``boost``
    rescores each channel by the passage's project's likeness to the current
    one before the fusion (``boost.py``); the fusion stays the main query, so
    the ranking stays global on a sharded collection.
    """
    if groups <= 0 or not store.exists(scopes[0]):
        return []
    alias = _alias(store, scopes)
    query_filter = scope_filter(scopes, filters)
    likeness = likeness_formula(boost)
    prefetch = [
        boosted(channel, likeness)
        for channel in _prefetches(scopes, query_filter, vector, lexical_text, (), candidates)
    ]
    # One flat fused ranking, grouped here in its order. Qdrant's group query
    # is no substitute: with a fusion as its query it fuses again for every
    # round of groups it collects, so each round's best passage scores rank 0
    # and the groups interleave by round instead of by relevance (measured on
    # 1.19.2; ``test_qdrant_boost.py`` pins it).
    result = store.client.query_points(
        alias,
        prefetch=prefetch,
        query=models.RrfQuery(rrf=models.Rrf(k=RRF_K)),
        limit=max(candidates, groups * group_size),
        with_payload=True,
    )
    collected = _group_in_order(result.points, group_by, groups, group_size)
    ids = [point.id for points in collected.values() for point in points]
    cosines = _cosines(store, alias, scopes, vector, ids)
    return [(key, [_hit(point, cosines) for point in points]) for key, points in collected.items()]


def _group_in_order(points: Sequence[Any], group_by: str, groups: int, group_size: int) -> dict[str, list[Any]]:
    """The first ``groups`` values of ``group_by`` in ranking order, each with its best ``group_size`` points."""
    collected: dict[str, list[Any]] = {}
    for point in points:
        key = (point.payload or {}).get(group_by)
        if key is None:
            continue
        key = str(key)
        if key not in collected:
            if len(collected) >= groups:
                continue
            collected[key] = []
        if len(collected[key]) < group_size:
            collected[key].append(point)
    return collected


def facet_counts(
    store: QdrantStore, scopes: Sequence[str], key: str, filters: dict[str, Any] | None = None, limit: int = 50
) -> list[tuple[str, int]]:
    """How many chunks carry each value of ``key`` over ``scopes`` (exact counts)."""
    if not store.exists(scopes[0]):
        return []
    alias = _alias(store, scopes)
    response = store.client.facet(alias, key=key, facet_filter=scope_filter(scopes, filters), limit=limit, exact=True)
    return [(str(hit.value), int(hit.count)) for hit in response.hits]
