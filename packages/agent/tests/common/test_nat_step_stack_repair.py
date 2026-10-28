"""A LangGraph turn under the agent runtime keeps every step's parent open (no span the exporter drops)."""

from __future__ import annotations

from typing import TypedDict

from langchain_core.tracers.context import register_configure_hook
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import StateGraph

from agent.common.nat_step_repair import install_step_stack_repair
from nat.data_models.intermediate_step import IntermediateStepPayload
from nat.data_models.intermediate_step import IntermediateStepState
from nat.data_models.intermediate_step import IntermediateStepType
from nat.plugin_api import Context
from nat.plugin_api import ContextState
from nat.plugins.langchain.callback_handler import LangchainProfilerHandler
from nat.plugins.profiler.decorators.framework_wrapper import callback_handler_var
from nat.utils.reactive.subject import Subject


class _State(TypedDict, total=False):
    rounds: int


def _graph():
    async def agent(state):
        return {"rounds": state.get("rounds", 0) + 1}

    async def tools(state):
        return {}

    builder = StateGraph(_State)
    builder.add_node("agent", agent)
    builder.add_node("tools", tools)
    builder.add_edge(START, "agent")
    builder.add_conditional_edges("agent", lambda s: "tools" if s["rounds"] < 3 else END)
    builder.add_edge("tools", "agent")
    return builder.compile()


def _orphans(events) -> list[str]:
    """START steps whose parent had already ended: the ones the agent runtime's SpanExporter drops."""
    ended: set[str] = set()
    orphans: list[str] = []
    for event in events:
        if event.event_state == IntermediateStepState.START and event.parent_id in ended:
            orphans.append(event.payload.name)
        elif event.event_state == IntermediateStepState.END:
            ended.add(event.UUID)
    return orphans


async def _run_turn() -> list:
    state = ContextState.get()
    stream, events = Subject(), []
    stream.subscribe(on_next=events.append)
    state.event_stream.set(stream)
    state.active_span_id_stack.set(["root"])
    callback_handler_var.set(LangchainProfilerHandler())
    register_configure_hook(callback_handler_var, inheritable=True)
    manager = Context.get().intermediate_step_manager
    start = IntermediateStepPayload(UUID="turn", event_type=IntermediateStepType.WORKFLOW_START, name="turn")
    manager.push_intermediate_step(start)
    await _graph().ainvoke({"rounds": 0})
    end = IntermediateStepPayload(UUID="turn", event_type=IntermediateStepType.WORKFLOW_END, name="turn")
    manager.push_intermediate_step(end)
    return events


async def test_every_step_nests_under_an_open_parent():
    """Without the repair the ``tools`` node, and all under it, START under the ended ``agent`` node."""
    install_step_stack_repair()
    assert _orphans(await _run_turn()) == []
