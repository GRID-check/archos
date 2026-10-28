"""Deep research's subagents reach the chat wire as AG-UI 1.0 ``SUBAGENT_*`` events.

Two producers: the orchestrator's ``task`` calls (``SubagentEventsMiddleware``,
through a real ``create_agent`` tool loop) and each researcher worker of
``run_research_batch`` (``_run_research_query``). Both run inside a compiled
outer graph under ``astream``, the shape an in-process deep research has on a
chat turn, because only there does the writer reach them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from typing import TypedDict

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END
from langgraph.graph import StateGraph

from agent.agents.deep_researcher.custom_middleware import SubagentEventsMiddleware
from agent.agents.deep_researcher.models import ResearchNotes
from agent.agents.deep_researcher.models import ResearchQuery
from agent.agents.deep_researcher.tools import research
from agent.common.action_rows import ToolStepCallback
from agent.common.turn_status import emit_step
from agent.common.wire_v2 import StatusStep
from agent.common.wire_v2 import StepFinishedBody
from agent.common.wire_v2 import StepStartedBody
from agent.common.wire_v2 import SubagentErrorBody
from agent.common.wire_v2 import SubagentFinishedBody
from agent.common.wire_v2 import SubagentStartedBody


class _ToolCallingFake(GenericFakeChatModel):
    """A scripted chat model that accepts tools, for a real ``create_agent`` loop."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> _ToolCallingFake:
        return self


def _task_call(subagent_type: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {"name": "task", "args": {"description": "Plan it", "subagent_type": subagent_type}, "id": call_id}
        ],
    )


class _Outer(TypedDict, total=False):
    done: bool


async def _bodies_of(node: Any) -> list[Any]:
    graph = StateGraph(_Outer)
    graph.add_node("deep_research", node)
    graph.set_entry_point("deep_research")
    graph.add_edge("deep_research", END)
    # `subgraphs=True`, as the conversation graph streams: a nested graph's writes reach the stream only so.
    stream = graph.compile().astream({}, stream_mode="custom", subgraphs=True)
    return [chunk async for _namespace, chunk in stream]


def _orchestrator(responses: Iterator[AIMessage], task_body: Any) -> Any:
    @tool("task")
    async def task(description: str, subagent_type: str) -> str:
        """Run a subagent."""
        return await task_body(subagent_type)

    return create_agent(
        model=_ToolCallingFake(messages=responses),
        tools=[task],
        middleware=[SubagentEventsMiddleware(["planner-agent", "writer-agent"])],
    )


async def test_a_task_call_is_one_subagent_whose_steps_carry_its_id() -> None:
    async def planner(subagent_type: str) -> str:
        # The subagent's own graph: a node that writes a step, like a planner's search.
        inner = StateGraph(_Outer)

        async def search(state: _Outer) -> _Outer:
            emit_step(StatusStep(id="status:planner-search", slot="planner-search", channel="technical"))
            return {}

        inner.add_node("search", search)
        inner.set_entry_point("search")
        inner.add_edge("search", END)
        await inner.compile().ainvoke({})
        return "plan written"

    agent = _orchestrator(iter([_task_call("planner-agent", "call_plan"), AIMessage(content="done")]), planner)

    async def node(state: _Outer) -> _Outer:
        await agent.ainvoke(
            {"messages": [HumanMessage(content="Fluchtwege?")]}, config={"callbacks": [ToolStepCallback()]}
        )
        return {}

    bodies = await _bodies_of(node)
    (started,) = [body for body in bodies if isinstance(body, SubagentStartedBody)]
    assert (started.name, started.parent_tool_call_id, started.parent_subagent_run_id) == (
        "planner-agent",
        "call_plan",
        None,
    )
    steps = {
        (body.step.id, type(body).__name__): body.subagent_run_id
        for body in bodies
        if isinstance(body, StepStartedBody | StepFinishedBody)
    }
    assert steps[("status:planner-search", "StepFinishedBody")] == started.subagent_run_id
    # The `task` call that spawned it is the orchestrator's own row.
    task_rows = [run for (step_id, _), run in steps.items() if step_id.startswith("tool:")]
    assert task_rows and all(run is None for run in task_rows)
    assert [body.subagent_run_id for body in bodies if isinstance(body, SubagentFinishedBody)] == [
        started.subagent_run_id
    ]


async def test_a_task_that_comes_back_as_an_error_is_a_failed_subagent() -> None:
    async def broken(subagent_type: str) -> str:
        raise RuntimeError("planner blew up")

    agent = _orchestrator(iter([_task_call("planner-agent", "call_plan"), AIMessage(content="done")]), broken)

    async def node(state: _Outer) -> _Outer:
        # ToolNode turns a raising tool into an error ToolMessage, or raises:
        # either way the subagent is reported failed.
        try:
            await agent.ainvoke({"messages": [HumanMessage(content="Fluchtwege?")]})
        except RuntimeError:
            pass
        return {}

    bodies = await _bodies_of(node)
    errors = [body for body in bodies if isinstance(body, SubagentErrorBody)]
    assert len(errors) == 1
    assert "planner blew up" not in errors[0].message
    # An invocation ends once: no SUBAGENT_FINISHED after its error.
    assert not [body for body in bodies if isinstance(body, SubagentFinishedBody)]


async def test_a_task_naming_no_subagent_of_this_run_announces_nothing() -> None:
    async def unknown(subagent_type: str) -> str:
        return f"We cannot invoke subagent {subagent_type}"

    agent = _orchestrator(iter([_task_call("made-up-agent", "call_x"), AIMessage(content="done")]), unknown)

    async def node(state: _Outer) -> _Outer:
        await agent.ainvoke({"messages": [HumanMessage(content="?")]})
        return {}

    bodies = await _bodies_of(node)
    assert not [body for body in bodies if isinstance(body, SubagentStartedBody | SubagentFinishedBody)]


def _query(text: str) -> ResearchQuery:
    return ResearchQuery(
        query=text,
        subqueries=[],
        preferred_tools=["knowledge_search"],
        fallback_tools=[],
        target_components=["Fluchtweg"],
        rationale="needed",
    )


def _notes(topic: str) -> dict[str, Any]:
    return {
        "structured_response": ResearchNotes(
            query_topic=topic,
            target_components=["Fluchtweg"],
            summary="40 m",
            findings=[],
            gaps=[],
            sources=[],
            narrative_notes="",
            language="de",
            evidence_judgment=None,
        )
    }


class _Researcher:
    """A researcher runnable that writes one step, then returns notes (or nothing usable)."""

    def __init__(self, empty_for: str | None = None) -> None:
        self.empty_for = empty_for

    async def ainvoke(self, state: dict[str, Any], config: Any = None) -> dict[str, Any]:
        request = state["messages"][0].content
        topic = "b" if "Frage b" in request else "a"
        await asyncio.sleep(0)
        emit_step(StatusStep(id=f"status:research-{topic}", slot=f"research-{topic}", channel="technical"))
        if topic == self.empty_for:
            return {"messages": [AIMessage(content="no notes")]}
        return _notes(topic)


async def test_each_researcher_worker_is_its_own_subagent_and_a_useless_one_failed() -> None:
    async def node(state: _Outer) -> _Outer:
        await research._run_research_queries(
            queries=[_query("Frage a"), _query("Frage b")],
            researcher_runnable=_Researcher(empty_for="b"),
            runtime=None,
            callbacks=[],
            max_concurrency=2,
        )
        return {}

    bodies = await _bodies_of(node)
    started = {body.description: body for body in bodies if isinstance(body, SubagentStartedBody)}
    assert set(started) == {"Frage a", "Frage b"}
    assert {body.name for body in started.values()} == {research.RESEARCHER_AGENT}
    attributed = {
        body.step.id: body.subagent_run_id for body in bodies if isinstance(body, StepStartedBody | StepFinishedBody)
    }
    assert attributed == {
        "status:research-a": started["Frage a"].subagent_run_id,
        "status:research-b": started["Frage b"].subagent_run_id,
    }
    assert [body.subagent_run_id for body in bodies if isinstance(body, SubagentFinishedBody)] == [
        started["Frage a"].subagent_run_id
    ]
    assert [body.subagent_run_id for body in bodies if isinstance(body, SubagentErrorBody)] == [
        started["Frage b"].subagent_run_id
    ]


async def test_an_error_result_from_the_task_tool_is_a_failed_subagent_too() -> None:
    """A middleware further in may turn the raise into an error ToolMessage: still a failure, ended once."""
    middleware = SubagentEventsMiddleware(["writer-agent"])
    request = SimpleNamespace(tool_call={"name": "task", "args": {"subagent_type": "writer-agent"}, "id": "call_w"})

    async def handler(_request: Any) -> ToolMessage:
        return ToolMessage(content="Error: writer failed", tool_call_id="call_w", status="error")

    async def node(state: _Outer) -> _Outer:
        result = await middleware.awrap_tool_call(request, handler)
        assert result.status == "error"
        return {}

    bodies = await _bodies_of(node)
    assert [type(body) for body in bodies] == [SubagentStartedBody, SubagentErrorBody]
    assert bodies[1].code == "tool_error"


@pytest.fixture(autouse=True)
def _no_stray_subagent() -> Iterator[None]:
    from agent.common.turn_status import current_subagent

    assert current_subagent() is None
    yield
    assert current_subagent() is None
