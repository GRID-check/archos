"""The turn-start phases as Langfuse observations with their real latency.

A phase emitted as a point read 1 ms in Langfuse whatever it took
(`retrieve.knowledge_search` at the end of a 4.7 s search, 2026-10-27), so the
seconds before the first model call had no row to read. Pinned here: the pair
carries the block's true start and end, a raising or cancelled block is
recorded as such and still raises, and the open-span stack is untouched while
the block runs, so gathered branches cannot nest under each other.
"""

import asyncio
import json

import pytest

from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.observability.turn_phases import observed_phase
from aiq_agent.turn.admission import spanned


@pytest.fixture
def steps():
    from nat.plugin_api import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    seen = []
    state.event_stream.get().subscribe(seen.append)
    yield seen
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


def _pairs(steps):
    """``{name: (start, end)}`` for every balanced pair pushed."""
    starts = {step.UUID: step for step in steps if step.payload.event_type.value == "FUNCTION_START"}
    return {
        step.payload.name: (starts[step.UUID], step)
        for step in steps
        if step.payload.event_type.value == "FUNCTION_END"
    }


class TestTimestampedSpan:
    def test_the_pair_carries_the_given_interval(self, steps):
        emit_step_span("setup.x", {"a": 1}, {"b": 2}, started_at=100.0, ended_at=101.5)

        start, end = _pairs(steps)["setup.x"]
        # The exporter reads the span's start off the START and its end off the END.
        assert start.payload.event_timestamp == 100.0
        assert end.payload.event_timestamp == 101.5
        assert end.payload.span_event_timestamp == 100.0

    def test_without_timestamps_it_is_the_point_it_always_was(self, steps):
        emit_step_span("decide.x", {}, {})

        start, end = _pairs(steps)["decide.x"]
        assert end.payload.span_event_timestamp is None
        assert start.payload.event_timestamp <= end.payload.event_timestamp


class TestObservedPhase:
    async def test_records_the_block_as_it_ran(self, steps):
        with observed_phase("setup.project_context", shelves=2) as out:
            await asyncio.sleep(0.05)
            out["blocks"] = 3

        start, end = _pairs(steps)["setup.project_context"]
        assert end.payload.event_timestamp - start.payload.event_timestamp >= 0.04
        assert json.loads(start.payload.data.input) == {"shelves": 2}
        body = json.loads(end.payload.data.output)
        assert body["outcome"] == "ok"
        assert body["blocks"] == 3
        assert body["ms"] >= 40

    def test_a_raising_block_is_recorded_and_still_raises(self, steps):
        with pytest.raises(ValueError):
            with observed_phase("history.trim"):
                raise ValueError("boom")

        _, end = _pairs(steps)["history.trim"]
        assert json.loads(end.payload.data.output)["outcome"] == "error"
        assert json.loads(end.payload.data.output)["error"] == "ValueError"

    async def test_a_cancelled_block_is_recorded_as_cancelled(self, steps):
        async def held():
            with observed_phase("admission.wait"):
                await asyncio.sleep(10)

        task = asyncio.create_task(held())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        _, end = _pairs(steps)["admission.wait"]
        assert json.loads(end.payload.data.output)["outcome"] == "cancelled"

    async def test_gathered_phases_nest_under_the_caller_not_under_each_other(self, steps):
        from nat.plugin_api import ContextState

        async def branch(name: str, delay: float):
            with observed_phase(name):
                await asyncio.sleep(delay)

        await asyncio.gather(branch("setup.a", 0.03), branch("setup.b", 0.01))

        pairs = _pairs(steps)
        assert {start.parent_id for start, _ in pairs.values()} == {"root"}
        assert ContextState.get().active_span_id_stack.get() == ["root"]

    async def test_spanned_emits_its_phase_and_returns_the_value(self, steps):
        async def value():
            return 7

        assert await spanned("setup.session_registry", value()) == 7
        assert "setup.session_registry" in _pairs(steps)

    def test_outside_a_nat_run_it_is_absorbed(self):
        with observed_phase("setup.nothing") as out:
            out["n"] = 1


class TestDecisionSpanLatency:
    def test_a_decision_spans_its_call_not_a_point(self, steps):
        from aiq_agent.observability.decision_trace import emit_decision_span

        emit_decision_span("turn", {"questions": ["q"], "states": 1}, {"decided": 1, "latency_ms": 540})

        start, end = _pairs(steps)["decide.turn"]
        assert abs((end.payload.event_timestamp - start.payload.event_timestamp) - 0.54) < 0.01

    def test_without_a_latency_it_stays_a_point(self, steps):
        from aiq_agent.observability.decision_trace import emit_decision_span

        emit_decision_span("turn", {}, {"decided": 0, "skipped": "too_short"})

        _, end = _pairs(steps)["decide.turn"]
        assert end.payload.span_event_timestamp is None
