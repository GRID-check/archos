"""The agent's read tools, served to the BFF for other agents (ADR-0122).

``POST /v1/internal/tools/{name}`` runs one of ``BACKEND_READ_TOOLS`` (knowledge
search, passage reading, the file browser, page images, the two BIM tools, RIS)
with the arguments in the body, and answers what the tool returned. The BFF's
MCP server is the only caller: an outside agent reaches Piloti's best reads
through ``/api/mcp`` and the BFF forwards the call here
(``frontends/ui/src/lib/agent-api/backend-operations.ts``).

Two credentials, as for every act of a person on this tier:

* the internal token (``GRID_INTERNAL_API_TOKEN``) says the caller is the BFF;
* the signed ``X-Grid-Request-Context`` envelope says WHO asked and what they
  may read: the organization, the user, the project and the collection scope
  the BFF checked before it signed. The tools read all of it from the turn
  context, so it is laid there exactly as a chat turn lays it, from the
  VERIFIED envelope and nothing the request set itself.

An envelope that is missing, badly signed, unnamed for a user or an
organization, or older than the BFF's own verifier accepts is a 403: the tools
would otherwise run with no person and no scope. This tier verifies and forwards; it never
builds or signs an envelope (ADR-0108).

Only an allowlisted READ runs. A write is a BFF route, because the BFF is the
single writer of ``app`` (ADR-0003) and a person gates it.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from pydantic_core import to_jsonable_python

from aiq_agent.common.backend_tools import is_backend_read_tool
from aiq_agent.common.grounding_block import strip_trace_lanes
from aiq_agent.project_context import ORGANIZATION_ID_HEADER
from aiq_agent.project_context import PROJECT_ID_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import USER_ID_HEADER
from aiq_agent.project_context import GridRequestContext

from ..jobs.access import JOB_ENVELOPE_MAX_AGE_MS
from .builder_state import get_active_builder
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: How many images one door call may render: a ``document-look`` is one look, whatever it asks.
DOOR_LOOKS_PER_CALL = 1

#: Where a read tool is served; the BFF's ``backend-operations.ts`` posts here.
INTERNAL_TOOL_PATH = "/v1/internal/tools/{name}"


class ToolCall(BaseModel):
    """The body: the tool's own arguments, validated against the tool's input schema."""

    arguments: dict[str, Any] = Field(default_factory=dict)


def _verified_context(request: Request) -> GridRequestContext:
    """The envelope's context, or a 403 saying why there is none.

    The bar every reader that trusts the envelope holds it to (``jobs.access.verified_envelope``):
    signed with the shared secret, naming the user and the organization, and inside the
    BFF verifier's window in both directions. Here no user is asserted by the caller, so the
    envelope names the user it speaks for.
    """
    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    context = GridRequestContext.from_envelope(
        request.headers.get(REQUEST_CONTEXT_ENVELOPE_HEADER),
        request.headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
        secret,
    )
    fresh = (
        context is not None
        and context.issued_at is not None
        and abs(int(time.time() * 1000) - context.issued_at) <= JOB_ENVELOPE_MAX_AGE_MS
    )
    if not secret or context is None or not fresh or not context.user_id or not context.organization_id:
        raise HTTPException(
            status_code=403,
            detail={"error": "context_envelope_required", "detail": "a signed, current request-context envelope"},
        )
    return context


@contextmanager
def _turn_headers(request: Request, context: GridRequestContext) -> Iterator[None]:
    """Lay the verified context where the tools read a turn's, for the duration of one call.

    The tools read ``Context.get().metadata.headers``. The envelope travels as it
    arrived (its signature covers those bytes) and the three identity headers come
    from what it VERIFIED, so a header the caller set beside it never reaches a tool.
    """
    from starlette.datastructures import Headers

    from nat.plugin_api import ContextState
    from nat.runtime.user_metadata import RequestAttributes

    headers = {
        REQUEST_CONTEXT_ENVELOPE_HEADER: request.headers[REQUEST_CONTEXT_ENVELOPE_HEADER],
        REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: request.headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER, ""),
        ORGANIZATION_ID_HEADER: context.organization_id or "",
        USER_ID_HEADER: context.user_id or "",
    }
    if context.project_id:
        headers[PROJECT_ID_HEADER] = context.project_id
    attributes = RequestAttributes()
    attributes._request.headers = Headers(headers={name: value for name, value in headers.items() if value})
    state = ContextState.get()
    token = state.metadata.set(attributes)
    try:
        yield
    finally:
        state.metadata.reset(token)


@contextmanager
def _metered_call() -> Iterator[None]:
    """One door call as one bounded, booked unit of work, the way a chat turn is.

    The usage ledger: every model call a tool makes (a ``look``'s reading, a
    search's rerank) is booked to the person and organization the envelope
    verified, inside their budget, and reaches the BFF's budget gate, which
    refuses the next door call once it is spent. The image budget: a call gets
    a fresh one of :data:`DOOR_LOOKS_PER_CALL`, so one ``document-look`` costs one
    look, its reading included. The door's
    calls themselves are bounded by the budget, not by a per-call price.
    """
    from aiq_agent.common.cost_tracking import track_llm_costs
    from aiq_agent.common.image_view_budget import begin_image_view_budget
    from aiq_agent.common.image_view_budget import end_image_view_budget

    token = begin_image_view_budget(limit=DOOR_LOOKS_PER_CALL)
    try:
        with track_llm_costs():
            yield
    finally:
        end_image_view_budget(token)


def _wire(result: Any) -> Any:
    """What a tool returned, as JSON: text stays text, content blocks stay blocks.

    The evidence tools end their text with a ``## Trace-Lanes`` JSON line. It is
    the product's own trace (the derivation reads the records the renderer filed,
    never this line) and noise to an outside agent, so the door drops it here;
    the in-product path never passes through this route and keeps it.
    """
    if isinstance(result, str):
        return strip_trace_lanes(result)
    return to_jsonable_python(result, fallback=str)


def add_internal_tool_routes(router: APIRouter) -> None:
    """Add the read-tool route to the knowledge router."""

    @router.post(
        INTERNAL_TOOL_PATH,
        tags=["internal"],
        summary="Run one of the agent's read tools for the person the envelope names (internal)",
    )
    async def run_tool(name: str, call: ToolCall, request: Request) -> dict[str, Any]:
        _require_internal_token(request)
        if not is_backend_read_tool(name):
            # The allowlist answers before the workflow is asked, so a tool that
            # exists but is not a read looks the same as one that does not.
            raise HTTPException(status_code=404, detail={"error": "unknown_tool", "tool": name})
        context = _verified_context(request)

        builder = get_active_builder()
        if builder is None:
            raise HTTPException(status_code=503, detail={"error": "workflow_not_ready"})
        try:
            function = await builder.get_function(name)
        except ValueError as exc:
            # The allowlist names it and this deployment's config does not bind it.
            raise HTTPException(status_code=404, detail={"error": "tool_not_configured", "tool": name}) from exc
        try:
            arguments = function.input_schema.model_validate(call.arguments)
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"error": "invalid_arguments", "tool": name, "issues": exc.errors(include_input=False)},
            ) from exc

        with _turn_headers(request, context), _metered_call():
            try:
                result = await function.ainvoke(arguments)
            except Exception as exc:
                logger.exception("Read tool %s failed for user %s", name, context.user_id)
                raise HTTPException(status_code=502, detail={"error": "tool_failed", "tool": name}) from exc
        return {"tool": name, "result": _wire(result)}
