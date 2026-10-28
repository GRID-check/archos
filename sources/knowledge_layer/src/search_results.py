"""The tool result a ranked knowledge search returns.

The grounding block, the empty-result message and the coverage line.
"""

import logging

from knowledge_layer.grounding_hits import grounding_hits
from knowledge_layer.trace_lanes import trace_lanes_for_hits

logger = logging.getLogger(__name__)


def empty_search_message(
    query: str,
    *,
    file_name: str | None = None,
    doc_class: str | None = None,
    title_contains: str | None = None,
    folder: str | None = None,
) -> str:
    """Steer a miss toward a more specific next call, not a invented citation."""
    bits = [f"query={query!r}"]
    if file_name:
        bits.append(f"file_name={file_name!r}")
    if doc_class:
        bits.append(f"doc_class={doc_class!r}")
    if title_contains:
        bits.append(f"title_contains={title_contains!r}")
    if folder:
        bits.append(f"folder={folder!r}")
    return (
        "No passage matched " + ", ".join(bits) + ". "
        "Retry once with a shorter topic query"
        + (", a different `file_name` from the inventory" if file_name else ", or `file_name=` an exact inventory name")
        + ", or `title_contains=` a fragment. "
        # A name taken from the reader's open file filtered a norm question down
        # to nothing (answer feedback, October 2026): say that the law is not in
        # that file, so the retry can drop the filter instead of guessing names.
        + (
            "If the question is about the law (OIB, Bauordnung) rather than this file's own content, "
            "retry WITHOUT `file_name=`: the norms are not filed under the reader's documents. "
            if file_name
            else ""
        )
        + (
            f"Nothing is filed under {folder!r}, or nothing there matched — drop `folder=` "
            "to search the whole shelf, or take the exact folder from the inventory. "
            if folder
            else ""
        )
        + "Do not invent a citation. This tool does not open files — that is `surface_documents`."
    )


async def coverage_gap(query: str, merged, verdict, config, *, widened: bool):
    """The decider's "none of these answers it" for the pool as delivered, or ``None``.

    Asked only where the judge already ran and found the first pool
    insufficient, so the family overview, a pinned file, a skipped judge and a
    sufficient pool never reach it and render exactly as before. Only the
    ``jev`` decider: the LLM judge's verdict was on the fused head before the
    reranker and the requery round, and asking it again costs a frontier call.
    A degraded pool claims nothing either: the layer that dropped out may hold
    the answer, and the block already says it is partial.
    """
    from knowledge_layer.requery import DECIDER_JEV
    from knowledge_layer.requery import judge_coverage

    if verdict is None or verdict.sufficient or config.requery_decider != DECIDER_JEV:
        return None
    if not merged.success or getattr(merged, "error_message", None) or not merged.chunks:
        return None
    return await judge_coverage(query, merged.chunks, threshold=config.decision_sufficiency_threshold, widened=widened)


def format_results(
    retrieval_result,
    query: str,
    notice: str = "",
    trailer: str = "",
    preamble_note: str = "",
    opened_files: frozenset[str] = frozenset(),
    coverage_gap: str | None = None,
    reading_of: str | None = None,
) -> str:
    """Build this result set's grounding hits and render them for the LLM.

    The layout itself lives in
    :func:`~aiq_agent.common.grounding_block.render_grounding_block`, which also
    files the records under the hash of the bytes it returns, so the citation
    registry reads fields rather than re-parsing this text (ADR-0061). That is
    why both decorations are rendered here and neither is glued on by the
    caller: a byte added after rendering changes the hash, and the reader would
    fall back to parsing the text. ``notice`` is what the model must read before
    the results (the requery widening, a family overview that could not be
    built) and goes ahead of everything; ``trailer`` is ``read_passage``'s
    ``## Gliederung`` index and follows the fan-out.

    ``preamble_note`` is what the CALL was, when that is more than a count: the
    family a family-shaped query resolved to, and where its parts sit in the
    results. It is a second preamble line, so a result set without one renders
    byte-for-byte as before.

    ``coverage_gap`` is why the passages do not answer the question, when the
    decider read them and said so (``requery.judge_coverage``). The block then
    says "Coverage: insufficient" under a preamble that no longer calls the
    hits relevant; the line itself says how many were judged, and the preamble
    claims nothing about the rest.

    ``reading_of`` names what ``read_passage`` opened. That call searched for
    nothing and ranked nothing, so its header says which passages were read, in
    reading order, instead of "Found N relevant document(s)".
    """
    # The two answers below carry no block, so they carry no hash to protect
    # either; there the trailer is simply appended, which keeps it stated
    # whichever answer this call has.
    tail = f"\n{trailer}" if trailer else ""

    # Check for retrieval errors and surface them to the agent
    # getattr: callers pass duck-typed result-likes (e.g. SimpleNamespace in
    # tests) that may not carry the optional error_message field.
    if not retrieval_result.success:
        error_msg = getattr(retrieval_result, "error_message", None) or "Unknown error"
        return f"Knowledge retrieval failed: {error_msg}\n\nQuery: '{query}'{tail}"

    # Degraded partial retrieval (e.g. the base corpus dropped out on an
    # embedding-fingerprint mismatch while other layers survived): the chunks
    # below are real, but they are NOT the full corpus. Without this banner the
    # LLM reads a partial answer as a complete one.
    degraded_detail = getattr(retrieval_result, "error_message", None)
    degraded_banner = notice + (f"WARNING: {degraded_detail}\n\n" if degraded_detail else "")

    if not retrieval_result.chunks:
        return f"{degraded_banner}No relevant documents found for query: '{query}'{tail}"

    from aiq_agent.common.grounding_block import GroundingBlock
    from aiq_agent.common.grounding_block import render_grounding_block
    from aiq_agent.common.tool_calls import KNOWLEDGE_SEARCH_TOOL
    from aiq_agent.common.turn_status import current_lane_tool

    hits = grounding_hits(retrieval_result.chunks)
    if reading_of:
        preamble = f"Read {len(hits)} passage(s) of {reading_of}, in reading order:"
    elif coverage_gap:
        preamble = f"Found {len(hits)} document(s); none of the judged ones answers the question:"
    else:
        preamble = f"Found {len(hits)} relevant document(s):"
    return render_grounding_block(
        GroundingBlock(
            preamble=f"{preamble}\n{preamble_note}" if preamble_note else preamble,
            degraded_banner=degraded_banner,
            hits=hits,
            # Fan-out summary for the Herleitung UI, from the same records the
            # header lines state.
            lanes=trace_lanes_for_hits(hits, opened_files),
            # The scope the calling tool opened; the one caller that opens none
            # is the search itself.
            tool=current_lane_tool() or KNOWLEDGE_SEARCH_TOOL,
            trailer=trailer,
            coverage_gap=coverage_gap,
        )
    )
