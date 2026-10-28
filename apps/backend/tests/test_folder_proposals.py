"""New folders for the shelf root's documents (`/v1/folder-proposals`): map, reduce, verify, and checked answers."""

import asyncio
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

from agent.common import provider_limiter
from agent.common.openrouter import limited_async_http_client
from backend.routes import folder_proposals as module
from backend.routes.folder_proposals import MAX_DOCUMENTS
from backend.routes.folder_proposals import REDUCE_PROMPT
from backend.routes.folder_proposals import SYSTEM_PROMPT
from backend.routes.folder_proposals import FolderProposal
from backend.routes.folder_proposals import FolderProposalsRequest
from backend.routes.folder_proposals import add_folder_proposals_routes
from backend.routes.folder_proposals import parse_proposals

BODY = {
    "locale": "de",
    "folders": [{"path": "Bescheide", "description": "Bescheide"}, {"path": "Pläne"}],
    "documents": [
        {"id": "d1", "file": "Lageplan Nord.pdf", "type": "Plan"},
        {"id": "d2", "file": "Lageplan Süd.pdf", "type": "Plan"},
        {"id": "d3", "file": "Notiz.txt"},
        {"id": "d4", "file": "Notiz 2.txt"},
        {"id": "d5", "file": "Einzeln.pdf"},
    ],
    "trace": {"batch_id": "b1", "project_id": "p1", "shelf": "project"},
}


def _request(**changes) -> FolderProposalsRequest:
    return FolderProposalsRequest.model_validate({**BODY, **changes})


def _documents(count: int) -> list[dict]:
    return [{"id": f"d{index}", "file": f"Dokument {index}.pdf"} for index in range(1, count + 1)]


def test_keeps_a_new_folder_at_the_root_and_one_under_an_existing_folder():
    answer = {
        "proposals": [
            {"path": "Lagepläne", "description": "Lagepläne des Grundstücks", "ids": ["d1", "d2"]},
            {"path": "Pläne/Entwürfe", "description": "Entwürfe", "ids": ["d3", "d4"]},
        ]
    }
    proposals = parse_proposals(answer, _request())
    assert proposals is not None
    assert [(p.path, p.ids, p.description) for p in proposals] == [
        ("Lagepläne", ["d1", "d2"], "Lagepläne des Grundstücks"),
        ("Pläne/Entwürfe", ["d3", "d4"], "Entwürfe"),
    ]


def test_an_existing_folder_is_never_proposed_again_whatever_its_spelling():
    answer = {"proposals": [{"path": "bescheide", "ids": ["d1", "d2"]}]}
    assert parse_proposals(answer, _request()) == []


def test_a_parent_that_is_neither_the_root_nor_a_folder_is_dropped():
    answer = {"proposals": [{"path": "Unbekannt/Neu", "ids": ["d1", "d2"]}]}
    assert parse_proposals(answer, _request()) == []


@pytest.mark.parametrize("path", ["Pläne/", "/Neu", "Neu//Unter", "  ", "Neu/" + "x" * 256])
def test_an_empty_segment_or_an_over_long_name_is_dropped(path):
    assert parse_proposals({"proposals": [{"path": path, "ids": ["d1", "d2"]}]}, _request()) == []


def test_a_name_of_exactly_255_characters_is_kept():
    name = "x" * 255
    proposals = parse_proposals({"proposals": [{"path": name, "ids": ["d1", "d2"]}]}, _request())
    assert proposals is not None and [p.path for p in proposals] == [name]


def test_unknown_ids_and_ids_an_earlier_folder_took_do_not_count():
    answer = {
        "proposals": [
            {"path": "A", "ids": ["d1", "d2"]},
            {"path": "B", "ids": ["d2", "d3"]},
            {"path": "C", "ids": ["ghost", "d4", "d5"]},
            {"path": "D", "ids": ["ghost", "d1"]},
        ]
    }
    proposals = parse_proposals(answer, _request())
    assert proposals is not None
    assert [(p.path, p.ids) for p in proposals] == [("A", ["d1", "d2"]), ("C", ["d4", "d5"])]


def test_a_folder_needs_two_known_documents():
    assert parse_proposals({"proposals": [{"path": "Solo", "ids": ["d1"]}]}, _request()) == []


def test_at_most_twelve_folders_and_a_description_cut_to_500():
    request = _request(documents=_documents(30))
    answer = {
        "proposals": [
            {"path": f"Neu {index}", "description": "x" * 600, "ids": [f"d{2 * index + 1}", f"d{2 * index + 2}"]}
            for index in range(14)
        ]
    }
    proposals = parse_proposals(answer, request)
    assert proposals is not None
    assert len(proposals) == 12
    assert len(proposals[0].description or "") == 500


def test_a_path_appears_once():
    answer = {
        "proposals": [
            {"path": "Neu", "ids": ["d1", "d2"]},
            {"path": "neu", "ids": ["d3", "d4"]},
        ]
    }
    proposals = parse_proposals(answer, _request())
    assert proposals is not None and [p.path for p in proposals] == ["Neu"]


def test_a_path_named_twice_in_one_answer_keeps_the_documents_of_both():
    answer = {
        "proposals": [
            {"path": "08 Personal", "description": "", "ids": ["d1", "d2"]},
            {"path": "08 personal", "description": "Persönliches", "ids": ["d3", "d4"]},
        ]
    }
    proposals = parse_proposals(answer, _request())
    assert proposals is not None
    assert [(p.path, p.ids, p.description) for p in proposals] == [
        ("08 Personal", ["d1", "d2", "d3", "d4"], "Persönliches")
    ]


def test_an_answer_without_a_proposal_list_is_no_answer():
    assert parse_proposals({"folders": []}, _request()) is None


def test_the_fallback_keeps_the_twelve_largest_candidates_of_two_or_more_documents():
    request = _request(documents=_documents(31))
    candidates = [
        FolderProposal(path=f"Neu {index}", ids=[f"d{2 * index + 1}", f"d{2 * index + 2}"]) for index in range(13)
    ]
    candidates.append(FolderProposal(path="Gross", ids=["d27", "d28", "d29", "d30"]))
    candidates.append(FolderProposal(path="Solo", ids=["d31"]))
    fallback = module._fallback(request, candidates)
    assert [p.path for p in fallback] == ["Gross"] + [f"Neu {index}" for index in range(11)]


def test_the_request_refuses_a_field_it_does_not_know():
    with pytest.raises(ValueError):
        _request(documents=[{"id": "d1", "file": "a.pdf", "text": "Inhalt"}])


def test_more_documents_than_the_limit_are_refused():
    with pytest.raises(ValueError):
        _request(documents=_documents(MAX_DOCUMENTS + 1))


# ----------------------------------------------------------------- the endpoint


@pytest.fixture
def app():
    app = FastAPI()
    router = APIRouter()
    add_folder_proposals_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")


class _Answer:
    """What ``decide_many`` hands back per state: ``choice("folder")`` gives the distribution."""

    def __init__(self, distribution: dict[str, float]):
        self._distribution = distribution

    def choice(self, key: str):
        return "f0", self._distribution


@pytest.fixture
def decided(monkeypatch):
    """A decide_many that gives every state the same distribution: f0 most likely, then f1."""
    calls: list[dict] = []

    async def fake_decide_many(states, questions, **kwargs):
        calls.append({"states": list(states), "questions": questions, **kwargs})
        return [_Answer({"f0": 0.8, "f1": 0.3, "none": 0.1}) for _ in states]

    monkeypatch.setattr("agent.common.decisions.decide_many", fake_decide_many)
    return calls


def _reply(content: str | None) -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.raise_for_status = MagicMock()
    response.json.return_value = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    return response


def _route(answers: list[tuple[str, str | Exception]], reduce: str | Exception | None = None):
    """Answer each call by the document id it names: the first marker found in the user content wins.

    A marker is a document id as the prompt writes it, so ``"d1"`` never matches ``"d10"``. The reduce
    call is recognised by its system prompt.
    """

    def respond(payload: dict):
        system = payload["messages"][0]["content"]
        user = payload["messages"][1]["content"]
        if system == REDUCE_PROMPT:
            outcome = reduce
        else:
            outcome = next((answer for marker, answer in answers if f'"id": "{marker}"' in user), "")
        if isinstance(outcome, Exception):
            raise outcome
        return _reply(outcome)

    return respond


def _fake_http(respond) -> tuple[MagicMock, AsyncMock]:
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=lambda url, json, headers: respond(json))
    return MagicMock(return_value=client), client.post


async def _propose(app, fake, body=None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", fake):
            return await client.post("/v1/folder-proposals", json=body or BODY)


PROPOSAL = {"proposals": [{"path": "Lagepläne", "description": "Lagepläne", "ids": ["d1", "d2"]}]}


@pytest.mark.asyncio
async def test_one_chunk_answers_checked_proposals_with_confidences_and_skips_the_reduce(app, decided):
    fake, post = _fake_http(_route([("d1", json.dumps(PROPOSAL))]))
    response = await _propose(app, fake)
    assert response.status_code == 200
    body = response.json()
    assert body["error"] is None
    assert [(p["path"], p["ids"], p["confidences"]) for p in body["proposals"]] == [
        ("Lagepläne", ["d1", "d2"], {"d1": 0.8, "d2": 0.8})
    ]
    assert post.await_count == 1
    payload = post.call_args.kwargs["json"]
    assert payload["max_tokens"] == 3000
    assert payload["messages"][0]["content"] == SYSTEM_PROMPT
    assert len(decided) == 1 and len(decided[0]["states"]) == 2
    assert decided[0]["questions"]["folder"]["criteria"] == {
        "f0": "Lagepläne: Lagepläne",
        "none": "None of these new folders fits the document.",
    }


@pytest.mark.asyncio
async def test_the_calls_queue_interactive(app, decided):
    fake, _post = _fake_http(_route([("d1", json.dumps(PROPOSAL))]))
    spy = MagicMock(wraps=limited_async_http_client)
    with patch.object(module, "limited_async_http_client", spy):
        await _propose(app, fake)
    assert spy.call_args.kwargs["cls"] == provider_limiter.INTERACTIVE


@pytest.mark.asyncio
async def test_map_reduce_merges_the_candidates_of_two_chunks_into_one_folder(app, decided):
    documents = _documents(150)
    first = {"proposals": [{"path": "Fotos", "description": "Fotos", "ids": ["d1", "d2"]}]}
    second = {"proposals": [{"path": "Bilder Bestand", "description": "Bilder", "ids": ["d101", "d102"]}]}
    reduce = json.dumps(
        {"folders": [{"path": "Fotos", "description": "Fotos des Bestands", "merge": ["Fotos", "Bilder Bestand"]}]}
    )
    fake, post = _fake_http(_route([("d1", json.dumps(first)), ("d101", json.dumps(second))], reduce=reduce))
    response = await _propose(app, fake, {**BODY, "documents": documents})
    body = response.json()
    assert body["error"] is None
    assert [(p["path"], p["ids"]) for p in body["proposals"]] == [("Fotos", ["d1", "d2", "d101", "d102"])]
    assert post.await_count == 3
    reduce_call = next(
        c.kwargs["json"] for c in post.call_args_list if c.kwargs["json"]["messages"][0]["content"] == REDUCE_PROMPT
    )
    reduce_user = reduce_call["messages"][1]["content"]
    assert "Bilder Bestand" in reduce_user and '"id"' not in reduce_user


@pytest.mark.asyncio
async def test_a_single_chunk_with_candidates_skips_the_reduce(app, decided):
    documents = _documents(150)
    fake, post = _fake_http(_route([("d1", json.dumps(PROPOSAL)), ("d101", json.dumps({"proposals": []}))]))
    body = (await _propose(app, fake, {**BODY, "documents": documents})).json()
    assert [p["path"] for p in body["proposals"]] == ["Lagepläne"]
    assert post.await_count == 2
    assert all(c.kwargs["json"]["messages"][0]["content"] == SYSTEM_PROMPT for c in post.call_args_list)


@pytest.mark.asyncio
async def test_a_failed_chunk_still_yields_the_others(app, decided):
    documents = _documents(150)
    fake, post = _fake_http(_route([("d1", json.dumps(PROPOSAL)), ("d101", httpx.ConnectError("down"))]))
    body = (await _propose(app, fake, {**BODY, "documents": documents})).json()
    assert body["error"] is None
    assert [p["path"] for p in body["proposals"]] == ["Lagepläne"]
    assert post.await_count == 2


@pytest.mark.asyncio
async def test_every_chunk_failing_is_an_error(app, decided):
    documents = _documents(150)
    fake, _post = _fake_http(_route([("d1", httpx.ConnectError("down")), ("d101", "Ich weiß es nicht.")]))
    body = (await _propose(app, fake, {**BODY, "documents": documents})).json()
    assert body["proposals"] == []
    assert body["error"] == "llm_request_failed"


@pytest.mark.asyncio
async def test_the_same_path_from_two_chunks_keeps_the_documents_of_both(app, decided):
    documents = _documents(150)
    first = {"proposals": [{"path": "08 Personal", "description": "Personal", "ids": ["d1", "d2"]}]}
    second = {"proposals": [{"path": "08 Personal", "ids": ["d101", "d102"]}]}
    reduce = json.dumps({"folders": [{"path": "08 Personal", "description": "Personal", "merge": ["08 Personal"]}]})
    fake, post = _fake_http(_route([("d1", json.dumps(first)), ("d101", json.dumps(second))], reduce=reduce))
    body = (await _propose(app, fake, {**BODY, "documents": documents})).json()
    assert body["error"] is None
    assert [(p["path"], p["ids"]) for p in body["proposals"]] == [("08 Personal", ["d1", "d2", "d101", "d102"])]
    reduce_user = next(
        c.kwargs["json"]["messages"][1]["content"]
        for c in post.call_args_list
        if c.kwargs["json"]["messages"][0]["content"] == REDUCE_PROMPT
    )
    assert reduce_user.count('"path": "08 Personal"') == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("reduce", [httpx.ConnectError("down"), "Ich weiß es nicht."])
async def test_a_failed_reduce_proposes_the_grouped_candidates(app, decided, reduce):
    documents = _documents(150)
    first = {"proposals": [{"path": "Fotos", "ids": ["d1", "d2"]}]}
    second = {
        "proposals": [
            {"path": "Bilder", "ids": ["d101", "d102"]},
            {"path": "fotos", "ids": ["d103", "d104"]},
        ]
    }
    fake, post = _fake_http(_route([("d1", json.dumps(first)), ("d101", json.dumps(second))], reduce=reduce))
    body = (await _propose(app, fake, {**BODY, "documents": documents})).json()
    assert body["error"] is None
    assert [(p["path"], p["ids"]) for p in body["proposals"]] == [
        ("Fotos", ["d1", "d2", "d103", "d104"]),
        ("Bilder", ["d101", "d102"]),
    ]
    assert post.await_count == 3


@pytest.mark.asyncio
async def test_a_verification_over_its_budget_keeps_the_proposals_without_confidences(app, monkeypatch):
    async def slow(states, *_args, **_kwargs):
        await asyncio.sleep(0.5)
        return [_Answer({"f0": 0.8, "none": 0.1}) for _ in states]

    monkeypatch.setattr("agent.common.decisions.decide_many", slow)
    monkeypatch.setattr(module, "VERIFY_BUDGET_S", 0.05)
    fake, _post = _fake_http(_route([("d1", json.dumps(PROPOSAL))]))
    body = (await _propose(app, fake)).json()
    assert body["error"] is None
    assert [(p["path"], p["ids"], p["confidences"]) for p in body["proposals"]] == [("Lagepläne", ["d1", "d2"], {})]


@pytest.mark.asyncio
async def test_a_jev_failure_keeps_the_proposals_with_empty_confidences(app, monkeypatch):
    async def broken(states, *_args, **_kwargs):
        # How `decide_many` fails: one None per call it could not make, never a raise.
        return [None] * len(states)

    monkeypatch.setattr("agent.common.decisions.decide_many", broken)
    fake, _post = _fake_http(_route([("d1", json.dumps(PROPOSAL))]))
    body = (await _propose(app, fake)).json()
    assert body["error"] is None
    assert [(p["path"], p["confidences"]) for p in body["proposals"]] == [("Lagepläne", {})]


@pytest.mark.asyncio
async def test_no_documents_makes_no_call(app):
    fake, post = _fake_http(_route([]))
    body = (await _propose(app, fake, {**BODY, "documents": []})).json()
    assert body["proposals"] == []
    assert post.await_count == 0
