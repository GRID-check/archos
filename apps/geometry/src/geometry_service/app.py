"""The geometry service's HTTP surface (ADR-0149): the MCP endpoint and two probes.

``/mcp`` is the service's MCP server (``mcp_server.py``): one tool per geometry operation, streamable
HTTP, stateless, JSON responses. Its one client is the BFF's gateway. The internal token is checked
here, before MCP sees the request: a caller without it gets a plain 403 and no MCP session at all.
Each ``tools/call`` then checks the envelope and the handed-over sources itself.

The service decides no access: it knows nothing about people, projects or folders. The BFF decides
all of it and hands over an already-authorized source per model; the signature on it is input
integrity, so this service fetches nothing else.

``/healthz`` is liveness (the process answers). ``/readyz`` is readiness: the engine imports and
the internal token is configured, without which every call would be refused.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

from agent.common.envelope_auth import internal_token_refusal

from . import engine
from .mcp_server import create_server

MCP_PATH = "/mcp"


class _TokenGuard:
    """The internal token before MCP: no token, no session."""

    def __init__(self, manager: StreamableHTTPSessionManager) -> None:
        self.manager = manager

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        refused = internal_token_refusal(headers.get)
        if refused is not None:
            response = JSONResponse(status_code=refused[0], content={"code": "forbidden", "error": refused[1]})
            await response(scope, receive, send)
            return
        await self.manager.handle_request(scope, receive, send)


def create_app() -> FastAPI:
    manager = StreamableHTTPSessionManager(app=create_server(), json_response=True, stateless=True)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with manager.run():
            yield

    app = FastAPI(title="Geometry", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        ready = bool(os.environ.get("INTERNAL_API_TOKEN")) and await asyncio.to_thread(engine.current().available)
        return JSONResponse(status_code=200 if ready else 503, content={"ready": ready})

    app.mount(MCP_PATH, _TokenGuard(manager))
    return app


app = create_app()
