"""The WORKSPACE block: turn context → state → prompt (ADR-0122).

The BFF names who asks, where, and what is open now, this conversation's
proposals with every status among it. It renders below the KV-cache boundary,
and only when the turn can act on it through the workspace tools: without them
the block would describe a door the model does not have.
"""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template

ROOT = Path(__file__).resolve().parents[4]
#: The block the production renderer writes (`workspace-block.fixture.spec.ts`).
BLOCK = json.loads((ROOT / "frontends/ui/tests/fixtures/workspace/rendered.json").read_text(encoding="utf-8"))[
    "workspace"
].replace("{conversation}", "conv-1")
HEADING = "## Workspace"
SEARCH = {"name": "workspace__search", "description": "Find an operation."}
KNOWLEDGE = {"name": "knowledge_search", "description": "Search the knowledge base."}


def _render(tools, **overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Leg einen Ordner Fotos an.")], **overrides)
    return render_system_prompt(system_prompt_template(), state, tools)


def test_the_block_reaches_the_model_below_the_cache_boundary_with_how_to_read_it():
    rendered = _render([KNOWLEDGE, SEARCH], workspace_block=BLOCK)

    assert HEADING in rendered
    assert BLOCK in rendered
    assert rendered.index("## Context") < rendered.index(HEADING)
    after = rendered.split(HEADING)[1]
    assert "Take ids from here instead of looking them up" in after
    assert "is not proposed again" in after


def test_no_block_without_the_workspace_tools():
    assert HEADING not in _render([KNOWLEDGE], workspace_block=BLOCK)


def test_no_block_renders_no_section():
    assert HEADING not in _render([KNOWLEDGE, SEARCH])


def test_the_conversation_state_hands_the_block_to_the_research_state():
    from aiq_agent.agents.piloti.conversation import ConversationGraph
    from aiq_agent.agents.piloti.models.conversation import ConversationState

    state = ConversationState(messages=[HumanMessage(content="Wie?")], workspace_block=BLOCK)
    research = ConversationGraph._research_input(object.__new__(ConversationGraph), state, list(state.messages))

    assert research.workspace_block == BLOCK


def test_the_static_prompt_teaches_the_workspace_facts_and_the_work_kind():
    """The contract, not the prose: English queries, proposals not claimed done, records not cited."""
    static = (ROOT / "src/aiq_agent/agents/piloti/prompts/piloti_static.md").read_text(encoding="utf-8")
    section = static.split("<workspace>")[1].split("</workspace>")[0]
    assert "write the query in English" in section
    assert "never that it is done" in section
    assert "never with `[N]`" in section
    assert "`kind` to one of `direct`, `walkthrough`, `ruling`, `handoff`, `work`" in static
    assert '"kind": "work"' in static
