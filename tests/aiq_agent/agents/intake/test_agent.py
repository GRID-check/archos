"""The Erfassungs-Agent as the research worker runs it: a model in a loop that always finishes.

The model is scripted (it calls the real tools through the real ``create_agent``
graph); the BFF's route and the project's pages are the conftest doubles.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import ChatResult
from pydantic import PrivateAttr

from aiq_agent.agents.intake.agent import ProjectIntakeAgent
from aiq_agent.agents.intake.models import IntakeAgentState
from aiq_agent.agents.intake.read_log import current_read_log
from aiq_agent.common import LLMProvider
from tests.aiq_agent.agents.intake.conftest import JOB
from tests.aiq_agent.agents.intake.conftest import recorded_all
from tests.aiq_agent.agents.intake.conftest import validator


class ScriptedModel(BaseChatModel):
    """Answers each call with the next scripted message; the last one repeats."""

    _script: list[AIMessage] = PrivateAttr(default_factory=list)
    _seen: list[list[Any]] = PrivateAttr(default_factory=list)

    def __init__(self, script: list[AIMessage], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._script = list(script)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    @property
    def seen(self) -> list[list[Any]]:
        return self._seen

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedModel:
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._seen.append(list(messages))
        message = self._script.pop(0) if len(self._script) > 1 else self._script[0]
        # A fresh id per call, as a provider gives: a repeated message is a new call, not the old one again.
        calls = [{**call, "id": f"{call['name']}-{len(self._seen)}"} for call in message.tool_calls]
        message = message.model_copy(update={"tool_calls": calls}) if calls else message
        return ChatResult(generations=[ChatGeneration(message=message)])


def _call(name: str, **arguments: Any) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": arguments, "id": name}])


def _agent(model: BaseChatModel, **kwargs: Any) -> ProjectIntakeAgent:
    provider = LLMProvider()
    provider.set_default(model)
    return ProjectIntakeAgent(llm_provider=provider, tools=[], job_id=JOB, **kwargs)


def _state() -> IntakeAgentState:
    return IntakeAgentState(messages=[HumanMessage(content="Neue Dokumente hochgeladen")], organization_id="org-1")


READ_AND_RECORD = [
    _call("read_document", file_name="Baubeschreibung.pdf", pages=[2, 3]),
    _call(
        "record_values",
        values=[
            {
                "key": "geschosse_oberirdisch@bw1",
                "value": 3,
                "file_name": "Baubeschreibung.pdf",
                "page": 3,
                "quote": "Das Gebäude hat drei oberirdische Geschoße",
            }
        ],
    ),
]


class TestTheRunnerContract:
    def test_it_declares_its_state_and_writes_no_report(self):
        from aiq_api.jobs.runner import _get_agent_state_class
        from aiq_api.jobs.runner import _produces_report

        agent = _agent(ScriptedModel([AIMessage(content="x")]))
        assert _get_agent_state_class(agent) is IntakeAgentState
        assert _produces_report(ProjectIntakeAgent) is False

    def test_the_runner_constructs_it_the_way_it_constructs_every_agent(self):
        from aiq_api.jobs.runner import _create_agent_instance

        agent = _create_agent_instance(
            ProjectIntakeAgent, LLMProvider(), None, [], object(), verbose=False, callbacks=[], job_id=JOB
        )
        assert isinstance(agent, ProjectIntakeAgent)

    async def test_the_result_is_the_summary_the_runner_reports(self, signed_run, route, project):
        from aiq_api.jobs.runner import _extract_result

        route(record=recorded_all())
        result = await _agent(
            ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Drei Geschoße gefunden.")])
        ).run(_state())
        assert _extract_result(result) == "Drei Geschoße gefunden."


class TestTheLoop:
    async def test_it_starts_from_the_needs_reads_records_and_finishes_once(
        self, signed_run, route, project, intake_schema
    ):
        fake = route(record=recorded_all())
        model = ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Drei Geschoße gefunden.")])

        result = await _agent(model).run(_state())

        first = model.seen[0]
        opening = next(message for message in first if isinstance(message, HumanMessage)).content
        assert "geschosse_oberirdisch@bw1" in opening and "Occasion: Neue Dokumente hochgeladen" in opening
        assert [body["op"] for body in fake.bodies()] == ["needs", "record", "finish"]
        for body in fake.bodies():
            assert not list(validator(intake_schema, "InternalIntakeRequest").iter_errors(body))
        (finish,) = fake.bodies("finish")
        assert finish["documentsRead"] == ["Baubeschreibung.pdf"]
        assert finish["summary"] == "Drei Geschoße gefunden."
        assert result.outcome["ended"] == "model" and result.outcome["suggested"] == 1
        assert len(model.seen) == 3, "finish_intake ends the loop: no model call after it"
        assert current_read_log() is None, "the run's read log is unbound after the run"

    async def test_a_model_that_stops_without_finishing_is_finished_in_code(self, signed_run, route, project):
        fake = route(record=recorded_all())
        model = ScriptedModel([*READ_AND_RECORD, AIMessage(content="Ich habe drei Geschoße gefunden.")])

        result = await _agent(model).run(_state())

        (finish,) = fake.bodies("finish")
        assert finish["summary"] == "Ich habe drei Geschoße gefunden."
        assert result.outcome["ended"] == "model_without_finish" and result.outcome["finished"]

    async def test_a_model_that_never_stops_is_finished_at_the_step_budget(self, signed_run, route, project):
        fake = route()
        model = ScriptedModel([_call("read_document", file_name="Baubeschreibung.pdf")])

        result = await _agent(model, max_tool_steps=3).run(_state())

        (finish,) = fake.bodies("finish")
        assert "Schrittbudget" in finish["summary"]
        assert result.outcome["ended"] == "step_limit"

    async def test_a_slow_model_is_finished_at_the_time_budget(self, signed_run, route, project):
        class SlowModel(ScriptedModel):
            async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
                await asyncio.sleep(5)
                return self._generate(messages)

        fake = route()
        result = await _agent(SlowModel([AIMessage(content="x")]), max_run_seconds=0.05).run(_state())

        (finish,) = fake.bodies("finish")
        assert "Zeitbudget" in finish["summary"]
        assert result.outcome["ended"] == "time_budget"

    async def test_a_failing_model_still_finishes(self, signed_run, route, project):
        class BrokenModel(ScriptedModel):
            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                raise RuntimeError("provider down")

        fake = route()
        result = await _agent(BrokenModel([AIMessage(content="x")])).run(_state())

        assert len(fake.bodies("finish")) == 1
        assert result.outcome["ended"] == "error"


class TestWhenNothingCanBeRecorded:
    async def test_a_run_without_an_envelope_reads_nothing_and_says_why(self, unsigned_run, route, project):
        fake = route()
        model = ScriptedModel([AIMessage(content="x")])

        result = await _agent(model).run(_state())

        assert fake.requests == []
        assert model.seen == [], "no model call for a run that can record nothing"
        assert "no signed identity" in result.messages[-1].content
        assert result.outcome["ended"] == "refused" and not result.outcome["finished"]

    async def test_a_stale_reading_is_not_finished(self, signed_run, route, project):
        fake = route(needs=409)
        result = await _agent(ScriptedModel([AIMessage(content="x")])).run(_state())

        assert fake.bodies("finish") == []
        assert result.outcome["ended"] == "refused"


class TestThePrompt:
    def test_the_product_framing_scan_reads_this_prompt(self):
        """``tests/aiq_agent/test_product_framing.py`` holds every prompt to VISION.md and CONTEXT.md."""
        from tests.aiq_agent.test_product_framing import FILE_AS_PLAN
        from tests.aiq_agent.test_product_framing import OLD_FRAME
        from tests.aiq_agent.test_product_framing import PROMPTS

        assert "src/aiq_agent/agents/intake/prompts/system.j2" in PROMPTS
        from aiq_agent.agents.intake.agent import system_prompt

        rendered = system_prompt()
        assert not FILE_AS_PLAN.search(rendered) and not OLD_FRAME.search(rendered)
        assert "workspace" in rendered and "Piloti" in rendered

    @pytest.mark.parametrize("phrase", ["Never guess", "Zielzustand", "newest Fassung", "Never compute it"])
    def test_the_rules_the_tools_cannot_carry_are_in_it(self, phrase):
        from aiq_agent.agents.intake.agent import system_prompt

        assert phrase in system_prompt()
