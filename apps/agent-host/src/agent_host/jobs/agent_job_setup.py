"""The prepare phase of a research job: its models, its tools, and the request it stands in for.

``agent_job.run_agent_job`` runs these after the claim and before the agent. A
background worker has no inbound request, so everything a chat turn would read
from its headers (collection scope, project context, model overrides, whose
project, as whom, what the project remembers) is placed in the worker's
request metadata here, and every reader downstream works unchanged. The
models get every dial a chat turn's do: per-org overrides, the platform's
thinking level, the organization's own key (BYOK) and zero data retention.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING
from typing import Any

from agent.project_context import PROJECT_MEMORY_HEADER
from agent.project_context import compose_project_context

from .run_envelope import envelope_headers_for_run
from .run_result import extract_result
from .runner import WORKER_IDENTITY_HEADERS
from .runner import _b64url_encode_text
from .runner import _create_llm_provider
from .runner import _identity_values
from .runner import _inject_worker_headers
from .runner import _normalize_trace_id
from .runner import _resolve_worker_tool_refs
from .runner import _run_user_info

if TYPE_CHECKING:
    from .agent_job import JobRequest

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobModels:
    """The agent's function config and its models, with every dial applied."""

    fn_config: Any
    provider: Any
    llm: Any
    # The organization's own credential, re-applied by the reflection pass, which builds its own LLM.
    org_credential: Any
    zdr: bool


@dataclass(frozen=True)
class RunContext:
    """The agent-runtime context the job runs in, and what it resolved about the requester."""

    state: Any
    context: Any
    trace_id: int
    span_name: str
    event_stream: Any
    user_info: dict | None
    memory_digest: str | None
    # Profile and memory, composed as ``get_project_context_from_context()`` composes them.
    project_context: str | None

    def open_spans(self, request: JobRequest, workflow: Any, parent: Any) -> None:
        """Push the parent span (when there is one) and WORKFLOW_START, so LLM and tool events nest under them."""
        from nat.data_models.intermediate_step import IntermediateStepPayload
        from nat.data_models.intermediate_step import IntermediateStepType
        from nat.data_models.intermediate_step import StreamEventData

        steps = self.context.intermediate_step_manager
        if parent is not None:
            name = request.parent_function_name or "parent_workflow"
            steps.push_intermediate_step(
                IntermediateStepPayload(
                    UUID=request.parent_span_id, event_type=IntermediateStepType.SPAN_START, name=name, metadata=parent
                )
            )
        steps.push_intermediate_step(
            IntermediateStepPayload(
                UUID=request.job_id,
                event_type=IntermediateStepType.WORKFLOW_START,
                name=self.span_name,
                metadata=workflow,
                data=StreamEventData(input=request.input_text),
            )
        )

    def close_spans(self, request: JobRequest, result: Any, workflow: Any, parent: Any) -> None:
        """Push WORKFLOW_END and the parent's SPAN_END, then complete the event stream."""
        from nat.data_models.intermediate_step import IntermediateStepPayload
        from nat.data_models.intermediate_step import IntermediateStepType
        from nat.data_models.intermediate_step import StreamEventData

        steps = self.context.intermediate_step_manager
        steps.push_intermediate_step(
            IntermediateStepPayload(
                UUID=request.job_id,
                event_type=IntermediateStepType.WORKFLOW_END,
                name=self.span_name,
                metadata=workflow,
                data=StreamEventData(output=extract_result(result)),
            )
        )
        if parent is not None:
            name = request.parent_function_name or "parent_workflow"
            steps.push_intermediate_step(
                IntermediateStepPayload(
                    UUID=request.parent_span_id, event_type=IntermediateStepType.SPAN_END, name=name, metadata=parent
                )
            )
        self.event_stream.on_complete()


async def prepare_models(builder: Any, request: JobRequest) -> JobModels:
    """The agent's config and its models: per-org overrides, thinking level, BYOK, then zero data retention."""
    from agent.common import LLMRole
    from agent.common import get_reasoning_efforts
    from agent.common import resolve_org_llm_credential
    from agent.common import sanitize_model_overrides
    from agent.common.openrouter import data_policy_for

    fn_config = _function_config(builder, request.agent_config_name)
    built, llm = await _create_llm_provider(builder, fn_config)
    provider = built
    # On the provider itself, not only through the header bind_request injects,
    # so the override holds whenever the agent resolves its LLMs.
    if request.model_overrides:
        provider = provider.with_model_overrides(sanitize_model_overrides(request.model_overrides))
    # The platform owner's thinking level per group: platform-wide, so resolved
    # here as the chat replicas do. Off the loop: a cold cache is a BFF call.
    provider = provider.with_reasoning_efforts(await asyncio.to_thread(get_reasoning_efforts))
    # BYOK (ADR-0022): the org's own credential, fetched just in time and never
    # carried in the payload; resolution fails open to the platform credential.
    org_credential = None
    if request.organization_id:
        # Off the loop: a cold or expired cache is a BFF call.
        org_credential = await asyncio.to_thread(resolve_org_llm_credential, request.organization_id)
    if org_credential is not None:
        provider = provider.with_credential(org_credential)
    # Zero Data Retention (ADR-0014), after BYOK so the pin lands only on models
    # still pointing at OpenRouter. Every model the job builds comes from this
    # provider, so pinning it pins them all. Off the loop; fails closed.
    data_policy = await asyncio.to_thread(data_policy_for, request.organization_id)
    provider = provider.with_zdr(data_policy.zdr)
    if provider is not built and llm is not None:
        llm = provider.get(LLMRole.ORCHESTRATOR)
    return JobModels(
        fn_config=fn_config, provider=provider, llm=llm, org_credential=org_credential, zdr=data_policy.zdr
    )


def _function_config(builder: Any, name: str) -> Any:
    """The agent's function config; deep research's with its skills and sandbox resolved for this run."""
    fn_config = builder.get_function_config(name)
    if getattr(fn_config, "type", None) != "deep_research_agent":
        return fn_config
    from agent.agents.deep_researcher.register import DeepResearchAgentConfig
    from agent.agents.deep_researcher.register import resolve_deep_research_runtime_config

    if not isinstance(fn_config, DeepResearchAgentConfig):
        return fn_config
    skills_config, sandbox_config = resolve_deep_research_runtime_config(fn_config, builder)
    return fn_config.model_copy(update={"skills": skills_config, "sandbox": sandbox_config})


async def prepare_tools(builder: Any, fn_config: Any, data_sources: list[str] | None) -> list[Any]:
    """The agent's tools: its list (else the whole data-source registry), less its exclusions and the job's sources."""
    from nat.plugin_api import LLMFrameworkEnum

    tools = await builder.get_tools(
        tool_names=_resolve_worker_tool_refs(fn_config), wrapper_type=LLMFrameworkEnum.LANGCHAIN
    )
    excluded = set(getattr(fn_config, "exclude_tools", None) or ())
    tools = [tool for tool in tools if getattr(tool, "name", "") not in excluded]
    if data_sources is not None:
        from agent.common import filter_tools_by_sources

        tools = filter_tools_by_sources(tools, data_sources)
    return tools


async def bind_request(request: JobRequest, fn_config: Any) -> RunContext:
    """Start the job's agent-runtime context, parented under the submitter's trace, and supply its request headers."""
    from nat.data_models.invocation_node import InvocationNode
    from nat.plugin_api import Context
    from nat.plugin_api import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.workflow_run_id.set(request.job_id)
    if request.parent_conversation_id:
        state.conversation_id.set(request.parent_conversation_id)
    trace_id = _normalize_trace_id(request.parent_workflow_trace_id) or uuid.uuid4().int
    state.workflow_trace_id.set(trace_id)
    event_stream = Subject()  # what the exporters subscribe to
    state.event_stream.set(event_stream)
    _ = state.active_span_id_stack  # initialises the stack to ["root"]
    span_name = f"async_job:{request.agent_config_name}"
    state.active_function.set(
        InvocationNode(
            function_name=span_name,
            function_id=request.job_id,
            parent_id=request.parent_function_id,
            parent_name=request.parent_function_name,
        )
    )
    _inject_scope_headers(state, request, fn_config)
    user_info = await _inject_identity_headers(state, request)
    memory_digest = await _inject_memory_header(state, request)
    return RunContext(
        state=state,
        context=Context(state),
        trace_id=trace_id,
        span_name=span_name,
        event_stream=event_stream,
        user_info=user_info,
        memory_digest=memory_digest,
        project_context=compose_project_context(request.project_context, memory_digest),
    )


def _inject_scope_headers(state: Any, request: JobRequest, fn_config: Any) -> None:
    """Collection scope, project context and model overrides, as a synchronous request would carry them.

    Every free-text header is base64url (``_b64url_encode_text``): a raw German
    quote or em-dash makes Starlette's latin-1 header encoding throw before the
    agent ever starts, an instant job failure with zero events.
    """
    from agent.common import MODEL_OVERRIDES_HEADER
    from agent.project_context import normalize_project_context

    headers: dict[str, str] = {}
    if request.collection_scope is not None:
        headers["x-grid-collection-scope"] = _b64url_encode_text(json.dumps(request.collection_scope))
    elif getattr(fn_config, "type", None) == "deep_research_agent":
        _warn_unscoped(request)
    if request.project_context is not None:
        normalized = normalize_project_context(request.project_context)
        if normalized:
            headers["x-grid-project-context"] = _b64url_encode_text(normalized)
    if request.model_overrides:
        headers[MODEL_OVERRIDES_HEADER] = _b64url_encode_text(json.dumps(request.model_overrides))
    if headers:
        _inject_worker_headers(state, headers)


def _warn_unscoped(request: JobRequest) -> None:
    """Log, once per job, that a deep-research job without a collection scope cannot see project collections.

    Retrieval then falls back to the base corpus and the session collection
    with no other signal that a project's documents were invisible.
    """
    identity = request.identity
    logger.warning(
        "Job %s: async deep-research job has no collection scope; knowledge "
        "retrieval will search only the base/OIB and s_<conversation> session "
        "collections for this job — project collections will be invisible "
        "(authenticated=%s, project_scoped=%s)",
        request.job_id,
        bool(identity.get("organization_id") or identity.get("user_id")),
        bool(identity.get("project_id") or request.project_context),
    )


async def _inject_identity_headers(state: Any, request: JobRequest) -> dict | None:
    """WHO the job runs for, and AS WHOM it acts (ADR-0108); the requester's ``user_info``.

    The identity headers are what every project-scoped tool reads back through
    ``get_project_id_from_context()``. Only the envelope the BFF signed lets a
    tool act as that person; it is echoed, renewed by the BFF when stale, and
    never built here.
    """
    identity = request.identity
    identity_headers = {
        name: value
        for name, value in zip(WORKER_IDENTITY_HEADERS, _identity_values(identity), strict=True)
        if isinstance(value, str) and value.strip()
    }
    if identity_headers:
        _inject_worker_headers(state, identity_headers)
    envelope_headers = await envelope_headers_for_run(
        request.request_envelope, run_id=request.run_id, job_id=request.job_id, identity=identity
    )
    if envelope_headers:
        _inject_worker_headers(state, envelope_headers)
    return _run_user_info(request.user_info, envelope_headers)


async def _inject_memory_header(state: Any, request: JobRequest) -> str | None:
    """WHAT the project already knows: a live digest, else the one the BFF built at submit.

    The chat path's discipline (``piloti/conversation_register.py``): a
    successful fetch is authoritative even when empty, since memory may have
    been cleared since the job fired.
    """
    identity = request.identity
    digest = request.project_memory
    if identity.get("project_id") or identity.get("organization_id"):
        try:
            from agent.knowledge.project_memory import fetch_memory_digest

            digest = await asyncio.to_thread(
                fetch_memory_digest,
                project_id=identity.get("project_id"),
                organization_id=identity.get("organization_id"),
                query=request.input_text,
            )
        except Exception:
            logger.warning(
                "Job %s: live memory digest fetch failed; using the digest from submit time",
                request.job_id,
                exc_info=True,
            )
    if digest:
        _inject_worker_headers(state, {PROJECT_MEMORY_HEADER: _b64url_encode_text(digest)})
    return digest


def trace_metadata(request: JobRequest, run: RunContext) -> tuple[Any, Any]:
    """The workflow span's metadata, and the parent span's (None when the job has no parent span)."""
    from nat.data_models.intermediate_step import TraceMetadata

    trace_hex = f"{run.trace_id:032x}"
    workflow = TraceMetadata(
        provided_metadata={
            "workflow_run_id": request.job_id,
            "workflow_trace_id": trace_hex,
            "conversation_id": request.parent_conversation_id,
            "agent": request.agent_class_path,
            "parent_workflow_run_id": request.parent_workflow_run_id,
            "parent_workflow_name": request.parent_function_name,
        }
    )
    if not request.parent_span_id or request.parent_span_id == "root":
        return workflow, None
    parent = TraceMetadata(
        provided_metadata={
            "workflow_run_id": request.parent_workflow_run_id,
            "workflow_trace_id": trace_hex,
            "conversation_id": request.parent_conversation_id,
            "workflow_name": request.parent_function_name,
        }
    )
    return workflow, parent
