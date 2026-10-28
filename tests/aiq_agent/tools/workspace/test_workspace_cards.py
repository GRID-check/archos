"""``workspace__call``: a write the server proposed becomes an ``operation_proposal`` card; nothing else does.

The server's answer is the only input (``structuredContent`` ``{decision: 'propose', proposalId,
summary, operation}``, ``lib/agent-api/discovery.ts``). The proposal already exists, so no request
goes to the proposals route: the card carries the server's id and the person decides it there.
Only the socket and the card channel's binding are replaced.
"""

from __future__ import annotations

import json
import urllib.error
import uuid
from typing import Any

import pytest

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common import bff_http
from aiq_agent.tools.workspace import cards
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
    monkeypatch.setattr(bff_http._opener, "open", fake.open)
    monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)
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
        raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(bff_http._opener, "open", refuse)

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


async def test_a_read_lands_in_the_retrieval_ledger_and_a_proposal_or_refusal_does_not(server, registry) -> None:
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


# ---------------------------------------------------------------------------
# document-revision-compare -> revision_compare card (ADR-0128, slice V10)
# ---------------------------------------------------------------------------

NEWER_ID = str(uuid.uuid4())
OLDER_ID = str(uuid.uuid4())
COMPARE_INPUT = {"params": {"id": NEWER_ID}, "body": {"older": OLDER_ID, "page": 2}}
COMPARED = {
    "regions": [
        {"page": 2, "x": 0.6, "y": 0.1, "w": 0.2, "h": 0.1, "label": "Laufbreite 1,10 m statt 1,00 m"},
        {"page": 2, "x": 0.9, "y": 0.9, "w": 0.3, "h": 0.3, "label": "Plankopf"},
        {"page": 3, "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1, "label": "another page"},
        {"page": 2, "x": 0.1, "y": 0.1, "w": 0, "h": 0.1, "label": "no area"},
    ],
    "summary": ["Treppe breiter", "Plankopf geändert"],
}


async def test_a_comparison_puts_both_pages_and_the_boxes_in_the_chat(server, registry) -> None:
    server.append(structured_answer(COMPARED, "{}"))

    text = await workspace.run_call("document-revision-compare", COMPARE_INPUT)

    (card,) = registry.snapshot()
    assert card["type"] == "revision_compare"
    assert (card["older_id"], card["newer_id"], card["page"]) == (OLDER_ID, NEWER_ID, 2)
    assert card["summary"] == ["Treppe breiter", "Plankopf geändert"]
    # Only boxes on the compared page that have an area; one reaching past the edge is clamped onto it.
    assert card["changes"] == [
        {"region": [0.6, 0.1, 0.2, 0.1], "label": "Laufbreite 1,10 m statt 1,00 m"},
        {"region": [0.9, 0.9, 0.1, 0.1], "label": "Plankopf"},
    ]
    assert text.endswith("[[card:1]].")
    assert grid_card_adapter.validate_python(card).model_dump(exclude_none=True) == card


async def test_a_comparison_that_names_its_documents_puts_the_file_names_on_the_card(server, registry) -> None:
    named = {**COMPARED, "older_name": "Grundriss_A.pdf", "newer_name": " Grundriss_B.pdf "}
    server.append(structured_answer(named, "{}"))

    await workspace.run_call("document-revision-compare", COMPARE_INPUT)

    (card,) = registry.snapshot()
    assert (card["older_name"], card["newer_name"]) == ("Grundriss_A.pdf", "Grundriss_B.pdf")


async def test_a_comparison_without_names_leaves_them_off_the_card(server, registry) -> None:
    server.append(structured_answer({**COMPARED, "older_name": "", "newer_name": 7}, "{}"))

    await workspace.run_call("document-revision-compare", COMPARE_INPUT)

    (card,) = registry.snapshot()
    assert "older_name" not in card
    assert "newer_name" not in card


async def test_a_comparison_with_no_visible_change_still_shows_both_pages(server, registry) -> None:
    server.append(structured_answer({"regions": [], "summary": ["keine sichtbare Änderung"]}, "{}"))

    await workspace.run_call("document-revision-compare", COMPARE_INPUT)

    (card,) = registry.snapshot()
    assert card.get("changes", []) == []
    assert card["summary"] == ["keine sichtbare Änderung"]


async def test_the_same_pair_on_the_same_page_is_one_card_and_the_model_gets_its_number_again(server, registry) -> None:
    server.extend([structured_answer(COMPARED, "{}"), structured_answer(COMPARED, "{}")])

    await workspace.run_call("document-revision-compare", COMPARE_INPUT)
    text = await workspace.run_call("document-revision-compare", COMPARE_INPUT)

    assert len(registry.snapshot()) == 1
    assert text.endswith("[[card:1]].")


async def test_the_page_defaults_to_one_as_the_route_does(server, registry) -> None:
    server.append(
        structured_answer(
            {"regions": [{"page": 1, "x": 0, "y": 0, "w": 1, "h": 1, "label": "x"}], "summary": ["a"]}, "{}"
        )
    )

    await workspace.run_call("document-revision-compare", {"params": {"id": NEWER_ID}, "body": {"older": OLDER_ID}})

    (card,) = registry.snapshot()
    assert card["page"] == 1
    assert len(card["changes"]) == 1


@pytest.mark.parametrize(
    ("structured", "call_input"),
    [
        (None, COMPARE_INPUT),  # a refusal or a truncated answer carries no structured content
        ({"regions": [], "summary": []}, COMPARE_INPUT),
        (COMPARED, {"params": {"id": "not-a-uuid"}, "body": {"older": OLDER_ID, "page": 2}}),
        (COMPARED, {}),
    ],
)
async def test_anything_that_is_not_a_comparison_of_two_documents_emits_no_card(
    server, registry, structured, call_input
) -> None:
    server.append(structured_answer(structured, "{}"))

    text = await workspace.run_call("document-revision-compare", call_input)

    assert registry.snapshot() == []
    assert "[[card:" not in text


async def test_another_operation_with_the_same_result_shape_emits_no_comparison_card(server, registry) -> None:
    server.append(structured_answer(COMPARED, "{}"))

    await workspace.run_call("document-version-diff", COMPARE_INPUT)

    assert registry.snapshot() == []


def test_a_comparison_card_holds_an_address_never_image_bytes() -> None:
    card = {
        "type": "revision_compare",
        "older_id": OLDER_ID,
        "newer_id": NEWER_ID,
        "page": 1,
        "summary": ["data:image/png;base64,AAAA"],
    }
    with pytest.raises(ValueError, match="image bytes"):
        grid_card_adapter.validate_python(card)


def _action_row(emitted) -> tuple[Any, Any]:
    actions = [step for step in emitted.steps if step.kind == "action"]
    assert [step.status for step in actions][0] == "running"
    assert len(actions) == 2
    assert actions[0].id == actions[1].id
    return actions[0], actions[1]


async def test_a_call_leaves_one_workspace_row_naming_the_operation(server, registry, emitted) -> None:
    server.append(structured_answer({"projects": []}, '{"projects": []}'))

    await workspace.run_call("project-list", {})

    started, finished = _action_row(emitted)
    assert (started.verb, started.target) == ("workspace", "project-list")
    assert finished.status == "ok"


async def test_a_proposed_write_is_an_ok_row(server, registry, emitted) -> None:
    server.append(structured_answer(proposed()))

    await workspace.run_call("folder-rename", CALL_INPUT)

    assert _action_row(emitted)[1].status == "ok"


async def test_a_refused_call_is_an_error_row(server, registry, emitted) -> None:
    server.append(structured_answer(None, "Forbidden (HTTP 403)", is_error=True))

    await workspace.run_call("folder-rename", CALL_INPUT)

    assert _action_row(emitted)[1].status == "error"


async def test_a_rate_limited_call_is_an_error_row(server, registry, emitted) -> None:
    server.append(structured_answer(None, "Too many requests. (HTTP 429, rate_limited)", is_error=True))

    await workspace.run_call("folder-rename", CALL_INPUT)

    assert _action_row(emitted)[1].status == "error"


async def test_the_other_workspace_tools_leave_no_row(server, registry, emitted) -> None:
    server.append(structured_answer({"operations": []}, "[]"))

    await workspace.run_search("list projects")

    assert [step for step in emitted.steps if step.kind == "action"] == []
