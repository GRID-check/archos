"""The skills backend (ADR-0135): one run's resolved skills as read-only ``SKILL.md`` files.

What it must hold: the middleware parses what it serves exactly as the skill
says; nothing writes to it; and what a tenant's run can list or read is that
tenant's resolved set and nothing else — curated offers only when taken up,
another organization's rows never.
"""

from __future__ import annotations

from unittest import mock

import pytest
from deepagents.middleware.skills import SkillsMiddleware

from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.backend import SkillsBackend
from aiq_agent.skills.backend import skill_document
from aiq_agent.skills.builtin import discover_builtin_skills
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import parse_skill_md
from aiq_agent.skills.resolver import SkillResolver
from aiq_agent.skills.resolver import _is_curated
from aiq_agent.skills.runtime import SkillRuntime

RICH = Skill(
    name="fire-safety",
    description='Brandabschnitt, Fluchtweg: "GK" first.',
    body="# Brandschutz\n\nLoad `building-class` first.",
    metadata={"grid-title": "Brandschutz", "grid-cards": "calculation", "grid-hidden": "true"},
    license="CC-BY-4.0",
    compatibility="Austria",
    allowed_tools="knowledge_search read_passage",
    origin="org",
)


class TestTheDocument:
    def test_our_parser_reads_back_what_we_serve(self) -> None:
        parsed = parse_skill_md(skill_document(RICH), expected_dir_name="fire-safety", origin="org")
        assert parsed.model_dump() == RICH.model_dump()

    def test_the_middleware_lists_what_the_skill_says(self) -> None:
        runtime = SkillRuntime.office((RICH,))
        middleware = SkillsMiddleware(backend=runtime.mounted(), sources=["/skills/office/"])
        (meta,) = middleware.before_agent({}, None, None)["skills_metadata"]  # type: ignore[index]
        assert meta["name"] == "fire-safety"
        assert meta["description"] == RICH.description
        assert meta["path"] == "/skills/office/fire-safety/SKILL.md"
        assert meta["metadata"] == RICH.metadata
        assert meta["allowed_tools"] == ["knowledge_search", "read_passage"]
        assert meta["license"] == "CC-BY-4.0"

    def test_every_builtin_round_trips_through_the_middleware(self) -> None:
        """No builtin skill is dropped or renamed by the middleware's parser."""
        builtins = discover_builtin_skills()
        runtime = SkillRuntime.office(builtins)
        middleware = SkillsMiddleware(backend=runtime.mounted(), sources=["/skills/office/"])
        loaded = middleware.before_agent({}, None, None)["skills_metadata"]  # type: ignore[index]
        assert sorted(m["name"] for m in loaded) == sorted(s.name for s in builtins)
        assert {m["name"]: m["description"] for m in loaded} == {s.name: s.description for s in builtins}


class TestReadOnly:
    def _backend(self) -> SkillsBackend:
        return SkillsBackend({"office": (RICH,)})

    def test_write_edit_delete_and_upload_are_refused(self) -> None:
        backend = self._backend()
        path = "/office/fire-safety/SKILL.md"
        assert backend.write("/office/new/SKILL.md", "x").error
        assert backend.edit(path, "Brandschutz", "nichts").error
        assert backend.delete(path).error
        assert backend.upload_files([(path, b"x")])[0].error == "permission_denied"
        # Nothing changed.
        assert "Load `building-class` first." in backend.read(path).file_data["content"]  # type: ignore[index]
        assert backend.read("/office/new/SKILL.md").error

    async def test_the_async_twins_are_refused_too(self) -> None:
        backend = self._backend()
        assert (await backend.awrite("/office/new/SKILL.md", "x")).error
        assert (await backend.adelete("/office/fire-safety/SKILL.md")).error

    def test_grep_and_glob_see_the_documents(self) -> None:
        backend = self._backend()
        assert [m["path"] for m in backend.grep("building-class").matches or []] == ["/office/fire-safety/SKILL.md"]
        assert [m["path"] for m in backend.glob("**/SKILL.md").matches or []] == ["/office/fire-safety/SKILL.md"]


@pytest.fixture(autouse=True)
def _reset_cache():
    shared_cache.reset_local_store()
    yield
    shared_cache.reset_local_store()


def _row(name: str, **extra: object) -> dict[str, object]:
    return {"name": name, "description": f"{name} office skill.", "body": f"body-{name}", **extra}


class TestTenancy:
    """A run lists and reads its own organization's skills, and only those."""

    @pytest.fixture
    def resolver(self, monkeypatch: pytest.MonkeyPatch) -> SkillResolver:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
        return SkillResolver(agent="researcher")

    def _runtime_for(self, resolver: SkillResolver, org: str, rows: dict[str, list[dict[str, object]]]) -> SkillRuntime:
        with mock.patch.object(resolver, "_fetch_org_skills", side_effect=lambda o: rows[o]):
            return SkillRuntime.office(resolver.resolve(org))

    def test_an_office_skill_is_visible_only_to_its_organization(self, resolver: SkillResolver) -> None:
        rows = {"org-a": [_row("a-only")], "org-b": [_row("b-only")]}
        a = self._runtime_for(resolver, "org-a", rows)
        b = self._runtime_for(resolver, "org-b", rows)

        assert "a-only" in (a.catalog_block() or "")
        assert "b-only" not in (a.catalog_block() or "")
        assert "b-only" in (b.catalog_block() or "")
        assert a.mounted().read("/skills/office/b-only/SKILL.md").error
        assert b.mounted().read("/skills/office/a-only/SKILL.md").error

    def test_the_cache_is_keyed_by_organization(self, resolver: SkillResolver) -> None:
        """A cached payload for one org never answers for another."""
        rows = {"org-a": [_row("a-only")], "org-b": [_row("b-only")]}
        self._runtime_for(resolver, "org-a", rows)
        b = self._runtime_for(resolver, "org-b", rows)
        assert {s.name for s in b.skills} >= {"b-only"}
        assert "a-only" not in {s.name for s in b.skills}

    def test_a_shadowing_row_replaces_the_builtin_for_its_org_only(self, resolver: SkillResolver) -> None:
        machinery = next(s for s in resolver.always_on if s.name == "building-class")
        rows = {"org-a": [_row(machinery.name, description="Unsere Fassung.")], "org-b": []}
        a = self._runtime_for(resolver, "org-a", rows)
        b = self._runtime_for(resolver, "org-b", rows)
        assert "Unsere Fassung." in (a.catalog_block() or "")
        assert "Unsere Fassung." not in (b.catalog_block() or "")
        assert machinery.description in (b.catalog_block() or "")


class TestCuration:
    def test_a_curated_offer_is_absent_until_the_organization_takes_it_up(self, monkeypatch) -> None:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
        resolver = SkillResolver(agent="researcher")
        offer = next(s for s in resolver.builtin if _is_curated(s))
        with mock.patch.object(resolver, "_fetch_org_skills", return_value=[]):
            without = SkillRuntime.office(resolver.resolve("org-a"))
        assert offer.name not in {s.name for s in without.skills}
        assert without.mounted().read(f"/skills/office/{offer.name}/SKILL.md").error

        shared_cache.reset_local_store()
        taken = {"name": offer.name, "description": offer.description, "body": offer.body, "metadata": offer.metadata}
        with mock.patch.object(resolver, "_fetch_org_skills", return_value=[taken]):
            with_offer = SkillRuntime.office(resolver.resolve("org-a"))
        assert offer.name in {s.name for s in with_offer.skills}

    def test_a_hidden_skill_is_listed_and_readable(self) -> None:
        """``grid-hidden`` keeps the live line quiet; it never hides the skill from the model."""
        runtime = SkillRuntime.office((RICH,))
        assert "fire-safety" in (runtime.catalog_block() or "")
        assert runtime.mounted().read("/skills/office/fire-safety/SKILL.md").error is None
        assert runtime.hidden_activated == ("fire-safety",)
