"""The workspace client and the BFF's MCP server, tested against each other (ADR-0122).

Each side was tested alone: ``test_workspace_client.py`` against a fake socket,
``api/mcp/route.spec.ts`` against hand-built requests. Nothing proved the request
this client really builds is one the real route answers, or that the answer is one
this client really parses. Two committed fixtures close that, the pattern of
``request_context.json``:

* ``apps/workspace/tests/fixtures/workspace_mcp_requests.json`` is written HERE from
  the real request builder (only the socket is replaced). The BFF spec
  ``workspace-contract.spec.ts`` replays it against the real route handler.
* ``apps/workspace/tests/fixtures/workspace_mcp_responses.json`` is written by that
  spec from what the route really answered. The second half of this file feeds
  each body back through the real ``call_tool``.

``UPDATE_FIXTURES=1`` rewrites the requests fixture (the flag the TS fixtures use);
otherwise a stale one fails. Secrets are placeholders: the signing key and the
envelope are the spec's, not the fixture's.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest

from agent.common import bff_http
from agent.common.bff_http import SignedEnvelope
from agent.tools.workspace import client

REPO = Path(__file__).resolve().parents[5]
FIXTURES = REPO / "apps" / "workspace" / "tests" / "fixtures"
REQUESTS_PATH = FIXTURES / "workspace_mcp_requests.json"
RESPONSES_PATH = FIXTURES / "workspace_mcp_responses.json"

TOKEN_PLACEHOLDER = "<INTERNAL_API_TOKEN>"  # noqa: S105  # pragma: allowlist secret
SIGNATURE_PLACEHOLDER = "<ENVELOPE_SIGNATURE>"

#: The payload the spec signs (with a fresh ``issuedAt``). ``issuedAt`` is 0 here: the
#: BFF refuses an envelope older than six hours, so the spec sets the real time.
ENVELOPE_PAYLOAD = {"organizationId": "org_1", "userId": "user_1", "conversationId": "conv_1", "issuedAt": 0}
ENVELOPE_HEADER = (
    base64.urlsafe_b64encode(json.dumps(ENVELOPE_PAYLOAD, separators=(",", ":")).encode()).decode().rstrip("=")
)

#: The answer a turn names (``turn_answer_message_id``), a uuid the BFF marks when the conversation drew on a
#: restricted folder (ADR-0093). Fixed here so the fixture is stable.
ANSWER_MESSAGE_ID = "6f1c2b8e-3d4a-5b6c-8d7e-9f0a1b2c3d4e"

#: One real call per tool the agent exposes (``register.SERVER_TOOLS``), a write and a read of ``call-operation``.
CASES: list[tuple[str, str, dict[str, Any]]] = [
    ("search", "search-operations", {"query": "project", "limit": 10}),
    ("describe", "describe-operation", {"name": "project-member-add"}),
    (
        "call_write",
        "call-operation",
        {
            "name": "project-member-add",
            "input": {"params": {"id": "proj_1"}, "body": {"userId": "user_2", "role": "viewer"}},
        },
    ),
    ("call_read", "call-operation", {"name": "project-list", "input": {}}),
    ("report_missing", "report-missing-operation", {"description": "Add a deadline to the calendar."}),
]


class _Captured(Exception):
    pass


class _Opener:
    """Stands in for the socket only: records the request ``call_tool`` built, answers with ``reply``."""

    def __init__(self, reply: Any = None) -> None:
        self.request: Any = None
        self.reply = reply

    def open(self, request: Any, timeout: float | None = None) -> Any:  # noqa: ARG002
        self.request = request
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


class _Reply:
    def __init__(self, body: str, content_type: str) -> None:
        self._body = body.encode("utf-8")
        self.headers = {"Content-Type": content_type}

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Reply:
        return self

    def __exit__(self, *_: object) -> None:
        return None


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_TOKEN", "real-token-never-in-a-fixture")  # pragma: allowlist secret
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")


def _envelope() -> SignedEnvelope:
    return SignedEnvelope(header=ENVELOPE_HEADER, signature="real-signature-never-in-a-fixture")


def _redacted(headers: dict[str, str]) -> dict[str, str]:
    swaps = {
        "x-grid-internal-token": TOKEN_PLACEHOLDER,
        "x-grid-request-context-sig": SIGNATURE_PLACEHOLDER,
    }
    out = {name.lower(): swaps.get(name.lower(), value) for name, value in headers.items()}
    return dict(sorted(out.items()))


def _built_requests(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    built = []
    for case, tool, arguments in CASES:
        opener = _Opener(_Reply(json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": []}}), "application/json"))
        monkeypatch.setattr(bff_http, "_opener", opener)
        client.call_tool(tool, arguments, _envelope(), answer_message_id=ANSWER_MESSAGE_ID)
        request = opener.request
        built.append(
            {
                "name": case,
                "method": request.get_method(),
                "path": urlparse(request.full_url).path,
                "headers": _redacted(dict(request.header_items())),
                "body": json.loads(request.data.decode("utf-8")),
            }
        )
    return built


def _document(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    return {
        "comment": (
            "Written by packages/agent/tests/tools/workspace/test_workspace_mcp_contract.py from the real request "
            "builder of agent/tools/workspace/client.py; replayed by "
            "apps/workspace/app/api/mcp/workspace-contract.spec.ts against the real route. "
            "Regenerate with UPDATE_FIXTURES=1. The spec signs envelopePayload (with a current issuedAt) and "
            "substitutes the placeholders."
        ),
        "placeholders": {"token": TOKEN_PLACEHOLDER, "signature": SIGNATURE_PLACEHOLDER, "envelope": ENVELOPE_HEADER},
        "envelopePayload": ENVELOPE_PAYLOAD,
        "requests": _built_requests(monkeypatch),
    }


def test_request_fixture_is_what_the_client_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    document = _document(monkeypatch)
    if os.environ.get("UPDATE_FIXTURES") == "1":
        REQUESTS_PATH.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert json.loads(REQUESTS_PATH.read_text(encoding="utf-8")) == document, (
        "client.py builds a different request than the committed fixture. Re-run with UPDATE_FIXTURES=1, "
        "then run the BFF spec (workspace-contract.spec.ts) and commit both fixtures in the same change."
    )


def test_every_server_tool_the_agent_names_is_in_the_fixture() -> None:
    from agent.tools.workspace.register import SERVER_TOOLS

    covered = {
        body["params"]["name"] for body in (r["body"] for r in json.loads(REQUESTS_PATH.read_text())["requests"])
    }
    assert covered == set(SERVER_TOOLS.values())


# --- the other direction: what the real route answered, through the real parser ----------------------------------

#: What the model must be able to read from each answer the route really gave.
EXPECTED_TEXT = {
    "search": ["project-list", "project-member-add"],
    "describe": ["project-member-add", "inputSchema"],
    "call_write": ["Proposed", "the person decides", "Nothing was changed"],
    "call_read": ["proj_1"],
    "report_missing": ["recorded"],
}


def _responses() -> dict[str, Any]:
    return json.loads(RESPONSES_PATH.read_text(encoding="utf-8"))


def _reply_for(entry: dict[str, Any]) -> Any:
    if entry["status"] >= 400:
        import io

        return urllib.error.HTTPError(
            "http://frontend:3000/api/mcp",
            entry["status"],
            "refused",
            {"Content-Type": entry["contentType"]},  # type: ignore[arg-type]
            io.BytesIO(entry["body"].encode("utf-8")),
        )
    return _Reply(entry["body"], entry["contentType"])


@pytest.mark.parametrize("case", [name for name, _, _ in CASES])
def test_client_reads_what_the_route_answers(case: str, monkeypatch: pytest.MonkeyPatch) -> None:
    entry = _responses()["responses"][case]
    assert entry["status"] == 200
    tool, arguments = next((t, a) for n, t, a in CASES if n == case)
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    text = client.call_tool(tool, arguments, _envelope())
    assert not text.startswith("Error:"), text
    for needle in EXPECTED_TEXT[case]:
        assert needle in text


def test_a_proposed_write_carries_the_shape_the_card_is_made_from(monkeypatch: pytest.MonkeyPatch) -> None:
    """``structuredContent`` ``{decision, proposalId, summary, operation}`` is what ``cards.proposal_from`` reads."""
    entry = _responses()["responses"]["call_write"]
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    tool, arguments = next((t, a) for n, t, a in CASES if n == "call_write")

    result = client.call_tool_result(tool, arguments, _envelope())

    assert result.structured == {
        "decision": "propose",
        "proposalId": "prop_1",
        "summary": "Add user_2 to proj_1 as viewer",
        "operation": "project-member-add",
    }
    # The text is all the model reads: short, and it says nothing was done.
    assert result.text == "Proposed — the person decides. Nothing was changed."


def test_a_read_has_no_decision_to_propose(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent.tools.workspace.cards import proposal_from

    entry = _responses()["responses"]["call_read"]
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    tool, arguments = next((t, a) for n, t, a in CASES if n == "call_read")

    assert proposal_from(client.call_tool_result(tool, arguments, _envelope()).structured) is None


@pytest.mark.parametrize("case", ["refused_no_envelope", "refused_forged_envelope", "refused_wrong_token"])
def test_client_words_the_route_refusals(case: str, monkeypatch: pytest.MonkeyPatch) -> None:
    entry = _responses()["responses"][case]
    assert entry["status"] in (401, 403)
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    with pytest.raises(client.WorkspaceError) as caught:
        client.call_tool("search-operations", {"query": "x"}, _envelope())
    assert caught.value.status == entry["status"]
    assert str(caught.value).startswith(f"the workspace server refused the call ({entry['status']}): ")
    assert len(str(caught.value)) > len("the workspace server refused the call (401): ")


def test_a_tool_level_error_comes_back_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    entry = _responses()["responses"]["unknown_operation"]
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    text = client.call_tool("describe-operation", {"name": "nope"}, _envelope())
    assert text.startswith("Error: Unknown operation")


def test_a_read_refused_in_a_shared_conversation_reaches_the_model_as_the_servers_sentence(monkeypatch) -> None:
    """A read a shared conversation refuses (ADR-0094) reaches the model as the server's sentence, an error."""
    entry = _responses()["responses"]["refused_shared_conversation"]
    assert entry["status"] == 200
    monkeypatch.setattr(bff_http, "_opener", _Opener(_reply_for(entry)))
    tool, arguments = next((t, a) for n, t, a in CASES if n == "call_read")

    result = client.call_tool_result(tool, arguments, _envelope(), answer_message_id=ANSWER_MESSAGE_ID)

    assert result.text.startswith("Error: This conversation is shared")
    assert result.structured is None
