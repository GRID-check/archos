"""The picking of a ranked `knowledge_search`, as one `retrieve.knowledge_search` span (ADR-0044).

Query, collections, budgets and the picked chunk ids, files and scores:
metadata only, never chunk text. Emitted before the empty-result return, so a
search that found nothing is its own fact rather than indistinguishable from a
turn that never searched. Tracing never breaks the search: every step here
fails open.
"""

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def normalized_query_for_span(text: str) -> str:
    """Latency-span form of a query: whitespace-folded, casefolded.

    Local (not imported) so the span path never depends on the judge module:
    tracing must stay up when the loop module cannot be imported. Mirrors
    ``knowledge_layer.requery._normalised``.
    """
    try:
        return re.sub(r"\s+", " ", str(text or "")).strip().casefold()
    except Exception:
        return ""


def citation_key_for_span(chunk) -> str | None:
    """The citation key a returned chunk will be cited by, for the span.

    Mirrors ``format_results`` without its shelf-qualification: the span
    needs a stable per-fetch key loop_eval can count (repeat_query,
    cross_turn, family_overlap), not the rendering. Prefers the stored
    display citation when the backend populated it. Never raises.
    """
    try:
        stored = getattr(chunk, "display_citation", None)
        if isinstance(stored, str) and stored.strip():
            return " ".join(stored.split())
        name = getattr(chunk, "file_name", None) or ""
        page = getattr(chunk, "page_number", None)
        if not name:
            return None
        if isinstance(page, int) and page > 0:
            return f"{name}, p.{page}"
        return str(name)
    except Exception:
        return None


def current_span_round() -> int | None:
    """The retrieval round this fetch runs in, or ``None`` when unstamped.

    Fail-open: instrumentation never breaks the search.
    """
    try:
        from aiq_agent.common.turn_status import current_retrieval_round

        return current_retrieval_round()
    except Exception:
        return None


def emit(search: Any, merged: Any, overview: Any, coverage: Any) -> None:
    """Emit the span for a finished ranked search (``ranked_search.RankedSearch``)."""
    from aiq_agent.observability.retrieval_trace import build_retrieval_input
    from aiq_agent.observability.retrieval_trace import build_retrieval_output
    from aiq_agent.observability.retrieval_trace import emit_retrieval_span

    try:
        search_input = build_retrieval_input(
            query=search.query,
            retrieval_query=search.retrieval_query,
            collections=search.targets,
            candidate_k=search.candidate_k,
            top_k=search.top_k,
            reranked=search.engine.reranks,
            dropped_by_floor=search.dropped_by_floor,
            requery_queries=search.requery_queries,
        )
        try:
            search_input.update(_fetch_fields(search, merged, overview, coverage))
        except Exception:
            logger.debug("Retrieval span enrichment skipped", exc_info=True)
        emit_retrieval_span(
            tool_name="knowledge_search",
            search_input=search_input,
            picks=_picks(merged, build_retrieval_output(chunks=merged.chunks)),
        )
    except Exception:  # noqa: BLE001 - tracing must never break the search path
        logger.debug("Retrieval pick span failed", exc_info=True)


def _fetch_fields(search: Any, merged: Any, overview: Any, coverage: Any) -> dict[str, Any]:
    """Per-fetch latency instrumentation, additive only.

    The fields loop_eval counts double-fetch rates off: which round and tool
    fetched, the normalized query to spot repeat_query, the locator args to
    spot locator_eligible, and the requery/cap/refusal flags to spot
    cap_retry/repair_fetch. Counts and keys only, no usage or cost telemetry.
    """
    from .qdrant.search import RANKING

    args = search.args
    fields: dict[str, Any] = {
        "round": search.span_round,
        "tool": "knowledge_search",
        "prefiltered": search.pushdown.fields(user_shelves=bool(search.user_collections)),
        "normalized_query": normalized_query_for_span(search.query),
        # How the store reads and fuses its channels (``qdrant/search.py``
        # ``RANKING``): traces either side of a ranking change are told apart.
        "ranking": RANKING.label(),
    }
    named = {
        "file_name": args.file_name,
        "doc_class": args.doc_class,
        "title_contains": args.title_contains,
        "folder": args.folder,
        "group_by": args.grouping,
        "requery_skipped": search.requery_skipped_reason,
    }
    fields.update({key: value for key, value in named.items() if value})
    fields["requery_fired"] = bool(search.requery_fired)
    fields.update(_drop_fields(search))
    if overview is not None:
        # "fetch": the members were read by filter, no embedding (ADR-0115).
        fields["family_read"] = "fetch" if overview.structural else "retrieve"
    if coverage is not None:
        fields["coverage"] = "insufficient"
        fields["coverage_best"] = round(coverage.best, 3)
    if not merged.chunks:
        fields["empty"] = True
    if getattr(merged, "error_message", None):
        fields["degraded"] = True
    if not getattr(merged, "success", True):
        fields["refused"] = True
    return fields


def _drop_fields(search: Any) -> dict[str, int]:
    """What each budget left out; the noise count whenever the filter is on, zero included."""
    fields = {}
    if search.dropped_by_cap:
        fields["dropped_by_cap"] = search.dropped_by_cap
    if search.dropped_by_family:
        fields["dropped_by_family"] = search.dropped_by_family
    if search.engine.drop_noise:
        # Stated whenever the filter is on, zero included: a zero is a measurement.
        fields["dropped_as_noise"] = search.dropped_as_noise
    return fields


def _picks(merged: Any, picks: dict) -> dict:
    """The picked chunks' citation keys and clause ids beside what the trace builder records."""
    try:
        keys = [key for key in (citation_key_for_span(chunk) for chunk in merged.chunks) if key]
        if keys:
            picks["citation_keys"] = keys
        clause_ids = [(getattr(chunk, "metadata", None) or {}).get("clause_id") for chunk in merged.chunks]
        clause_ids = [str(value) for value in clause_ids if value]
        if clause_ids:
            picks["clause_ids"] = clause_ids
    except Exception:
        logger.debug("Retrieval picks enrichment skipped", exc_info=True)
    return picks
