"""The seconds before the first model call: paid at boot where they can be, observable where they cannot.

Measured on dev (2026-10-27): the first turn of a process took 9.2 s from the
workflow span to the first model call, against 1.8 s on a later turn. Two of
the causes were first-use costs inside the turn, and this pins that they are
paid at boot: the tiktoken encoder (loaded inside the graph's first node, on
the event loop) and the phases between the workflow span and the LangGraph run,
which had no observation of their own, now each have one.
"""

from __future__ import annotations

import threading

import pytest
from langchain_core.messages import AIMessage

from agent.agents.piloti import conversation_register as register_mod
from agent.agents.piloti.models import ResearchAgentState
from agent.common.wire_v2 import UserMessage


async def _shallow(state):
    return ResearchAgentState(messages=list(state.messages) + [AIMessage(content="Antwort.")])


@pytest.fixture
def phases():
    """The names of every Grid step pair pushed while the test runs."""
    from nat.plugin_api import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    seen: list[str] = []
    state.event_stream.get().subscribe(
        lambda step: seen.append(step.payload.name) if step.payload.event_type.value == "FUNCTION_END" else None
    )
    yield seen
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


class TestBootPaysTheEncoder:
    async def test_the_workflow_build_loads_the_encoder_off_the_loop(self, workflow_harness, monkeypatch):
        loop_thread = threading.current_thread()
        threads: list[threading.Thread] = []
        monkeypatch.setattr(register_mod, "warm_token_encoder", lambda: threads.append(threading.current_thread()))

        await workflow_harness["turn"](UserMessage(conversation_id="c", message_id="m", text="Hallo"), _shallow)

        # Once per build (the harness builds once per turn), never on the loop.
        assert len(threads) == 1
        assert threads[0] is not loop_thread


class TestTheTurnStartIsObservable:
    async def test_every_phase_before_the_graph_has_its_observation(self, workflow_harness, phases):
        await workflow_harness["turn"](
            UserMessage(conversation_id="c", message_id="m", text="Wie hoch ist ein Geländer?"), _shallow
        )

        for name in (
            "setup.restricted_use",
            "setup.project_context",
            "setup.session_registry",
            "setup.subject_document",
            "setup.shown_restricted_notes",
            "setup.answer_streaming",
            "admission.wait",
            "setup.checkpoint_digest",
            "history.trim",
        ):
            assert name in phases, name
