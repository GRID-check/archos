"""The geometry service speaks MCP: one tool per operation, over streamable HTTP at ``/mcp``.

Its only client is the BFF's gateway (``POST /api/bim/models/{id}/geometry``, ADR-0149), which
decides all access, then calls the tool named by the operation. Each call is one stateless HTTP
POST answered with JSON (``tools/list``, ``tools/call``), so every call carries its own credentials
as headers:

* ``x-internal-token``: the caller is the BFF (checked before MCP sees the request, ``app.py``);
* the request-context envelope: whom the work is for (a trace, a log), not consulted for access;
* ``x-model-sources``: the already-authorized source of each model the call reads, signed for this
  call's model and tool (``signed_sources.py``). A ``tools/call`` without one fetches nothing and
  is answered as an error result with ``source_not_signed``.

The tools are the operations of ``wire.py``; their input schemas are generated from the same
pydantic models the call is validated with, plus ``modelId``. A result's ``structuredContent`` is
``{op, result, meta}`` (``result`` is the engine's Answer); a refusal is ``isError`` with
``structuredContent`` ``{status, code, error, retryAfter?}``, which the BFF maps like an HTTP status.

The MCP SDK is the official ``mcp`` package (1.x, in the workspace lock), its low-level ``Server``
and ``StreamableHTTPSessionManager`` in stateless JSON mode. The engine's own stdio server
(``ifc_spatial.mcp_server``) is not reused: it speaks in file paths and model handles, with no
notion of a source handed over by someone who decided access.
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
from typing import Any

from mcp import types
from mcp.server.lowlevel import Server
from pydantic import ValidationError
from starlette.datastructures import Headers

from agent.common.envelope_auth import ENVELOPE_HEADER
from agent.common.envelope_auth import ENVELOPE_SIG_HEADER
from agent.common.envelope_auth import verified_envelope_context

from . import operations
from .refusals import body
from .refusals import refusal
from .signed_sources import SOURCES_HEADER
from .signed_sources import SOURCES_SIG_HEADER
from .signed_sources import verified_sources
from .trace import call_facts
from .trace import log_call
from .trace import model_handle
from .wire import BoxesOp
from .wire import ClashOp
from .wire import DiffOp
from .wire import GeometryRequest
from .wire import GroupBoxesOp
from .wire import InRoomOp
from .wire import NearOp
from .wire import NeighboursOp
from .wire import WarmOp
from .wire import WithinOp

#: The Langfuse trace the BFF opened for this call; a cold build scores `geometry-cold-ms` on it.
TRACE_HEADER = "x-trace-id"
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")

#: Each operation as a tool: its model and its description. English, coordinates IFC world, Z-up, metres.
_TOOLS: dict[str, tuple[type, str]] = {
    "boxes": (BoxesOp, "Each element's axis-aligned box (min, max) and centroid, their union, and missing ids."),
    "group-boxes": (GroupBoxesOp, "One union box per named group of GlobalIds."),
    "within": (WithinOp, "Elements whose box meets a region: a box, or an element's box grown by margin."),
    "near": (NearOp, "Elements within radius of a point or an element, nearest first, with distances."),
    "in-room": (InRoomOp, "What a space holds: declared by containment and computed from geometry, each tagged."),
    "neighbours": (NeighboursOp, "Elements whose surface comes within gap of an element's surface."),
    "clash": (ClashOp, "Pairs between two sets that intersect, touch or come closer than a clearance."),
    "diff": (DiffOp, "Per GlobalId against an earlier revision: added, removed, moved, resized or unchanged."),
    "warm": (WarmOp, "Prepare the model's element index in the background; returns at once."),
}


def _input_schema(model: type) -> dict[str, Any]:
    """The operation model's JSON Schema without ``op`` (the tool's name says it), plus ``modelId``."""
    schema = copy.deepcopy(model.model_json_schema(by_alias=True))  # type: ignore[attr-defined]
    schema["properties"].pop("op", None)
    schema["properties"] = {
        "modelId": {"type": "string", "description": "The model (revision) id."},
        **schema["properties"],
    }
    schema["required"] = ["modelId", *[name for name in schema.get("required", []) if name != "op"]]
    schema.pop("title", None)
    return schema


TOOLS = [
    types.Tool(
        name=name, description=f"{text} Coordinates are IFC world, Z-up, metres.", inputSchema=_input_schema(model)
    )
    for name, (model, text) in _TOOLS.items()
]


def _error(refused: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(refused))],
        structuredContent=refused,
        isError=True,
    )


def _request(name: str, arguments: dict[str, Any]) -> GeometryRequest:
    operation = {key: value for key, value in arguments.items() if key != "modelId"}
    return GeometryRequest.model_validate({"modelId": arguments.get("modelId"), "operation": {"op": name, **operation}})


def _sources(headers: Headers, request: GeometryRequest) -> dict[str, dict[str, Any]] | types.CallToolResult:
    context = verified_envelope_context(headers.get(ENVELOPE_HEADER), headers.get(ENVELOPE_SIG_HEADER))
    if context is None:
        return _error(body(403, "context_envelope_required", "a signed, current request-context envelope"))
    sources = verified_sources(
        headers.get(SOURCES_HEADER),
        headers.get(SOURCES_SIG_HEADER),
        context,
        model_id=request.model_id,
        op=request.operation.op,
    )
    if not sources:
        return _error(body(403, "source_not_signed", "no source handed over for this call"))
    return sources


async def answer(name: str, arguments: dict[str, Any], headers: Headers) -> types.CallToolResult:
    """One ``tools/call``: validate, take the handed-over sources, run the operation, or refuse."""
    if name not in _TOOLS:
        return _error(body(404, "unknown_tool", f"no tool {name}"))
    try:
        request = _request(name, arguments)
    except ValidationError as exc:
        return _error(body(400, "invalid_request", exc.errors(include_input=False, include_url=False)[0]["msg"]))
    sources = _sources(headers, request)
    if isinstance(sources, types.CallToolResult):
        return sources
    trace = headers.get(TRACE_HEADER, "")
    try:
        outcome = await asyncio.to_thread(operations.run, request, sources, trace if _TRACE_ID.match(trace) else None)
    except Exception as exc:  # noqa: BLE001 - every failure is answered as a refusal
        refused = refusal(exc)
        log_call(ifc_op=name, ifc_outcome=refused["code"], ifc_model=model_handle(request.model_id))
        return _error(refused)
    log_call(**call_facts(outcome, model_id=request.model_id))
    meta = {
        "cacheTier": outcome.cache_tier,
        "ms": outcome.ms,
        "elements": outcome.elements,
        "truncated": outcome.truncated,
    }
    structured = {"op": outcome.op, "result": outcome.result, "meta": meta}
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(structured))], structuredContent=structured
    )


def create_server() -> Server:
    server: Server = Server("geometry")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return TOOLS

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        http_request = server.request_context.request
        headers = http_request.headers if http_request is not None else Headers()
        return await answer(name, arguments or {}, headers)

    return server
