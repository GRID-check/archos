"""``ActionOutcome``: what a tool call found, and the status that follows from it (ADR-0131)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.turn_status import ActionRow


def _chunk(name: str, collection: str = "c"):
    return SimpleNamespace(file_name=name, metadata={"collection": collection})


def test_chunks_count_hits_and_distinct_documents() -> None:
    outcome = ActionOutcome()
    outcome.record_chunks([_chunk("a.pdf"), _chunk("a.pdf"), _chunk("b.pdf"), _chunk("a.pdf", "other")])

    assert (outcome.hits, outcome.documents) == (4, 3)


@pytest.mark.parametrize(
    ("outcome", "default", "expected"),
    [
        (ActionOutcome(hits=3), "ok", "ok"),
        (ActionOutcome(hits=0), "ok", "empty"),
        (ActionOutcome(files=0, folders=0), "ok", "empty"),
        (ActionOutcome(files=0, folders=2), "ok", "ok"),
        (ActionOutcome(), "ok", "ok"),
        (ActionOutcome(), "error", "error"),
        (ActionOutcome(hits=5, failed=True), "ok", "error"),
    ],
)
def test_status(outcome: ActionOutcome, default: str, expected: str) -> None:
    assert outcome.status(default=default) == expected


def test_settle_finishes_the_row_once_with_its_counts(emitted) -> None:
    row = ActionRow("search", query="q")
    ActionOutcome(hits=2, documents=1, searched=9).settle(row)

    started, finished = emitted.steps
    assert started.id == finished.id
    assert (finished.status, finished.counts.hits, finished.counts.searched) == ("ok", 2, 9)
