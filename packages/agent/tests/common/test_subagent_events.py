"""Subagent invocations on the chat wire (AG-UI 1.0 ``SUBAGENT_*``), from ``common/turn_status.py``.

Every test goes through a compiled graph under ``astream(stream_mode="custom")``,
because the writer and the ContextVar both reach a producer only through the
tasks LangGraph starts: a unit call outside a graph would pass with neither.
"""

from __future__ import annotations

import asyncio
from typing import Any
from typing import TypedDict
from uuid import uuid4

import pytest
from langgraph.errors import GraphInterrupt
from langgraph.graph import END
from langgraph.graph import StateGraph

from agent.common.action_rows import ToolStepCallback
from agent.common.turn_status import SUBAGENT_FAILED_MESSAGE
from agent.common.turn_status import current_subagent
from agent.common.turn_status import emit_step
from agent.common.turn_status import subagent_run
from agent.common.wire_v2 import StatusStep
from agent.common.wire_v2 import StepFinishedBody
from agent.common.wire_v2 import StepStartedBody
from agent.common.wire_v2 import SubagentErrorBody
from agent.common.wire_v2 import SubagentFinishedBody
from agent.common.wire_v2 import SubagentStartedBody


class _State(TypedDict, total=False):
    n: int


def _status(slot: str) -> StatusStep:
    return StatusStep(id=f"status:{slot}", slot=slot, channel="technical")


async def _bodies(node: Any) -> list[Any]:
    """What ``node`` writes to the custom stream when it runs as a graph's only node."""
    graph = StateGraph(_State)
    graph.add_node("work", node)
    graph.set_entry_point("work")
    graph.add_edge("work", END)
    compiled = graph.compile()
    return [chunk async for chunk in compiled.astream({"n": 0}, stream_mode="custom")]


def _attribution(bodies: list[Any]) -> dict[str, str | None]:
    return {
        body.step.id: body.subagent_run_id for body in bodies if isinstance(body, StepStartedBody | StepFinishedBody)
    }


async def test_a_subagent_brackets_its_steps_and_a_nested_one_names_its_parent() -> None:
    async def node(state: _State) -> _State:
        emit_step(_status("before"))
        async with subagent_run("deep_researcher") as outer:
            emit_step(_status("outer"))
            async with subagent_run("planner-agent", parent_tool_call_id="call_1") as inner:
                emit_step(_status("inner"))
                assert current_subagent() == inner
            assert current_subagent() == outer
        emit_step(_status("after"))
        return {}

    bodies = await _bodies(node)
    started = [body for body in bodies if isinstance(body, SubagentStartedBody)]
    finished = [body.subagent_run_id for body in bodies if isinstance(body, SubagentFinishedBody)]
    outer, inner = started
    assert (outer.name, outer.parent_subagent_run_id, outer.parent_tool_call_id) == ("deep_researcher", None, None)
    assert (inner.name, inner.parent_subagent_run_id, inner.parent_tool_call_id) == (
        "planner-agent",
        outer.subagent_run_id,
        "call_1",
    )
    assert finished == [inner.subagent_run_id, outer.subagent_run_id]
    assert _attribution(bodies) == {
        "status:before": None,
        "status:outer": outer.subagent_run_id,
        "status:inner": inner.subagent_run_id,
        "status:after": None,
    }


async def test_parallel_subagents_each_keep_their_own_steps() -> None:
    """``asyncio.gather`` copies the context per task: two researchers never share an id."""

    async def worker(label: str) -> None:
        async with subagent_run("researcher-agent", description=f"Frage {label}"):
            await asyncio.sleep(0)
            emit_step(_status(label))

    async def node(state: _State) -> _State:
        await asyncio.gather(worker("a"), worker("b"))
        return {}

    bodies = await _bodies(node)
    ids = {body.description: body.subagent_run_id for body in bodies if isinstance(body, SubagentStartedBody)}
    assert _attribution(bodies) == {"status:a": ids["Frage a"], "status:b": ids["Frage b"]}


async def test_a_failure_is_reported_without_its_text_and_raised_to_the_caller() -> None:
    async def node(state: _State) -> _State:
        with pytest.raises(RuntimeError, match="secret tool output"):
            async with subagent_run("researcher-agent"):
                raise RuntimeError("secret tool output")
        emit_step(_status("parent goes on"))
        return {}

    bodies = await _bodies(node)
    errors = [body for body in bodies if isinstance(body, SubagentErrorBody)]
    assert [(error.message, error.code) for error in errors] == [(SUBAGENT_FAILED_MESSAGE, "RuntimeError")]
    assert not any(isinstance(body, SubagentFinishedBody) for body in bodies)
    assert _attribution(bodies) == {"status:parent goes on": None}


async def test_a_pause_is_not_a_failure() -> None:
    """``GraphBubbleUp`` (an ``interrupt()``) leaves the subagent open: suspending it is ADR-0140's."""

    async def node(state: _State) -> _State:
        with pytest.raises(GraphInterrupt):
            async with subagent_run("planner-agent"):
                raise GraphInterrupt(())
        return {}

    bodies = await _bodies(node)
    assert [type(body) for body in bodies] == [SubagentStartedBody]


async def test_outside_a_graph_run_nothing_is_written_and_nothing_breaks() -> None:
    """A deep-research job worker has no stream: the binding still scopes, the emits are no-ops."""
    async with subagent_run("deep_researcher") as frame:
        emit_step(_status("job"))
        assert current_subagent() == frame
    assert current_subagent() is None


async def test_the_tool_call_that_spawns_a_subagent_is_its_parents_row() -> None:
    """deepagents' ``task`` runs the subagent inside the tool, so the tool's own row must be handed up."""

    async def node(state: _State) -> _State:
        callback = ToolStepCallback()
        async with subagent_run("deep_researcher"):
            async with subagent_run("planner-agent", parent_tool_call_id="call_task"):
                spawning, inside = uuid4(), uuid4()
                await callback.on_tool_start({"name": "task"}, "", run_id=spawning, tool_call_id="call_task")
                await callback.on_tool_start({"name": "knowledge_search"}, "", run_id=inside, tool_call_id="call_ks")
                await callback.on_tool_end("", run_id=inside)
                await callback.on_tool_end("", run_id=spawning)
        return {}

    bodies = await _bodies(node)
    started = {body.name: body.subagent_run_id for body in bodies if isinstance(body, SubagentStartedBody)}
    rows = [
        (body.step.tool, body.subagent_run_id)
        for body in bodies
        if isinstance(body, StepStartedBody | StepFinishedBody)
    ]
    assert rows == [
        ("task", started["deep_researcher"]),
        ("knowledge_search", started["planner-agent"]),
        ("knowledge_search", started["planner-agent"]),
        ("task", started["deep_researcher"]),
    ]


async def test_a_long_description_is_clipped_to_one_line_for_the_wire() -> None:
    async def node(state: _State) -> _State:
        async with subagent_run("researcher-agent", description="Zeile eins\n" + "x" * 400):
            pass
        return {}

    (started, _finished) = await _bodies(node)
    assert started.description is not None
    assert "\n" not in started.description
    assert len(started.description) == 160
    assert started.description.endswith("…")
