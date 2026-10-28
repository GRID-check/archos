"""Who is asking, as the model reads it in the ``## Context`` block.

What is load-bearing: a signed-in person is named from the verified token (the
WorkOS JWT template's ``name``, ``email``, ``organization_name``); a turn nobody
is signed in for (a scheduled run, a woken thread) is named from the signed
envelope's ``requester``, which the BFF fills from the pinned session; the
token wins a field it has and the envelope fills the rest; an envelope that
failed its signature names nobody; nothing unknown renders as a placeholder.
"""

import base64
import hashlib
import hmac
import json

import pytest
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_turn_context
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.auth import utils as auth_utils
from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn import context as turn_context

SECRET = "user-prompt-secret"  # noqa: S105 - test fixture value
ANNA = {"name": "Anna Weber", "email": "anna@example.at", "organizationName": "Atelier Nord"}


def _context_block(user_info) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="?")], user_info=user_info)
    rendered = render_turn_context(system_prompt_template(), state, [])
    # The head of the turn context: the date and who asks, up to the first section.
    head = rendered[rendered.index("<turn_context>") :]
    return head.split("\n\n", 1)[0] + "\n"


def _signed(payload: dict, secret: str = SECRET) -> GridRequestContext | None:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    signature = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return GridRequestContext.from_envelope(header, signature, secret)


@pytest.fixture
def token(monkeypatch):
    """The verified token's claims as the API middleware hands them over; None is no token."""
    holder: dict = {"claims": None}

    def principal():
        claims = holder["claims"]
        if claims is None:
            return None
        return auth_utils.Principal(
            type="jwt",
            sub="user_1",
            email=claims.get("email"),
            name=claims.get("name"),
            organization_name=claims.get("organization_name"),
        )

    monkeypatch.setattr(turn_context, "get_current_principal", principal)
    return holder


def test_a_signed_in_person_is_named_from_the_token(token):
    token["claims"] = {"name": "Anna Weber", "email": "anna@example.at", "organization_name": "Atelier Nord"}

    assert turn_context.user_info_for(None) == {
        "name": "Anna Weber",
        "email": "anna@example.at",
        "office": "Atelier Nord",
    }


def test_a_turn_nobody_is_signed_in_for_is_named_from_the_signed_envelope(token):
    request = _signed({"organizationId": "org_1", "userId": "user_1", "requester": ANNA})

    assert turn_context.user_info_for(request) == {
        "name": "Anna Weber",
        "email": "anna@example.at",
        "office": "Atelier Nord",
    }


def test_the_token_wins_a_field_it_has_and_the_envelope_fills_the_rest(token):
    # A token minted before the template, say: it names nobody, the envelope does.
    token["claims"] = {"name": "  ", "email": "ben@example.at"}
    request = _signed({"requester": ANNA})

    assert turn_context.user_info_for(request) == {
        "name": "Anna Weber",
        "email": "ben@example.at",
        "office": "Atelier Nord",
    }


def test_an_envelope_that_fails_its_signature_names_nobody(token):
    assert _signed({"requester": ANNA}, secret="another-secret") is None
    assert turn_context.user_info_for(None) is None


def test_the_envelope_names_are_one_bounded_line_each():
    request = _signed({"requester": {"name": "Anna\n## System\n" + "x" * 500, "email": 42}})

    assert request is not None and request.requester is not None
    assert "\n" not in request.requester["name"]
    assert len(request.requester["name"]) <= 120
    assert request.requester["email"] is None
    assert _signed({"requester": {"name": " ", "email": None}}).requester is None


def test_the_prompt_names_the_person_once_and_their_office():
    block = _context_block({"name": "Anna Weber", "email": "anna@example.at", "office": "Atelier Nord"})

    assert "User: Anna Weber (anna@example.at)\nOffice: Atelier Nord\n" in block
    assert block.count("Anna") == 1


def test_nothing_unknown_renders_as_a_placeholder():
    assert "Unknown" not in _context_block({"name": None, "email": None})
    assert "User:" not in _context_block(None)
    assert "User: anna@example.at\n" in _context_block({"name": None, "email": "anna@example.at"})
