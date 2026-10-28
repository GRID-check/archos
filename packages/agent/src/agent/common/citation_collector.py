"""The citations one tool call returned, as records on ``ToolMessage.artifact`` (ADR-0133 §8).

A filesystem tool renders its passages as a grounding block, and the renderer
files the records under the hash of the bytes it returned (ADR-0061). That
lookup needs the bytes unchanged. The records also ride on the message itself,
so a reader that holds the message and not the turn's capture (an evicted
result, a replayed message whose text was trimmed) still has them:

* the producer (``knowledge_layer.estate``) calls :func:`note_citations` with
  the hits it rendered;
* the tool wrapper opens :func:`collect_citations` around the call and puts what
  was collected on the result's ``artifact`` (:func:`artifact_for`);
* source capture reads the artifact first (:func:`hits_from_artifact`), then the
  text lookup.

The collector is a ``ContextVar`` set per call, so parallel calls in one round,
each its own task, keep separate collectors (prototype p2, ADR-0133). Outside a
collector, :func:`note_citations` does nothing.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from agent.common.grounding_block import GroundingHit

logger = logging.getLogger(__name__)

#: The artifact key the records travel under.
ARTIFACT_KEY = "citations"

_collector: ContextVar[list[GroundingHit] | None] = ContextVar("citation_hits", default=None)


@contextmanager
def collect_citations() -> Iterator[list[GroundingHit]]:
    """Open a collector for one tool call; the yielded list fills as the call renders hits."""
    collected: list[GroundingHit] = []
    token = _collector.set(collected)
    try:
        yield collected
    finally:
        _collector.reset(token)


def note_citations(hits: Iterable[GroundingHit]) -> None:
    """Add rendered hits to the open collector; nothing outside one."""
    collected = _collector.get()
    if collected is not None:
        collected.extend(hits)


def artifact_for(hits: Iterable[GroundingHit]) -> dict[str, Any] | None:
    """The artifact a result carries for ``hits``: JSON, so the checkpointer stores it as it stores the text."""
    dumped = [hit.model_dump(mode="json") for hit in hits]
    return {ARTIFACT_KEY: dumped} if dumped else None


def hits_from_artifact(artifact: Any) -> list[GroundingHit] | None:
    """The records an artifact carries; ``None`` when it carries none (no artifact, or not ours)."""
    if not isinstance(artifact, dict):
        return None
    raw = artifact.get(ARTIFACT_KEY)
    if not isinstance(raw, list) or not raw:
        return None
    hits: list[GroundingHit] = []
    for item in raw:
        try:
            hits.append(item if isinstance(item, GroundingHit) else GroundingHit.model_validate(item))
        except Exception:  # noqa: BLE001 - a record that does not validate is dropped, the text path remains
            logger.warning("A citation record on a tool result did not validate", exc_info=True)
    return hits or None
