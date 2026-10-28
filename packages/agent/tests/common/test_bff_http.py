"""The one BFF client: where it calls, with which credential, and what it refuses to do.

The transport tests run against a real loopback HTTP server rather than a
patched opener, because the properties under test (a redirect is not followed,
no proxy is used, a ``file:`` URL is not read) live in the opener itself.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from typing import Any

import pytest

from agent.agents.intake.client import IntakeRequestError
from agent.common import bff_http
from agent.common import citation_events
from agent.common import cost_tracking
from agent.common import profiler
from agent.knowledge.bim_query import BimQueryRejectedError
from agent.knowledge.bim_query import BimQueryUnavailableError
from agent.knowledge.estate_tree_client import EstateTreeError
from agent.knowledge.folder_cards.client import FolderCardsError
from agent.knowledge.project_memory import CrossProjectMemoryRefusedError
from agent.knowledge.project_memory import OrgMemoryDisabledError
from agent.tools.canvas.client import CanvasRequestError
from agent.tools.cross_project.client import CrossProjectLookupError
from agent.tools.documents.filing import FilingError
from agent.tools.proposals_client import ProposalRequestError
from agent.tools.tasks.client import DelegationError
from agent.tools.workspace.client import WorkspaceError
from agent.turn.context_client import TurnContextError

TOKEN = "service-token"


class _Server:
    """A loopback server answering each path with a queued (status, headers, body); it records every request."""

    def __init__(self) -> None:
        self.answers: dict[str, tuple[int, dict[str, str], bytes]] = {}
        self.requests: list[dict[str, Any]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                server.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": self.rfile.read(length) if length else b"",
                    }
                )
                status, headers, body = server.answers.get(self.path.split("?")[0], (404, {}, b"{}"))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = do_PUT = do_DELETE = _answer

            def log_message(self, *args: Any) -> None:  # noqa: ARG002 - quiet
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def bff(monkeypatch: pytest.MonkeyPatch) -> Iterator[_Server]:
    server = _Server()
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", server.url)
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
    yield server
    server.close()


class TestWhereItCalls:
    def test_the_internal_url_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend-internal:3000/")
        monkeypatch.setenv("FRONTEND_URL", "http://frontend-public:3000")
        assert bff_http.internal_base_url() == "http://frontend-internal:3000"

    def test_the_public_url_is_the_second_choice(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
        monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000/")
        assert bff_http.internal_base_url() == "http://localhost:3000"

    @pytest.mark.parametrize("internal", [None, ""])
    def test_the_service_name_when_neither_is_set(self, monkeypatch: pytest.MonkeyPatch, internal: str | None) -> None:
        if internal is None:
            monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
        else:
            monkeypatch.setenv("FRONTEND_INTERNAL_URL", internal)
        monkeypatch.delenv("FRONTEND_URL", raising=False)
        assert bff_http.internal_base_url() == "http://frontend:3000"


class TestTheCredential:
    @pytest.mark.parametrize("token", [None, ""])
    def test_no_token_sends_nothing(self, bff: _Server, monkeypatch: pytest.MonkeyPatch, token: str | None) -> None:
        if token is None:
            monkeypatch.delenv("INTERNAL_API_TOKEN")
        else:
            monkeypatch.setenv("INTERNAL_API_TOKEN", token)
        with pytest.raises(bff_http.BffNotConfiguredError, match="INTERNAL_API_TOKEN is not configured"):
            bff_http.get_json("/api/internal/x", timeout=2)
        assert bff.requests == []

    def test_the_token_and_the_echoed_envelope_go_out(self, bff: _Server) -> None:
        bff.answers["/api/internal/x"] = (200, {"Content-Type": "application/json"}, b'{"ok": true}')
        envelope = bff_http.SignedEnvelope(header="eyJhIjoxfQ", signature="c2ln")

        assert bff_http.post_json("/api/internal/x", {"ü": 1}, timeout=2, headers=envelope.headers()) == {"ok": True}

        (sent,) = bff.requests
        assert sent["headers"]["X-Grid-Internal-Token"] == TOKEN
        assert sent["headers"]["X-Grid-Request-Context"] == "eyJhIjoxfQ"
        assert sent["headers"]["X-Grid-Request-Context-Sig"] == "c2ln"
        assert sent["headers"]["Content-Type"] == "application/json"
        assert json.loads(sent["body"]) == {"ü": 1}

    def test_a_caller_cannot_replace_the_token(self, bff: _Server) -> None:
        bff.answers["/api/internal/x"] = (200, {}, b"{}")
        bff_http.get_json("/api/internal/x", timeout=2, headers={"x-grid-internal-token": "chosen"})
        assert bff.requests[0]["headers"]["X-Grid-Internal-Token"] == TOKEN

    def test_the_query_is_encoded(self, bff: _Server) -> None:
        bff.answers["/api/internal/x"] = (200, {}, b"{}")
        bff_http.get_json("/api/internal/x", timeout=2, query={"a": "b c", "d": "ä"})
        assert bff.requests[0]["path"] == "/api/internal/x?a=b+c&d=%C3%A4"


class TestWhatItRefuses:
    def test_a_redirect_is_never_followed_and_never_named(self, bff: _Server) -> None:
        elsewhere = _Server()
        try:
            location = f"{elsewhere.url}/sign-in?state=secret"
            bff.answers["/api/internal/x"] = (302, {"Location": location}, b"")
            with pytest.raises(bff_http.BffRefusedError) as refused:
                bff_http.post_json("/api/internal/x", {"a": 1}, timeout=2)
            assert refused.value.status == 302
            assert "secret" not in str(refused.value) and "sign-in" not in str(refused.value)
            assert elsewhere.requests == [], "the token followed the redirect"
        finally:
            elsewhere.close()

    def test_an_environment_proxy_is_not_used(self, bff: _Server, monkeypatch: pytest.MonkeyPatch) -> None:
        """The token never travels through an egress proxy an environment variable configured."""
        proxy = _Server()
        try:
            for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
                monkeypatch.setenv(name, proxy.url)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            # A ProxyHandler reads the environment when it is built, so the
            # opener is built again here, under the proxy settings.
            monkeypatch.setattr(bff_http, "_opener", bff_http._build_opener())
            bff.answers["/api/internal/x"] = (200, {}, b"{}")
            assert bff_http.get_json("/api/internal/x", timeout=2) == {}
            assert proxy.requests == []
        finally:
            proxy.close()

    def test_a_file_url_is_not_read(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:  # noqa: ANN001
        secret = tmp_path / "api" / "internal" / "x"
        secret.parent.mkdir(parents=True)
        secret.write_text('{"secret": true}')
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", f"file://{tmp_path}")
        monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
        with pytest.raises(bff_http.BffUnreachableError):
            bff_http.get_json("/api/internal/x", timeout=2)

    def test_a_refusal_carries_the_envelope(self, bff: _Server) -> None:
        body = json.dumps({"error": "Kein Zugriff.", "code": "FORBIDDEN", "details": {"reason": "x"}}).encode()
        bff.answers["/api/internal/x"] = (403, {"Content-Type": "application/json"}, body)
        with pytest.raises(bff_http.BffRefusedError) as refused:
            bff_http.get_json("/api/internal/x", timeout=2)
        assert (refused.value.status, refused.value.code, refused.value.error_text) == (
            403,
            "FORBIDDEN",
            "Kein Zugriff.",
        )
        assert refused.value.body["details"] == {"reason": "x"}

    def test_a_refusal_without_json_has_an_empty_envelope(self, bff: _Server) -> None:
        bff.answers["/api/internal/x"] = (500, {}, b"<html>oops</html>")
        with pytest.raises(bff_http.BffRefusedError) as refused:
            bff_http.get_json("/api/internal/x", timeout=2)
        assert (refused.value.body, refused.value.code, refused.value.error_text) == ({}, None, None)

    @pytest.mark.parametrize("body", [b"<html>", b"", b"\xff"])
    def test_a_2xx_that_is_not_json_is_malformed(self, bff: _Server, body: bytes) -> None:
        bff.answers["/api/internal/x"] = (200, {}, body)
        with pytest.raises(bff_http.BffMalformedResponseError):
            bff_http.get_json("/api/internal/x", timeout=2)

    def test_nobody_listening_is_unreachable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        server = _Server()
        url = server.url
        server.close()
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", url)
        monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
        with pytest.raises(bff_http.BffUnreachableError):
            bff_http.get_json("/api/internal/x", timeout=2)

    def test_send_returns_the_raw_answer(self, bff: _Server) -> None:
        bff.answers["/api/mcp"] = (200, {"Content-Type": "text/event-stream"}, b"data: {}\n\n")
        response = bff_http.send("POST", "/api/mcp", timeout=2, body={})
        assert (response.status, response.content_type, response.body) == (200, "text/event-stream", b"data: {}\n\n")


@pytest.mark.parametrize(
    "error",
    [
        BimQueryRejectedError,
        BimQueryUnavailableError,
        CanvasRequestError,
        CrossProjectLookupError,
        CrossProjectMemoryRefusedError,
        DelegationError,
        EstateTreeError,
        FilingError,
        FolderCardsError,
        IntakeRequestError,
        OrgMemoryDisabledError,
        ProposalRequestError,
        TurnContextError,
        WorkspaceError,
    ],
)
def test_every_domain_error_is_a_bff_error(error: type[Exception]) -> None:
    """A caller that needs only "the BFF did not answer" catches the base; each domain keeps its own name."""
    assert issubclass(error, bff_http.BffError)
    assert issubclass(error, RuntimeError)


def test_a_rejected_bim_query_is_still_a_value_error() -> None:
    assert issubclass(BimQueryRejectedError, ValueError)


LEDGERS = [
    (cost_tracking._post_usage_events, "/api/internal/usage", {"events": [{"a": 1}]}),
    (profiler._post_profiler_spans, "/api/internal/agent-profiler-spans", {"spans": [{"a": 1}]}),
    (citation_events._post_batch, "/api/internal/citation-events", {"events": [{"a": 1}]}),
]


@pytest.mark.parametrize(("post", "route", "payload"), LEDGERS)
class TestTheLedgersGoThroughTheSeam:
    """The three best-effort ledgers: through the seam, with the token, and never raising."""

    def test_the_batch_reaches_its_route_with_the_token(
        self, bff: _Server, post: Callable[[dict], None], route: str, payload: dict
    ) -> None:
        bff.answers[route] = (202, {}, b"")
        post(payload)
        (sent,) = bff.requests
        assert (sent["path"], sent["headers"]["X-Grid-Internal-Token"]) == (route, TOKEN)
        assert json.loads(sent["body"]) == payload

    def test_a_refusal_is_logged_not_raised(
        self, bff: _Server, post: Callable[[dict], None], route: str, payload: dict
    ) -> None:
        bff.answers[route] = (403, {}, b'{"error": "Forbidden"}')
        post(payload)
        assert len(bff.requests) == 1

    def test_no_token_sends_nothing(
        self,
        bff: _Server,
        monkeypatch: pytest.MonkeyPatch,
        post: Callable[[dict], None],
        route: str,  # noqa: ARG002
        payload: dict,
    ) -> None:
        monkeypatch.delenv("INTERNAL_API_TOKEN")
        post(payload)
        assert bff.requests == []
