"""Where an upload belongs (`/v1/filing-fit`): metadata in, checked moves out, silence by default."""

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from agent_host.routes.filing_fit import MAX_SCORED_FOLDERS
from agent_host.routes.filing_fit import SORT_INSTRUCTIONS
from agent_host.routes.filing_fit import SYSTEM_PROMPT
from agent_host.routes.filing_fit import FilingFitRequest
from agent_host.routes.filing_fit import FilingMove
from agent_host.routes.filing_fit import add_filing_fit_routes
from agent_host.routes.filing_fit import build_user_content
from agent_host.routes.filing_fit import parse_moves
from agent_host.routes.filing_fit import score_moves

BODY = {
    "basis": "content",
    "locale": "de",
    "folders": [
        {"path": "Bescheide", "description": "Bescheide und Stellungnahmen der Behörden", "doc_types": ["Bescheid"]},
        {"path": "Pläne/Einreichung", "description": "Einreichunterlagen"},
    ],
    "conventions": [{"path": "Korrespondenz", "description": "Briefe und Mails mit Behörden", "projects": 4}],
    "documents": [
        {"id": "d1", "file": "MA37_Bescheid_2026.pdf", "folder": "", "type": "Bescheid", "summary": "Baubewilligung"},
        {"id": "d2", "file": "Schreiben Fristerstreckung.pdf", "folder": "Bescheide"},
        {"id": "d3", "file": "EG.pdf", "folder": "Pläne/Einreichung", "type": "Grundriss"},
    ],
    "trace": {"batch_id": "b1", "project_id": "p1", "shelf": "project"},
}


def _request(**changes) -> FilingFitRequest:
    return FilingFitRequest.model_validate({**BODY, **changes})


def test_keeps_a_move_into_a_known_folder_in_its_own_spelling():
    moves = parse_moves(
        {"moves": [{"id": "d1", "folder": "bescheide", "reason": "Ein Bescheid der MA 37."}]}, _request()
    )
    assert moves is not None
    assert [(move.id, move.folder, move.new) for move in moves] == [("d1", "Bescheide", False)]


def test_drops_an_unknown_document_and_an_unknown_folder():
    answer = {
        "moves": [
            {"id": "invented", "folder": "Bescheide", "reason": "x"},
            {"id": "d1", "folder": "Erfunden", "reason": "x"},
        ]
    }
    assert parse_moves(answer, _request()) == []


def test_drops_a_move_into_the_folder_it_is_in_and_a_second_move_for_one_document():
    answer = {
        "moves": [
            {"id": "d3", "folder": "Pläne/Einreichung", "reason": "liegt schon richtig"},
            {"id": "d2", "folder": "Korrespondenz", "reason": "Ein Brief, kein Bescheid."},
            {"id": "d2", "folder": "Bescheide", "reason": "doch"},
        ]
    }
    moves = parse_moves(answer, _request())
    assert moves is not None
    assert [(move.id, move.folder) for move in moves] == [("d2", "Korrespondenz")]


def test_a_convention_is_a_new_folder_with_the_convention_description():
    moves = parse_moves({"moves": [{"id": "d2", "folder": "Korrespondenz", "reason": "Ein Brief."}]}, _request())
    assert moves is not None
    assert moves[0].new is True
    assert moves[0].description == "Briefe und Mails mit Behörden"


def test_an_empty_reason_is_no_move_and_a_missing_list_is_no_answer():
    assert parse_moves({"moves": [{"id": "d1", "folder": "Bescheide", "reason": "  "}]}, _request()) == []
    assert parse_moves({"candidates": []}, _request()) is None


def test_the_model_reads_names_descriptions_and_types_but_no_content_field():
    content = build_user_content(_request())
    assert "Bescheide und Stellungnahmen der Behörden" in content
    assert '"type": "Bescheid"' in content
    assert '"folder": ""' in content
    assert "Write each reason in German." in content


def test_the_request_refuses_a_field_it_does_not_know():
    with pytest.raises(ValueError):
        FilingFitRequest.model_validate({**BODY, "documents": [{"id": "d1", "file": "a.pdf", "text": "Inhalt"}]})


@pytest.fixture
def app():
    app = FastAPI()
    router = APIRouter()
    add_filing_fit_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")


def _client_returning(content: str | None = None, error: Exception | None = None):
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.raise_for_status = MagicMock()
    response.json.return_value = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=error) if error else AsyncMock(return_value=response)
    return MagicMock(return_value=client), client.post


async def _judge(app, fake, body=None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", fake):
            return await client.post("/v1/filing-fit", json=body or BODY)


@pytest.mark.asyncio
async def test_one_call_for_the_batch_answers_checked_moves(app):
    answer = json.dumps(
        {
            "moves": [
                {"id": "d1", "folder": "Bescheide", "reason": "Ein Bescheid."},
                {"id": "ghost", "folder": "Bescheide", "reason": "x"},
            ]
        }
    )
    fake, post = _client_returning(answer)
    response = await _judge(app, fake)
    assert response.status_code == 200
    body = response.json()
    assert [move["id"] for move in body["moves"]] == ["d1"]
    assert body["error"] is None
    assert post.await_count == 1


@pytest.mark.asyncio
async def test_an_unreadable_answer_proposes_nothing(app):
    fake, _post = _client_returning("Ich bin mir nicht sicher.")
    body = (await _judge(app, fake)).json()
    assert body["moves"] == []
    assert body["error"] == "llm_response_malformed"


@pytest.mark.asyncio
async def test_an_upstream_failure_proposes_nothing(app):
    fake, _post = _client_returning(error=httpx.ConnectError("down"))
    body = (await _judge(app, fake)).json()
    assert body == {"moves": [], "model": None, "error": "llm_request_failed", "trace_id": None}


@pytest.mark.asyncio
async def test_nothing_to_file_into_makes_no_call(app):
    fake, post = _client_returning(json.dumps({"moves": []}))
    body = (await _judge(app, fake, {**BODY, "folders": [], "conventions": []})).json()
    assert body["moves"] == []
    assert post.await_count == 0


SORT_ANSWER = json.dumps(
    {
        "moves": [
            {"id": "d1", "folder": "Korrespondenz", "reason": "Ein Brief an die Behörde."},
            {"id": "d3", "folder": "Bescheide", "reason": "Ein Bescheid der MA 37."},
        ]
    }
)


class _Answer:
    """What ``decide_many`` hands back per state: ``choice("folder")`` gives the distribution."""

    def __init__(self, distribution: dict[str, float]):
        self._distribution = distribution

    def choice(self, key: str):
        return "f0", self._distribution


@pytest.fixture
def decided(monkeypatch):
    """A decide_many that answers every state with one distribution and records what it was asked."""
    calls: list[dict] = []
    distribution = {"f0": 0.9, "f2": 0.4, "none": 0.1}

    async def fake_decide_many(states, questions, **kwargs):
        calls.append({"states": list(states), "questions": questions, **kwargs})
        return [_Answer(distribution) for _ in states]

    monkeypatch.setattr("agent.common.decisions.decide_many", fake_decide_many)
    return calls


@pytest.mark.asyncio
async def test_sort_asks_with_the_sort_instructions_and_a_larger_budget(app, decided):
    fake, post = _client_returning(SORT_ANSWER)
    body = (await _judge(app, fake, {**BODY, "purpose": "sort"})).json()
    assert [move["id"] for move in body["moves"]] == ["d1", "d3"]
    payload = post.call_args.kwargs["json"]
    assert payload["max_tokens"] == 4000
    assert payload["messages"][0]["content"] == SYSTEM_PROMPT + "\n" + SORT_INSTRUCTIONS


@pytest.mark.asyncio
async def test_sort_attaches_the_probability_of_each_moves_folder(app, decided):
    fake, _post = _client_returning(SORT_ANSWER)
    body = (await _judge(app, fake, {**BODY, "purpose": "sort"})).json()
    assert {move["id"]: move["confidence"] for move in body["moves"]} == {"d1": 0.4, "d3": 0.9}
    (call,) = decided
    assert len(call["states"]) == 2
    assert all("folder" not in state for state in call["states"])
    assert call["questions"]["folder"]["criteria"] == {
        "f0": "Bescheide: Bescheide und Stellungnahmen der Behörden",
        "f1": "Pläne/Einreichung: Einreichunterlagen",
        "f2": "Korrespondenz: Briefe und Mails mit Behörden",
        "none": "No folder of this shelf fits the document.",
    }


@pytest.mark.asyncio
async def test_a_failed_score_keeps_every_move_unscored(app, monkeypatch):
    async def broken(states, *_args, **_kwargs):
        # How `decide_many` fails: one None per call it could not make, never a raise.
        return [None] * len(states)

    monkeypatch.setattr("agent.common.decisions.decide_many", broken)
    fake, _post = _client_returning(SORT_ANSWER)
    response = await _judge(app, fake, {**BODY, "purpose": "sort"})
    assert response.status_code == 200
    assert [(move["id"], move["confidence"]) for move in response.json()["moves"]] == [("d1", None), ("d3", None)]


@pytest.mark.asyncio
async def test_an_upload_is_never_scored_and_keeps_the_upload_budget(app, monkeypatch):
    spy = AsyncMock(return_value=[])
    monkeypatch.setattr("agent.common.decisions.decide_many", spy)
    fake, post = _client_returning(SORT_ANSWER)
    body = (await _judge(app, fake, BODY)).json()
    assert [move["confidence"] for move in body["moves"]] == [None, None]
    spy.assert_not_awaited()
    payload = post.call_args.kwargs["json"]
    assert payload["max_tokens"] == 2000
    assert payload["messages"][0]["content"] == SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_too_many_folders_to_offer_are_not_scored(monkeypatch):
    spy = AsyncMock(return_value=[])
    monkeypatch.setattr("agent.common.decisions.decide_many", spy)
    request = _request(folders=[{"path": f"Ordner {index}"} for index in range(MAX_SCORED_FOLDERS + 1)])
    scores = await score_moves(request, [FilingMove(id="d1", folder="Ordner 0", reason="x")], None)
    assert scores == [None]
    spy.assert_not_awaited()
