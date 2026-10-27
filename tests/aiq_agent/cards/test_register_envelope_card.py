"""The model's ``project_profile_patch`` card leaves the turn as a server proposal (ADR-0105).

The model composes this card in the answer envelope and no tool runs, so the one
place a turn can create its proposal is where the envelope's cards are made
final and registered (``cards/envelope.register_envelope_card``, called by
``agents/piloti/answer_pipeline._register_envelope_cards``). Only the transport
is faked, so the body checked is the one the client really sends.

* **An open turn gets a proposal**; the card carries its id, and the body is the
  contract's, with the card's real position as ``originCardIndex``.
* **A confined turn does not.** The refusal comes first: no card, no request.
* **Every failure is the card without an id**, which the browser still applies.
* **The id is never the model's.** One it wrote is stripped, and one it was
  never given cannot be taught.
* **One card, one request.**
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

import aiq_agent.project_context as pc
from aiq_agent.agents.piloti.answer_pipeline import _register_envelope_cards
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.envelope import REFUSED_CONFINED
from aiq_agent.cards.envelope import register_envelope_card
from aiq_agent.cards.envelope import validate_model_card
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common import bff_http
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.knowledge import scoping
from aiq_agent.turn.response import answer_message_id

ROOT = Path(__file__).resolve().parents[3]
PROPOSALS_SCHEMA = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "proposals.schema.json"

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
CONVERSATION, USER_MESSAGE = "conv-1", "msg-1"
FIRST = "55555555-0000-4000-8000-000000000005"
SECOND = "66666666-0000-4000-8000-000000000006"
MODELS_OWN_ID = "99999999-0000-4000-8000-000000000009"

PATCH = {
    "type": "project_profile_patch",
    "title": "Projektkontext aktualisieren: Gebäudeklasse",
    "rationale": "Laut Einreichplan ist das Gebäude GK4.",
    "patch": [{"op": "add", "path": "/facts/gebaeudeklasse", "value": "GK4"}],
    "preview": [{"label": "Gebäudeklasse", "before": "GK3", "after": "GK4"}],
}
SECOND_PATCH = {
    "type": "project_profile_patch",
    "title": "Annahme entfernen",
    "rationale": "Der Bauherr hat die Bauweise bestätigt.",
    "patch": [{"op": "remove", "path": "/assumptions/bauweise"}],
}
CALCULATION = {
    "type": "ifc_model_picker",
    "title": "Haus A",
    "note": "GK 4.",
}


class Transport:
    """``_opener.open`` with answers queued: a dict is a 200 body, an int an HTTP error."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[urllib.request.Request] = []

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.data) for request in self.requests]

    def __call__(self, request: urllib.request.Request, timeout: float) -> Any:
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, int):
            raise urllib.error.HTTPError(request.full_url, answer, "refused", {}, io.BytesIO(b"{}"))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(answer).encode("utf-8")
        return response


def _created(proposal_id: str) -> dict[str, str]:
    return {"id": proposal_id, "status": "proposed"}


@pytest.fixture
def registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


@pytest.fixture(autouse=True)
def turn(monkeypatch):
    """An open chat turn: a signed envelope, a service token, a scope with no restricted folder."""
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: CONVERSATION)
    monkeypatch.setattr(pc, "get_user_message_id_from_context", lambda: USER_MESSAGE)
    monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1"])
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "internal-token")
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test")


@pytest.fixture
def transport(monkeypatch):
    def install(*answers: Any) -> Transport:
        fake = Transport(*answers)
        monkeypatch.setattr(bff_http._opener, "open", fake)
        return fake

    return install


async def _finish(*cards: dict[str, Any]) -> str:
    """What the answer pipeline does with the envelope's cards: validate, repair, register."""
    prose = "\n\n".join(f"[[card:{n}]]" for n in range(1, len(cards) + 1))
    return await _register_envelope_cards(AnswerMeta(cards=[dict(card) for card in cards]), prose, [], None)


def _contract_errors(body: dict[str, Any]) -> list[str]:
    schema = json.loads(PROPOSALS_SCHEMA.read_text(encoding="utf-8"))
    request = {**schema["$defs"]["InternalProposalRequest"], "$defs": schema["$defs"]}
    return [e.message for e in Draft202012Validator(request, format_checker=FormatChecker()).iter_errors(body)]


class TestAnOpenTurn:
    async def test_the_card_gets_a_proposal_and_carries_its_id(self, registry, transport):
        fake = transport(_created(FIRST))
        await _finish(PATCH)

        (body,) = fake.bodies()
        assert _contract_errors(body) == []
        assert body == {
            "op": "create",
            "kind": "project_profile",
            "payload": {
                "title": PATCH["title"],
                "rationale": PATCH["rationale"],
                "patch": PATCH["patch"],  # the preview is neither rendered nor recorded
            },
            "answerMessageId": answer_message_id(CONVERSATION, USER_MESSAGE),
            "originCardIndex": 0,
        }
        (card,) = registry.snapshot()
        assert card["type"] == "project_profile_patch" and card["proposal_id"] == FIRST
        grid_card_adapter.validate_python(card)

    async def test_the_index_counts_the_cards_the_tools_pushed_first(self, registry, transport):
        registry.add({"type": "document_draft"})
        fake = transport(_created(FIRST), _created(SECOND))
        await _finish(CALCULATION, PATCH, SECOND_PATCH)

        assert [body["originCardIndex"] for body in fake.bodies()] == [2, 3]
        assert [card.get("proposal_id") for card in registry.snapshot()] == [None, None, FIRST, SECOND]

    async def test_a_card_that_proposes_nothing_asks_nobody(self, registry, transport):
        fake = transport()
        await _finish(CALCULATION)

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert card["type"] == "ifc_model_picker"

    async def test_the_prose_markers_still_name_the_cards_positions(self, registry, transport):
        registry.add({"type": "document_draft"})
        transport(_created(FIRST))
        content = await _finish(PATCH)

        assert content == "[[card:2]]"

    async def test_one_card_is_one_request(self, registry, transport):
        fake = transport(_created(FIRST), _created(SECOND))
        await _finish(PATCH, SECOND_PATCH)

        assert len(fake.requests) == 2
        assert len({json.dumps(body["payload"], sort_keys=True) for body in fake.bodies()}) == 2

    async def test_a_card_registered_again_at_its_position_names_the_same_proposal_key(self, registry, transport):
        """The database dedupes on (answer, index): the second call must send the first's key."""
        fake = transport(_created(FIRST), _created(FIRST))
        validated, _ = validate_model_card(dict(PATCH))
        assert validated is not None
        await register_envelope_card(registry, validated)
        registry.clear()
        await register_envelope_card(registry, validated)

        first, second = fake.bodies()
        assert (first["answerMessageId"], first["originCardIndex"]) == (
            second["answerMessageId"],
            second["originCardIndex"],
        )
        (card,) = registry.snapshot()
        assert card["proposal_id"] == FIRST


class TestAConfinedTurn:
    async def test_the_card_is_refused_and_no_proposal_is_created(self, monkeypatch, registry, transport):
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1", "proj_p1_r0123456789ab"])
        fake = transport(_created(FIRST))

        validated, refusal = validate_model_card(dict(PATCH))
        assert validated is None and refusal is not None and refusal.kind == REFUSED_CONFINED

        await _finish(PATCH)

        assert fake.requests == []
        assert registry.snapshot() == []


class TestEveryFailureIsTheCardWithoutAnId:
    @pytest.mark.parametrize("failure", [404, 403, 500], ids=["older-bff", "refused", "server-error"])
    async def test_a_refused_create_registers_the_card_without_an_id(self, registry, transport, failure):
        transport(failure)
        await _finish(PATCH)

        (card,) = registry.snapshot()
        assert card["type"] == "project_profile_patch" and "proposal_id" not in card
        assert card["patch"] == PATCH["patch"]

    async def test_a_run_without_an_envelope_asks_nobody(self, monkeypatch, registry, transport):
        monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (None, None))
        fake = transport()
        await _finish(PATCH)

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert "proposal_id" not in card

    async def test_a_failing_card_does_not_cost_its_neighbour_a_proposal(self, registry, transport):
        transport(500, _created(SECOND))
        await _finish(PATCH, SECOND_PATCH)

        assert [card.get("proposal_id") for card in registry.snapshot()] == [None, SECOND]


class TestTheIdIsNeverTheModels:
    def test_an_id_the_model_wrote_is_stripped_by_the_one_validator(self):
        validated, refusal = validate_model_card({**PATCH, "proposal_id": MODELS_OWN_ID})

        assert refusal is None and validated is not None
        assert "proposal_id" not in validated

    async def test_an_id_the_model_wrote_does_not_survive_a_refused_create(self, registry, transport):
        """Otherwise Accept would apply a proposal this turn never made."""
        transport(404)
        await _finish({**PATCH, "proposal_id": MODELS_OWN_ID})

        (card,) = registry.snapshot()
        assert "proposal_id" not in card

    def test_the_shape_the_model_is_taught_has_no_such_field(self):
        assert "proposal_id" not in render_card_details(["project_profile_patch"])
