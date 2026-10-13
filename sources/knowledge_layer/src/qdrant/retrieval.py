"""The adapter's reads from Qdrant, in the adapter's terms: one logical collection per call.

``LlamaIndexRetriever`` keeps its contract (``retrieve(query, collection)``,
``find_text(collection, pattern)``) and, under ``AIQ_VECTOR_BACKEND=qdrant``,
answers from here. Nothing returned carries a ``qdrant_client`` type.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from .search import Hit
from .search import grouped_search
from .search import hybrid_search
from .search import phrase
from .store import get_store


def search(
    scope: str,
    *,
    vector: Sequence[float],
    lexical_text: str,
    top_k: int,
    filters: dict[str, Any] | None,
    exact_terms: Sequence[str],
    identity: Mapping[str, str],
) -> list[Hit]:
    """The fused hybrid ranking over one logical collection; refuses a foreign embedder."""
    store = get_store(identity)
    store.check_identity(scope)
    return hybrid_search(
        store,
        [scope],
        vector=vector,
        lexical_text=lexical_text,
        limit=top_k,
        filters=filters,
        exact_terms=exact_terms,
        candidates=top_k,
    )


def search_grouped(
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    groups: int,
    group_size: int,
    identity: Mapping[str, str],
) -> list[tuple[str, list[Hit]]]:
    """One fused ranking over many logical collections, grouped per collection, best group first."""
    store = get_store(identity)
    store.check_identity(scopes[0])
    return grouped_search(
        store,
        scopes,
        vector=vector,
        lexical_text=lexical_text,
        group_by="scope",
        groups=groups,
        group_size=group_size,
    )


def term_frequencies(scope: str, terms: Sequence[str]) -> tuple[int, dict[str, int]]:
    """How many chunks ``scope`` holds, and how many contain each term as a phrase."""
    store = get_store()
    total = store.count(scope)
    return total, {term: store.count(scope, None, phrase(term)) for term in terms}


def find_text(scope: str, pattern: str, filters: dict[str, Any] | None, limit: int) -> list[Hit]:
    """Every chunk of ``scope`` whose text matches the regex ``pattern``, up to ``limit``.

    Qdrant has no regex filter. The pattern ``browse.phrase_pattern`` builds is
    written to mean the same in Rust's ``regex`` and Python's ``re`` (it was
    always re-checked in Python), so it is applied here over the scope's
    chunk text, read by scroll. An exact search reads one collection, which
    holds thousands of chunks, not millions.
    """
    compiled = re.compile(pattern)
    hits: list[Hit] = []
    for record in get_store().scroll(scope, filters):
        payload = dict(record.payload or {})
        text = str(payload.get("text") or "")
        if compiled.search(text):
            hits.append(Hit(str(payload.get("chunk_id") or record.id), text, payload, 0.0, 1.0))
            if len(hits) >= limit:
                break
    return hits


def healthy() -> bool:
    """True when Qdrant answers."""
    return get_store().health()
