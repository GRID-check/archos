"""One namespace: the estate's ``read_file`` beside the drafts' four verbs (ADR-0133).

What is pinned: which implementation each name runs (a tool with a taken name replaces the stock one
silently, prototype trap 1); a draft is read, written and edited exactly as before, through the
``CompositeBackend`` route, with its stored keys unchanged; an estate read is a grounding block whose
records ride ``ToolMessage.artifact``; a draft read registers no source; the per-mount source toggle;
the repeat-fetch guard never signs a draft; and the wire's tool step says which mount a call reached.
"""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from knowledge_layer import stored_pages
from knowledge_layer.browse import FileRow
from knowledge_layer.estate import EstateBackend
from langgraph.store.memory import InMemoryStore

from aiq_agent.common import action_rows
from aiq_agent.common import data_sources
from aiq_agent.common import tool_calls
from aiq_agent.common import turn_status
from aiq_agent.common.citation_collector import hits_from_artifact
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.tool_calls import fetch_signature
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.draft_store import draft_namespace
from aiq_agent.tools.documents.filesystem import NO_DRAFTS
from aiq_agent.tools.documents.filesystem import PilotiFilesystem
from aiq_agent.tools.documents.filesystem import composite_backend
from aiq_agent.tools.documents.tools import filesystem_tools

PATH = "/project/Gutachten/Brandschutzkonzept.pdf.md"
ROW = FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_a", folder="Gutachten")


def _estate() -> EstateBackend:
    async def rows():
        return [ROW]

    async def none():
        return []

    async def pages(collection, file_name, *, wanted=None):
        texts = {1: "Der Fluchtweg führt ins Freie.", 2: "Keine Sprinkler."}
        items = [stored_pages.Page(number=n, text=t) for n, t in texts.items() if wanted is None or n in wanted]
        return stored_pages.PageText(pages=items, origin="stored", page_count=2)

    return EstateBackend(SimpleNamespace(), rows_loader=rows, restricted_loader=none, page_reader=pages)


@pytest.fixture
def drafts() -> DraftBackend:
    return DraftBackend(store=InMemoryStore(), conversation_id="conv-1")


@pytest.fixture(autouse=True)
def _capture():
    token = begin_grounding_capture()
    try:
        yield
    finally:
        end_grounding_capture(token)


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(tool_call_id=f"call-{uuid4().hex[:6]}", state={}, context=None, store=None, config={})


def _tools(drafts: DraftBackend | None) -> dict:
    return {tool.name: tool for tool in filesystem_tools(drafts, _estate())}


async def _call(tools: dict, name: str, **args):
    return await tools[name].coroutine(runtime=_runtime(), **args)


class TestWhatIsBound:
    def test_with_drafts_the_four_verbs(self, drafts: DraftBackend) -> None:
        assert list(_tools(drafts)) == ["ls", "read_file", "write_file", "edit_file", "glob", "grep"]

    def test_without_a_conversation_only_the_readers(self) -> None:
        assert list(_tools(None)) == ["ls", "read_file", "glob", "grep"]

    def test_delete_and_execute_are_never_built(self, drafts: DraftBackend) -> None:
        """``CompositeBackend`` always offers ``delete`` (prototype trap 3): only the allowlist keeps it off."""
        assert not set(_tools(drafts)) & {"delete", "execute"}

    def test_read_file_is_ours_and_takes_pages_and_clause(self, drafts: DraftBackend) -> None:
        read = _tools(drafts)["read_file"]
        assert set(read.args) >= {"file_path", "offset", "limit", "pages", "clause"}
        assert ".pdf.md" in read.description and "/drafts/" in read.description

    def test_the_subclass_keeps_the_stock_name(self, drafts: DraftBackend) -> None:
        """A subclass with another name is appended beside the stock instance (prototype p5)."""
        middleware = PilotiFilesystem(
            estate=_estate(), backend=composite_backend(drafts, _estate()), tools=["read_file"]
        )
        assert middleware.name == "FilesystemMiddleware"


class TestTheDrafts:
    async def test_write_read_edit_go_through_the_route_with_their_keys_unchanged(self, drafts: DraftBackend) -> None:
        tools = _tools(drafts)
        written = await _call(tools, "write_file", file_path="/drafts/vermerk.md", content="# Vermerk\nalt")
        assert written.status != "error", written.content
        edited = await _call(tools, "edit_file", file_path="/drafts/vermerk.md", old_string="alt", new_string="neu")
        assert edited.status != "error", edited.content
        read = await _call(tools, "read_file", file_path="/drafts/vermerk.md")
        assert read.content.startswith("@@ lines") and "neu" in read.content
        listed = await _call(tools, "ls", path="/drafts/")
        assert "/drafts/vermerk.md" in listed.content
        keys = [item.key for item in await drafts._get_store().asearch(draft_namespace("conv-1"))]
        assert keys == ["/drafts/vermerk.md"]

    async def test_a_draft_is_still_write_once(self, drafts: DraftBackend) -> None:
        tools = _tools(drafts)
        await _call(tools, "write_file", file_path="/drafts/a.md", content="# A")
        again = await _call(tools, "write_file", file_path="/drafts/a.md", content="# B")
        assert again.status == "error" and "edit_file" in again.content

    async def test_nothing_outside_the_drafts_is_writable(self, drafts: DraftBackend) -> None:
        refused = await _call(_tools(drafts), "write_file", file_path="/project/x.md", content="x")
        assert refused.status == "error" and "permission denied" in refused.content

    async def test_the_legacy_root_still_reads(self, drafts: DraftBackend) -> None:
        tools = _tools(drafts)
        await _call(tools, "write_file", file_path="/drafts/a.md", content="# A")
        read = await _call(tools, "read_file", file_path="/entwuerfe/a.md")
        assert "# A" in read.content

    async def test_a_turn_without_drafts_says_so(self) -> None:
        refused = await _call(_tools(None), "read_file", file_path="/drafts/a.md")
        assert refused.status == "error" and refused.content == NO_DRAFTS


class TestTheEstate:
    async def test_a_read_is_a_grounding_block_with_its_records_on_the_artifact(self) -> None:
        message = await _call(_tools(None), "read_file", file_path=PATH, pages="2")
        assert message.status == "success"
        assert "Citation: Brandschutzkonzept.pdf, p.2" in message.content
        hits = hits_from_artifact(message.artifact)
        assert hits is not None and [hit.citation_key for hit in hits] == ["Brandschutzkonzept.pdf, p.2"]

    async def test_capture_reads_the_artifact_first(self) -> None:
        message = await _call(_tools(None), "read_file", file_path=PATH, pages="1")
        entries = extract_sources_from_tool_result(
            "read_file", "text the turn never rendered", artifact=message.artifact
        )
        assert [entry.citation_key for entry in entries] == ["Brandschutzkonzept.pdf, p.1"]
        assert entries[0].chunk_text == "Der Fluchtweg führt ins Freie."

    async def test_a_replayed_estate_read_is_parsed_back_from_its_text(self) -> None:
        message = await _call(_tools(None), "read_file", file_path=PATH, pages="1")
        end_grounding_capture(begin_grounding_capture())
        token = begin_grounding_capture()  # a fresh turn: the records are gone, only the text remains
        try:
            entries = extract_sources_from_tool_result("read_file", message.content)
        finally:
            end_grounding_capture(token)
        assert [entry.citation_key for entry in entries] == ["Brandschutzkonzept.pdf, p.1"]

    async def test_a_draft_read_registers_no_source(self, drafts: DraftBackend) -> None:
        tools = _tools(drafts)
        await _call(tools, "write_file", file_path="/drafts/a.md", content="# A\nSiehe https://example.org")
        read = await _call(tools, "read_file", file_path="/drafts/a.md")
        assert read.artifact is None
        assert extract_sources_from_tool_result("read_file", read.content) == []

    async def test_parallel_calls_keep_their_own_records(self) -> None:
        import asyncio

        tools = _tools(None)
        one, two = await asyncio.gather(
            _call(tools, "read_file", file_path=PATH, pages="1"), _call(tools, "read_file", file_path=PATH, pages="2")
        )
        assert [hit.page for hit in hits_from_artifact(one.artifact)] == [1]
        assert [hit.page for hit in hits_from_artifact(two.artifact)] == [2]


class TestTheRound:
    def test_the_guard_signs_an_estate_read_and_never_a_draft(self) -> None:
        estate = fetch_signature({"name": "read_file", "args": {"file_path": PATH, "pages": "2"}})
        assert estate is not None
        assert fetch_signature({"name": "read_file", "args": {"file_path": PATH.upper(), "pages": " 2 "}}) == estate
        assert fetch_signature({"name": "read_file", "args": {"file_path": PATH, "pages": "3"}}) != estate
        assert fetch_signature({"name": "read_file", "args": {"file_path": "/drafts/a.md"}}) is None
        assert fetch_signature({"name": "ls", "args": {"path": "/project/"}}) is None

    def test_the_knowledge_toggle_refuses_the_estate_and_keeps_the_drafts(self, monkeypatch) -> None:
        monkeypatch.setattr(data_sources, "get_source_id_for_tool", {"knowledge_search": "knowledge_layer"}.get)
        monkeypatch.setattr(data_sources, "get_source", lambda _id: None)
        off = {"knowledge_layer"}
        assert data_sources.disabled_source_notice("read_file", off, {"file_path": PATH}) is not None
        assert data_sources.disabled_source_notice("read_file", off, {"file_path": "/drafts/a.md"}) is None
        assert data_sources.disabled_source_notice("ls", off, {"path": "/drafts/"}) is None
        assert data_sources.disabled_source_notice("write_file", off, {"file_path": "/drafts/a.md"}) is None

    def test_an_estate_read_is_a_retrieval_round_and_a_draft_read_is_not(self) -> None:
        assert tool_calls.is_retrieval_round([{"name": "read_file", "args": {"file_path": PATH}}])
        assert not tool_calls.is_retrieval_round([{"name": "read_file", "args": {"file_path": "/drafts/a.md"}}])

    async def test_the_tool_step_says_which_mount(self, monkeypatch) -> None:
        emitted: list = []
        monkeypatch.setattr(turn_status, "emit_step", lambda step, started=False, **_: emitted.append(step))
        callback = action_rows.ToolStepCallback()
        run = uuid4()
        await callback.on_tool_start({"name": "read_file"}, "", run_id=run, inputs={"file_path": PATH})
        await callback.on_tool_end("", run_id=run)
        draft = uuid4()
        await callback.on_tool_start({"name": "read_file"}, "", run_id=draft, inputs={"file_path": "/drafts/a.md"})
        other = uuid4()
        await callback.on_tool_start({"name": "knowledge_search"}, "", run_id=other, inputs={"query": "x"})
        assert [(step.tool, step.mount, step.status) for step in emitted] == [
            ("read_file", "project", "running"),
            ("read_file", "project", "ok"),
            ("read_file", "drafts", "running"),
            ("knowledge_search", None, "running"),
        ]


class TestTheSkillsRoute:
    """``/skills/`` (ADR-0135) sits beside ``/drafts/`` and the estate on one composite."""

    def _tools(self, drafts: DraftBackend | None) -> dict:
        from aiq_agent.skills.backend import SkillsBackend
        from aiq_agent.skills.models import Skill

        skill = Skill(
            name="fire-safety", description="Brandschutz.", body="# Brandschutz\n\nErst die GK.", origin="org"
        )
        skills = SkillsBackend({"office": (skill,)})
        return {tool.name: tool for tool in filesystem_tools(drafts, _estate(), skills=skills)}

    async def test_a_skill_reads_through_the_stock_tool(self, drafts: DraftBackend) -> None:
        read = await _call(
            self._tools(drafts), "read_file", file_path="/skills/office/fire-safety/SKILL.md", limit=1000
        )
        assert read.status != "error", read.content
        assert "Erst die GK." in read.content and read.artifact is None
        assert "/skills/" in self._tools(drafts)["read_file"].description

    async def test_the_estate_and_the_drafts_still_read(self, drafts: DraftBackend) -> None:
        tools = self._tools(drafts)
        estate = await _call(tools, "read_file", file_path=PATH, pages="1")
        assert "Citation: Brandschutzkonzept.pdf, p.1" in estate.content
        await _call(tools, "write_file", file_path="/drafts/a.md", content="# A")
        assert "# A" in (await _call(tools, "read_file", file_path="/drafts/a.md")).content

    async def test_a_skill_is_never_writable_and_reads_without_a_conversation(self) -> None:
        tools = self._tools(None)
        assert set(tools) == {"ls", "read_file", "glob", "grep"}
        read = await _call(tools, "read_file", file_path="/skills/office/fire-safety/SKILL.md")
        assert read.status != "error", read.content

    def test_a_skill_read_is_no_source_no_signature_and_no_toggle(self, monkeypatch) -> None:
        monkeypatch.setattr(data_sources, "get_source_id_for_tool", {"knowledge_search": "knowledge_layer"}.get)
        args = {"file_path": "/skills/office/fire-safety/SKILL.md"}
        assert data_sources.source_id_for_call("read_file", args) is None
        assert data_sources.disabled_source_notice("read_file", {"knowledge_layer"}, args) is None
        assert fetch_signature({"name": "read_file", "args": args}) is None


class TestGrepOnTheDrafts:
    async def test_a_drafts_grep_is_the_stock_literal_grep(self, drafts: DraftBackend) -> None:
        tools = _tools(drafts)
        await _call(tools, "write_file", file_path="/drafts/a.md", content="# A\nFluchtweg hier")
        found = await _call(tools, "grep", pattern="Fluchtweg", path="/drafts/")
        assert "/drafts/a.md" in found.content and found.artifact is None

    def test_grep_takes_the_standard_arguments_and_ours(self, drafts: DraftBackend) -> None:
        grep = _tools(drafts)["grep"]
        assert list(grep.args)[:5] == ["pattern", "path", "glob", "output_mode", "max_count"]
        assert {"mode", "stemmed", "context"} <= set(grep.args)

    def test_an_estate_grep_is_signed_and_a_drafts_grep_is_not(self) -> None:
        signed = fetch_signature({"name": "grep", "args": {"pattern": "Fluchtweg", "path": "/project/"}})
        assert signed is not None
        assert fetch_signature({"name": "grep", "args": {"pattern": "fluchtweg", "path": "/project/"}}) == signed
        assert fetch_signature({"name": "grep", "args": {"pattern": "Fluchtweg", "mode": "regex"}}) != signed
        assert fetch_signature({"name": "grep", "args": {"pattern": "x", "path": "/drafts/"}}) is None


class TestKnowledgeSearchPath:
    def test_a_path_compiles_to_shelf_folder_and_file(self) -> None:
        from knowledge_layer.register import _path_scope

        assert _path_scope("/project/Gutachten/", None, None, None) == ("project", "Gutachten", None)
        assert _path_scope("/office/", None, None, None) == ("office", None, None)
        assert _path_scope("/law/oib/oib-rl_2.pdf.md", None, None, None) == ("base", None, "oib-rl_2.pdf")
        assert _path_scope("/project/A/x.pdf.md", None, "B", None) == ("project", "B", "x.pdf")
        assert _path_scope("/", "office", None, None) == ("office", None, None)

    @pytest.mark.parametrize("path", ["/drafts/a.md", "project/x", "/nowhere/"])
    def test_a_path_that_names_no_place_is_refused(self, path: str) -> None:
        from knowledge_layer.register import _path_scope

        with pytest.raises(ValueError):
            _path_scope(path, None, None, None)
