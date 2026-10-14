"""The project intake agent is hosted by the research worker (slice 4 of agentic project intake).

Module under test: ``aiq_api.jobs.runner`` and ``aiq_api.registry``.

The intake writes suggested values onto a project, not a report. Three things
follow, each pinned here: the post-report model calls (grid cards, anatomy,
follow-ups, reflection) are skipped when the agent declares
``produces_report = False``; its LLM runs on the chat model's group; and the
completion-token budget cap guards it as it guards deep research.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_agent.common import AgentGroup
from aiq_api.jobs import runner
from aiq_api.registry import AGENT_REGISTRY
from aiq_api.registry import get_agent_config


class _Reportless:
    """An agent that writes to objects: it declares no report."""

    produces_report = False


class _Reporting:
    """An agent like every one before the intake: no declaration, so a report."""


@pytest.fixture
def passes(monkeypatch) -> dict[str, AsyncMock]:
    mocks = {
        "_generate_grid_cards": AsyncMock(return_value=SimpleNamespace(cards=[{"type": "summary"}], failed=False)),
        "_extract_report_anatomy": AsyncMock(return_value=SimpleNamespace(findings=None, answer_meta=None)),
        "_propose_report_follow_ups": AsyncMock(return_value={"items": [{"question": "q"}]}),
        "_run_deep_research_reflection": AsyncMock(return_value=None),
    }
    for name, mock in mocks.items():
        monkeypatch.setattr(runner, name, mock)
    return mocks


def _run_passes(agent_cls: type):
    return runner._run_report_passes(
        produces_report=runner._produces_report(agent_cls),
        llm=object(),
        input_text="q",
        report="r",
        organization_id="org",
        builder=object(),
        job_id="job-1",
    )


class TestReportlessAgentGetsNoReportPasses:
    def test_the_declaration_defaults_to_a_report(self) -> None:
        assert runner._produces_report(_Reporting) is True
        assert runner._produces_report(_Reportless) is False

    @pytest.mark.asyncio
    async def test_a_reportless_agent_makes_no_model_call(self, passes) -> None:
        cards_result, anatomy, follow_ups = await _run_passes(_Reportless)

        for mock in passes.values():
            mock.assert_not_called()
        assert cards_result.cards is None
        assert cards_result.failed is False
        assert anatomy.findings is None
        assert anatomy.answer_meta is None
        assert anatomy.failed is False
        assert follow_ups is None

    @pytest.mark.asyncio
    async def test_an_agent_without_the_declaration_still_gets_every_pass(self, passes) -> None:
        cards_result, _anatomy, follow_ups = await _run_passes(_Reporting)

        for mock in passes.values():
            mock.assert_awaited_once()
        assert cards_result.cards == [{"type": "summary"}]
        assert follow_ups == {"items": [{"question": "q"}]}
        assert passes["_run_deep_research_reflection"].await_args.kwargs["job_id"] == "job-1"

    @pytest.mark.parametrize("agent_type", ["deep_researcher", "researcher"])
    def test_the_agents_registered_before_the_intake_keep_their_report(self, agent_type) -> None:
        agent_cls = runner._load_agent_class(AGENT_REGISTRY[agent_type].class_path)
        assert runner._produces_report(agent_cls) is True


async def _default_group(fn_config) -> AgentGroup:
    """The group ``_create_llm_provider`` tags the config's single ``llm`` with."""
    captured: dict[str, AgentGroup] = {}

    class _Provider:
        def set_default(self, llm, group=None) -> None:
            captured["group"] = group

        def configure(self, *args, **kwargs) -> None:
            pass

    async def fake_llm(_builder, _ref):
        return MagicMock(name="llm")

    with (
        patch("aiq_agent.common.get_langchain_llm", fake_llm),
        patch("aiq_agent.common.LLMProvider", _Provider),
    ):
        await runner._create_llm_provider(object(), fn_config)
    return captured["group"]


class TestModelGroup:
    @pytest.mark.asyncio
    async def test_the_intake_agent_runs_on_the_chat_model_group(self) -> None:
        group = await _default_group(SimpleNamespace(type="project_intake_agent", llm="chat_llm"))
        assert group == AgentGroup.RESEARCH

    @pytest.mark.asyncio
    async def test_the_chat_agent_keeps_its_group(self) -> None:
        group = await _default_group(SimpleNamespace(type="research_agent", llm="chat_llm"))
        assert group == AgentGroup.RESEARCH

    @pytest.mark.asyncio
    async def test_any_other_single_llm_agent_keeps_the_deep_research_default(self) -> None:
        group = await _default_group(SimpleNamespace(type="something_else", llm="chat_llm"))
        assert group == AgentGroup.DEEP_RESEARCH


class TestRunnerWiring:
    def test_the_budget_cap_guards_deep_research_and_the_intake_only(self) -> None:
        assert runner._BUDGET_GUARDED_AGENT_TYPES == {"deep_research_agent", "project_intake_agent"}

    def test_the_intake_has_its_own_profile_label(self) -> None:
        assert runner._JOB_PROFILE_NAMES == {"project_intake_agent": "project_intake_job"}


class TestRegistryEntry:
    def test_the_intake_agent_is_registered_by_path(self) -> None:
        entry = get_agent_config("project_intake")
        assert entry.class_path == "aiq_agent.agents.intake.agent.ProjectIntakeAgent"
        assert entry.config_name == "project_intake_agent"
        assert entry.description
