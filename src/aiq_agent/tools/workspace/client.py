"""Piloti as a client of Piloti's own MCP server (ADR-0121): one stateless ``tools/call`` per call.

The server (``POST /api/mcp`` on the BFF) is the agent surface of the product;
external agents reach it with OAuth, this tier reaches it by ECHOING the turn's
signed request-context envelope, exactly as ``tools/tasks/client.py`` does.
Echo, never sign: the BFF verifies the two strings, builds the acting person's
pinned session and runs the operation under that person's rights. A run with no
envelope has no acting person and the tool refuses (``register.py``).

## Why this is not NAT's ``mcp_client`` group

NAT's MCP client connects once, in a lifecycle task created at build time, and
its streamable-HTTP transport sends every request from tasks spawned inside that
task (``anyio`` ``tg.start_soon`` copies the CONNECT-time contextvars). An auth
provider that read the envelope from a contextvar would therefore see no turn at
all, or the first turn's, and send one person's identity on another's call. This
module reads nothing itself: the caller passes the envelope it read inside the
turn's own context, and every call opens, sends and closes its own request, so
there is no connection a second turn could inherit.

The server is stateless, so there is no ``initialize`` handshake to repeat: a
call is one JSON-RPC POST that names the protocol version in its header.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from ..documents.filing import SignedEnvelope

logger = logging.getLogger(__name__)

MCP_PATH = "/api/mcp"

#: The version this client speaks. The server also serves 2026-07-28; the older
#: one is named because it is the one a client that never ran ``initialize`` is
#: certain to be answered in.
PROTOCOL_VERSION = "2025-11-25"

#: ``discovery`` exposes the four meta-tools; the full catalogue would cost every
#: turn a tool list of hundreds (``docs/architecture/agent-tool-surface.md``).
MODE_HEADER = "x-piloti-mcp-mode"
DISCOVERY_MODE = "discovery"

#: The answer the turn is writing (``turn_answer_message_id``), as the other internal tools send it in
#: their bodies (``answerMessageId``): the BFF marks it in ``message_restricted_use`` when a read runs in
#: a conversation that drew on a restricted folder (ADR-0093). A header, because the MCP body is JSON-RPC.
ANSWER_MESSAGE_HEADER = "X-Grid-Answer-Message-Id"

#: A routed operation runs a BFF route in-process, some of them a search.
REQUEST_TIMEOUT_SECONDS = 30

#: Cap on what is handed to the model; a longer answer says so (errors and truncation name the next call).
MAX_RESULT_CHARS = 24_000


@dataclass(frozen=True)
class ToolResult:
    """A ``tools/call`` answer: the text the model reads, and the result's ``structuredContent`` when it has one.

    ``structured`` is for the code around the model, never shown to it. It is ``None`` for a tool-level
    error (``isError``): a refusal is words, not a shape to act on.
    """

    text: str
    structured: dict[str, Any] | None = None


class WorkspaceError(RuntimeError):
    """The server refused, or could not be reached. Carries what the model may be told."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """A 3xx is an auth middleware, not a move; following it would drop the envelope."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def request_headers(token: str, envelope: SignedEnvelope, answer_message_id: str | None = None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        MODE_HEADER: DISCOVERY_MODE,
        "X-Grid-Internal-Token": token,
        # The two that decide WHO this is. Forwarded exactly as they arrived.
        "X-Grid-Request-Context": envelope.header,
        "X-Grid-Request-Context-Sig": envelope.signature,
    }
    if answer_message_id:
        headers[ANSWER_MESSAGE_HEADER] = answer_message_id
    return headers


def _jsonrpc_from(raw: str, content_type: str) -> dict[str, Any]:
    """The JSON-RPC message in a JSON body, or in the last ``data:`` event of an SSE one."""
    if "text/event-stream" in content_type:
        events = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = next((event for event in reversed(events) if event), "")
    message = json.loads(raw)
    if not isinstance(message, dict):
        raise ValueError("not an object")
    return message


def _http_refusal(exc: urllib.error.HTTPError) -> WorkspaceError:
    """The server's own sentence when it sent one (a JSON-RPC error or ``{"error"}``), else the status."""
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - empty, unreadable or not JSON
        payload = None
    detail = None
    if isinstance(payload, dict):
        error = payload.get("error")
        detail = error.get("message") if isinstance(error, dict) else error
    base = f"the workspace server refused the call ({exc.code})"
    text = f"{base}: {detail}" if isinstance(detail, str) and detail.strip() else base
    return WorkspaceError(text, status=exc.code)


def _structured_content(message: dict[str, Any]) -> dict[str, Any] | None:
    """The result's ``structuredContent`` when it is an object and the result is not a tool-level error."""
    result = message.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        return None
    structured = result.get("structuredContent")
    return structured if isinstance(structured, dict) else None


def _result_text(message: dict[str, Any]) -> str:
    """The text of a ``tools/call`` result; a tool-level error is prefixed so the model reads it as one."""
    error = message.get("error")
    if isinstance(error, dict):
        raise WorkspaceError(str(error.get("message") or "the workspace server answered with an error"))
    result = message.get("result")
    if not isinstance(result, dict):
        raise WorkspaceError("the workspace server answered with something that is not a result")
    parts = [str(item.get("text", "")) for item in result.get("content") or [] if isinstance(item, dict)]
    text = "\n".join(part for part in parts if part).strip()
    if not text and result.get("structuredContent") is not None:
        text = json.dumps(result["structuredContent"], ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "\n[gekürzt: Antwort zu lang. Frage enger, mit `query` oder `limit`.]"
    return f"Fehler: {text}" if result.get("isError") else text


def call_tool(
    name: str, arguments: dict[str, Any], envelope: SignedEnvelope, *, answer_message_id: str | None = None
) -> str:
    """One MCP ``tools/call``; the result text. See :func:`call_tool_result` for the rest of the answer."""
    return call_tool_result(name, arguments, envelope, answer_message_id=answer_message_id).text


def call_tool_result(
    name: str, arguments: dict[str, Any], envelope: SignedEnvelope, *, answer_message_id: str | None = None
) -> ToolResult:
    """One MCP ``tools/call``; the text and the ``structuredContent``. Blocking: call it through ``asyncio.to_thread``.

    Raises :class:`WorkspaceError` for a refusal or a transport failure, so the
    tool has one thing to catch. A tool-level error (``isError``) is NOT raised:
    it is the server teaching the model what to fix, and is returned as text.
    ``answer_message_id`` names the answer the turn writes (:data:`ANSWER_MESSAGE_HEADER`); None sends none.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise WorkspaceError("GRID_INTERNAL_API_TOKEN is not configured")

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    request = urllib.request.Request(
        f"{_base_url()}{MCP_PATH}",
        data=json.dumps(body).encode("utf-8"),
        headers=request_headers(token, envelope, answer_message_id),
        method="POST",
    )
    try:
        with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
        message = _jsonrpc_from(raw, content_type)
        return ToolResult(text=_result_text(message), structured=_structured_content(message))
    except urllib.error.HTTPError as exc:
        logger.warning("Workspace MCP refused the call (status=%s)", exc.code)
        raise _http_refusal(exc) from exc
    except WorkspaceError:
        raise
    except Exception as exc:  # noqa: BLE001 - transport or parse; the tool words it for the model
        logger.warning("Workspace MCP could not be reached or read", exc_info=True)
        raise WorkspaceError("the workspace server could not be reached") from exc
