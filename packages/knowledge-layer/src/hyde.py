"""HyDE as an extra retrieval channel (experiment, default off): a hypothetical passage drafted beside the search."""

import logging

logger = logging.getLogger(__name__)


async def draft_hyde_text(hyde_llm_obj, query: str, *, enabled: bool, timeout_seconds: float) -> str | None:
    """Draft the HyDE probe passage for ``query``; ``None`` means baseline.

    The single seam between the search path and the draft model, so tests can
    pin "identifier-shaped query → no model call" and "slow model → baseline"
    without driving the whole search. Never raises: the gate, the import and
    the draft call all fail open to ``None``.
    """
    try:
        from aiq_agent.common.hyde import draft_passage
        from aiq_agent.common.hyde import should_draft
    except ImportError:
        return None
    if not should_draft(query, enabled=enabled and hyde_llm_obj is not None):
        return None
    return await draft_passage(hyde_llm_obj, query, timeout_seconds=timeout_seconds)
