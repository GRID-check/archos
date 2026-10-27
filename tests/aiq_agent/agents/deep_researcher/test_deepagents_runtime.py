"""Tests for DeepAgents runtime config, skill collection resolution, and backend wiring."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from deepagents.backends import CompositeBackend
from deepagents.backends import StateBackend
from pydantic import ValidationError

from aiq_agent.agents.deep_researcher.deepagents_runtime import SHARED_ROUTE
from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepAgentsRuntime
from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig
from aiq_agent.agents.deep_researcher.deepagents_runtime import discover_skill_collections
from aiq_agent.agents.deep_researcher.deepagents_runtime import resolve_skill_collections
from aiq_agent.skills import SKILLS_ROOT

SYNTHESIS_SKILL_SOURCE = f"{SKILLS_ROOT}synthesis/"


class TestSkillCollections:
    """Public skill config uses collection names, not DeepAgents virtual paths."""

    def test_builtin_skill_collections_are_discovered(self) -> None:
        collections = discover_skill_collections()

        assert collections["research"] == "/skills/research/"
        assert collections["synthesis"] == "/skills/synthesis/"

    def test_nested_skill_collections_are_discovered(self, tmp_path) -> None:
        skill_dir = tmp_path / "finance" / "earnings" / "quarterly-summary"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("---\nname: quarterly-summary\n---\n", encoding="utf-8")

        assert discover_skill_collections(tmp_path) == {"finance/earnings": "/skills/finance/earnings/"}

    def test_resolve_skill_collections_maps_names_to_sources(self) -> None:
        assert resolve_skill_collections(("synthesis",)) == ("/skills/synthesis/",)

    def test_resolve_skill_collections_rejects_unknown_names(self) -> None:
        with pytest.raises(ValueError, match="Unknown deep research skill collection"):
            resolve_skill_collections(("typo",))

    def test_skills_config_forbids_old_fields(self) -> None:
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            DeepResearchSkillsConfig(enabled=True)


class TestDeepAgentsRuntimeRouting:
    """Runtime uses stock DeepAgents backends with only the routes required."""

    def test_baseline_uses_plain_state_backend(self) -> None:
        runtime = DeepAgentsRuntime()

        assert isinstance(runtime.backend_for(None), StateBackend)
        assert isinstance(runtime.backend_for(runtime.skill_runtime()), StateBackend)
        assert runtime.execution_enabled is False
        assert runtime.collections == ()

    def test_curated_offers_are_absent_from_the_skills_mount(self) -> None:
        """An offer the org never switched on must not be readable from /skills/.

        Chat drops ``grid-catalog: curated`` from always_on; the deep run's
        builtin collections drop it too, so the same gate holds on both agents.
        An offer the org took up arrives through the BFF payload, as an office skill.
        """
        runtime = DeepAgentsRuntime(
            skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}),
        )
        backend = runtime.backend_for(runtime.skill_runtime())
        listed = backend.ls("/skills/synthesis/")
        names = [entry["path"].rstrip("/").rsplit("/", 1)[-1] for entry in (listed.entries or [])]
        assert "long-form-report-writer" in names
        assert "prediction-report-writer" not in names
        hidden = backend.read("/skills/synthesis/prediction-report-writer/SKILL.md")
        assert hidden.file_data is None
        assert hidden.error
        downloads = backend.download_files(
            [
                "/skills/synthesis/long-form-report-writer/SKILL.md",
                "/skills/synthesis/prediction-report-writer/SKILL.md",
            ]
        )
        assert downloads[0].error is None
        assert downloads[0].content is not None
        assert downloads[1].content is None
        assert downloads[1].error == "file_not_found"

        oib_runtime = DeepAgentsRuntime(
            skills=DeepResearchSkillsConfig(agents={"researcher-agent": ("oib",)}),
        )
        oib_backend = oib_runtime.backend_for(oib_runtime.skill_runtime())
        oib = oib_backend.ls("/skills/oib/")
        oib_names = [entry["path"].rstrip("/").rsplit("/", 1)[-1] for entry in (oib.entries or [])]
        assert "fire-safety" in oib_names
        assert "submission-check" not in oib_names
        assert "existing-building" not in oib_names
        grepped = oib_backend.grep("Gebäudeklasse", path="/skills/oib/")
        grep_paths = [match["path"] for match in (grepped.matches or [])]
        assert grep_paths
        assert not any("submission-check" in path for path in grep_paths)

    def test_a_taken_up_offer_is_an_office_skill(self) -> None:
        from aiq_agent.skills.builtin import discover_builtin_skills
        from aiq_agent.skills.resolver import _is_curated

        offer = next(s for s in discover_builtin_skills() if _is_curated(s))
        runtime = DeepAgentsRuntime(skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}))
        skills = runtime.skill_runtime((offer,))
        backend = runtime.backend_for(skills)
        assert backend.read(f"/skills/office/{offer.name}/SKILL.md").error is None
        assert skills.sources == ("synthesis", "office")

    def test_skills_only_adds_skills_route(self) -> None:
        runtime = DeepAgentsRuntime(
            skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}),
        )
        skills = runtime.skill_runtime()
        backend = runtime.backend_for(skills)

        assert isinstance(backend, CompositeBackend)
        assert isinstance(backend.default, StateBackend)
        assert set(backend.routes) == {SKILLS_ROOT}
        assert backend.routes[SKILLS_ROOT] is skills.backend
        assert runtime.skill_sources_for("writer-agent", skills) == [SYNTHESIS_SKILL_SOURCE]
        assert runtime.skill_sources_for("researcher-agent", skills) == []

    def test_each_run_gets_its_own_skills_and_shares_the_default(self) -> None:
        """The skills are per tenant and per run (ADR-0018); the job's default backend is not."""
        runtime = DeepAgentsRuntime(skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}))
        first, second = runtime.skill_runtime(), runtime.skill_runtime()
        a, b = runtime.backend_for(first), runtime.backend_for(second)
        assert a.routes[SKILLS_ROOT] is not b.routes[SKILLS_ROOT]
        assert a.default is b.default
        a.read("/skills/synthesis/long-form-report-writer/SKILL.md")
        assert first.activated == ("long-form-report-writer",)
        assert second.activated == ()

    def test_sandbox_only_adds_shared_route(self) -> None:
        fake_sandbox = MagicMock()
        with patch(
            "aiq_agent.agents.deep_researcher.deepagents_runtime._create_sandbox_backend",
            return_value=fake_sandbox,
        ):
            runtime = DeepAgentsRuntime(sandbox=DeepResearchSandboxConfig())
            backend = runtime.backend_for(runtime.skill_runtime())

        assert isinstance(backend, CompositeBackend)
        assert backend.default is fake_sandbox
        assert set(backend.routes) == {SHARED_ROUTE}
        assert runtime.execution_enabled is True

    def test_sandbox_and_skills_add_shared_and_skills_routes(self) -> None:
        fake_sandbox = MagicMock()
        skills = DeepResearchSkillsConfig(agents={"researcher-agent": ("research",)})
        with patch(
            "aiq_agent.agents.deep_researcher.deepagents_runtime._create_sandbox_backend",
            return_value=fake_sandbox,
        ):
            runtime = DeepAgentsRuntime(skills=skills, sandbox=DeepResearchSandboxConfig())
            skill_runtime = runtime.skill_runtime()
            backend = runtime.backend_for(skill_runtime)

        assert isinstance(backend, CompositeBackend)
        assert backend.default is fake_sandbox
        # Every skill of `research` is a curated offer, so the run holds none of
        # them and mounts no `/skills/` route: an offer reaches a run only as an
        # office skill the organization took up.
        assert set(backend.routes) == {SHARED_ROUTE}
        assert isinstance(backend.routes[SHARED_ROUTE], StateBackend)
        assert runtime.skill_sources_for("researcher-agent", skill_runtime) == []

    def test_require_sandbox_collection_without_sandbox_raises(self) -> None:
        skills = DeepResearchSkillsConfig(
            agents={"researcher-agent": ("research",)},
            require_sandbox=("research",),
        )

        with pytest.raises(ValueError, match="require a sandbox"):
            DeepAgentsRuntime(skills=skills)

    def test_skills_config_rejects_unknown_agent_keys(self) -> None:
        with pytest.raises(ValidationError, match="Unknown deep research skill agent"):
            DeepResearchSkillsConfig(agents={"researcher": ("research",)})

    def test_require_sandbox_collection_with_sandbox_is_allowed(self) -> None:
        skills = DeepResearchSkillsConfig(
            agents={"researcher-agent": ("research",)},
            require_sandbox=("research",),
        )
        runtime = DeepAgentsRuntime(skills=skills, sandbox=DeepResearchSandboxConfig())

        assert runtime.collections == ("research",)

    def test_require_sandbox_collection_with_sandbox_still_rejects_unknown_names(self) -> None:
        skills = DeepResearchSkillsConfig(
            agents={"researcher-agent": ("research",)},
            require_sandbox=("typo",),
        )

        with pytest.raises(ValueError, match="Unknown deep research skill collection"):
            DeepAgentsRuntime(skills=skills, sandbox=DeepResearchSandboxConfig())

    def test_deepagents_skill_scanner_finds_synthesis_skills_from_nested_source(self) -> None:
        from deepagents.middleware.skills import _list_skills

        runtime = DeepAgentsRuntime(skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}))
        backend = runtime.backend_for(runtime.skill_runtime())

        top_level_skills = _list_skills(backend, SKILLS_ROOT)
        synthesis_skills = _list_skills(backend, SYNTHESIS_SKILL_SOURCE)

        assert [skill["name"] for skill in top_level_skills] == []
        assert sorted(skill["name"] for skill in synthesis_skills) == [
            "inspection-report-writer",
            "long-form-report-writer",
        ]
        assert sorted(skill["path"] for skill in synthesis_skills) == [
            "/skills/synthesis/inspection-report-writer/SKILL.md",
            "/skills/synthesis/long-form-report-writer/SKILL.md",
        ]

    def test_deepagents_subagent_skills_key_adds_skills_middleware(self) -> None:
        from deepagents import create_deep_agent

        fake_graph = MagicMock()
        fake_graph.with_config.return_value = fake_graph
        create_agent_calls: list[dict[str, Any]] = []

        def fake_create_agent(*_args: Any, **kwargs: Any) -> MagicMock:
            create_agent_calls.append(kwargs)
            return fake_graph

        fake_model = MagicMock()
        profile = MagicMock()
        profile.tool_description_overrides = {}
        profile.excluded_tools = []
        profile.excluded_middleware = []
        profile.materialize_extra_middleware.return_value = []
        profile.general_purpose_subagent = MagicMock(enabled=False)
        profile.base_system_prompt = None
        profile.system_prompt_suffix = None

        with (
            patch("deepagents.graph.resolve_model", return_value=fake_model),
            patch("deepagents._models.resolve_model", return_value=fake_model),
            patch("deepagents.graph._harness_profile_for_model", return_value=profile),
            patch("deepagents.graph.create_summarization_middleware", return_value=MagicMock()),
            patch("deepagents.graph.create_agent", side_effect=fake_create_agent),
            patch("deepagents.middleware.subagents.create_agent", side_effect=fake_create_agent),
        ):
            create_deep_agent(
                model=fake_model,
                tools=[],
                subagents=[
                    {
                        "name": "writer-agent",
                        "description": "Writes the final answer.",
                        "system_prompt": "Write.",
                        "skills": [SYNTHESIS_SKILL_SOURCE],
                    }
                ],
                backend=StateBackend(),
                skills=[SKILLS_ROOT],
            )

        writer_middleware = create_agent_calls[0]["middleware"]
        writer_skills = [m for m in writer_middleware if m.__class__.__name__ == "SkillsMiddleware"]
        assert len(writer_skills) == 1
        assert writer_skills[0].sources == [SYNTHESIS_SKILL_SOURCE]


class TestDeepAgentsRuntimeJobId:
    """job_id should drive the sandbox name; a missing one falls back to uuid."""

    def test_explicit_job_id_is_kept(self) -> None:
        sandbox = DeepResearchSandboxConfig()
        with patch("aiq_agent.agents.deep_researcher.deepagents_runtime._create_sandbox_backend") as create_backend:
            runtime = DeepAgentsRuntime(sandbox=sandbox, job_id="job-abc-123")
            _ = runtime.backend_for(None)

        create_backend.assert_called_once_with(sandbox, "job-abc-123")

    def test_missing_job_id_generates_uuid(self) -> None:
        sandbox_a = DeepResearchSandboxConfig()
        sandbox_b = DeepResearchSandboxConfig()
        with patch("aiq_agent.agents.deep_researcher.deepagents_runtime._create_sandbox_backend") as create_backend:
            runtime_a = DeepAgentsRuntime(sandbox=sandbox_a)
            runtime_b = DeepAgentsRuntime(sandbox=sandbox_b)
            _ = runtime_a.backend_for(None)
            _ = runtime_b.backend_for(None)

        job_id_a = create_backend.call_args_list[0].args[1]
        job_id_b = create_backend.call_args_list[1].args[1]
        assert len(job_id_a) == 36
        assert job_id_a != job_id_b

    def test_modal_sandbox_config_requires_provider_dependencies(self) -> None:
        def find_spec(module_name: str):
            if module_name == "langchain_modal":
                return None
            return object()

        with (
            patch(
                "aiq_agent.agents.deep_researcher.deepagents_runtime.importlib.util.find_spec", side_effect=find_spec
            ),
            pytest.raises(ImportError, match="langchain-modal"),
        ):
            _ = DeepAgentsRuntime(sandbox=DeepResearchSandboxConfig()).backend_for(None)


class TestTheSkillsMountIsReadOnly:
    """The permission rules deny writes on `/skills/**` in the tools; the backend refuses on its own too.

    Nothing is on disk behind the mount any more, but deepagents 0.7 offers a
    recursive `delete`, and a write that reached the backend another way must
    still change nothing.
    """

    def _skills(self) -> Any:
        runtime = DeepAgentsRuntime(skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}))
        return runtime.backend_for(runtime.skill_runtime()).routes[SKILLS_ROOT]

    def test_write_edit_and_delete_are_refused(self) -> None:
        skills = self._skills()
        target = "/synthesis/long-form-report-writer/SKILL.md"
        before = skills.read(target).file_data["content"]

        assert "read-only" in (skills.write("/new.md", "x").error or "")
        assert "read-only" in (skills.edit(target, "a", "b").error or "")
        assert "read-only" in (skills.delete("/synthesis").error or "")
        assert skills.read(target).file_data["content"] == before

    async def test_the_async_twins_are_refused_too(self) -> None:
        skills = self._skills()
        assert "read-only" in ((await skills.adelete("/synthesis")).error or "")
        assert "read-only" in ((await skills.awrite("/new.md", "x")).error or "")

    def test_grep_still_honours_the_match_cap(self) -> None:
        result = self._skills().grep("the", path="/synthesis", max_count=1)
        assert result.error is None
        assert len(result.matches or []) == 1
