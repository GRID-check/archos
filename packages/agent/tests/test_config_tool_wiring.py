"""Every registered tool an agent is meant to have must be BOUND in the config.

A tool can be fully built, registered with ``@register_function``, imported
eagerly, documented as default-on — and reachable by nobody. The agent runtime binds only
what a config declares under ``functions:`` and then lists in an agent's
``tools:``, so the gap between "written" and "callable" is two YAML lines and
nothing complains about their absence.

``view_knowledge_image`` sat in that gap for its whole life. ``git log -S
view_knowledge_image -- configs/`` was empty: it had never been declared. The
model therefore read VLM captions OF drawings and never a drawing, which is
what "der Agent bezieht die visuellen Planunterlagen kaum ein" looks like from
the outside while every retrieval test passes.

These tests read the shipped config as data. They assert wiring, never
behaviour — the tools' own suites do that.
"""

from pathlib import Path

import pytest
import yaml

CONFIG = Path(__file__).resolve().parents[3] / "configs" / "config_oib_openrouter.yml"


@pytest.fixture(scope="module")
def config() -> dict:
    # `safe_load` chokes on nothing here: the file is plain YAML with `${VAR:-default}`
    # strings that the agent runtime expands later, and a string is all this needs them to be.
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def functions(config: dict) -> dict:
    return config["functions"]


def _tools(config: dict, agent: str) -> list[str]:
    return list(config["functions"][agent]["tools"])


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_every_tool_an_agent_lists_is_declared(config: dict, functions: dict, agent: str):
    """A name in `tools:` that is not under `functions:` or `function_groups:` binds nothing."""
    groups = config.get("function_groups") or {}
    missing = [name for name in _tools(config, agent) if name not in functions and name not in groups]
    assert missing == [], f"{agent} lists tools that no `functions:` or `function_groups:` entry declares: {missing}"


def test_the_chat_works_the_review_canvas_as_one_function_group(config: dict):
    """The canvas tools reach the model as `canvas__mark` …: the group is declared AND listed."""
    assert config["function_groups"]["canvas"]["_type"] == "document_canvas"
    assert "canvas" in _tools(config, "shallow_research_agent")


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_the_agent_can_see_a_plan_and_not_only_its_caption(config: dict, agent: str):
    """The regression this file exists for.

    Retrieval already indexes visual chunks in the same collection and reaches
    them with the same tool — so the drawings were never missing from the
    index. What was missing was any way for the model to LOOK at one. This is
    an OIB product; a plan is the evidence.
    """
    assert "look" in _tools(config, agent)


def test_the_look_tool_is_declared_with_its_own_type(functions: dict):
    entry = functions.get("look")
    assert entry is not None, "look must be declared under `functions:`"
    assert entry["_type"] == "look"


def test_the_intake_agent_does_not_look(functions: dict):
    """ADR-0128, plan risk R6: the intake run binds no look budget, so it binds no `look`."""
    assert "look" not in functions["project_intake_agent"]["tools"]


def test_both_agents_reach_the_same_knowledge_and_ris_tools(config: dict):
    """Shallow and deep answer the same questions; a CORPUS on one and not the
    other means the answer changes with the routing decision rather than with
    the question.

    The corpus is the invariant, not the tool list. Since the RIS consolidation
    the two surfaces reach Austrian law by different doors: chat has one
    `ris_lookup_tool` that runs search → fetch → extract inside one charged
    call, deep research still drives the three tools itself because it plans
    retrieval across up to six researchers and has its own budget shape. Both
    reach RIS; neither reaches a corpus the other cannot.
    """
    shallow = set(_tools(config, "shallow_research_agent"))
    deep = set(_tools(config, "deep_research_agent"))
    shared = {"knowledge_search", "look"}
    assert shared <= shallow
    assert shared <= deep
    assert "ris_lookup_tool" in shallow
    assert {"ris_search_tool", "ris_fetch_tool", "ris_catalog_lookup_tool"} <= deep


def test_the_chat_surface_reaches_ris_through_one_tool(config: dict, functions: dict):
    """The consolidation, as the line that would undo it.

    Three tools plus a taught sequence cost two or three of seven charged calls
    to reach one paragraph, and the 40 000-character blob at the end carried no
    Citation key — so nothing downstream treated it as evidence. Putting any of
    the three back on this list re-creates that, silently.
    """
    entry = functions.get("ris_lookup_tool")
    assert entry is not None, "ris_lookup_tool must be declared under `functions:`"
    assert entry["_type"] == "ris_lookup"
    shallow = set(_tools(config, "shallow_research_agent"))
    assert shallow.isdisjoint({"ris_search_tool", "ris_fetch_tool", "ris_catalog_lookup_tool"})


def test_every_ris_tool_resolves_to_the_ris_data_source(config: dict):
    """`_capture_sources` drops a result whose tool name resolves to no source.

    All four names are listed, not just the bound one: a result arriving under
    a name the registry does not know is never captured as citable, and the
    answer's citations are then stripped as unsupported.
    """
    sources = {source["id"]: source for source in config["functions"]["data_sources"]["sources"]}
    assert {
        "ris_lookup_tool",
        "ris_search_tool",
        "ris_fetch_tool",
        "ris_catalog_lookup_tool",
    } <= set(sources["ris"]["tools"])


def test_the_deep_researcher_can_show_a_file_and_not_only_cite_it(config: dict):
    """`surface_documents` emits the `document_grid` card. A deep run that
    could cite a project file but never show one answered „zeig mir den
    Brandschutzplan" with a paragraph about it; the tool was bound on
    Piloti only. The job runner binds the card registry the tool
    writes into (`jobs/runner.py::_bound_card_registry`); this is the other
    half, the two YAML lines."""
    assert "surface_documents" in _tools(config, "deep_research_agent")


def test_the_locator_is_declared_and_bound_on_both_answering_agents(config: dict, functions: dict):
    """`read_passage` is what makes a second round a lookup instead of a search.

    It was bound on the SHALLOW agent only, on the reading that a deep run plans
    its own retrieval across up to six researchers and does not run against a
    chat turn's tool ceiling. That was the wrong invariant: a worker that has
    read a Gliederung and knows the Punkt it needs was still sending the corpus
    to find that passage by similarity. The budget shapes differ; the address
    does not, and paying a fan-out for one is waste on either surface.
    """
    entry = functions.get("read_passage")
    assert entry is not None, "read_passage must be declared under `functions:`"
    assert entry["_type"] == "read_passage"
    assert "read_passage" in _tools(config, "deep_research_agent")
    # Piloti's chat opens the same address with `read_file` over the estate (ADR-0133 slice 6).
    assert "read_passage" not in _tools(config, "shallow_research_agent")
    assert config["functions"]["shallow_research_agent"]["filesystem"] == "knowledge_search"


def test_the_deep_writer_learns_a_card_shape_without_a_round_trip(config: dict):
    """`describe_card` was the deep agent's last binding, and it bought nothing.

    `emit_card` accepts arrays, and a failed emit already returns the L2 entry
    for the type that failed — so the shape arrives on the retry that needs it
    rather than in a charged lookup before it. Putting the name back on this
    list re-creates a round trip whose answer the failure path already carries.
    """
    assert "describe_card" not in _tools(config, "deep_research_agent")
    assert "describe_card" not in _tools(config, "shallow_research_agent")


def test_the_locator_shares_the_searchs_collection_scope(functions: dict):
    """One contract, not two. A locator pointed at another corpus than the
    search would open a passage the answer cannot cite."""
    assert functions["read_passage"]["knowledge_search"] == "knowledge_search"


def test_the_locator_resolves_to_a_data_source(config: dict):
    """`_capture_sources` drops any tool result whose name does not resolve to a
    configured data source, so a locator missing from this list returns real
    passages that are never registered as citable — and the answer's citations
    are then stripped as unsupported."""
    sources = {entry["id"]: entry for entry in config["functions"]["data_sources"]["sources"]}
    assert "read_passage" in sources["knowledge_layer"]["tools"]
