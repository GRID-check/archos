"""The office's reference projects: turn context → state → prompt.

The catalog is what lets the agent look into past projects UNASKED
(docs/design/cross-project-escalation.md): the closed projects most like this
one, one line each, rendered below the KV-cache boundary because they vary per
office. It renders only when the turn can act on it: a catalog without
``project_lookup`` bound promises a door the model does not have.
"""

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_turn_context
from aiq_agent.agents.piloti.prompt import system_prompt_template

BOUNDARY_ANCHOR = "<turn_context>"
HEADING = "## Referenzprojekte des Büros"
CATALOG = "- Wohnbau Graz (id p1): 2019–2021, steiermark, GK 4, holzbau · gemeinsam: GK 4"
LOOKUP = {"name": "project_lookup", "description": "Schlägt in anderen Projekten nach."}
SEARCH = {"name": "knowledge_search", "description": "Search the knowledge base."}


def _render(tools, **overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Wie haben wir die Fluchttreppe gelöst?")], **overrides)
    return render_turn_context(system_prompt_template(), state, tools)


def test_the_catalog_reaches_the_model_below_the_cache_boundary_with_the_rule_to_look_unasked():
    rendered = _render([SEARCH, LOOKUP], reference_projects=CATALOG)

    assert HEADING in rendered
    assert CATALOG in rendered
    assert rendered.index(BOUNDARY_ANCHOR) < rendered.index(HEADING)
    block = rendered.split(HEADING)[1]
    assert "`project_lookup`" in block
    assert "as a precedent, not a norm" in block


def test_a_precedent_is_kept_apart_into_what_applies_what_the_office_does_and_where_it_was_done():
    """The contract, not the prose: the three parts, their order, and the edition/Land caveat."""
    block = _render([SEARCH, LOOKUP], reference_projects=CATALOG).split(HEADING)[1]

    assert "keep three parts apart and in this order" in block
    assert block.index("what applies") < block.index("how the office usually") < block.index("where the office did it")
    assert "project, year, Bundesland" in block
    assert "if the precedent's edition or Bundesland differs" in block


def test_no_catalog_without_the_tool_to_act_on_it():
    assert HEADING not in _render([SEARCH], reference_projects=CATALOG)


def test_no_catalog_renders_no_section():
    assert HEADING not in _render([SEARCH, LOOKUP])


def test_the_conversation_state_hands_the_catalog_to_the_research_state():
    """The graph edge the field has to survive: a catalog that stops at the
    conversation state is one the answering agent never reads."""
    from aiq_agent.agents.piloti.conversation import ConversationGraph
    from aiq_agent.agents.piloti.models.conversation import ConversationState

    state = ConversationState(messages=[HumanMessage(content="Wie?")], reference_projects=CATALOG)
    research = ConversationGraph._research_input(object.__new__(ConversationGraph), state, list(state.messages))

    assert research.reference_projects == CATALOG
