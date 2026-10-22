"""The proposal as a server object: what goes over the wire, as whom, and what happens when it cannot.

Only the transport is faked (``client._opener.open``), so the request the test
reads is the one ``post_proposal`` really builds, headers included. The tool,
the card and the client above the socket are the real ones. The client is
shared by the three kinds (``file_operation``, ``memory``, ``project_profile``);
the file tool is the one that drives it here, the other two callers have their
own suites (``tests/aiq_agent/memory/test_register.py``,
``tests/aiq_agent/cards/test_register_envelope_card.py``) and share the wire
tests below.

Five properties:

* **The body is the contract's.** It validates against
  ``frontends/ui/tests/fixtures/proposals.schema.json``, the JSON Schema the
  BFF exports from ``lib/proposals/types.ts``, for every kind. No Pydantic twin.
* **The card's index is its real position.** ``originCardIndex`` is where the
  card sits in the turn's registry, even when a sibling tool adds a card while
  the request is out.
* **The envelope is echoed.** The two strings the turn arrived with go out
  unchanged; nothing here signs.
* **The card carries the id**, and every call opens its own card with its own
  proposal, because a stored proposal cannot grow.
* **Every failure is a notice and a failure.** No envelope, a 404 from an older
  BFF, a network error: the card stays in the registry without ``proposal_id``
  (the UI draws it read-only; its position is identity, so it is never taken
  out), the browser executes nothing, and the tool tells the model it could not
  propose.
"""

from __future__ import annotations

import asyncio
import io
import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from typing import get_args
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
from aiq_agent.tools import proposals_client as client
from aiq_agent.tools.files.cards import propose_file_operation
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


def _branch(schema: dict[str, Any], kind: str) -> dict[str, Any]:
    """The request definition's ``oneOf`` branch for ``kind``."""
    branches = schema["$defs"][REQUEST_DEF]["oneOf"]
    return next(branch for branch in branches if branch["properties"]["kind"]["const"] == kind)


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
            (
                "move",
                {
                    "document": "Brandschutzkonzept.pdf",
                    "target_folder": "Einreichung",
                    "reason": "Belongs with the Bescheid of 12 March",
                },
            ),
            (
                "rename",
                {
                    "document": "Grundriss OG.pdf",
                    "new_name": "Grundriss Obergeschoss",
                    "reason": "Matches the plan set",
                },
            ),
            ("create_folder", {"new_name": "Fotos", "target_folder": "", "reason": "Site photos have no home yet"}),
            ("assign", {"document": "Grundriss OG.pdf", "member": "Anna Berger", "reason": "Anna asked to own it"}),
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
        payload = _branch(proposals_schema, "file_operation")["properties"]["payload"]
        assert payload["properties"]["operations"]["maxItems"] == MAX_FILE_OPERATIONS

    def test_the_contract_has_exactly_the_three_kinds_this_client_can_ask_for(self, proposals_schema):
        kinds = {branch["properties"]["kind"]["const"] for branch in proposals_schema["$defs"][REQUEST_DEF]["oneOf"]}
        assert kinds == set(get_args(client.ProposalKind))

    @pytest.mark.parametrize("index", [None, 0, 3])
    @pytest.mark.parametrize(
        ("kind", "payload"),
        [
            (
                "file_operation",
                {"operation": "create_folder", "operations": [{"folder_name": "Fotos", "parent_folder": ""}]},
            ),
            (
                "memory",
                {
                    "scope": "organization",
                    "kind": "preference",
                    "content": "Wir planen in Achsmaßen.",
                    "confidence": "high",
                },
            ),
            (
                "memory",
                {
                    "scope": "organization",
                    "kind": "decision",
                    "content": "Brandschutzkonzept liegt beim Büro Berger.",
                    "confidence": "medium",
                    "supersedes": "Brandschutzkonzept liegt beim Büro Huber.",
                },
            ),
            (
                "project_profile",
                {
                    "title": "Projektkontext aktualisieren: Gebäudeklasse",
                    "rationale": "Laut Einreichplan ist das Gebäude GK4.",
                    "patch": [{"op": "add", "path": "/facts/gebaeudeklasse", "value": "GK4"}],
                },
            ),
            (
                "project_profile",
                {"title": "Annahme entfernen", "patch": [{"op": "remove", "path": "/assumptions/bauweise"}]},
            ),
        ],
    )
    def test_every_kind_builds_a_body_the_contract_accepts(self, proposals_schema, kind, payload, index):
        body = client.proposal_request(kind, payload, card_index=index)

        errors = sorted(_validator(proposals_schema, REQUEST_DEF).iter_errors(body), key=str)
        assert not errors, [error.message for error in errors]
        assert body["kind"] == kind and body["payload"] == payload
        assert body.get("originCardIndex") == index

    def test_the_contract_is_closed_so_a_stray_field_is_caught_here(self, proposals_schema):
        """A guard on the guard: if the schema went loose, the tests above would pass for any body."""
        body = client.proposal_request(
            "memory", {"scope": "organization", "kind": "decision", "content": "x", "confidence": "low"}
        )
        body["payload"]["proposal_id"] = FIRST
        assert list(_validator(proposals_schema, REQUEST_DEF).iter_errors(body))


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
                            "source": "project",
                            "current": "Nachweise",
                            "target_folder": "Einreichung",
                        }
                    ],
                },
                "answerMessageId": answer_message_id(CONVERSATION, USER_MESSAGE),
                "originCardIndex": 0,
            }
        ]

    async def test_the_reason_travels_on_the_item_and_the_card(self, registry, transport):
        fake = transport(_created(FIRST))
        await _propose(
            "move",
            document="Brandschutzkonzept.pdf",
            target_folder="Einreichung",
            reason="  Belongs with the Bescheid\nof 12 March ",
        )

        (body,) = fake.bodies()
        assert body["payload"]["operations"][0]["reason"] == "Belongs with the Bescheid of 12 March"
        assert registry.snapshot()[0]["operations"][0]["reason"] == "Belongs with the Bescheid of 12 March"

    async def test_a_long_reason_is_cut_and_an_empty_one_is_left_off(self, registry, transport):
        fake = transport(_created(FIRST), _created(SECOND))
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung", reason="x" * 500)
        await _propose("rename", document="Grundriss OG.pdf", new_name="Neu", reason="  ")

        long_item, empty_item = (body["payload"]["operations"][0] for body in fake.bodies())
        assert len(long_item["reason"]) == 200
        assert "reason" not in empty_item

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
        assert "originCardIndex" not in body  # an index means nothing without the answer it counts in
        assert uuid.UUID(answer_message_id(CONVERSATION, USER_MESSAGE))  # the id it would send is a UUID


# ── The card's index ───────────────────────────────────────────────────────


class TestTheIndexIsTheCardsRealPosition:
    async def test_it_counts_the_cards_the_tools_already_pushed(self, registry, transport):
        registry.add({"type": "document_draft"})
        fake = transport(_created(FIRST))
        await _propose("create_folder", new_name="Fotos")

        assert [body["originCardIndex"] for body in fake.bodies()] == [1]
        assert registry.snapshot()[1]["proposal_id"] == FIRST

    async def test_a_sibling_card_added_while_the_request_is_out_does_not_move_it(
        self, monkeypatch, registry, transport
    ):
        """The index is read when the card is placed, not when the answer comes back."""
        fake = transport(_created(FIRST))
        inner = fake.__call__

        def sibling_lands_first(request, timeout):
            registry.add({"type": "document_draft"})
            return inner(request, timeout)

        monkeypatch.setattr(client._opener, "open", sibling_lands_first)
        await _propose("create_folder", new_name="Fotos")

        assert [body["originCardIndex"] for body in fake.bodies()] == [0]
        proposal, sibling = registry.snapshot()
        assert proposal["type"] == "file_operation_proposal" and proposal["proposal_id"] == FIRST
        assert sibling["type"] == "document_draft"

    async def test_parallel_calls_are_two_cards_with_two_indexes(self, registry, transport):
        fake = transport(_created(FIRST), _created(SECOND))
        await asyncio.gather(
            _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung"),
            _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung"),
        )

        assert sorted(body["originCardIndex"] for body in fake.bodies()) == [0, 1]
        assert sorted(card["proposal_id"] for card in registry.snapshot()) == [FIRST, SECOND]
        for index, card in enumerate(registry.snapshot()):
            sent = next(body for body in fake.bodies() if body["originCardIndex"] == index)
            assert sent["payload"]["operations"][0]["document"] == card["operations"][0]["document"]

    async def test_refused_parallel_calls_are_two_notices_asked_one_after_the_other(self, registry, transport):
        """Nothing is merged into a sibling's card: each call asked, each left its own card, each reports failure."""
        fake = transport(404, 404)
        results = await asyncio.gather(
            _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung"),
            _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung"),
        )

        assert all("could not be created" in result for result in results)
        assert len(fake.requests) == 2
        assert sorted(body["originCardIndex"] for body in fake.bodies()) == [0, 1]
        cards = registry.snapshot()
        assert all("proposal_id" not in card for card in cards)
        assert sorted(card["operations"][0]["document"] for card in cards) == [
            "Brandschutzkonzept.pdf",
            "Grundriss OG.pdf",
        ]
        assert all(len(card["operations"]) == 1 for card in cards)


# ── The card ────────────────────────────────────────────────────────────────


class TestTheCardCarriesTheProposal:
    async def test_the_card_carries_the_id_and_the_result_still_claims_nothing(self, registry, transport):
        transport(_created(FIRST))
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert card["proposal_id"] == FIRST
        assert card["operation"] == "move" and len(card["operations"]) == 1
        grid_card_adapter.validate_python(card)
        assert "NOTHING has been changed YET" in result
        assert "do not say it is done" in result

    async def test_a_second_call_is_a_second_proposal_never_a_grown_one(self, registry, transport):
        """A stored proposal cannot grow; a card that grew on the client would show two moves and apply one."""
        fake = transport(_created(FIRST), _created(SECOND))
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung")

        assert [len(body["payload"]["operations"]) for body in fake.bodies()] == [1, 1]
        assert [body["originCardIndex"] for body in fake.bodies()] == [0, 1]
        assert [body["payload"]["operations"][0]["document"] for body in fake.bodies()] == [
            "Brandschutzkonzept.pdf",
            "Grundriss OG.pdf",
        ]
        assert [(card["proposal_id"], len(card["operations"])) for card in registry.snapshot()] == [
            (FIRST, 1),
            (SECOND, 1),
        ]

    async def test_a_refusal_after_a_stored_proposal_leaves_its_own_notice(self, registry, transport):
        """The stored card keeps its one row and its id; the refused call's row is not added to it."""
        transport(_created(FIRST), 503)
        await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")
        await _propose("move", document="Grundriss OG.pdf", target_folder="Einreichung")

        first, second = registry.snapshot()
        assert first["proposal_id"] == FIRST and len(first["operations"]) == 1
        assert "proposal_id" not in second and len(second["operations"]) == 1


# ── No server proposal: a read-only notice, and a failure the model hears ──


class TestEveryFailureIsANoticeAndAFailure:
    @pytest.mark.parametrize(
        "failure",
        [
            404,  # an older BFF without the route
            403,
            500,
            urllib.error.URLError("connection refused"),
            TimeoutError("timed out"),
            {"id": "not-a-uuid", "status": "proposed"},
        ],
        ids=["older-bff", "refused", "server-error", "unreachable", "timeout", "no-usable-id"],
    )
    async def test_a_refused_or_unreachable_route_reports_failure_and_leaves_the_card_without_an_id(
        self, registry, transport, failure
    ):
        transport(failure)
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        (card,) = registry.snapshot()
        assert "proposal_id" not in card
        assert card["operations"][0]["document"] == "Brandschutzkonzept.pdf"
        assert result.startswith("Error:")
        assert "could not be created" in result
        assert "Nothing was changed" in result
        assert "Proposed" not in result and "shown as a card" not in result

    @pytest.mark.parametrize(
        ("operation", "params"),
        [
            ("move", {"document": "Brandschutzkonzept.pdf", "target_folder": "Einreichung"}),
            ("rename", {"document": "Grundriss OG.pdf", "new_name": "Grundriss Obergeschoss"}),
            ("create_folder", {"new_name": "Fotos", "target_folder": ""}),
            ("assign", {"document": "Grundriss OG.pdf", "member": "Anna Berger"}),
        ],
    )
    async def test_all_four_operations_hand_the_failure_to_the_model(self, registry, transport, operation, params):
        transport(500)
        result = await _propose(operation, **params)

        assert "could not be created" in result
        assert "NOTHING has been changed YET" not in result
        (card,) = registry.snapshot()
        assert card["operation"] == operation and "proposal_id" not in card

    async def test_the_function_returns_false_and_keeps_the_card_in_the_registry(self, registry, transport):
        """Position is identity (`cardKey`, `originCardIndex`): the notice stays where it is."""
        registry.add({"type": "document_draft"})
        transport(503, _created(SECOND))
        item = {"folder_name": "Fotos", "parent_folder": "", "current": "Fotos"}

        refused = await propose_file_operation(operation="create_folder", title="Neuen Ordner anlegen", item=item)
        stored = await propose_file_operation(operation="create_folder", title="Neuen Ordner anlegen", item=item)

        assert refused is False and stored is True
        draft, notice, proposal = registry.snapshot()
        assert draft["type"] == "document_draft"
        assert notice["type"] == "file_operation_proposal" and "proposal_id" not in notice
        assert proposal["proposal_id"] == SECOND

    async def test_a_run_without_an_envelope_asks_nobody(self, monkeypatch, registry, transport):
        """No acting person: nothing is sent, not even unsigned."""
        monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (None, None))
        fake = transport()
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert "proposal_id" not in card
        assert "could not be created" in result

    async def test_a_missing_service_token_is_a_failure(self, monkeypatch, registry, transport):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
        fake = transport()
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        (card,) = registry.snapshot()
        assert "proposal_id" not in card
        assert "could not be created" in result

    async def test_no_card_channel_stores_no_proposal(self, transport):
        """A proposal nobody is shown is a row nobody decides."""
        fake = transport()
        result = await _propose("move", document="Brandschutzkonzept.pdf", target_folder="Einreichung")

        assert fake.requests == []
        assert "could not be created" in result
