"""``workspace__call``: a write the server proposed becomes an ``operation_proposal`` card; nothing else does.

The server's answer is the only input (``structuredContent`` ``{decision: 'propose', proposalId,
summary, operation}``, ``lib/agent-api/discovery.ts``). The proposal already exists, so no request
goes to the proposals route: the card carries the server's id and the person decides it there.
Only the socket and the card channel's binding are replaced.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.workspace import cards
from aiq_agent.tools.workspace import client
from aiq_agent.tools.workspace import register as workspace

from .test_workspace_client import SECRET
from .test_workspace_client import _Response
from .test_workspace_client import bind
from .test_workspace_client import turn_of

PROPOSAL_ID = str(uuid.uuid4())
PROPOSED_TEXT = "Proposed — the person decides. Nothing was changed."
CALL_INPUT = {"params": {"id": "p1", "folderId": "f1"}, "body": {"name": "Pläne"}}


def structured_answer(structured: dict[str, Any] | None, text: str = PROPOSED_TEXT, *, is_error: bool = False) -> str:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if structured is not None:
        result["structuredContent"] = structured
    return json.dumps({"jsonrpc": "2.0", "id": 1, "result": result})


def proposed(proposal_id: str = PROPOSAL_ID, operation: str = "folder-rename") -> dict[str, Any]:
    return {
        "decision": "propose",
        "proposalId": proposal_id,
        "summary": f"Rename ({operation})",
        "operation": operation,
    }


class Server:
    """Answers each socket call with the next body of ``answers``; every request is recorded."""

    def __init__(self) -> None:
        self.answers: list[str] = []
        self.requests: list[Any] = []

    def append(self, answer: str) -> None:
        self.answers.append(answer)

    def extend(self, answers: list[str]) -> None:
        self.answers.extend(answers)

    def open(self, request: Any, timeout: float) -> _Response:  # noqa: ARG002
        self.requests.append(request)
        return _Response(self.answers.pop(0))


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Server:
    fake = Server()
    monkeypatch.setattr(client._opener, "open", fake.open)
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test/")
    bind(monkeypatch, turn_of("anna"))
    return fake


@pytest.fixture
def registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


async def test_a_proposed_write_puts_the_card_in_the_chat_with_the_servers_proposal_id(server, registry) -> None:
    server.append(structured_answer(proposed()))

    text = await workspace.run_call("folder-rename", CALL_INPUT)

    assert text == f"{PROPOSED_TEXT} Proposal {PROPOSAL_ID}: Rename (folder-rename)."
    (card,) = registry.snapshot()
    assert card == {
        "type": "operation_proposal",
        "title": "Rename (folder-rename)",
        "operation": "folder-rename",
        "input": CALL_INPUT,
        "proposal_id": PROPOSAL_ID,
    }
    # It is a card of the real vocabulary, not a look-alike.
    assert grid_card_adapter.validate_python(card).model_dump(exclude_none=True) == card


async def test_the_card_is_shown_without_asking_the_proposals_route_for_anything(server, registry) -> None:
    server.append(structured_answer(proposed()))

    await workspace.run_call("folder-rename", CALL_INPUT)

    paths = {request.full_url for request in server.requests}
    assert paths == {"http://bff.test/api/mcp"}


async def test_the_same_call_repeated_shows_one_card(server, registry) -> None:
    """The server answers a repeat with the proposal it already has; a second card would be a second control."""
    server.extend([structured_answer(proposed()), structured_answer(proposed())])

    await workspace.run_call("folder-rename", CALL_INPUT)
    await workspace.run_call("folder-rename", CALL_INPUT)

    assert len(registry.snapshot()) == 1


async def test_two_different_proposals_are_two_cards(server, registry) -> None:
    other = str(uuid.uuid4())
    server.extend([structured_answer(proposed()), structured_answer(proposed(other, "folder-delete"))])

    await workspace.run_call("folder-rename", CALL_INPUT)
    await workspace.run_call("folder-delete", {"params": {"id": "p1"}})

    assert [card["proposal_id"] for card in registry.snapshot()] == [PROPOSAL_ID, other]


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param(structured_answer({"projects": [{"id": "p1"}]}, "{...}"), id="a read"),
        pytest.param(structured_answer(None, "plain text"), id="no structured content"),
        pytest.param(structured_answer({"decision": "run"}, "ran"), id="another decision"),
        pytest.param(structured_answer(proposed("prop_1"), PROPOSED_TEXT), id="an id that is not a uuid"),
        pytest.param(
            structured_answer({"decision": "propose", "proposalId": PROPOSAL_ID}), id="no operation or summary"
        ),
        pytest.param(structured_answer(proposed(), "Not allowed", is_error=True), id="a refusal"),
    ],
)
async def test_anything_but_a_proposal_emits_no_card(server, registry, answer) -> None:
    server.append(answer)

    await workspace.run_call("project-list", {})

    assert registry.snapshot() == []


async def test_only_call_emits_cards(server, registry) -> None:
    """A search or a describe may echo a proposal-shaped result; they are not writes."""
    server.append(structured_answer(proposed()))

    await workspace.run_describe("folder-rename")

    assert registry.snapshot() == []


async def test_a_rate_limited_door_tells_the_model_to_call_again_next_round(server, registry, monkeypatch) -> None:
    def refuse(request: Any, timeout: float) -> _Response:  # noqa: ARG001
        raise client.urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(client._opener, "open", refuse)

    assert await workspace.run_search("list projects") == workspace.RATE_LIMITED
    assert "next round" in workspace.RATE_LIMITED


async def test_a_rate_limited_operation_tells_the_model_to_call_again_next_round(server, registry) -> None:
    server.append(structured_answer(None, "Too many requests. (HTTP 429, rate_limited)", is_error=True))

    assert await workspace.run_call("folder-rename", CALL_INPUT) == workspace.RATE_LIMITED
    assert registry.snapshot() == []


async def test_a_read_returns_the_servers_text_unchanged(server, registry) -> None:
    server.append(structured_answer({"projects": []}, '{"projects": []}'))

    assert await workspace.run_call("project-list", {}) == '{"projects": []}'


async def test_without_a_card_channel_the_proposal_still_stands_and_the_model_is_told(server) -> None:
    server.append(structured_answer(proposed()))

    text = await workspace.run_call("folder-rename", CALL_INPUT)

    assert text.startswith(PROPOSED_TEXT)
    assert "could not be shown" in text
    assert "inbox" in text


def test_proposal_from_reads_only_the_documented_shape() -> None:
    assert cards.proposal_from(proposed()) == cards.OperationProposal(
        proposal_id=PROPOSAL_ID, operation="folder-rename", summary="Rename (folder-rename)"
    )
    assert cards.proposal_from(None) is None
    assert cards.proposal_from("propose") is None
    assert cards.proposal_from({**proposed(), "summary": "  "}) is None


async def test_a_read_lands_in_the_herleitung_ledger_and_a_proposal_or_refusal_does_not(server, registry) -> None:
    from aiq_agent.common.turn_status import begin_lane_capture
    from aiq_agent.common.turn_status import end_lane_capture
    from aiq_agent.common.turn_status import get_lane_captures

    server.extend(
        [
            structured_answer({"projects": [{"id": "p1"}]}, '{"projects": [{"id": "p1"}]}'),
            structured_answer(proposed()),
            structured_answer(None, "Not allowed (HTTP 403, FORBIDDEN)", is_error=True),
        ]
    )
    token = begin_lane_capture()
    try:
        await workspace.run_call("project-list", {})
        await workspace.run_call("folder-rename", CALL_INPUT)
        await workspace.run_call("project-delete", {"params": {"id": "p1"}})
        hits = get_lane_captures()
    finally:
        end_lane_capture(token)

    assert [(hit["name"], hit.get("shelf")) for hit in hits] == [("project-list", workspace.WORKSPACE_SHELF)]
