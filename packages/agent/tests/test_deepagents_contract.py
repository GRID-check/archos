"""What this repo assumes about deepagents, checked against the installed release.

deepagents moves fast (32 releases in the 0.7 line in three months), several
of them changing tool output, defaults or private builders we call. Each test
here names one assumption, the code that rests on it, and what to do when a bump
breaks it. A failure here after `uv lock --upgrade-package deepagents` is the
point: read the message, fix the named code, then update the test.

The pin is exact (`deepagents==` in `pyproject.toml`) so a bump is a decision,
not an accident; `test_the_installed_release_is_the_pinned_one` keeps the venv
honest about which release these checks ran against.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import inspect
import re
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from typing import get_args
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool

REPO_ROOT = Path(__file__).resolve().parents[3]

#: Every deepagents name imported anywhere in `src/`, `apps/` or `tests/`,
#: by module. A name missing after a bump is an ImportError at worker start in
#: production; here it is a test that says which module moved it.
_IMPORTED_NAMES = {
    "deepagents": ["create_deep_agent"],
    "deepagents.backends": ["CompositeBackend", "FilesystemBackend", "StateBackend"],
    "deepagents.backends.protocol": [
        "BackendProtocol",
        "DeleteResult",
        "EditResult",
        "ExecuteResponse",
        "FileInfo",
        "FileDownloadResponse",
        "FileUploadResponse",
        "GlobResult",
        "GrepResult",
        "LsResult",
        "ReadResult",
        "WriteResult",
    ],
    "deepagents.backends.sandbox": ["BaseSandbox"],
    "deepagents.backends.store": ["StoreBackend"],
    "deepagents.backends.utils": ["create_file_data", "slice_read_response", "validate_path"],
    "deepagents.middleware.filesystem": [
        "FilesystemMiddleware",
        "FilesystemPermission",
        "FsToolName",
        "ReadFileSchema",
        # private, used by tests that pin our permission rules' semantics
        "_apply_permissions_to_ls_results",
        "_check_fs_permission",
    ],
    "deepagents.middleware.patch_tool_calls": ["PatchToolCallsMiddleware"],
    "deepagents.middleware.skills": ["SkillsMiddleware", "_list_skills"],
    "deepagents.middleware.summarization": ["create_summarization_middleware"],
    # named in `backend/jobs/phase_events.py` and `tokenomics/`, which read the
    # `task` tool's `subagent_type` argument off tool callbacks
    "deepagents.middleware.subagents": ["TaskToolSchema", "_build_task_tool"],
}


@pytest.mark.parametrize(("module_name", "names"), sorted(_IMPORTED_NAMES.items()))
def test_every_name_we_import_still_exists(module_name: str, names: list[str]) -> None:
    module = importlib.import_module(module_name)
    missing = [name for name in names if not hasattr(module, name)]
    assert not missing, (
        f"deepagents no longer exports {missing} from {module_name}. Grep the repo for each name "
        "(packages/agent/src/agent/agents/deep_researcher, "
        "packages/agent/src/agent/tools/documents, tests) and port it to "
        "the release's replacement before bumping."
    )


def test_the_installed_release_is_the_pinned_one() -> None:
    pyproject = tomllib.loads((REPO_ROOT / "packages" / "agent" / "pyproject.toml").read_text(encoding="utf-8"))
    pins = [dep for dep in pyproject["project"]["dependencies"] if re.match(r"deepagents\s*[=<>~!]", dep)]
    assert len(pins) == 1 and pins[0].startswith("deepagents=="), (
        f"deepagents must be pinned exactly in pyproject.toml, found {pins}: every 0.7 patch release has "
        "changed something a test in this file checks."
    )
    pinned = pins[0].removeprefix("deepagents==")
    installed = importlib.metadata.version("deepagents")
    assert installed == pinned, f"venv has deepagents {installed}, pyproject pins {pinned}: run `uv sync --group dev`"


# ---------------------------------------------------------------------------
# FilesystemMiddleware: the allowlist both tool surfaces are built with
# ---------------------------------------------------------------------------


def test_the_filesystem_tool_names_are_the_ones_our_allowlists_use() -> None:
    """`draft_tools` and the deep researcher build the FS tools from an allowlist of these names."""
    from deepagents.middleware.filesystem import FsToolName

    from agent.agents.deep_researcher.factory import FILESYSTEM_TOOL_NAMES
    from agent.tools.documents.tools import DRAFT_TOOL_NAMES

    known = set(get_args(FsToolName))
    assert known == {"ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute"}, (
        f"FsToolName is now {sorted(known)}. A new tool is offered to every agent that does not pass "
        "`tools=`; decide whether DRAFT_TOOL_NAMES (tools/documents/tools.py) and FILESYSTEM_TOOL_NAMES "
        "(deep_researcher/factory.py) should list it."
    )
    assert set(DRAFT_TOOL_NAMES) <= known
    assert set(FILESYSTEM_TOOL_NAMES) <= known


def test_filesystem_middleware_takes_the_arguments_we_pass() -> None:
    from deepagents.middleware.filesystem import FilesystemMiddleware

    parameters = set(inspect.signature(FilesystemMiddleware.__init__).parameters)
    expected = {"backend", "custom_tool_descriptions", "permissions", "tools"}
    assert expected <= parameters, (
        f"FilesystemMiddleware no longer takes {sorted(expected - parameters)}; "
        "tools/documents/tools.py and deep_researcher/factory.py pass all four."
    )


def test_the_allowlist_builds_only_the_listed_tools() -> None:
    """An excluded name must not be dispatchable at all, not merely hidden from the model."""
    from deepagents.backends import CompositeBackend
    from deepagents.backends import StateBackend
    from deepagents.middleware.filesystem import FilesystemMiddleware

    backend = CompositeBackend(default=StateBackend(), routes={"/shared/": StateBackend()})
    stock = {t.name for t in FilesystemMiddleware(backend=backend).tools}
    assert "delete" in stock, "CompositeBackend no longer offers `delete`: the allowlists may be redundant, not wrong"
    allowed = {t.name for t in FilesystemMiddleware(backend=backend, tools=["ls", "read_file"]).tools}
    assert allowed == {"ls", "read_file"}


#: The private builders ``tools/documents/filesystem.PilotiFilesystem`` overrides (ADR-0133). They carry no
#: stability promise, so a rename is caught here rather than by a model that silently gets the stock tool.
_OVERRIDDEN_BUILDERS = ("_create_read_file_tool", "_create_ls_tool", "_create_glob_tool", "_create_grep_tool")


@pytest.mark.parametrize("builder", _OVERRIDDEN_BUILDERS)
def test_the_builders_the_estate_overrides_exist_and_take_nothing(builder: str) -> None:
    from deepagents.middleware.filesystem import FilesystemMiddleware

    method = getattr(FilesystemMiddleware, builder, None)
    assert method is not None, (
        f"FilesystemMiddleware.{builder} is gone: PilotiFilesystem's override is never called, and the stock tool "
        "(no grounding blocks, no citations) is bound under our name. Port tools/documents/filesystem.py."
    )
    assert list(inspect.signature(method).parameters) == ["self"]
    source = inspect.getsource(FilesystemMiddleware._create_tools)
    assert f"self.{builder}" in source, f"_create_tools no longer calls {builder}; the override is dead code"


def test_the_stock_read_file_coroutine_takes_what_the_estate_wrapper_passes() -> None:
    """The drafts' read goes through the stock coroutine with ``file_path``, ``runtime``, ``offset``, ``limit``."""
    from deepagents.backends import StateBackend
    from deepagents.middleware.filesystem import FilesystemMiddleware
    from deepagents.middleware.filesystem import ReadFileSchema

    stock = next(t for t in FilesystemMiddleware(backend=StateBackend(), tools=["read_file"]).tools)
    assert set(inspect.signature(stock.coroutine).parameters) >= {"file_path", "runtime", "offset", "limit"}
    assert set(ReadFileSchema.model_fields) == {"file_path", "offset", "limit"}, (
        "ReadFileSchema changed: EstateReadFileSchema (tools/documents/filesystem.py) restates its three fields bare"
    )


def test_the_composite_strips_the_route_prefix_the_draft_route_puts_back() -> None:
    """``_DraftRoute`` re-prefixes ``/drafts`` because the composite hands a routed backend ``/a.md``."""
    from deepagents.backends import CompositeBackend
    from deepagents.backends import StateBackend

    composite = CompositeBackend(default=StateBackend(), routes={"/drafts/": StateBackend()})
    _backend, key = composite._get_backend_and_key("/drafts/a.md")
    assert key == "/a.md"


# ---------------------------------------------------------------------------
# Backends: the protocol our two subclasses override
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "agent.tools.documents.draft_store:DraftBackend",
        "agent.skills.backend:SkillsBackend",
        "agent.tools.documents.filesystem:_DraftRoute",
        "knowledge_layer.estate:EstateBackend",
    ],
)
def test_our_backend_overrides_match_the_protocol(path: str) -> None:
    """An override that drops an argument the stock tools pass is a TypeError the model reads as a failed tool."""
    from deepagents.backends.protocol import BackendProtocol

    module_name, class_name = path.split(":")
    cls = getattr(importlib.import_module(module_name), class_name)
    for name, member in vars(cls).items():
        stock = getattr(BackendProtocol, name, None)
        if name.startswith("_") or not callable(member) or stock is None:
            continue
        ours = set(inspect.signature(member).parameters)
        theirs = set(inspect.signature(stock).parameters)
        assert theirs <= ours, f"{class_name}.{name} lacks {sorted(theirs - ours)} that BackendProtocol.{name} takes"


def test_state_backend_still_reads_through_the_one_hook_the_skills_backend_overrides() -> None:
    """``SkillsBackend`` hands ``StateBackend`` its files by overriding ``_read_files`` (ADR-0135)."""
    from deepagents.backends import StateBackend

    from agent.skills.backend import SkillsBackend
    from agent.skills.models import Skill

    assert callable(getattr(StateBackend, "_read_files", None)), "StateBackend._read_files is gone"
    backend = SkillsBackend({"office": (Skill(name="x", description="d", body="b"),)})
    # Outside a graph: a StateBackend that still read the graph's channel would raise here.
    assert [e["path"] for e in backend.ls("/office/").entries or []] == ["/office/x/"]
    assert backend.glob("**/SKILL.md").matches
    assert backend.download_files(["/office/x/SKILL.md"])[0].content


def test_skills_middleware_takes_our_template_and_renders_outside_an_agent() -> None:
    """Piloti renders the catalog with ``before_agent`` + ``modify_request``, without hosting the middleware."""
    from deepagents.middleware.skills import SkillsMiddleware

    from agent.skills.models import Skill
    from agent.skills.runtime import SKILLS_PROMPT
    from agent.skills.runtime import SkillRuntime

    parameters = set(inspect.signature(SkillsMiddleware.__init__).parameters)
    assert {"backend", "sources", "system_prompt"} <= parameters
    for slot in ("{skills_locations}", "{skills_load_warnings}", "{skills_list}"):
        assert slot in SKILLS_PROMPT
    block = SkillRuntime.office((Skill(name="x", description="the d", body="b"),)).catalog_block() or ""
    assert "- **x**: the d" in block, "the middleware's catalog line changed shape; the skills tests read it"
    assert "/skills/office/x/SKILL.md" in block


def test_store_backend_still_has_the_helpers_the_draft_backend_calls() -> None:
    from deepagents.backends.store import StoreBackend

    for name in ("_get_store", "_get_namespace", "_search_store_paginated"):
        assert callable(getattr(StoreBackend, name, None)), f"StoreBackend.{name} is gone; DraftBackend calls it"
    namespace = inspect.signature(StoreBackend.__init__).parameters.get("namespace")
    assert namespace is not None, "StoreBackend no longer takes `namespace=`; DraftBackend.__init__ passes it"


def test_stock_write_overwrites_so_the_draft_refusal_is_ours() -> None:
    """Since 0.7 `write` creates or overwrites; `draft_store.write_refusal` keeps drafts create-only.

    If this starts failing because the stock backend refuses again, the refusal
    in `draft_store._overwrite_refusal` is redundant (not wrong), and the
    deep-researcher README's note on overwrites is stale.
    """
    from deepagents.backends.store import StoreBackend
    from langgraph.store.memory import InMemoryStore

    backend = StoreBackend(store=InMemoryStore(), namespace=lambda _rt: ("contract",))
    backend.write("/a.md", "one")
    assert backend.write("/a.md", "two").error is None
    assert backend.read("/a.md").file_data["content"] == "two"


# ---------------------------------------------------------------------------
# Tool contracts the model's descriptions and our callbacks rely on
# ---------------------------------------------------------------------------


async def test_read_file_output_has_the_header_our_draft_description_names() -> None:
    """`tools/documents/tools.py` tells the model the `@@ lines … @@` header is not part of the draft."""
    from langgraph.store.memory import InMemoryStore

    from agent.tools.documents.draft_store import DraftBackend
    from agent.tools.documents.tools import draft_tools

    backend = DraftBackend(store=InMemoryStore(), conversation_id="contract")
    await backend.awrite("/drafts/a.md", "# A\nzwei\n")
    read = next(t for t in draft_tools(backend) if t.name == "read_file")
    message = await read.coroutine(file_path="/drafts/a.md", runtime=SimpleNamespace(tool_call_id="c", state={}))
    first, *body = message.content.splitlines()
    assert first.startswith("@@ lines"), f"read_file output changed: {message.content!r}; update _TOOL_DESCRIPTIONS"
    assert body == ["# A", "zwei"], f"read_file body is no longer verbatim: {body!r}; update _TOOL_DESCRIPTIONS"


def test_the_task_tool_takes_description_and_subagent_type_only() -> None:
    """`phase_events.py` and `tokenomics/nat_adapter.py` read `subagent_type` from the call's input."""
    from deepagents.middleware.subagents import TaskToolSchema
    from pydantic import ValidationError

    assert set(TaskToolSchema.model_fields) == {"description", "subagent_type"}
    with pytest.raises(ValidationError, match="prompt"):
        TaskToolSchema.model_validate({"description": "x", "subagent_type": "planner-agent", "prompt": "y"})


# ---------------------------------------------------------------------------
# What create_deep_agent no longer gives by default
# ---------------------------------------------------------------------------


def _fake_model() -> GenericFakeChatModel:
    return GenericFakeChatModel(messages=iter([AIMessage(content="done")]))


def _deep_research_tool_names() -> dict[str, set[str]]:
    """Build the real deep-research graph and return each agent's model-facing tool names.

    `create_agent` is captured in both places deepagents calls it, so every
    middleware stack the release assembles (orchestrator, each subagent and the
    auto-added general-purpose one) is inspected as built, not as we think it is.
    """
    from agent.agents.deep_researcher import factory
    from agent.agents.deep_researcher.custom_middleware import SourceRegistryMiddleware
    from agent.agents.deep_researcher.deepagents_runtime import DeepAgentsRuntime
    from agent.agents.deep_researcher.models import DeepResearchAgentState
    from agent.common import LLMProvider

    @tool
    def web_search_tool(query: str) -> str:
        """Search the web."""
        return query

    calls: list[tuple[str, dict[str, Any]]] = []

    def capturing(default_name: str) -> Any:
        def capture(*_args: Any, **kwargs: Any) -> MagicMock:
            calls.append((kwargs.get("name") or default_name, kwargs))
            graph = MagicMock()
            graph.with_config.return_value = graph
            return graph

        return capture

    provider = LLMProvider()
    provider.set_default(_fake_model())
    registry = SourceRegistryMiddleware(source_tool_names={web_search_tool.name})
    tool_set = factory.build_deep_research_tool_set(
        [web_search_tool],
        source_registry_middleware=registry,
        max_concurrent_source_tool_calls=2,
        max_source_tool_batch_size=3,
    )
    with (
        patch("deepagents.graph.create_agent", side_effect=capturing("orchestrator")),
        patch("deepagents.middleware.subagents.create_agent", side_effect=capturing("subagent")),
        patch.object(factory, "create_agent", side_effect=capturing("researcher-agent")),
    ):
        factory.build_deep_research_graph(
            llm_provider=provider,
            state=DeepResearchAgentState(messages=[]),
            prompts={name: "" for name in ("planner", "researcher", "orchestrator", "writer", "source_router")},
            tools=[web_search_tool],
            runtime=DeepAgentsRuntime(),
            tool_set=tool_set,
            middleware_set=factory.build_deep_research_middleware_set(
                tool_set=tool_set, source_registry_middleware=registry, max_research_concurrency=2
            ),
            source_registry_middleware=registry,
            callbacks=[],
            domain_catalog_path=None,
            max_research_concurrency=2,
        )
    agents: dict[str, set[str]] = {}
    for name, kwargs in calls:
        names = {t.name for t in kwargs.get("tools") or []}
        for middleware in kwargs.get("middleware") or []:
            names.update(t.name for t in getattr(middleware, "tools", None) or [])
        agents[name] = names
    return agents


def test_write_todos_is_where_the_prompts_offer_it_and_delete_is_nowhere() -> None:
    """0.7 dropped `TodoListMiddleware` from the defaults and added `delete` (CompositeBackend offers it).

    `orchestrator.j2` and `planner.j2` offer `write_todos`, and the job's todo
    artifact (`backend/jobs/callbacks.py`) is built from it, so
    `factory.planning_middleware` adds it back; `FILESYSTEM_TOOL_NAMES` keeps
    `delete` off every agent.
    """
    agents = _deep_research_tool_names()
    assert {"orchestrator", "planner-agent", "writer-agent", "researcher-agent"} <= set(agents), sorted(agents)
    assert "task" in agents["orchestrator"]
    for name in ("orchestrator", "planner-agent"):
        assert "write_todos" in agents[name], f"{name} tools: {sorted(agents[name])}"
    assert "write_todos" not in agents["researcher-agent"], "the researcher never had todos"
    offenders = {name: sorted(tools) for name, tools in agents.items() if "delete" in tools}
    assert not offenders, f"`delete` is offered to {offenders}; build their FilesystemMiddleware with the allowlist"
