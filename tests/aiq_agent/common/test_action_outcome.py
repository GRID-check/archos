"""``ActionOutcome``: what a tool call found, and the status that follows from it (ADR-0132)."""

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


def test_hits_from_an_unadmitted_restricted_folder_are_not_counted() -> None:
    """The row settles before the round is admitted: no count the model could be refused (ADR-0088)."""
    outcome = ActionOutcome()
    outcome.record_chunks([_chunk("a.pdf"), _chunk("geheim.pdf", "proj_a_r0123456789ab")])

    assert (outcome.hits, outcome.documents, outcome.unnamed) == (None, None, True)
    assert outcome.status(default="error") == "ok"


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


async def test_parallel_calls_keep_their_own_call_id_for_their_sources(monkeypatch):
    """Sources a call returns carry that call's id, even beside a sibling call (ADR-0132)."""
    import asyncio

    from aiq_agent.common import turn_status

    bodies: list = []
    monkeypatch.setattr(turn_status, "emit", bodies.append)

    async def call(name: str) -> tuple[str, str | None]:
        row = turn_status.ActionRow("search", query=name)
        await asyncio.sleep(0)
        seen = turn_status.current_action_call()
        row.finish("ok")
        return row.call_id, seen

    results = await asyncio.gather(call("a"), call("b"))
    assert [own for own, _ in results] == [seen for _, seen in results]
    assert results[0][0] != results[1][0]
    assert turn_status.current_action_call() is None
    finished = [b.step for b in bodies if b.type == "STEP_FINISHED"]
    assert {s.call_id for s in finished} == {own for own, _ in results}


def test_an_incomplete_search_says_so_on_its_row(monkeypatch):
    """A literal search that could not search everything is never drawn as a complete count (ADR-0133)."""
    from aiq_agent.common import turn_status

    steps: list = []
    monkeypatch.setattr(turn_status, "emit_step", lambda step, started=False: steps.append(step))
    row = ActionRow("search", query="Brandabschnitt", mode="exact")
    outcome = ActionOutcome(searched=9)
    outcome.record(0, documents=0)
    outcome.incomplete = True
    outcome.settle(row)

    finished = steps[-1]
    assert (finished.status, finished.incomplete, finished.counts.searched) == ("empty", True, 9)


def test_a_complete_search_carries_no_incomplete_flag(monkeypatch):
    from aiq_agent.common import turn_status

    steps: list = []
    monkeypatch.setattr(turn_status, "emit_step", lambda step, started=False: steps.append(step))
    row = ActionRow("search", query="Brandabschnitt", mode="exact")
    ActionOutcome(hits=3, documents=1).settle(row)
    assert steps[-1].incomplete is None


def test_a_settled_place_replaces_the_running_one(monkeypatch):
    """A row that settles at a place's root drops the name it showed while running (ADR-0132)."""
    from aiq_agent.common import turn_status

    steps: list = []
    monkeypatch.setattr(turn_status, "emit_step", lambda step, started=False: steps.append(step))
    row = ActionRow("read", target="README")
    row.finish("ok", verb="list", mount="project")
    assert (steps[-1].verb, steps[-1].mount, steps[-1].target) == ("list", "project", None)
