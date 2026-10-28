"""What a search sends Qdrant's lexical channels: the BM25 text and the selective exact terms, priced per collection.

``df_cache`` is the caller's document-frequency memo (the retriever keeps one), so pricing a
term costs one count per new term rather than one per retrieval.
"""

import logging
from collections.abc import Sequence

logger = logging.getLogger(__name__)

#: Entries in the exact-term document-frequency cache before it is cleared. The live
#: key set is a handful of terms per collection; the cap only bounds a pathological
#: run of one-off terms.
_EXACT_TERM_DF_CACHE_MAX = 512


def lexical_inputs(
    query: str, collection_names: str | Sequence[str], df_cache: dict[tuple[str, int, str], int]
) -> tuple[str, list[str]]:
    """The BM25 query text and the selective exact terms, both priced against the searched collections.

    The BM25 terms go through the rule the German mirror has always applied
    (``german_text.select_terms``): a term absent from the collection or on
    more than a quarter of it is dropped, and with no alphabetic term left
    BM25 is not asked at all. Empty beats noisy. Sent unpriced, BM25 ranked
    whole Richtlinien for „OIB-RL 2“ on the digit and for a file name on
    „ausgabe mai 2023“, and fusion promoted that over the dense hits:
    exact-id MRR 0.30 against Chroma's 0.53 (``qdrant-gates-2026-10.md``).
    The candidates leave out what BM25 must not be asked for at any price
    (``retrieval.bm25_candidates``: umlaut stopwords, file-name pieces).

    Several collections (cross-project grouped search) are priced over their
    union, the corpus BM25's IDF is computed over.

    Fails open to the unpriced inputs: pricing sharpens the channels, it
    never gates a search.
    """
    from aiq_agent.common import german_text

    from ..qdrant import retrieval as qdrant_retrieval
    from .hybrid import extract_exact_terms
    from .hybrid import selective_terms

    exact = extract_exact_terms(query) if extract_exact_terms is not None else []
    candidates = qdrant_retrieval.bm25_candidates(query, extra_terms=expansion_terms(query))
    try:
        if len(df_cache) >= _EXACT_TERM_DF_CACHE_MAX:
            df_cache.clear()
        total, frequencies = qdrant_retrieval.term_frequencies(collection_names, [*candidates, *exact], cache=df_cache)
    except Exception as e:  # noqa: BLE001 - same fail-open as the Chroma path's pricing
        logger.warning("Term frequencies unavailable (%s); BM25 and exact terms unpriced", e)
        return bm25_text(query), exact
    lexical = german_text.select_terms(candidates, frequencies, total)
    terms = selective_terms({term: frequencies[term] for term in exact}, total) if exact else []
    return " ".join(lexical), terms


def expansion_terms(query: str) -> list[str]:
    """The EN->DE glossary terms the German mirror is given for ``query``; none when unavailable."""
    try:
        from aiq_agent.common import query_expansion

        return list(query_expansion.expansion_terms(query))
    except Exception:  # noqa: BLE001 - the glossary widens recall, it never gates a search
        logger.debug("Query expansion unavailable for the BM25 channel", exc_info=True)
        return []


def bm25_text(query: str) -> str:
    """The unpriced BM25 query: the question plus the EN->DE glossary terms the German mirror was given.

    What BM25 receives only when pricing fails (``lexical_inputs``).
    """
    return " ".join([query, *expansion_terms(query)])
