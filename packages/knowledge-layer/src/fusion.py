"""Fusing per-collection retrievals into one ranked pool.

Rank fusion across collections, the per-document diversity cap and the OCR-noise filter.
"""

import logging
from contextlib import suppress

from .chunk_noise import without_noise

logger = logging.getLogger(__name__)


# Diversity-aware merge caps how many chunks per document are taken in the
# first pass before spreading to other documents. The cap is soft: with
# max_per_document=2 and top_k=8 the first pass covers >=4 documents, and the
# fill pass exceeds the cap rather than returning fewer than top_k chunks.
_MAX_CHUNKS_PER_DOC = 2


# Substring identifying an embedding-fingerprint mismatch in a layer failure.
# Produced by ``qdrant.schema.identity_mismatch`` (which reports a
# same-dimension model swap as "embedding mismatch: ...") and
# preserved verbatim in ``RetrievalResult.error_message`` by ``_retrieve_sync``
# ("Retrieval failed: Collection '...' embedding mismatch: ..."). A mismatch
# means the stored and query vectors live in different spaces, so the affected
# collection contributed nothing — total base-corpus loss when it is the only
# layer. Unlike a missing session collection (routine, stays quiet) this is a
# configuration fault and must surface as degraded/error, never as a miss.
_EMBEDDING_MISMATCH_MARKER = "embedding mismatch"


def _is_embedding_mismatch(value: object) -> bool:
    """True when a layer failure reports a fingerprint mismatch, not a routine miss."""
    if isinstance(value, BaseException):
        value = str(value)
    return isinstance(value, str) and _EMBEDDING_MISMATCH_MARKER in value.lower()


def _rank_channel(chunks) -> list:
    """Lay one collection's hits out so that list position IS the per-collection rank.

    ``fuse_with_ranks`` reads a chunk's rank from its position, while the adapter states
    a hit's rank in ``retrieval_rank`` (stamped after the intra-collection lexical
    fusion, so it is the collection's final order, not the raw vector order). Positions
    a stamped rank has vacated are padded with ``None``, which the fuser skips because it
    carries no ``chunk_id``: a collection whose rank 3 was dropped upstream keeps rank 4
    at rank 4 instead of silently promoting it.

    Chunks with no stamped rank (SimpleNamespace test doubles, anything predating
    the field) fall back to their position in the list, which
    is the order the retriever returned them in — so an unstamped layer behaves exactly
    as it did before the field existed.
    """
    by_rank: dict[int, object] = {}
    for position, chunk in enumerate(chunks):
        rank = getattr(chunk, "retrieval_rank", None)
        if not isinstance(rank, int) or isinstance(rank, bool) or rank < 0:
            rank = position
        # A duplicated or colliding rank must never evict a hit; push it to the next free
        # slot so both survive and their relative order is preserved.
        while rank in by_rank:
            rank += 1
        by_rank[rank] = chunk
    if not by_rank:
        return []
    return [by_rank.get(rank) for rank in range(max(by_rank) + 1)]


def apply_diversity_cap(ordered, top_k: int, max_per_document: int) -> list:
    """Select ``top_k`` chunks from a ranked list, spreading across distinct documents.

    The cap is SOFT, which is what both the docstring it replaces and the LLM-facing tool
    description have always promised: at most ``max_per_document`` chunks per distinct
    document (keyed by collection + file_name) *where possible*, and the cap is exceeded
    rather than returning fewer than ``top_k`` chunks.

    The first pass is bounded at ``top_k`` selections. The previous inline version scanned
    the ENTIRE merged list, so ``selected`` was already longer than ``top_k`` under any
    production config and ``(selected + leftovers)[:top_k]`` reduced to ``selected[:top_k]``
    — the fill pass was unreachable and the quota was hard. Worse, appending the deferred
    chunks after every selected one meant a downstream ``[:top_k]`` trim saw a list whose
    head had been rebuilt out of low-ranked chunks: on a single-topic query it swapped
    seven on-topic hits for seven off-topic ones from other documents.

    The result is returned in rank order, i.e. as a subsequence of ``ordered``. Selection
    order was not monotone in the ranking key it was selected by, which is what made the
    downstream trim lossy.

    Args:
        ordered: Chunks in final rank order, best first.
        top_k: Maximum number of chunks to return.
        max_per_document: Per-document cap for the first pass; ``0`` disables diversity
            entirely, making this a plain top-k truncation.

    Returns:
        At most ``top_k`` chunks, in the same relative order as ``ordered``.
    """
    if max_per_document <= 0 or top_k <= 0:
        return list(ordered[:top_k])

    selected: list[int] = []
    deferred: list[int] = []
    per_doc: dict[tuple, int] = {}
    for index, chunk in enumerate(ordered):
        if len(selected) >= top_k:
            # Bounded first pass: once the slate is full, everything left is a fill
            # candidate. Nothing below this point is a cap decision.
            deferred.append(index)
            continue
        doc_key = ((getattr(chunk, "metadata", None) or {}).get("collection"), getattr(chunk, "file_name", None))
        if per_doc.get(doc_key, 0) < max_per_document:
            per_doc[doc_key] = per_doc.get(doc_key, 0) + 1
            selected.append(index)
        else:
            deferred.append(index)

    # Soft quota: when there are not enough distinct documents to fill the slate, the
    # chunks the cap deferred come back, best rank first.
    for index in deferred:
        if len(selected) >= top_k:
            break
        selected.append(index)

    return [ordered[index] for index in sorted(selected)]


def _noise_key(chunk) -> str:
    """One passage, the same in every pool it turns up in."""
    return getattr(chunk, "chunk_id", None) or str(getattr(chunk, "content", ""))


def pool_without_noise(pool, *, enabled: bool) -> tuple[object, frozenset[str]]:
    """``pool`` without its OCR-debris passages (``chunk_noise``), and which went.

    Off, the pool comes back as it came in, the same object: the search is then
    exactly what it was before the filter existed. What went is keyed by
    passage, so a requery that widens the pool counts a passage left out of
    both pools once.
    """
    if not enabled:
        return pool, frozenset()
    kept, dropped = without_noise(pool.chunks)
    if not dropped:
        return pool, frozenset()
    kept_ids = {id(chunk) for chunk in kept}
    gone = frozenset(_noise_key(chunk) for chunk in pool.chunks if id(chunk) not in kept_ids)
    logger.info("OCR noise filter left out %d of %d ranked candidate(s)", dropped, len(pool.chunks))
    return pool.model_copy(update={"chunks": kept}), gone


def merge_results(results, query: str, top_k: int, backend_name: str, max_per_document: int = _MAX_CHUNKS_PER_DOC):
    """
    Merge per-collection retrieval results into one ranked result by rank fusion.

    Chunks are NOT comparable by score across collections. ``Chunk.score`` is a true
    cosine similarity, but the professionally chunked base corpus sits in a systematically
    better distance band than a session or project collection, so a user's own uploaded
    PDF can never win on raw score and "layered retrieval" does not layer. Each surviving
    result therefore contributes one RRF channel (in ``target_collections`` order, so
    the base corpus wins exact ties) and the merged order is the fused rank — scale-free
    by construction, so a session hit at rank 0 can outrank a corpus hit at rank 5.
    When the retrieval loop has fanned out, ``results`` also carries one result per
    (collection, alternative query), appended after the originals: a chunk that two
    formulations agree on is fused upward, one that only a paraphrase reached enters
    the pool, and the original query keeps the tie-break seat.

    Selection over that fused order is diversity-aware; see ``apply_diversity_cap``. With
    a single collection and ``max_per_document=0`` this is identical to a plain top-k
    truncation of that collection's own order.

    ``chunk.score`` is never mutated: ``format_results`` keeps displaying the true
    similarity. The fusion score is recorded on ``chunk.fusion_score`` for diagnostics.

    Failed layers (``success=False``, e.g. a brand-new session whose collection
    does not exist yet) and raised exceptions are treated as empty contributions
    and skipped — EXCEPT an embedding-fingerprint mismatch (see
    ``_EMBEDDING_MISMATCH_MARKER``), which is a configuration fault, not a miss:
    a wrong ``GRID_EMBED_MODEL``/``GRID_EMBED_BASE_URL`` silently drops the whole
    base corpus while the surviving layers still answer. A mismatch therefore
    rides along on the merged result instead of being skipped quietly: no
    surviving channel means ``success=False`` with the mismatch detail (an
    error the caller cannot mistake for "nothing matched"); surviving channels
    mean ``success=True`` with ``error_message`` set (a degraded signal — real
    chunks, but from an incomplete corpus). A missing collection stays routine:
    ``success=True`` with no ``error_message``. This never raises.

    Args:
        results: List of RetrievalResult objects or Exceptions (from asyncio.gather),
            in ``target_collections`` order.
        query: The original query string.
        top_k: Maximum number of merged chunks to return.
        backend_name: Fallback backend label if no successful result is available.
        max_per_document: Diversity cap per distinct document on the first pass.

    Returns:
        A synthetic RetrievalResult with the merged top-k chunks: ``success=False``
        when mismatches left no surviving channel, ``success=True`` with
        ``error_message`` set when mismatches dropped some channels but others
        survived (degraded), and a plain ``success=True`` otherwise.
    """
    from aiq_agent.knowledge.schema import RetrievalResult

    channels: list[list] = []
    backend = backend_name
    mismatch_errors: list[str] = []
    for result in results:
        if isinstance(result, Exception):
            if _is_embedding_mismatch(result):
                mismatch_errors.append(str(result)[:500])
                logger.error("Knowledge layer embedding mismatch, skipping: %s", result)
            else:
                logger.debug("Knowledge layer raised, skipping: %s", result)
            continue
        if not getattr(result, "success", False):
            # A missing collection is routine — every new conversation's session
            # collection does not exist until something is uploaded into it, so
            # logging that at WARNING would bury the signal under one line per turn.
            # Everything else is not routine: a corpus that dropped out because the store
            # was unreachable, a collection deleted and recreated, or a filter that
            # failed to translate all produced a confident answer built on an empty
            # knowledge layer with nothing above DEBUG to say so.
            message = getattr(result, "error_message", None) or ""
            if _is_embedding_mismatch(message):
                if message not in mismatch_errors:
                    mismatch_errors.append(message)
                logger.error("Knowledge layer embedding mismatch, skipping: %s", message)
            elif "not found" in message.lower():
                logger.debug("Knowledge layer absent, skipping: %s", message)
            else:
                logger.warning("Knowledge layer failed, skipping: %s", message)
            continue
        if result.backend:
            backend = result.backend
        # One channel per SURVIVING collection, in arrival order. Skipped layers must not
        # leave an empty channel behind: an empty channel is harmless to RRF but a
        # non-empty one from a later collection would shift into the tie-break seat.
        channels.append(_rank_channel(result.chunks))

    merged_chunks = []
    for chunk, _fused_rank, fused_score in _fuse_channels(channels):
        with suppress(Exception):
            # Diagnostic only. Never displayed; `score` stays the true cosine so the
            # "Relevance Score:" line keeps meaning what citation parsing expects.
            chunk.fusion_score = fused_score
        merged_chunks.append(chunk)

    try:
        from aiq_agent.common.focus_file import get_focused_file_name
        from aiq_agent.common.focus_file import get_focused_shelf

        focused = get_focused_file_name()
        focused_shelf = get_focused_shelf()
    except Exception:
        focused = None
        focused_shelf = None
    if focused:

        def _is_focus(chunk) -> bool:
            if (chunk.file_name or "") != focused:
                return False
            if not focused_shelf:
                return True
            return (chunk.metadata or {}).get("shelf") == focused_shelf

        matching = [chunk for chunk in merged_chunks if _is_focus(chunk)]
        # Matches are the turn. Filling the rest from Archiv/project is how
        # "summarize this PDF" grew a Büro plan (#429).
        merged_chunks = matching if matching else merged_chunks

    merged_top_k = apply_diversity_cap(merged_chunks, top_k, max_per_document)

    if mismatch_errors:
        # De-duplicated: the requery fan-out retries each collection per
        # alternative query, so one broken corpus reports once per query.
        unique = list(dict.fromkeys(mismatch_errors))
        detail = "; ".join(unique)
        if not channels:
            # Total loss: every layer dropped out on a fingerprint mismatch.
            # success=False so the caller renders a failure, never a miss.
            return RetrievalResult(success=False, chunks=[], query=query, backend=backend, error_message=detail)
        # Partial loss: the chunks below are real, but the corpus behind them is
        # incomplete. success=True carries them; error_message carries the
        # degraded signal `format_results` renders as a WARNING banner.
        return RetrievalResult(
            success=True,
            chunks=merged_top_k,
            query=query,
            backend=backend,
            error_message=(
                f"Degraded retrieval: {len(unique)} collection(s) skipped "
                f"due to embedding mismatch ({detail}). Results cover only the "
                "remaining collections and are incomplete."
            ),
        )

    return RetrievalResult(success=True, chunks=merged_top_k, query=query, backend=backend)


def _fuse_channels(channels: list[list]) -> list[tuple]:
    """Reciprocal-rank-fuse per-collection channels, failing open to concatenation.

    The fusion helper lives in the llamaindex package, so it is imported lazily and
    defensively: ``merge_results`` is called on ``asyncio.gather(..., return_exceptions=True)``
    output and must never raise, so a fusion failure degrades to the (still
    collection-ordered) concatenation rather than losing the whole search.
    """
    try:
        from knowledge_layer.llamaindex.hybrid import fuse_with_ranks

        return fuse_with_ranks(channels)
    except Exception as exc:  # pragma: no cover - import/fusion failure is fail-open
        logger.warning("Cross-collection rank fusion unavailable, using collection order: %s", exc)
        flat = [chunk for channel in channels for chunk in channel if chunk is not None]
        return [(chunk, rank, 0.0) for rank, chunk in enumerate(flat)]
