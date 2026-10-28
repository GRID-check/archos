"""The WORKSPACE block: turn context → state → prompt (ADR-0123).

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
from aiq_agent.agents.piloti.prompt import render_turn_context
from aiq_agent.agents.piloti.prompt import system_prompt_template

ROOT = Path(__file__).resolve().parents[5]
#: The block the production renderer writes (`workspace-block.fixture.spec.ts`).
BLOCK = json.loads((ROOT / "apps/workspace/tests/fixtures/workspace/rendered.json").read_text(encoding="utf-8"))[
    "workspace"
].replace("{conversation}", "conv-1")
HEADING = "## Workspace"
SEARCH = {"name": "workspace__search", "description": "Find an operation."}
KNOWLEDGE = {"name": "knowledge_search", "description": "Search the knowledge base."}


def _render(tools, **overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Leg einen Ordner Fotos an.")], **overrides)
    return render_turn_context(system_prompt_template(), state, tools)


def test_the_block_reaches_the_model_below_the_cache_boundary_with_how_to_read_it():
    rendered = _render([KNOWLEDGE, SEARCH], workspace_block=BLOCK)

    assert HEADING in rendered
    assert BLOCK in rendered
    assert rendered.index("<turn_context>") < rendered.index(HEADING)
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
    """The contract, not the prose: English operation discovery, records not cited, the work kind.

    That a proposal is not done is said where it matters, by the tool that
    proposes: `workspace__call`'s description and its "Proposed" result. The
    server enforces it (a write never runs), so the static prompt no longer
    repeats it.
    """
    from aiq_agent.tools.workspace.register import DESCRIPTIONS

    static = (ROOT / "packages/agent/src/aiq_agent/agents/piloti/prompts/piloti_static.md").read_text(encoding="utf-8")
    rules = static.split("<rules>")[1].split("</rules>")[0]
    # English is for finding an operation; a document search runs over German documents.
    assert "look one up (`workspace__search`) in English" in rules
    assert "search documents in their language" in rules
    assert "never with `[N]`" in static.split("CITATIONS.")[1]
    assert "never claim it is done" in DESCRIPTIONS["call"]
    assert "`kind` to one of `direct`, `walkthrough`, `ruling`, `handoff`, `work`" in static
    assert '"kind": "work"' in static
