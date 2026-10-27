"""``workspace__*``: the identity on the wire, the refusal without one, and the server's words relayed.

Only the socket is replaced. The request context, the headers and the tool
functions are the real ones: what is under test is that EVERY call carries the
envelope of the turn that made it (never one read at build time) and that a
run with no acting person calls nothing.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import urllib.error
from typing import Any

import pytest

from aiq_agent.common import bff_http
from aiq_agent.tools.workspace import client
from aiq_agent.tools.workspace import register as workspace

SECRET = "workspace-test-secret"  # noqa: S105 - test fixture value  # pragma: allowlist secret


class _Metadata:
    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = headers


class _Context:
    def __init__(self, headers: dict[str, str]) -> None:
        self.metadata = _Metadata(headers)
        self.conversation_id = "conv-1"


def bind(monkeypatch: pytest.MonkeyPatch, headers: dict[str, str]) -> None:
    from nat.plugin_api import Context

    context = _Context(headers)
    monkeypatch.setattr(Context, "get", staticmethod(lambda: context))


def turn_of(user: str) -> dict[str, str]:
    """The BFF's own encoding of a signed envelope for ``user``: base64url(JSON) and the hex HMAC of the JSON."""
    raw = json.dumps({"organizationId": "org_1", "userId": user, "issuedAt": 1_757_500_000_000})
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    signature = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return {"x-grid-request-context": header, "x-grid-request-context-sig": signature}


class _Response:
    def __init__(self, body: str, content_type: str = "application/json") -> None:
        self._body = body.encode("utf-8")
        self.headers = {"Content-Type": content_type}

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None


def result(text: str, *, is_error: bool = False) -> str:
    return json.dumps(
        {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}}
    )


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Every request that reached the socket; answers with a plain result."""
    requests: list[Any] = []

    def _open(request: Any, timeout: float) -> _Response:
        requests.append(request)
        return _Response(result("ok"))

    monkeypatch.setattr(bff_http._opener, "open", _open)
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test/")
    return requests


def header(request: Any, name: str) -> str | None:
    return request.get_header(name.capitalize())


async def test_each_call_echoes_the_envelope_of_its_own_turn(monkeypatch, sent) -> None:
    bind(monkeypatch, turn_of("anna"))
    await workspace.run_search("add a member")
    bind(monkeypatch, turn_of("ben"))
    await workspace.run_describe("project-member-add")

    anna, ben = turn_of("anna"), turn_of("ben")
    assert [header(r, "X-grid-request-context") for r in sent] == [
        anna["x-grid-request-context"],
        ben["x-grid-request-context"],
    ]
    assert [header(r, "X-grid-request-context-sig") for r in sent] == [
        anna["x-grid-request-context-sig"],
        ben["x-grid-request-context-sig"],
    ]


async def test_concurrent_turns_never_swap_identities(monkeypatch, sent) -> None:
    """Two turns, two tasks, one process: each call reads the context of the task it runs in."""
    from nat.plugin_api import Context

    current: dict[str, str] = {}

    class _PerTask:
        metadata = type("M", (), {"headers": property(lambda self: current[asyncio.current_task().get_name()])})()
        conversation_id = None

    monkeypatch.setattr(Context, "get", staticmethod(lambda: _PerTask()))

    async def turn(user: str) -> None:
        current[asyncio.current_task().get_name()] = turn_of(user)
        await asyncio.sleep(0)
        await workspace.run_search(f"query of {user}")

    await asyncio.gather(*(asyncio.create_task(turn(u), name=u) for u in ("anna", "ben", "cleo")))

    by_query = {json.loads(r.data)["params"]["arguments"]["query"]: header(r, "X-grid-request-context") for r in sent}
    assert by_query == {f"query of {u}": turn_of(u)["x-grid-request-context"] for u in ("anna", "ben", "cleo")}


async def test_the_request_is_one_stateless_tools_call_in_search_mode(monkeypatch, sent) -> None:
    bind(monkeypatch, turn_of("anna"))
    await workspace.run_call("project-get", {"params": {"id": "p1"}})

    (request,) = sent
    assert request.full_url == "http://bff.test/api/mcp"
    assert header(request, "X-grid-internal-token") == SECRET
    assert header(request, "X-piloti-mcp-mode") == "search"
    assert json.loads(request.data) == {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "call-operation", "arguments": {"name": "project-get", "input": {"params": {"id": "p1"}}}},
    }


async def test_each_call_names_the_answer_its_turn_writes(monkeypatch, sent) -> None:
    """The BFF marks that answer when a read runs in a conversation that drew on a restricted folder (ADR-0093)."""
    from aiq_agent.turn.response import turn_answer_message_id

    bind(monkeypatch, turn_of("anna"))
    await workspace.run_call("project-get", {"params": {"id": "p1"}})

    (request,) = sent
    assert header(request, client.ANSWER_MESSAGE_HEADER) == turn_answer_message_id("conv-1")


async def test_a_run_outside_a_conversation_names_no_answer(monkeypatch, sent) -> None:
    bind(monkeypatch, turn_of("anna"))
    from nat.plugin_api import Context

    Context.get().conversation_id = None
    await workspace.run_search("anything")

    (request,) = sent
    assert header(request, client.ANSWER_MESSAGE_HEADER) is None


async def test_the_four_functions_map_to_the_servers_four_tools(monkeypatch, sent) -> None:
    bind(monkeypatch, turn_of("anna"))
    await workspace.run_search("x", domain="projects", limit=3)
    await workspace.run_describe("a")
    await workspace.run_call("a")
    await workspace.run_report_missing("cannot do b")

    names = [json.loads(r.data)["params"]["name"] for r in sent]
    assert names == ["search-operations", "describe-operation", "call-operation", "report-missing-operation"]
    assert json.loads(sent[0].data)["params"]["arguments"] == {"query": "x", "limit": 3, "domain": "projects"}


@pytest.mark.parametrize("headers", [{}, {"x-grid-request-context": "h"}, {"x-grid-request-context-sig": "s"}])
async def test_without_a_full_envelope_nothing_is_sent(monkeypatch, sent, headers) -> None:
    bind(monkeypatch, headers)
    text = await workspace.run_call("project-delete", {})

    assert sent == []
    assert "no signed request context" in text


async def test_a_tool_level_error_is_relayed_as_the_servers_lesson(monkeypatch, sent) -> None:
    monkeypatch.setattr(
        bff_http._opener,
        "open",
        lambda request, timeout: _Response(
            result("Unknown operation `proj-get`. Did you mean `project-get`?", is_error=True)
        ),
    )
    bind(monkeypatch, turn_of("anna"))

    text = await workspace.run_describe("proj-get")

    assert text == "Error: Unknown operation `proj-get`. Did you mean `project-get`?"


async def test_a_refusal_from_the_server_is_worded_with_its_own_sentence(monkeypatch, sent) -> None:
    def _refuse(request: Any, timeout: float) -> _Response:
        body = io.BytesIO(json.dumps({"error": "request context signature invalid"}).encode())
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, body)

    monkeypatch.setattr(bff_http._opener, "open", _refuse)
    bind(monkeypatch, turn_of("anna"))

    text = await workspace.run_call("project-get", {})

    assert "(401): request context signature invalid" in text
    assert "Nothing was changed" in text


async def test_an_unreachable_server_is_a_sentence_not_a_crash(monkeypatch, sent) -> None:
    def _down(request: Any, timeout: float) -> _Response:
        raise OSError("connection refused")

    monkeypatch.setattr(bff_http._opener, "open", _down)
    bind(monkeypatch, turn_of("anna"))

    assert "could not be reached" in await workspace.run_search("x")


def test_an_event_stream_answer_is_read() -> None:
    sse = f"event: message\ndata: {result('from sse')}\n\n"

    assert client._result_text(client._jsonrpc_from(sse, "text/event-stream")) == "from sse"


def test_a_jsonrpc_error_is_a_workspace_error() -> None:
    message = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad params"}}

    with pytest.raises(client.WorkspaceError, match="bad params"):
        client._result_text(message)


def test_a_long_answer_is_passed_on_whole_because_the_server_caps_it() -> None:
    """One cap, the server's (``MAX_RESULT_CHARS`` in ``discovery.ts``): a second cut here would end mid-JSON."""
    long = "x" * 60_000
    message = json.loads(result(long))

    assert client._result_text(message) == long
    assert not hasattr(client, "MAX_RESULT_CHARS")


def test_the_group_exposes_exactly_the_four_named_functions() -> None:
    assert set(workspace.DESCRIPTIONS) == set(workspace.SERVER_TOOLS)


def test_the_descriptions_are_the_servers_words_read_from_the_fixture() -> None:
    """The server writes the meta-tools once (``metaToolsFor``); this group keeps no copy, only its own tool names."""
    tools = json.loads(workspace.META_TOOLS_PATH.read_text(encoding="utf-8"))["tools"]

    assert set(tools) == set(workspace.SERVER_TOOLS.values())
    for step, server_name in workspace.SERVER_TOOLS.items():
        expected = tools[server_name]["description"]
        for other_step, other_name in workspace.SERVER_TOOLS.items():
            expected = expected.replace(other_name, f"workspace__{other_step}")
        assert workspace.DESCRIPTIONS[step] == expected
        # The model knows these tools by this group's names only.
        assert not any(name in workspace.DESCRIPTIONS[step] for name in workspace.SERVER_TOOLS.values())


def test_the_in_product_search_never_offers_the_platform_domain() -> None:
    tools = json.loads(workspace.META_TOOLS_PATH.read_text(encoding="utf-8"))["tools"]

    assert "platform" not in tools["search-operations"]["inputSchema"]["properties"]["domain"]["enum"]
