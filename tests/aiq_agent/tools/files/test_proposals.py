"""The proposal as a server object: what goes over the wire, as whom, and what happens when it cannot.

Only the transport is faked (``client._opener.open``), so the request the test
reads is the one ``post_proposal`` really builds, headers included. The tool,
the card and the client above the socket are the real ones.

Four properties:

* **The body is the contract's.** It validates against
  ``frontends/ui/tests/fixtures/proposals.schema.json``, the JSON Schema the
  BFF exports from ``lib/proposals/types.ts``. No Pydantic twin.
* **The envelope is echoed.** The two strings the turn arrived with go out
  unchanged; nothing here signs.
* **The card carries the id**, and a server-backed card is never extended,
  because a stored proposal cannot grow.
* **Every failure is the old card.** No envelope, a 404 from an older BFF, a
  network error: the card goes out without ``proposal_id`` and extends as it
  always did, and the model is told the same thing.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

import aiq_agent.project_context as pc
from aiq_agent.cards.models import MAX_FILE_OPERATIONS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.tools.files import client
from aiq_agent.tools.files.register import ProposeFileChangeConfig
from aiq_agent.tools.files.register import propose_file_change
from aiq_agent.turn.response import answer_message_id

ROOT = Path(__file__).resolve().parents[4]
PROPOSALS_SCHEMA = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "proposals.schema.json"
REQUEST_DEF = "InternalProposalRequest"
RESPONSE_DEF = "InternalProposalResponse"

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
TOKEN = "internal-token"
CONVERSATION, USER_MESSAGE = "conv-1", "msg-1"
FIRST = "55555555-0000-4000-8000-000000000005"
SECOND = "66666666-0000-4000-8000-000000000006"

INVENTORY = [
    AvailableDocument(
        file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_1", folder_path="Nachweise"
    ),
    AvailableDocument(file_name="Grundriss OG.pdf", shelf="project", collection="proj_1", folder_path=None),
    AvailableDocument(file_name="Schnitt A-A.pdf", shelf="project", collection="proj_1", folder_path="Einreichung"),
]


class FakeTransport:
    """``_opener.open`` with the answers queued: a dict is a 200 body, an int an HTTP error, an exception raised."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[urllib.request.Request] = []

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.data) for request in self.requests]

    def __call__(self, request: urllib.request.Request, timeout: float) -> Any:
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, int):
            raise urllib.error.HTTPError(request.full_url, answer, "refused", {}, io.BytesIO(b'{"error":"nope"}'))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(answer).encode("utf-8")
        return response


@pytest.fixture
def registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


@pytest.fixture(autouse=True)
def turn(monkeypatch):
    """A project-scoped chat turn with a signed envelope and a service token."""
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: "p1")
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: CONVERSATION)
    monkeypatch.setattr(pc, "get_user_message_id_from_context", lambda: USER_MESSAGE)
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test")
    set_turn_documents(INVENTORY)
    yield
    set_turn_documents(None)


@pytest.fixture
def transport(monkeypatch):
    def install(*answers: Any) -> FakeTransport:
        fake = FakeTransport(*answers)
        monkeypatch.setattr(client._opener, "open", fake)
        return fake

    return install


async def _propose(operation: str, **params: str) -> str:
    async with propose_file_change(ProposeFileChangeConfig(), MagicMock()) as info:
        return await info.single_fn(info.input_schema(operation=operation, **params))


def _created(proposal_id: str) -> dict[str, str]:
    return {"id": proposal_id, "status": "proposed"}


# ── The wire, against the contract ─────────────────────────────────────────


@pytest.fixture(scope="module")
def proposals_schema() -> dict[str, Any]:
    if not PROPOSALS_SCHEMA.exists():
        pytest.skip(
            f"{PROPOSALS_SCHEMA.relative_to(ROOT)} is not generated yet: the BFF's proposals route exports it "
            "from lib/proposals/types.ts. The body is still pinned by the shape tests below."
        )
    return json.loads(PROPOSALS_SCHEMA.read_text(encoding="utf-8"))


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """One named definition, ``$ref`` resolved against the whole file, formats asserted."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]}, format_checker=FormatChecker())


class TestTheWireContract:
    @pytest.mark.parametrize("name", [REQUEST_DEF, RESPONSE_DEF])
    def test_the_fixture_is_where_the_contract_lives(self, proposals_schema, name):
        """A guard on the guard: a renamed definition must fail loudly, not pass silently."""
        assert name in proposals_schema["$defs"]

    @pytest.mark.parametrize(
        ("operation", "params"),
        [
            ("move", {"document": "Brandschutzkonzept.pdf", "target_folder": "Einreichung"}),
            ("move", {"document": "Schnitt A-A.pdf", "target_folder": ""}),
            ("rename", {"document": "Grundriss OG.pdf", "new_name": "Grundriss Obergeschoss"}),
            ("create_folder", {"new_name": "Fotos", "target_folder": ""}),
            ("create_folder", {"new_name": "Fotos", "target_folder": "Einreichung"}),
            ("assign", {"document": "Grundriss OG.pdf", "member": "Anna Berger"}),
        ],
    )
    async def test_every_operation_sends_a_body_the_contract_accepts(
        self, proposals_schema, registry, transport, operation, params
    ):
        fake = transport(_created(FIRST))
        await _propose(operation, **params)

        (body,) = fake.bodies()
        errors = sorted(_validator(proposals_schema, REQUEST_DEF).iter_errors(body), key=str)
        assert not errors, [error.message for error in errors]

    def test_the_answer_the_tool_reads_is_the_contracts(self, proposals_schema):
        assert not list(_validator(proposals_schema, RESPONSE_DEF).iter_errors(_created(FIRST)))

    def test_the_server_holds_no_more_rows_than_the_card_shows(self, proposals_schema):
        """A proposal the card cannot draw in full would be applied unseen."""
        payload = proposals_schema["$defs"][REQUEST_DEF]["properties"]["payload"]
        assert payload["properties"]["operations"]["maxItems"] == MAX_FILE_OPERATIONS


class TestTheRequest:
    async def test_the_body_is_one_create_of_the_calls_rows(self, registry, transport):
        fake = transport(_created(FIRST))
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (request,) = fake.requests
        assert request.full_url == "http://bff.test/api/internal/proposals"
        assert request.get_method() == "POST"
        assert fake.bodies() == [
            {
                "op": "create",
                "kind": "file_operation",
                "payload": {
                    "operation": "move",
                    "operations": [
                        {
                            "document": "Brandschutzkonzept.pdf",
                            "source": "projekt",
                            "current": "Nachweise",
                            "target_folder": "Einreichung",
                        }
                    ],
                },
                "answerMessageId": answer_message_id(CONVERSATION, USER_MESSAGE),
            }
        ]

    async def test_the_envelope_is_echoed_byte_for_byte(self, registry, transport):
        """Echo, never sign: the turn's two strings go out exactly as they arrived."""
        fake = transport(_created(FIRST))
        await _propose("assign", document="Grundriss OG.pdf", member="Anna Berger")

        (request,) = fake.requests
        assert request.get_header("X-grid-request-context") == HEADER
        assert request.get_header("X-grid-request-context-sig") == SIGNATURE
        assert request.get_header("X-grid-internal-token") == TOKEN

    async def test_a_turn_without_a_conversation_names_no_answer(self, monkeypatch, registry, transport):
        monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: None)
        fake = transport(_created(FIRST))
        await _propose("create_folder", new_name="Fotos")

        (body,) = fake.bodies()
        assert "answerMessageId" not in body
        assert uuid.UUID(answer_message_id(CONVERSATION, USER_MESSAGE))  # the id it would send is a UUID


# ── The card ────────────────────────────────────────────────────────────────


class TestTheCardCarriesTheProposal:
    async def test_the_card_carries_the_id_and_the_result_still_claims_nothing(self, registry, transport):
        transport(_created(FIRST))
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert card["proposal_id"] == FIRST
        assert card["operation"] == "move" and len(card["operations"]) == 1
        grid_card_adapter.validate_python(card)
        assert "NOCH NICHTS geändert" in result
        assert "sage nicht, dass es erledigt ist" in result

    async def test_a_second_call_is_a_second_proposal_never_a_grown_one(self, registry, transport):
        """A stored proposal cannot grow; a card that grew on the client would show two moves and apply one."""
        fake = transport(_created(FIRST), _created(SECOND))
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung")

        assert [len(body["payload"]["operations"]) for body in fake.bodies()] == [1, 1]
        assert [(card["proposal_id"], len(card["operations"])) for card in registry.snapshot()] == [
            (FIRST, 1),
            (SECOND, 1),
        ]

    async def test_a_fallback_after_a_stored_proposal_opens_its_own_card(self, registry, transport):
        """A browser-executed row must never be appended to a card the server holds."""
        transport(_created(FIRST), 503)
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung")

        first, second = registry.snapshot()
        assert first["proposal_id"] == FIRST and len(first["operations"]) == 1
        assert "proposal_id" not in second and len(second["operations"]) == 1

    async def test_an_id_that_is_not_a_uuid_is_not_carried(self, registry, transport):
        transport({"id": "not-a-uuid", "status": "proposed"})
        await _propose("create_folder", new_name="Fotos")

        (card,) = registry.snapshot()
        assert "proposal_id" not in card


# ── The fallback: exactly the card from before the route ───────────────────


class TestEveryFailureIsTheOldCard:
    @pytest.mark.parametrize(
        "failure",
        [
            404,  # an older BFF without the route
            403,
            500,
            urllib.error.URLError("connection refused"),
            TimeoutError("timed out"),
        ],
        ids=["older-bff", "refused", "server-error", "unreachable", "timeout"],
    )
    async def test_a_refused_or_unreachable_route_emits_the_card_without_an_id(self, registry, transport, failure):
        transport(failure)
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert "proposal_id" not in card
        assert card["operations"][0]["document"] == "Brandschutzkonzept.pdf"
        assert "NOCH NICHTS geändert" in result

    async def test_the_fallback_card_extends_as_it_always_did(self, registry, transport):
        transport(404, 404)
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert "proposal_id" not in card
        assert [item["document"] for item in card["operations"]] == ["Brandschutzkonzept.pdf", "Grundriss OG.pdf"]

    async def test_a_run_without_an_envelope_asks_nobody(self, monkeypatch, registry, transport):
        """No acting person: nothing is sent, not even unsigned."""
        monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (None, None))
        fake = transport()
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert "proposal_id" not in card

    async def test_a_missing_service_token_is_the_old_card(self, monkeypatch, registry, transport):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
        fake = transport()
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert "proposal_id" not in card

    async def test_no_card_channel_stores_no_proposal(self, transport):
        """A proposal nobody is shown is a row nobody decides."""
        fake = transport()
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        assert "konnte also nicht" in result
