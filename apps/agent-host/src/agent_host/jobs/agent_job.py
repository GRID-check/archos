"""One research job, in phases: claim, prepare, run, persist, finish.

The research worker (``jobs/worker.py``) claims a queued row and awaits
``run_agent_job`` with its payload. This is the one place a research job runs
(ADR-0021), and the function reads as its phases, each a function with one job:

- ``_claim``: the job store's RUNNING write, refused when a cancel or the reaper
  finalized the job between the queue claim and here;
- ``_prepare_models``, ``_prepare_tools`` and ``_bind_request``: the agent's
  config, its models with every dial (overrides, thinking level, BYOK, zero
  data retention), its tools, and the request metadata a background run has to
  supply by hand because it has no inbound request;
- ``_run``: the agent, inside its workflow span, cost tracking and card channel;
- ``_persist``: the post-report passes, the cards and the marks the run left on
  its answer, folded into the job output;
- ``_finish``: the terminal SUCCESS write, the thread turn and the
  notification, each gated on this run owning the verdict.

``_finish_failed`` and ``_release`` are the failure and ``finally`` paths;
``runner._finalize_cancelled_run`` is the cancelled one. ``JobScope`` carries
what those terminal paths close, whether or not setup got that far. The
helpers each phase calls live in ``jobs/runner.py``; what a finished run's state
says (report, sources, the marks on its answer) is read in ``jobs/run_result.py``.

A parameter of ``run_agent_job`` is a payload key: removing or renaming one
needs its old name in ``worker.RETIRED_PAYLOAD_KEYS``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from agent.common.plan_documents import PlanDocuments
from agent.common.plan_documents import sanitize_plan_documents
from agent.common.provider_limiter import RESEARCH
from agent.common.provider_limiter import with_provider_class
from agent.observability import boot_timing
from agent.observability.boot_timing import BootClock

from .agent_job_setup import RunContext
from .agent_job_setup import bind_request
from .agent_job_setup import prepare_models
from .agent_job_setup import prepare_tools
from .agent_job_setup import trace_metadata
from .callbacks import AgentEventCallback
from .event_store import BatchingEventStore
from .event_store import EventStore
from .job_outcome import JobOutcome
from .job_outcome import finish
from .job_outcome import finish_failed
from .job_outcome import persist
from .phase_events import PhaseProgressCallback
from .run_ledger_fold import RunLedgerFold
from .runner import _BUDGET_GUARDED_AGENT_TYPES
from .runner import _JOB_PROFILE_NAMES
from .runner import CancellationMonitor
from .runner import _bound_card_registry
from .runner import _create_agent_instance
from .runner import _finalize_cancelled_run
from .runner import _load_agent_class
from .runner import _purge_deep_checkpoint_unless_reclaimed
from .runner import _resolve_deep_research_checkpointer
from .runner import _run_agent
from .runner import _update_status_if_not_terminal

logger = logging.getLogger(__name__)

#: ``run_agent_job`` parameters that set up the process, not the job.
_PROCESS_KNOBS = frozenset({"configure_logging", "log_level"})


@dataclass(frozen=True)
class JobRequest:
    """The job's payload: ``run_agent_job``'s parameters less the logging knobs, one field each."""

    # The job store's and the event store's database.
    db_url: str
    # The NAT config, the agent class's module path, and its function in that config.
    config_file_path: str
    job_id: str
    # The query the job runs.
    input_text: str
    agent_class_path: str
    agent_config_name: str
    # The submitting workflow's span, run, trace and conversation, and its trace
    # tags at submit, so the job's trace continues the caller's.
    parent_span_id: str | None = None
    parent_function_id: str | None = None
    parent_function_name: str | None = None
    parent_workflow_run_id: str | None = None
    parent_workflow_trace_id: int | str | None = None
    parent_conversation_id: str | None = None
    request_trace_tags: dict[str, str] | None = None
    # What the agent may read: document summaries, allowed sources, collections.
    available_documents: list[dict] | None = None
    data_sources: list[str] | None = None
    # The request's token, for data sources with ``requires_auth``.
    auth_token: str | None = None
    collection_scope: list[str] | None = None
    # The project profile, injected as the ``x-grid-project-context`` header.
    project_context: str | None = None
    # The memory digest the BFF built when the job fired. A FALLBACK: the worker
    # fetches a live digest first (a queued job may wait minutes) and keeps this
    # one only when that fetch fails.
    project_memory: str | None = None
    # The rendered PLATFORM_LESSONS block: request contextvars do not survive into a worker.
    platform_lessons: str | None = None
    # Per-org ``{agent_group: model_id}`` from the submitting request.
    model_overrides: dict[str, str] | None = None
    # Identity and budget at submit, for cost tracking, BYOK, zero data
    # retention and the identity headers (``capture_usage_context()``).
    usage_context: dict | None = None
    # What the prompts render about the requester and the clarifier dialog.
    user_info: dict | None = None
    clarifier_result: str | None = None
    # The post-report memory reflection, captured from the submit's feature flag,
    # and its ``llms:`` ref (else the workflow's own).
    memory_reflection_enabled: bool = False
    memory_reflection_llm: str | None = None
    # The worker's own id, filled in at replay, for the still-owner publish
    # gate. None (unclaimed) leaves only the terminal verdict to gate publishing.
    claim_owner: str | None = None
    # The ``task_runs`` row this job is, for the run ledger's flush. Without it
    # the ledger still folds and streams as ``run.ledger``, and posts nothing.
    run_id: str | None = None
    # The Unterlagen named on the plan card (``plan_documents`` contract).
    documents: dict | None = None
    # The requester's signed ``{header, signature}`` (ADR-0108), echoed to the
    # tools that act as a person; renewed when stale, dropped on any refusal.
    request_envelope: dict | None = None

    @property
    def identity(self) -> dict:
        """Who the job runs for, captured at submit: project, organization and user ids."""
        return (self.usage_context or {}).get("identity") or {}

    @property
    def organization_id(self) -> str | None:
        return self.identity.get("organization_id")

    @property
    def expect_run(self) -> bool:
        """A job with a run id was submitted for a ``task_runs`` row: a 404 there is "not yet", and retried."""
        return self.run_id is not None


@dataclass
class JobScope:
    """What the terminal paths close or finalize, filled in as the phases get that far."""

    job_store: Any = None
    monitor: CancellationMonitor | None = None
    event_store: Any = None
    # The run's own account of itself (``jobs/run_ledger_fold.py``), sealed by ``_release``.
    ledger: RunLedgerFold | None = None
    auth_token_reset: Any = None
    plan_documents: PlanDocuments | None = None
    agent_event_callback: AgentEventCallback | None = None
    card_snapshot: list[dict[str, Any]] = field(default_factory=list)


@with_provider_class(RESEARCH)
async def run_agent_job(
    configure_logging: bool,
    log_level: int,
    db_url: str,
    config_file_path: str,
    job_id: str,
    input_text: str,
    agent_class_path: str,
    agent_config_name: str,
    parent_span_id: str | None = None,
    parent_function_id: str | None = None,
    parent_function_name: str | None = None,
    parent_workflow_run_id: str | None = None,
    parent_workflow_trace_id: int | str | None = None,
    parent_conversation_id: str | None = None,
    request_trace_tags: dict[str, str] | None = None,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    auth_token: str | None = None,
    collection_scope: list[str] | None = None,
    project_context: str | None = None,
    project_memory: str | None = None,
    platform_lessons: str | None = None,
    model_overrides: dict[str, str] | None = None,
    usage_context: dict | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
    memory_reflection_enabled: bool = False,
    memory_reflection_llm: str | None = None,
    claim_owner: str | None = None,
    run_id: str | None = None,
    documents: dict | None = None,
    request_envelope: dict | None = None,
):
    """Run any registered agent as a research job, cancellable, traced under its caller's span.

    The parameters are the queue payload; ``JobRequest`` documents each one.
    """
    request = JobRequest(**{name: value for name, value in locals().items() if name not in _PROCESS_KNOBS})
    scope = JobScope()
    _prepare_process(scope, request, configure_logging, log_level)
    try:
        await _execute(scope, request)
    except asyncio.CancelledError:
        await _finish_cancelled(scope, request)
    except Exception as exc:
        await finish_failed(scope, request, exc)
    finally:
        await _release(scope, request)
        # Drop the run's durable deep-checkpoint rows once the run is terminal,
        # unless another worker now owns the job (see the helper).
        await _purge_deep_checkpoint_unless_reclaimed(request.db_url, request.job_id, request.claim_owner)


async def _finish_cancelled(scope: JobScope, request: JobRequest) -> None:
    """Record a run that was cancelled, or lost its claim: the two are told apart inside, by claim state.

    A user cancel keeps its INTERRUPTED verdict, notice and ``job.cancelled``
    event; the loser of a reclaim emits ``job.ownership-lost`` only.
    """
    scope.event_store = await _finalize_cancelled_run(
        job_store=scope.job_store,
        db_url=request.db_url,
        job_id=request.job_id,
        claim_owner=request.claim_owner,
        parent_conversation_id=request.parent_conversation_id,
        usage_context=request.usage_context,
        event_store=scope.event_store,
        expect_run=request.expect_run,
    )


def _prepare_process(scope: JobScope, request: JobRequest, configure_logging: bool, log_level: int) -> None:
    """The per-job process setup: the job's auth token, trace-tag injection, logging."""
    if request.auth_token:
        # A ContextVar, so concurrent jobs in one worker never see each other's token.
        from ._auth_context import job_auth_token

        scope.auth_token_reset = job_auth_token.set(request.auth_token)

    from agent.common.logging_utils import suppress_noisy_dependency_logs
    from agent.common.nat_step_repair import install_step_stack_repair
    from agent_host.auth.request_trace import install_request_trace_span_injection

    install_request_trace_span_injection()
    if configure_logging:
        try:
            from nat.utils.log_utils import setup_logging

            setup_logging(log_level)
        except ImportError:
            logging.basicConfig(level=log_level)
    # Quiet NAT's per-parallel-step span-stack warnings (deep research's fan-out
    # triggers them on every parallel call) and keep LangGraph's steps parented,
    # or their spans never reach Langfuse.
    suppress_noisy_dependency_logs()
    install_step_stack_repair()
    logger.info(
        "Research worker received: agent=%s, config=%s, job_id=%s",
        request.agent_class_path,
        request.agent_config_name,
        request.job_id,
    )


async def _execute(scope: JobScope, request: JobRequest) -> None:
    """Claim, prepare, run, persist, finish: the job's happy path, phase by phase."""
    if not await _claim(scope, request):
        logger.info("Job %s already terminal before start; aborting run", request.job_id)
        return
    from agent.observability import ensure_registered as register_grid_telemetry
    from agent_host.auth.request_trace import request_trace_tag_context
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.observability.exporter_manager import ExporterManager
    from nat.runtime.loader import load_config

    # Same JOIN as apps/agent-host/start_web.py: Grid telemetry `_type`s register at import
    # and are not in NAT's stock registry, so load_config fails without it.
    register_grid_telemetry()
    clock = BootClock("research-job")  # paid by every job, not once per process
    with clock.phase("load_config"):
        config = load_config(request.config_file_path)
    agent_cls = _load_agent_class(request.agent_class_path)

    building = time.monotonic()
    async with WorkflowBuilder.from_config(config=config) as builder:
        clock.record("workflow_build", time.monotonic() - building)
        boot_timing.flush()
        models = await prepare_models(builder, request)
        tools = await prepare_tools(builder, models.fn_config, request.data_sources)
        run = await bind_request(request, models.fn_config)
        exporters = {name: configured.instance for name, configured in builder._telemetry_exporters.items()}
        with request_trace_tag_context(request.request_trace_tags or {}):
            # The exporter must start before the first event is pushed.
            async with ExporterManager.from_exporters(exporters).start(context_state=run.state):
                result = await _run(scope, request, run, agent_cls=agent_cls, models=models, tools=tools)
                # Persisted inside the exporter's context, so the UI sees
                # completion before the exporter flushes and cleans up.
                outcome: JobOutcome = await persist(
                    scope, request, run, result, agent_cls=agent_cls, models=models, builder=builder, config=config
                )
                await finish(scope, request, outcome)


async def _claim(scope: JobScope, request: JobRequest) -> bool:
    """Write RUNNING unless the job is already terminal; whether this run goes ahead.

    Guarded, not unconditional: a cancel (INTERRUPTED) or the ghost reaper
    (FAILURE) may have finalized the job between the queue claim and here, and
    an unconditional write would resurrect a reaped job or lose a cancel (the
    cancel deletes the queue row, so this status is its only signal).
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
    from nat.front_ends.fastapi.async_jobs.job_store import JobStore

    scope.job_store = JobStore(scheduler_address="", db_url=request.db_url)
    if not await _update_status_if_not_terminal(scope.job_store, request.job_id, JobStatus.RUNNING):
        return False
    scope.monitor = CancellationMonitor(db_url=request.db_url, job_id=request.job_id, poll_interval=1.0)
    # The Unterlagen, sanitised ONCE: the agent state, the ledger and the prompts read this object.
    scope.plan_documents = sanitize_plan_documents(request.documents)
    return True


async def _run(scope: JobScope, request: JobRequest, run: RunContext, *, agent_cls: type, models, tools) -> Any:
    """Run the agent inside its workflow span, its cost tracking and its card channel; its raw result."""
    from agent.common.cost_tracking import BudgetSnapshot
    from agent.common.cost_tracking import track_llm_costs
    from agent.common.profiler import track_agent_profile

    workflow_metadata, parent_metadata = trace_metadata(request, run)
    run.open_spans(request, workflow_metadata, parent_metadata)
    callbacks, verbose = _callbacks(scope, request, models.fn_config)
    agent = _create_agent_instance(
        agent_cls=agent_cls,
        llm_provider=models.provider,
        llm=models.llm,
        tools=tools,
        fn_config=models.fn_config,
        verbose=verbose,
        callbacks=callbacks,
        job_id=request.job_id,
        # Durable checkpointing: None unless deep_research_agent.checkpoint_db is configured.
        checkpointer=await _resolve_deep_research_checkpointer(models.fn_config),
    )
    usage = request.usage_context or {}
    with (
        track_agent_profile(
            agent_name=_JOB_PROFILE_NAMES.get(getattr(models.fn_config, "type", None), "deep_research_job"),
            job_id=request.job_id,
            identity=request.identity,
        ),
        # Identity and budget were captured at submit: a worker has no request headers.
        track_llm_costs(
            job_id=request.job_id,
            identity=request.identity,
            budget=BudgetSnapshot.from_header(usage.get("budget_header")) or BudgetSnapshot(),
        ),
        # The card channel a chat turn binds: without it `emit_card` and
        # `surface_documents` answer "no card channel" in a job.
        _bound_card_registry() as card_registry,
    ):
        result = await _run_agent(
            agent=agent,
            input_text=request.input_text,
            monitor=scope.monitor,
            available_documents=request.available_documents,
            data_sources=request.data_sources,
            event_store=scope.event_store,
            user_info=run.user_info,
            clarifier_result=request.clarifier_result,
            plan_documents=scope.plan_documents,
            project_context=run.project_context,
            platform_lessons=request.platform_lessons,
            organization_id=request.organization_id,
        )
    scope.card_snapshot = card_registry.snapshot()
    run.close_spans(request, result, workflow_metadata, parent_metadata)
    return result


def _callbacks(scope: JobScope, request: JobRequest, fn_config: Any) -> tuple[list[Any], bool]:
    """The agent's callbacks, and the event store and run ledger they write through; and whether verbose."""
    from agent.common import VerboseTraceCallback
    from agent.common import is_verbose
    from agent.common.nat_step_repair import SpanClosingProfilerHandler

    verbose = is_verbose(getattr(fn_config, "verbose", False))
    callbacks: list[Any] = [VerboseTraceCallback()] if verbose else []
    event_store = BatchingEventStore(EventStore(request.db_url, request.job_id))
    # Built per run, never at module level (ADR-0018): a worker process is
    # reused across jobs and tenants, and a ledger that outlived its run would
    # put one office's documents on another office's report. Wrapping the store
    # is what feeds it; every producer downstream writes exactly as it did.
    plan_documents = scope.plan_documents
    scope.ledger = RunLedgerFold(
        job_id=request.job_id,
        run_id=request.run_id,
        event_store=event_store,
        basis=[doc.model_dump() for doc in plan_documents.basis] if plan_documents else None,
    )
    scope.monitor.on_document_added = scope.ledger.add_basis
    scope.event_store = scope.ledger.observing(event_store)
    scope.agent_event_callback = AgentEventCallback(scope.event_store)
    # SpanClosingProfilerHandler, created after WORKFLOW_START so it has the right
    # parent, closes errored LLM/tool spans that would otherwise orphan a frame.
    callbacks += [scope.agent_event_callback, SpanClosingProfilerHandler()]
    fn_type = getattr(fn_config, "type", None)
    # Phase progress needs deep research's planner/researcher/writer structure.
    if fn_type == "deep_research_agent":
        max_concurrency = getattr(fn_config, "max_research_concurrency", None)
        callbacks.append(PhaseProgressCallback(scope.event_store, max_research_concurrency=max_concurrency))
    if fn_type in _BUDGET_GUARDED_AGENT_TYPES:
        from agent.common import create_budget_guard_callback

        budget_guard = create_budget_guard_callback()
        if budget_guard is not None:
            callbacks.append(budget_guard)
    return callbacks, verbose


async def _release(scope: JobScope, request: JobRequest) -> None:
    """Close what the job opened, on every path: the ledger, the event buffer, the monitor, the token."""
    # The ledger's last word (the sealed step, the final snapshot) is an event
    # too, so it is written before the flush below.
    if scope.ledger is not None:
        await scope.ledger.close()
    if scope.event_store is not None and hasattr(scope.event_store, "flush"):
        scope.event_store.flush()
    if scope.monitor:
        scope.monitor.stop()
    if scope.auth_token_reset is not None:
        from ._auth_context import job_auth_token

        job_auth_token.reset(scope.auth_token_reset)
    # The URL dedup caches are class-level dicts keyed by job id.
    AgentEventCallback.cleanup_job_urls(request.job_id)
