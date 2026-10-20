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
from tests.aiq_agent.agents.intake.conftest import NEEDS
from tests.aiq_agent.agents.intake.conftest import NEEDS_BODY
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


@pytest.fixture
def needs_covered_after_record():
    """``needs`` as the BFF answers it: first as the run starts, then with the decisive Geschoße suggested."""
    calls: list[dict[str, Any]] = []

    def answer(body: dict[str, Any]) -> dict[str, Any]:
        calls.append(body)
        if len(calls) == 1:
            return NEEDS_BODY
        return {**NEEDS_BODY, "needs": [{**NEEDS[0], "state": "suggested", "decisive": False}, *NEEDS[1:]]}

    return answer


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

    def test_the_runner_hands_it_the_budgets_its_config_names(self):
        from aiq_agent.agents.intake.register import ProjectIntakeAgentConfig
        from aiq_api.jobs.runner import _create_agent_instance

        config = ProjectIntakeAgentConfig(llm="research_llm", max_tool_steps=12, max_run_seconds=90)
        agent = _create_agent_instance(
            ProjectIntakeAgent, LLMProvider(), None, [], config, verbose=False, callbacks=[], job_id=JOB
        )
        assert (agent.max_tool_steps, agent.max_run_seconds, agent._job_id) == (12, 90, JOB)

    def test_the_config_defaults_are_the_agents(self):
        from aiq_agent.agents.intake.agent import DEFAULT_MAX_RUN_SECONDS
        from aiq_agent.agents.intake.agent import DEFAULT_MAX_TOOL_STEPS
        from aiq_agent.agents.intake.register import ProjectIntakeAgentConfig

        config = ProjectIntakeAgentConfig(llm="research_llm")
        assert (config.max_tool_steps, config.max_run_seconds) == (DEFAULT_MAX_TOOL_STEPS, DEFAULT_MAX_RUN_SECONDS)
        assert (DEFAULT_MAX_TOOL_STEPS, DEFAULT_MAX_RUN_SECONDS) == (80, 1200)
        assert DEFAULT_MAX_RUN_SECONDS < 30 * 60, "a run ends before the BFF reconciles a reading (30 minutes)"

    async def test_the_result_is_the_summary_the_runner_reports(
        self, signed_run, route, project, needs_covered_after_record
    ):
        from aiq_api.jobs.runner import _extract_result

        route(record=recorded_all(), needs=needs_covered_after_record)
        result = await _agent(
            ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Drei Geschoße gefunden.")])
        ).run(_state())
        assert _extract_result(result) == "Drei Geschoße gefunden."


class TestTheLoop:
    async def test_it_starts_from_the_needs_reads_records_and_finishes_once(
        self, signed_run, route, project, intake_schema, needs_covered_after_record
    ):
        fake = route(record=recorded_all(), needs=needs_covered_after_record)
        model = ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Drei Geschoße gefunden.")])

        result = await _agent(model).run(_state())

        first = model.seen[0]
        opening = next(message for message in first if isinstance(message, HumanMessage)).content
        assert "geschosse_oberirdisch@bw1" in opening and "Occasion: Neue Dokumente hochgeladen" in opening
        assert "What the last reading found" not in opening, "no note before a first reading finished"
        # The finish reads the needs first: nothing decisive is open, so it finishes.
        assert [body["op"] for body in fake.bodies()] == ["needs", "progress", "record", "needs", "finish"]
        # The page counts the document the moment it is opened, not at the finish.
        assert [body["filesOpened"] for body in fake.bodies("progress")] == [["Baubeschreibung.pdf"]]
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


class TestTheFinishHold:
    async def test_a_first_finish_with_decisive_needs_open_and_files_unread_is_held_once(
        self, signed_run, route, project
    ):
        fake = route(record=recorded_all())
        model = ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Drei Geschoße gefunden.")])

        result = await _agent(model).run(_state())

        ops = [body["op"] for body in fake.bodies() if body["op"] != "progress"]
        assert ops == ["needs", "record", "needs", "finish"]
        held = model.seen[3][-1].content
        assert held.startswith("Not finished yet.") and "geschosse_oberirdisch@bw1" in held
        # The file this run read is not named; the one nobody opened is.
        assert "Einreichplan.pdf" in held and "Baubeschreibung.pdf" not in held
        assert len(model.seen) == 4, "the second call finishes, and nothing runs after it"
        assert result.outcome["ended"] == "model" and result.outcome["finish_held"] is True

    async def test_past_the_step_budget_the_finish_is_never_held(self, signed_run, route, project):
        fake = route(record=recorded_all())
        model = ScriptedModel([*READ_AND_RECORD, _call("finish_intake", summary="Budget aufgebraucht.")])

        result = await _agent(model, max_tool_steps=2).run(_state())

        assert [body["op"] for body in fake.bodies() if body["op"] != "progress"] == ["needs", "record", "finish"]
        assert result.outcome["ended"] == "model" and result.outcome["finish_held"] is False

    async def test_a_model_that_never_finishes_after_a_hold_is_still_finished_in_code(self, signed_run, route, project):
        fake = route(record=recorded_all())
        model = ScriptedModel(
            [*READ_AND_RECORD, _call("finish_intake", summary="Fertig."), AIMessage(content="Ich höre hier auf.")]
        )

        result = await _agent(model).run(_state())

        (finish,) = fake.bodies("finish")
        assert finish["summary"] == "Ich höre hier auf."
        assert result.outcome["ended"] == "model_without_finish" and result.outcome["finished"]


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

    @pytest.mark.parametrize("status", [401, 403])
    async def test_an_identity_the_bff_refuses_is_not_finished(self, signed_run, route, project, status):
        fake = route(needs=status)
        result = await _agent(ScriptedModel([AIMessage(content="x")])).run(_state())

        assert fake.bodies("finish") == []
        assert result.outcome["ended"] == "refused" and not result.outcome["finished"]


class TestTheOpening:
    def test_it_is_the_projects_state_with_the_last_readings_note(self):
        from aiq_agent.agents.intake.agent import first_message
        from tests.aiq_agent.agents.intake.conftest import NEEDS_BODY

        opening = first_message(
            "Neue Dokumente hochgeladen", {**NEEDS_BODY, "previousSummary": "Einreichplan gelesen; Fluchtniveau offen."}
        )
        assert "as it stands" in opening
        assert "What the last reading found (its own summary): Einreichplan gelesen; Fluchtniveau offen." in opening
        assert "geschosse_oberirdisch@bw1" in opening and "Baubeschreibung.pdf" in opening


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

    def test_it_prescribes_no_procedure(self):
        """Goal, rules, tools and budget; the model chooses its way (the product owner's direction)."""
        import re

        from aiq_agent.agents.intake.agent import system_prompt

        rendered = system_prompt()
        assert "<loop>" not in rendered
        assert not re.search(r"^\s*\d+\.\s", rendered, re.MULTILINE), "no numbered steps"
        assert "yours to choose" in rendered

    def test_it_names_every_tool_once_and_states_the_budget_as_information(self):
        from aiq_agent.agents.intake.agent import system_prompt

        rendered = system_prompt(max_steps=80, max_run_seconds=1200)
        assert "About 80 tool calls and 20 minutes" in rendered
        for tool in (
            "intake_needs",
            "list_files",
            "knowledge_search",
            "read_document",
            "read_passage",
            "record_values",
            "withdraw_values",
            "finish_intake",
        ):
            assert f"`{tool}`" in rendered, tool

    def test_it_says_the_run_is_unattended_and_the_summary_is_grounded(self):
        from aiq_agent.agents.intake.agent import system_prompt

        rendered = system_prompt()
        assert "nobody can answer" in rendered and "Do not end a turn with a plan" in rendered
        assert "rests on something a tool returned in this run" in rendered
