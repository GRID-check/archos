"""Who is asking, as the model reads it in the ``## Context`` block.

What is load-bearing: the name, email and office come from the verified access
token, which carries them through the WorkOS JWT template (``name``, ``email``,
``organization_name``); a name the template rendered empty is no name; nothing
unknown renders as a placeholder.
"""

import pytest
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.auth import utils as auth_utils
from aiq_agent.turn import context as turn_context


def _context_block(user_info) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="?")], user_info=user_info)
    rendered = render_system_prompt(system_prompt_template(), state, [])
    return rendered[rendered.index("## Context") : rendered.index("## Available Tools")]


@pytest.fixture
def token(monkeypatch):
    """The verified token's claims, as the API middleware hands them over."""
    claims: dict = {"type": "jwt", "sub": "user_1"}

    def principal():
        return auth_utils.Principal(
            type=claims["type"],
            sub=claims["sub"],
            email=claims.get("email"),
            name=claims.get("name"),
            organization_name=claims.get("organization_name"),
        )

    monkeypatch.setattr(turn_context, "get_current_principal", principal)
    return claims


def test_the_template_claims_become_the_user_info(token):
    token.update(name="Anna Weber", email="anna@example.at", organization_name="Atelier Nord")

    assert turn_context.user_info_from_principal() == {
        "name": "Anna Weber",
        "email": "anna@example.at",
        "office": "Atelier Nord",
    }


def test_a_name_the_template_rendered_empty_is_no_name(token):
    token.update(name="  ", email="anna@example.at")

    assert turn_context.user_info_from_principal() == {"name": None, "email": "anna@example.at", "office": None}


def test_the_prompt_names_the_person_once_and_their_office():
    block = _context_block({"name": "Anna Weber", "email": "anna@example.at", "office": "Atelier Nord"})

    assert "User: Anna Weber (anna@example.at)\nOffice: Atelier Nord\n" in block
    assert block.count("Anna") == 1


def test_nothing_unknown_renders_as_a_placeholder():
    assert "Unknown" not in _context_block({"name": None, "email": None})
    assert "User:" not in _context_block(None)
    assert "User: anna@example.at\n" in _context_block({"name": None, "email": "anna@example.at"})
