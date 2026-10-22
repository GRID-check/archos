"""The agent's read tools over HTTP, for the BFF's MCP server (ADR-0122).

The route must run a tool only for the person a signed, current envelope names,
only when the tool is on the read allowlist, and with the turn context the tools
read laid from that VERIFIED envelope.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.common.backend_tools import BACKEND_READ_TOOLS
from aiq_agent.project_context import GridRequestContext
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.project_context import get_project_id_from_context
from aiq_api.routes import internal_tools
from aiq_api.routes.internal_tools import add_internal_tool_routes

TOKEN = "real-secret"  # pragma: allowlist secret
PATH = "/v1/internal/tools/{name}"


class _SearchInput(BaseModel):
    query: str = Field(description="what to look for")
    top_k: int = 3


class _FakeFunction:
    """A NAT function: an input model and an ``ainvoke`` that records the context it ran in."""

    input_schema = _SearchInput

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result: Any = "passage text"

    async def ainvoke(self, value: _SearchInput) -> Any:
        context = GridRequestContext.from_context()
        self.calls.append(
            {
                "arguments": value.model_dump(),
                "project": get_project_id_from_context(),
                "organization": get_organization_id_from_context(),
                "user": context.user_id,
                "scope": context.collection_scope,
            }
        )
        return self.result


class _FakeBuilder:
    def __init__(self, functions: dict[str, _FakeFunction]) -> None:
        self.functions = functions

    async def get_function(self, name: str) -> _FakeFunction:
        if name not in self.functions:
            raise ValueError(f"Function `{name}` not found")
        return self.functions[name]


def _envelope(payload: dict[str, Any], secret: str = TOKEN) -> dict[str, str]:
    raw = json.dumps(payload)
    return {
        "x-grid-request-context": base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode(),
        "x-grid-request-context-sig": hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }


def _payload(**overrides: Any) -> dict[str, Any]:
    return {
        "organizationId": "org_1",
        "userId": "user_1",
        "projectId": "proj_1",
        "collectionScope": [{"collection": "p_proj_1", "shelf": "project"}],
        "issuedAt": int(time.time() * 1000),
        **overrides,
    }


@pytest.fixture
def fake_function(monkeypatch: pytest.MonkeyPatch) -> _FakeFunction:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    function = _FakeFunction()
    builder = _FakeBuilder({"knowledge_search": function, "write_file": _FakeFunction()})
    monkeypatch.setattr(internal_tools, "get_active_builder", lambda: builder)
    return function


@pytest.fixture
def client(fake_function: _FakeFunction) -> TestClient:
    router = APIRouter()
    add_internal_tool_routes(router)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _post(client: TestClient, name: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
    return client.post(PATH.format(name=name), json=body, headers=headers)


def _headers(**payload: Any) -> dict[str, str]:
    return {"x-grid-internal-token": TOKEN, **_envelope(_payload(**payload))}


def test_it_runs_the_tool_for_the_person_the_envelope_names(client: TestClient, fake_function: _FakeFunction):
    response = _post(client, "knowledge_search", {"arguments": {"query": "Fluchtweg"}}, _headers())

    assert response.status_code == 200
    assert response.json() == {"tool": "knowledge_search", "result": "passage text"}
    assert fake_function.calls == [
        {
            "arguments": {"query": "Fluchtweg", "top_k": 3},
            "project": "proj_1",
            "organization": "org_1",
            "user": "user_1",
            "scope": ["p_proj_1"],
        }
    ]


def test_it_answers_content_blocks_as_blocks(client: TestClient, fake_function: _FakeFunction):
    blocks = [
        {"type": "text", "text": "page 3"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA"}},
    ]
    fake_function.result = blocks

    response = _post(client, "knowledge_search", {"arguments": {"query": "x"}}, _headers())

    assert response.json()["result"] == blocks


def test_it_refuses_a_call_without_the_envelope(client: TestClient, fake_function: _FakeFunction):
    response = _post(client, "knowledge_search", {"arguments": {"query": "x"}}, {"x-grid-internal-token": TOKEN})

    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "context_envelope_required"
    assert fake_function.calls == []


def test_it_refuses_individual_headers_in_place_of_the_envelope(client: TestClient, fake_function: _FakeFunction):
    headers = {
        "x-grid-internal-token": TOKEN,
        "x-grid-user-id": "user_1",
        "x-grid-organization-id": "org_1",
        "x-grid-project-id": "proj_1",
    }
    assert _post(client, "knowledge_search", {"arguments": {"query": "x"}}, headers).status_code == 403
    assert fake_function.calls == []


def test_it_refuses_an_envelope_signed_with_another_secret(client: TestClient, fake_function: _FakeFunction):
    headers = {"x-grid-internal-token": TOKEN, **_envelope(_payload(), secret="somebody-else")}

    assert _post(client, "knowledge_search", {"arguments": {"query": "x"}}, headers).status_code == 403
    assert fake_function.calls == []


@pytest.mark.parametrize(
    "payload",
    [
        {"userId": None},
        {"organizationId": None},
        {"issuedAt": None},
        {"issuedAt": int(time.time() * 1000) - 7 * 60 * 60 * 1000},
    ],
    ids=["no-user", "no-organization", "not-stamped", "too-old"],
)
def test_it_refuses_an_envelope_that_names_nobody_or_is_stale(
    client: TestClient, fake_function: _FakeFunction, payload: dict[str, Any]
):
    body = {key: value for key, value in _payload(**payload).items() if value is not None}
    headers = {"x-grid-internal-token": TOKEN, **_envelope(body)}

    assert _post(client, "knowledge_search", {"arguments": {"query": "x"}}, headers).status_code == 403
    assert fake_function.calls == []


def test_it_refuses_a_caller_without_the_internal_token(client: TestClient, fake_function: _FakeFunction):
    envelope = _envelope(_payload())

    assert _post(client, "knowledge_search", {"arguments": {"query": "x"}}, envelope).status_code == 403
    assert (
        _post(
            client, "knowledge_search", {"arguments": {"query": "x"}}, {**envelope, "x-grid-internal-token": "no"}
        ).status_code
        == 403
    )
    assert fake_function.calls == []


def test_it_refuses_a_tool_that_is_not_on_the_allowlist(client: TestClient):
    # `write_file` IS bound in the fake workflow: the allowlist, not the builder, decides.
    for name in ("write_file", "file_draft", "does_not_exist"):
        response = _post(client, name, {"arguments": {"query": "x"}}, _headers())
        assert response.status_code == 404, name
        assert response.json()["detail"]["error"] == "unknown_tool"


def test_an_allowlisted_tool_the_config_does_not_bind_is_not_found(client: TestClient):
    response = _post(client, "ris_lookup_tool", {"arguments": {"question": "x"}}, _headers())

    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "tool_not_configured"


def test_it_rejects_arguments_the_tool_does_not_take(client: TestClient, fake_function: _FakeFunction):
    response = _post(client, "knowledge_search", {"arguments": {"top_k": "many"}}, _headers())

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "invalid_arguments"
    assert fake_function.calls == []


def test_the_turn_context_does_not_outlive_the_call(client: TestClient):
    from nat.plugin_api import Context

    _post(client, "knowledge_search", {"arguments": {"query": "x"}}, _headers())

    assert get_project_id_from_context() is None
    assert Context.get().metadata.headers is None or "x-grid-project-id" not in Context.get().metadata.headers


def test_a_header_set_beside_the_envelope_never_reaches_the_tool(client: TestClient, fake_function: _FakeFunction):
    headers = {**_headers(), "x-grid-project-id": "proj_other", "x-grid-user-id": "user_other"}

    _post(client, "knowledge_search", {"arguments": {"query": "x"}}, headers)

    assert fake_function.calls[0]["project"] == "proj_1"
    assert fake_function.calls[0]["user"] == "user_1"


def test_a_tool_that_fails_is_a_502_that_names_no_internals(client: TestClient, fake_function: _FakeFunction):
    async def boom(value: _SearchInput) -> str:
        raise RuntimeError("qdrant at 10.0.0.4 refused")

    fake_function.ainvoke = boom  # type: ignore[method-assign]

    response = _post(client, "knowledge_search", {"arguments": {"query": "x"}}, _headers())

    assert response.status_code == 502
    assert "10.0.0.4" not in response.text


def test_the_workflow_not_being_ready_is_a_503(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(internal_tools, "get_active_builder", lambda: None)

    assert _post(client, "knowledge_search", {"arguments": {"query": "x"}}, _headers()).status_code == 503


def test_every_allowlisted_tool_is_a_read():
    """The list is a promise to the MCP clients that none of these changes anything."""
    forbidden = ("write", "edit", "file_draft", "propose", "remember", "create", "delete", "submit", "emit")
    assert [name for name in BACKEND_READ_TOOLS if any(word in name for word in forbidden)] == []


def test_a_door_call_is_booked_to_the_envelopes_person_and_may_render_one_look(
    client: TestClient, fake_function: _FakeFunction, monkeypatch: pytest.MonkeyPatch
):
    """A ``document-look`` with a question makes a vision call: it lands on the ledger, and it is one look."""
    from aiq_agent.common import cost_tracking
    from aiq_agent.common.image_view_budget import try_consume_image_view

    posted: list[dict[str, Any]] = []
    monkeypatch.setattr(cost_tracking, "_post_usage_events", posted.append)
    looks: list[bool] = []

    async def look_and_read(value: _SearchInput) -> Any:
        looks.extend([try_consume_image_view("region"), try_consume_image_view("region")])
        cost_tracking.record_completion_usage(
            {"usage": {"prompt_tokens": 900, "completion_tokens": 50, "cost": 0.002}},
            role=cost_tracking.USAGE_ROLE_LOOK_READING,
            requested_model="vision-1",
        )
        return "Gelesen: 2,70 m"

    monkeypatch.setattr(fake_function, "ainvoke", look_and_read)

    response = _post(client, "knowledge_search", {"arguments": {"query": "Raumhöhe"}}, _headers())

    assert response.status_code == 200
    assert looks == [True, False]
    [batch] = posted
    assert (batch["organizationId"], batch["userId"], batch["projectId"]) == ("org_1", "user_1", "proj_1")
    assert [(event["role"], event["costUsd"]) for event in batch["events"]] == [("look_reading", 0.002)]
