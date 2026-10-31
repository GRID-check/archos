"""The service's MCP server, through the official MCP client: what it lists, and what a call needs.

The engine and the model download are faked as in ``test_geometry_service.py``
(``geometry_testing.service``); the client is ``mcp.ClientSession`` over streamable HTTP, against the app in
process. A call without a source the BFF handed over is refused as an error result, never answered.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from geometry_service.app import MCP_PATH
from geometry_service.app import create_app
from geometry_testing.service import GID
from geometry_testing.service import MODEL
from geometry_testing.service import SECRET
from geometry_testing.service import headers_for
from geometry_testing.service import install_fakes
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


@pytest.fixture
def fake(monkeypatch):
    yield from install_fakes(monkeypatch)


async def _session_call(headers: dict[str, str], action) -> Any:
    app = create_app()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://geometry", headers=headers) as http:
            async with streamable_http_client(f"http://geometry{MCP_PATH}/", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    return await action(session)


def test_tools_list_names_every_operation_with_an_english_schema(fake) -> None:
    tools = asyncio.run(_session_call({"x-internal-token": SECRET}, lambda s: s.list_tools())).tools
    assert [tool.name for tool in tools] == [
        "boxes",
        "group-boxes",
        "within",
        "near",
        "in-room",
        "neighbours",
        "clash",
        "diff",
        "warm",
    ]
    for tool in tools:
        assert "IFC world, Z-up, metres" in (tool.description or "")
        assert tool.inputSchema["required"][0] == "modelId"
        assert "op" not in tool.inputSchema["properties"]


def test_a_call_with_the_handed_over_source_answers(fake) -> None:
    body = {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}
    result = asyncio.run(
        _session_call(headers_for(body), lambda s: s.call_tool("boxes", {"modelId": MODEL, "globalIds": [GID]}))
    )
    assert result.isError is False
    assert result.structuredContent["result"]["value"]["boxes"][0]["globalId"] == GID


def test_a_call_without_a_handed_over_source_is_refused(fake) -> None:
    source, _, _ = fake
    body = {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}
    headers = {k: v for k, v in headers_for(body).items() if not k.startswith("x-model-sources")}
    result = asyncio.run(_session_call(headers, lambda s: s.call_tool("boxes", {"modelId": MODEL, "globalIds": [GID]})))
    assert result.isError is True
    assert result.structuredContent["code"] == "source_not_signed"
    assert source.downloads == 0


def test_a_source_signed_for_another_tool_is_refused(fake) -> None:
    body = {"modelId": MODEL, "operation": {"op": "warm"}}  # signed for warm, called as boxes
    result = asyncio.run(
        _session_call(headers_for(body), lambda s: s.call_tool("boxes", {"modelId": MODEL, "globalIds": [GID]}))
    )
    assert (result.isError, result.structuredContent["code"]) == (True, "source_not_signed")


def test_without_the_internal_token_there_is_no_session(fake) -> None:
    with TestRefused() as refused:
        asyncio.run(_session_call({}, lambda s: s.list_tools()))
    assert refused.raised


class TestRefused:
    """Any failure to open the session counts: the MCP client surfaces a 403 as an exception group."""

    raised = False

    def __enter__(self) -> TestRefused:
        return self

    def __exit__(self, kind, *_rest) -> bool:
        self.raised = kind is not None
        return True
