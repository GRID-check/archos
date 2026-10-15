"""Who is asking, as the model reads it in the ``## Context`` block.

What is load-bearing: the BFF's names for the signed requester reach the prompt
(the access token usually carries none), the first name stands on its own line
so the agent can address the person, and nothing unknown renders as a
placeholder.
"""

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.turn.context import with_requester

ANNA = {"first_name": "Anna", "last_name": "Weber", "email": "anna@example.at"}


def _context_block(user_info) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="?")], user_info=user_info)
    rendered = render_system_prompt(system_prompt_template(), state, [])
    return rendered[rendered.index("## Context") : rendered.index("## Available Tools")]


def test_the_requester_fills_a_principal_the_token_left_nameless():
    merged = with_requester({"name": None, "email": None}, ANNA, "Atelier Nord")

    assert merged == {
        "name": "Anna Weber",
        "first_name": "Anna",
        "last_name": "Weber",
        "email": "anna@example.at",
        "office": "Atelier Nord",
    }


def test_the_requester_completes_a_turn_with_no_principal_at_all():
    assert with_requester(None, {"first_name": "Anna", "last_name": None, "email": None}, None) == {
        "name": "Anna",
        "first_name": "Anna",
        "last_name": None,
        "email": None,
    }


def test_without_a_requester_the_principal_stands_unchanged():
    principal = {"name": "Anna Weber", "email": "anna@example.at"}

    assert with_requester(principal, None, None) is principal
    assert with_requester(principal, {"first_name": None, "last_name": None, "email": None}, None)["name"] == (
        "Anna Weber"
    )


def test_the_prompt_names_the_person_their_first_name_and_their_office():
    block = _context_block(with_requester(None, ANNA, "Atelier Nord"))

    assert "User: Anna Weber (anna@example.at)" in block
    assert "First name: Anna" in block
    assert "Last name: Weber" in block
    assert "Office: Atelier Nord" in block


def test_nothing_unknown_renders_as_a_placeholder():
    assert "Unknown" not in _context_block({"name": None, "email": None})
    assert "User:" not in _context_block(None)
    assert "User: anna@example.at\n" in _context_block({"name": None, "email": "anna@example.at"})
