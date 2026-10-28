"""
Agent-agnostic job runner.

The helpers of the research worker's job function, ``agent_job.run_agent_job``, which runs any registered agent with:
- NAT's JobStore for job metadata and status
- SSE event streaming for real-time UI updates
- Cancellation monitoring for graceful job termination
- Phoenix/OpenTelemetry observability via NAT's ExporterManager
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import importlib
import json
import logging
import os
import time
from collections.abc import Callable
from collections.abc import Iterator
from datetime import UTC
from datetime import datetime
from typing import Any

from starlette.datastructures import Headers

from aiq_agent.agents.deep_researcher.anatomy import ReportAnatomy
from aiq_agent.cards.generate import CardGenerationResult
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.plan_documents import PlanDocument
from aiq_agent.common.plan_documents import PlanDocuments
from aiq_agent.common.plan_documents import sanitize_plan_documents
from aiq_agent.project_context import ORGANIZATION_ID_HEADER
from aiq_agent.project_context import PROJECT_ID_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import USER_ID_HEADER

from .conversation_output import INTERRUPTED_NOTICE
from .conversation_output import write_job_notice
from .event_store import BatchingEventStore
from .event_store import EventStore
from .outcome_notify import notify_job_outcome

logger = logging.getLogger(__name__)

# Root modules of LLM/provider client stacks — exceptions raised from these are
# classified as provider errors in sanitize_job_error().
_LLM_PROVIDER_ERROR_MODULES = frozenset(
    {
        "openai",
        "anthropic",
        "litellm",
        "langchain",
        "langchain_core",
        "langchain_openai",
        "langchain_anthropic",
        "langchain_nvidia_ai_endpoints",
    }
)

# Root modules of HTTP/transport stacks — classified as connection errors.
_NETWORK_ERROR_MODULES = frozenset({"httpx", "httpcore", "aiohttp", "requests", "urllib3"})

# langgraph is a transitive (not declared) dependency of this package — guard
# the import so error classification keeps working if it is ever absent.
try:
    from langgraph.errors import GraphRecursionError as _GraphRecursionError
except ImportError:
    _GraphRecursionError = None

# User-safe error messages for sanitize_job_error — named constants so they
# are testable and searchable.  Each category gets one curated string that
# leaks no exception-internal data (hosts, DSNs, paths, credentials).
_WALL_CLOCK_TIMEOUT_MSG = "Die Recherche hat ihr Zeitlimit erreicht und wurde ohne vollständiges Ergebnis abgebrochen."
_GENERIC_TIMEOUT_MSG = "The job timed out while waiting on an external service."
_GRAPH_RECURSION_ERROR_MSG = "Die Recherche hat ihr Schritt-Limit erreicht, ohne ein vollständiges Ergebnis zu liefern."
_LLM_PROVIDER_ERROR_MSG = "The LLM provider returned an error while running the job."
_CONNECTION_ERROR_MSG = "A connection error occurred while running the job."
_INTERNAL_ERROR_MSG = "The job failed due to an internal error."

# A run that SUCCEEDED but owes the reader a caveat gets its own job_events row
# rather than a status change: the answer is real and persisted, it is just
# marked. Same ``job.*`` lifecycle shape as job.heartbeat/job.error/job.phase,
# so the existing SSE surface streams it to clients unchanged.
JOB_DEGRADED_EVENT_TYPE = "job.degraded"

# What travels in that event: stable tokens only, never prose. The reader is
# told about a cutoff by the report's own banner, in the product's voice; this
# channel exists so a live listener and an operator counting cutoffs can see it.
_DEGRADED_EVENT_FIELDS = ("research_truncated", "truncation_reason", "degraded_reasons")

#: Lifecycle event a reclaimed loser emits instead of ``job.cancelled``
#: (deep-research hardening, item 7). The ownership-loss abort arrives as a
#: bare ``task.cancel()`` — the same delivery as a user cancel — so the loser
#: and a real cancel are told apart by positive claim state (``_lost_claim``),
#: never by message sniffing. Same ``job.*`` lifecycle shape as the other
#: terminal events, stored through the same ``EventStore`` the SSE stream
#: replays, so the stored history and the live stream agree. Deliberately NOT a
#: ``job.phase`` row:
#: ``phase_events`` owns phase progress for the progress display, and an
#: ownership change is not a phase (apps/backend/AGENTS.md).
JOB_OWNERSHIP_LOST_EVENT_TYPE = "job.ownership-lost"

#: The only payload of the ownership-lost event. A stable reason token, never
#: the user-cancel string and never worker hostnames (worker ids are
#: ``hostname:pid`` — infra detail that must not stream to clients).
_OWNERSHIP_LOST_REASON = "queue claim reclaimed by another worker"

#: The request-context headers a worker supplies to the tools it runs, from
#: the run's identity. The contract `aiq_agent.project_context.
#: TOOL_CONTEXT_REQUIREMENTS` is checked against THIS tuple by
#: `packages/agent/tests/test_tool_context_contract.py`: a tool that needs a header
#: the worker does not inject fails that test rather than every unattended run.
WORKER_IDENTITY_HEADERS: tuple[str, ...] = (PROJECT_ID_HEADER, ORGANIZATION_ID_HEADER, USER_ID_HEADER)

#: The signed request-context envelope, which the worker injects ONLY when the
#: run carries one the BFF signed for its requester (ADR-0108,
#: ``jobs/run_envelope.py``). Never built here: the worker echoes the bytes the
#: BFF minted at submit, or the fresh ones it minted on renewal. A run without
#: one injects neither header, and the tools that act as a person refuse.
WORKER_ENVELOPE_HEADERS: tuple[str, ...] = (REQUEST_CONTEXT_ENVELOPE_HEADER, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER)


def _identity_values(identity: dict) -> tuple[object, object, object]:
    return (identity.get("project_id"), identity.get("organization_id"), identity.get("user_id"))


def sanitize_job_error(exc: BaseException) -> str:
    """Map an internal exception to a user-safe error message.

    Raw exception text can leak hosts, DSNs, file paths, or credentials into
    the persisted ``job.error`` field and emitted ``job.error`` events, both of
    which are returned to API clients. Callers must log the full exception
    server-side (``logger.exception``) and persist/emit only this message.

    Kept informative by category (time budget / step limit / timeout /
    provider / connection / internal) without ever including the exception's
    own text.

    NOTE: cancellation paths intentionally bypass this — the UI string-matches
    the exact error "cancelled by user".
    """
    from aiq_agent.common import RunBudgetExceededError
    from aiq_agent.common.cost_tracking import BudgetExceededError

    if isinstance(exc, (RunBudgetExceededError, BudgetExceededError)):
        # Already curated, user-safe messages ("run exceeded the configured
        # completion-token budget of N"; "the organization's LLM budget is
        # exhausted … an org admin can raise limits under …") -- persist
        # verbatim. The second used to fall through to "internal error", so
        # the one failure a person could act on themselves read as a crash.
        return str(exc)

    root_module = (type(exc).__module__ or "").split(".")[0]
    if isinstance(exc, TimeoutError):
        # The deep-research wall-clock budget (max_run_seconds) is re-raised as
        # a TimeoutError carrying a "wall-clock" marker; a bare TimeoutError is
        # an external-service wait.
        if "wall-clock" in str(exc).lower():
            return _WALL_CLOCK_TIMEOUT_MSG
        return _GENERIC_TIMEOUT_MSG
    from aiq_agent.common.canned_replies import ZDR_MODEL_REFUSED_MESSAGE
    from aiq_agent.common.openrouter import is_data_policy_refusal

    if is_data_policy_refusal(exc):
        # Curated and actionable: the model has no zero-data-retention
        # endpoint, and only an admin choosing another one changes that.
        return ZDR_MODEL_REFUSED_MESSAGE
    if _GraphRecursionError is not None and isinstance(exc, _GraphRecursionError):
        # A runaway graph hit recursion_limit — not an internal defect, and not
        # an LLM provider error (langgraph is deliberately not in the provider
        # module set above).
        return _GRAPH_RECURSION_ERROR_MSG
    if root_module in _LLM_PROVIDER_ERROR_MODULES:
        return _LLM_PROVIDER_ERROR_MSG
    if root_module in _NETWORK_ERROR_MODULES or isinstance(exc, (ConnectionError, OSError)):
        return _CONNECTION_ERROR_MSG
    return _INTERNAL_ERROR_MSG


async def _update_status_if_not_terminal(job_store: Any, job_id: str, status: Any, **kwargs: Any) -> bool:
    """Write a job status only if the job is not already in a terminal state.

    Terminal statuses (SUCCESS/FAILURE/INTERRUPTED) are sticky: the ghost-job
    reaper or the cancel route may have already finalized this job while the
    worker was still running, and the runner's own success/failure write must
    not overwrite that verdict (e.g. flipping a reaped FAILURE back to SUCCESS).

    This is a single conditional ``UPDATE ... WHERE status NOT IN (terminal)``
    executed in the job store's own transaction, and the write verdict comes
    from the statement's rowcount — not from a prior read. A separate
    get-then-update would leave a read-then-write race: the reaper's FAILURE
    landing between the runner's read and write was silently overwritten with
    SUCCESS. Here the loser of the race affects zero rows and reports False,
    so exactly one verdict wins and its payload (output/error) is never
    partially clobbered.

    Returns True if the status was written, False if it was left untouched.
    Raises ValueError if the job does not exist (matching NAT's
    ``JobStore.update_status`` contract).
    """
    from sqlalchemy import update

    from nat.front_ends.fastapi.async_jobs.job_store import JobInfo
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    if not isinstance(status, JobStatus):
        status = JobStatus(status)
    terminal_statuses = {JobStatus.SUCCESS.value, JobStatus.FAILURE.value, JobStatus.INTERRUPTED.value}
    stmt = (
        update(JobInfo)
        .where(JobInfo.job_id == job_id, JobInfo.status.not_in(terminal_statuses))
        .values(_status_values(status, **kwargs))
    )
    async with job_store.session() as session:
        result = await session.execute(stmt)
        written = (result.rowcount or 0) > 0
    if written:
        return True
    await _explain_refused_write(job_store, job_id, status)
    return False


def _status_values(status: Any, *, error: Any = None, output_path: Any = None, output: Any = None) -> dict[str, Any]:
    """The columns a status write sets, serialized as NAT's ``JobStore.update_status`` does.

    NAT honors exactly these fields; mirroring its output serialization keeps a
    guarded write byte-identical to the unguarded one it replaces.
    """
    from pydantic import BaseModel

    if isinstance(output, BaseModel):
        output = output.model_dump_json(round_trip=True)
    if isinstance(output, dict | list):
        output = json.dumps(output)
    return {
        "status": status.value,
        "error": error,
        "output_path": output_path,
        "output": output,
        "updated_at": datetime.now(UTC),
    }


async def _explain_refused_write(job_store: Any, job_id: str, status: Any) -> None:
    """Log why a guarded write touched no row, or raise ``ValueError`` when the job does not exist.

    Zero rows means the job is already terminal (the race the guard is for) or
    missing. One read tells them apart; the write already refused, so the read
    cannot cause a flip either way.
    """
    job = await job_store.get_job(job_id)
    if job is None:
        raise ValueError(f"Job {job_id} not found in job store")
    logger.info("Job %s already in terminal status %s; not overwriting with %s", job_id, job.status, status)


async def _current_job_status(job_store: Any, job_id: str) -> str | None:
    """Best-effort read of a job's current status; None when unreadable/missing.

    Separate from :func:`_update_status_if_not_terminal` on purpose: that
    function owns the terminal-status write (hardening item 6) and reports only
    whether it wrote. The conversation-write gates below (item 10) need the
    standing verdict itself — e.g. to keep a legitimate user-cancel notice
    while skipping a loser's notice beside the winner's answer — so they read
    it here, and only on the path where the status write did not win.
    """
    if job_store is None:
        return None
    try:
        job = await job_store.get_job(job_id)
    except Exception:
        logger.warning("Could not read current status for job %s", job_id, exc_info=True)
        return None
    if job is None:
        return None
    return getattr(job, "status", None)


async def _lost_claim(db_url: str, job_id: str, claim_owner: str | None) -> bool:
    """True only on POSITIVE ownership loss: this run no longer holds its job's claim.

    Two things are a loss, and both are visible in the queue row: another worker
    holds the claim (a reclaim after this one stalled), or the row is QUEUED
    again while this run is alive (a draining worker gave the claim back,
    ``queue.release_claims``, so another worker runs the job from the start).

    ``claim_owner`` is the research worker's own id. ``None`` (an unclaimed run, as in
    the tests) has no claim table to check, so only the terminal verdict gates
    publishing. Anything
    indeterminate (no row, row gone via cancel/mark_done, unreadable) is NOT a
    loss: the terminal-verdict gate below stays the decider and fails open, the
    same philosophy :func:`_update_status_if_not_terminal` keeps.
    """
    if not claim_owner:
        return False
    from . import queue

    status, owner = await asyncio.to_thread(queue.claim_state, db_url, job_id)
    if owner is not None and owner != claim_owner:
        logger.warning(
            "Job %s claim now held by %s (not %s); this run lost the race",
            job_id,
            owner,
            claim_owner,
        )
        return True
    if status == queue.QUEUED:
        logger.warning("Job %s is queued again (its claim was given back); this run stops", job_id)
        return True
    return False


async def _should_write_notice(*, job_store: Any, job_id: str, verdict: str, finalized: bool) -> bool:
    """Whether a terminal path may write its conversation notice.

    The notice must agree with the standing verdict, or the thread contradicts
    the status: a run that wrote the terminal state (``finalized``) always may;
    otherwise only the same verdict may repeat it (a user-cancel notice after
    the cancel route's INTERRUPTED, idempotent by deterministic message id) or
    an unreadable/missing status (fail open — a broken read must not silence a
    failure notice). A loser's notice beside the winner's answer, or beside a
    reaper FAILURE it would relabel, is skipped with a log line.
    """
    if finalized:
        return True
    status = await _current_job_status(job_store, job_id)
    if status is None or status == verdict:
        return True
    logger.info(
        "Job %s already in terminal status %s; skipping %s notice (loser writes nothing user-visible)",
        job_id,
        status,
        verdict,
    )
    return False


async def _should_notify_outcome(*, job_store: Any, job_id: str, verdict: str, finalized: bool) -> bool:
    """Whether a terminal path may report ``verdict`` to the BFF's outcome route.

    The BFF closes the run's ``task_runs`` row from this call and nothing else,
    so a path whose verdict is already standing must report it too: the cancel
    route writes INTERRUPTED before the runner's ``CancelledError`` arrives, and
    until 2026-09 only a run that wrote the status itself (``finalized``)
    notified, so a cancelled run stayed ``running`` in the BFF forever.

    Stricter than :func:`_should_write_notice` on one point: an unreadable status
    does NOT fail open. The outcome route overwrites the row's status, so a
    guessed ``interrupted`` could relabel a run the winner already reported as a
    success. Reporting the standing verdict twice is harmless (the BFF writes the
    same status and upserts one inbox row per run).
    """
    if finalized:
        return True
    return await _current_job_status(job_store, job_id) == verdict


async def _should_emit_cancelled_event(*, job_store: Any, job_id: str, finalized: bool) -> bool:
    """Whether the cancel path may stream ``job.cancelled`` (hardening item 7).

    Extends item 10's verdict-agreement rule (``_should_write_notice``) from
    the thread to the lifecycle stream: the event must agree with the standing
    verdict, or a late abort rewrites history as "cancelled by user". This run
    wrote INTERRUPTED itself (``finalized``), or the cancel route owns the
    verdict (standing INTERRUPTED) — both stream. An unreadable or missing
    status fails open: a broken read must not silence the only trace of an
    abort. A standing SUCCESS/FAILURE means the winner or the reaper owns the
    stream, and the event is skipped with a log line. A still-RUNNING status
    with no write of our own (``finalized`` False — the INTERRUPTED write
    failed) also streams nothing: no verdict was recorded, and claiming a user
    cancel would contradict the store. The ghost reaper owns the eventual
    signal there. Notice and event therefore always agree (same truth table as
    ``_should_write_notice`` for the interrupted verdict).
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    if finalized:
        return True
    status = await _current_job_status(job_store, job_id)
    if status is None or status == JobStatus.INTERRUPTED.value:
        return True
    logger.info(
        "Job %s already in terminal status %s; skipping job.cancelled event "
        "(a late abort must not rewrite the standing verdict)",
        job_id,
        status,
    )
    return False


def _emit_lifecycle_event(*, db_url: str, event_store: Any | None, job_id: str, event: dict[str, Any]) -> Any:
    """Store and flush one terminal-path lifecycle event; create the store lazily, and return it.

    The lazy ``BatchingEventStore(EventStore(db_url, job_id))`` is the one every
    terminal path uses; returning it keeps the caller's flush semantics.
    """
    if event_store is None:
        event_store = BatchingEventStore(EventStore(db_url, job_id))
    event_store.store(event)
    if hasattr(event_store, "flush"):
        event_store.flush()
    return event_store


async def _finalize_cancelled_run(
    *,
    job_store: Any,
    db_url: str,
    job_id: str,
    claim_owner: str | None,
    parent_conversation_id: str | None,
    usage_context: dict | None,
    event_store: Any | None,
    expect_run: bool = False,
) -> Any:
    """Finalize a run aborted via ``asyncio.CancelledError`` (hardening item 7).

    Root cause this closes: the DB worker aborts a reclaimed run with a bare
    ``run_task.cancel()``, which is indistinguishable on delivery from the
    ``CancellationMonitor``'s user cancel — so the handler told every abort as
    a user cancel (INTERRUPTED "cancelled by user" + user notice +
    ``job.cancelled``) while the new owner was still running. The two causes
    are told apart here by positive claim state — item 10's ``_lost_claim`` —
    never by message sniffing.

    A reclaimed loser publishes nothing user-visible: no INTERRUPTED write, no
    thread notice, no outcome notify, no ``job.cancelled``. Its only signal is
    the truthful ``job.ownership-lost`` lifecycle event. Anything else follows
    the pre-existing user-cancel shape, with the ``job.cancelled`` event
    additionally gated on verdict agreement (``_should_emit_cancelled_event``)
    so a late abort after the winner's SUCCESS or the reaper's FAILURE streams
    nothing.

    Still-owner first (item 10): a reclaim abort must not steal the terminal
    write from the new owner, nor leave an INTERRUPTED_NOTICE beside the
    winner's answer. Returns the event store (created lazily when the path
    streams an event).
    """
    if await _lost_claim(db_url, job_id, claim_owner):
        logger.warning("Job %s lost its queue claim; emitting ownership-lost only (the owner publishes)", job_id)
        lost = {"type": JOB_OWNERSHIP_LOST_EVENT_TYPE, "data": {"reason": _OWNERSHIP_LOST_REASON}}
        return _emit_lifecycle_event(db_url=db_url, event_store=event_store, job_id=job_id, event=lost)

    logger.info("Job %s cancelled", job_id)
    finalized = await _mark_interrupted(job_store, job_id)
    await _publish_interrupted(
        job_store=job_store,
        job_id=job_id,
        finalized=finalized,
        parent_conversation_id=parent_conversation_id,
        usage_context=usage_context,
        expect_run=expect_run,
    )
    # The event agrees with the standing verdict too (item 7): after the
    # winner's SUCCESS or the reaper's FAILURE a late abort must not rewrite
    # history as "cancelled by user".
    if await _should_emit_cancelled_event(job_store=job_store, job_id=job_id, finalized=finalized):
        cancelled = {"type": "job.cancelled", "data": {"reason": "cancelled by user"}}
        event_store = _emit_lifecycle_event(db_url=db_url, event_store=event_store, job_id=job_id, event=cancelled)
    return event_store


async def _mark_interrupted(job_store: Any, job_id: str) -> bool:
    """Write INTERRUPTED unless the job is already terminal; whether this run wrote it.

    Sticky terminal statuses: a reaper's FAILURE or a winner's SUCCESS stays.
    The "cancelled by user" error string is exact: the UI string-matches on it.
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    if not job_store:
        return False
    try:
        return await _update_status_if_not_terminal(job_store, job_id, JobStatus.INTERRUPTED, error="cancelled by user")
    except ConnectionError, TimeoutError, RuntimeError:
        return False


async def _publish_interrupted(
    *,
    job_store: Any,
    job_id: str,
    finalized: bool,
    parent_conversation_id: str | None,
    usage_context: dict | None,
    expect_run: bool,
) -> None:
    """The cancelled run's thread notice and outcome report, each gated on agreeing with the verdict."""
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    # Gated on verdict agreement (item 10): a user cancel (standing
    # INTERRUPTED, or this run's write) still leaves its notice — otherwise
    # the thread stays empty. A loser cancelled after the winner's SUCCESS
    # or the reaper's FAILURE writes nothing beside it.
    if await _should_write_notice(
        job_store=job_store,
        job_id=job_id,
        verdict=JobStatus.INTERRUPTED.value,
        finalized=finalized,
    ):
        await write_job_notice(
            conversation_id=parent_conversation_id,
            job_id=job_id,
            usage_context=usage_context,
            notice=INTERRUPTED_NOTICE,
            expect_run=expect_run,
        )
    # Standing INTERRUPTED counts: the cancel route wrote it before this abort
    # arrived, and the BFF's run row closes only on this report.
    if await _should_notify_outcome(
        job_store=job_store,
        job_id=job_id,
        verdict=JobStatus.INTERRUPTED.value,
        finalized=finalized,
    ):
        await notify_job_outcome(
            job_id=job_id, usage_context=usage_context, status="interrupted", expect_run=expect_run
        )


def _normalize_trace_id(trace_id: int | str | None) -> int | None:
    """Convert trace ID to integer format.

    Args:
        trace_id: Trace ID as int, hex string, or None.

    Returns:
        Integer trace ID or None.
    """
    if trace_id is None:
        return None
    if isinstance(trace_id, int):
        return trace_id
    try:
        return int(trace_id, 16)
    except ValueError:
        return int(trace_id)


#: The job event the write-now route records and the monitor listens for.
WRITE_NOW_EVENT_TYPE = "job.write_now_requested"
#: The job event the documents route records when the reader adds a document
#: to the Grundlage while the run goes; the monitor hands it to the run.
DOCUMENT_ADDED_EVENT_TYPE = "job.document_added"
#: What the monitor reads off the job's events. Filtered in the query: a run
#: writes an event per streamed token, and paging through those a hundred per
#: poll left a control request waiting behind them.
CONTROL_EVENT_TYPES = (WRITE_NOW_EVENT_TYPE, DOCUMENT_ADDED_EVENT_TYPE)


class CancellationMonitor:
    """
    Monitors job status for cancellation requests.

    Polls the job store at regular intervals and sets an asyncio.Event
    when the job status changes to INTERRUPTED or FAILURE (the latter is
    written by the ghost-job reaper, which must also stop the worker).
    """

    def __init__(
        self,
        db_url: str,
        job_id: str,
        poll_interval: float = 1.0,
    ):
        self.db_url = db_url
        self.job_id = job_id
        self.poll_interval = poll_interval
        self._cancelled = asyncio.Event()
        # „Jetzt schreiben": the reader asked for the report from what is there.
        # Read off the job's own events, beside the status poll, so the request
        # reaches a worker that holds nothing but the job id.
        self.write_now = asyncio.Event()
        # Documents the reader added to the Grundlage while the run goes, in
        # arrival order, append-only: it is also the dedupe history. The
        # research tool reads past its own cursor before a batch
        # (``deep_researcher.control``); ``on_document_added`` is the ledger
        # fold's hook, so the block shows the addition at once.
        self.added_documents: list[PlanDocument] = []
        self.on_document_added: Callable[[PlanDocument], None] | None = None
        self._last_event_id = 0
        self._monitor_task: asyncio.Task | None = None

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled.is_set()

    async def _poll_job_status(self) -> None:
        """Poll job status and set cancelled event if interrupted."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        job_store = JobStore(scheduler_address="", db_url=self.db_url)

        # FAILURE included: the ghost-job reaper writes FAILURE externally and
        # the worker must stop instead of running to completion against a job
        # that has already been finalized.
        stop_statuses = (JobStatus.INTERRUPTED.value, JobStatus.FAILURE.value)

        while not self._cancelled.is_set():
            try:
                job = await job_store.get_job(self.job_id)
                if job and job.status in stop_statuses:
                    logger.info("Cancellation detected for job %s (status: %s)", self.job_id, job.status)
                    self._cancelled.set()
                    break
                events = await EventStore.get_events_async(
                    self.db_url, self.job_id, after_id=self._last_event_id, event_types=CONTROL_EVENT_TYPES
                )
                self._note_control_events(events)
            except Exception as e:
                logger.warning("Error checking job status for %s: %s", self.job_id, e)

            await asyncio.sleep(self.poll_interval)

    def _note_control_events(self, events: list[dict]) -> None:
        """Advance the cursor over the job's events and act on the reader's controls."""
        for event in events:
            event_id = event.get("_id")
            if isinstance(event_id, int) and event_id > self._last_event_id:
                self._last_event_id = event_id
            if event.get("type") == WRITE_NOW_EVENT_TYPE:
                logger.info("Write-now requested for job %s", self.job_id)
                self.write_now.set()
            elif event.get("type") == DOCUMENT_ADDED_EVENT_TYPE:
                self._note_added_document(event.get("data"))

    def _note_added_document(self, data: Any) -> None:
        docs = sanitize_plan_documents({"basis": [data]}) if isinstance(data, dict) else None
        if docs is None:
            return
        doc = docs.basis[0]
        if any(d.name.casefold() == doc.name.casefold() for d in self.added_documents):
            return
        logger.info("Document added to the Grundlage of job %s: %s", self.job_id, doc.name)
        self.added_documents.append(doc)
        if self.on_document_added is not None:
            self.on_document_added(doc)

    def start(self) -> None:
        """Start the cancellation monitor background task."""
        if self._monitor_task is None:
            self._monitor_task = asyncio.create_task(self._poll_job_status())
            logger.debug("Started cancellation monitor for job %s", self.job_id)

    def stop(self) -> None:
        """Stop the cancellation monitor."""
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            self._monitor_task = None
            logger.debug("Stopped cancellation monitor for job %s", self.job_id)

    def check(self) -> None:
        """Check if cancelled and raise CancelledError if so."""
        if self._cancelled.is_set():
            raise asyncio.CancelledError("Job cancelled by user")


# Interval for emitting heartbeat events
HEARTBEAT_INTERVAL_SECONDS = 30


async def run_with_cancellation(
    coro,
    monitor: CancellationMonitor,
    event_store: EventStore | BatchingEventStore | None = None,
) -> Any:
    """
    Run a coroutine with cancellation monitoring and periodic heartbeats.

    Emits job.heartbeat events every 30s so the SSE stream stays alive
    and the ghost job reaper can detect dead workers.
    Raises asyncio.CancelledError if the monitor detects cancellation.
    """
    task = asyncio.create_task(coro)
    monitor.start()
    start_time = time.monotonic()
    last_heartbeat = start_time

    try:
        while not task.done():
            if monitor.is_cancelled:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                raise asyncio.CancelledError("Job cancelled by user")

            now = time.monotonic()
            if event_store and (now - last_heartbeat) >= HEARTBEAT_INTERVAL_SECONDS:
                last_heartbeat = now
                event_store.store(
                    {
                        "type": "job.heartbeat",
                        "data": {"uptime_seconds": int(now - start_time)},
                    }
                )

            await asyncio.sleep(0.1)

        return task.result()
    finally:
        monitor.stop()


def _resolve_worker_tool_refs(fn_config: Any) -> list[str]:
    """Resolve the tool refs a worker agent should build with.

    Uses the config's explicit ``tools`` list, or auto-inherits the entire
    data_source_registry when none are configured.

    The empty check is falsy (not ``is None``): agent configs declare ``tools``
    with ``default_factory=list``, so an omitted list arrives as ``[]``, never
    ``None``. A prior ``is None`` guard therefore never inherited and silently
    built a tool-less agent — the researcher workers received no source tools
    while validation elsewhere reported the inherited tools as available. This
    matches the two other resolution sites (the sync agent build in
    deep_researcher/register.py and the chat-route validator in
    piloti/conversation_register.py), which both treat an empty list as "inherit".
    """
    tool_refs = getattr(fn_config, "tools", None)
    if not tool_refs:
        from aiq_agent.common import get_all_tool_refs

        return get_all_tool_refs()
    return list(tool_refs)


async def _resolve_deep_research_checkpointer(fn_config: Any) -> Any | None:
    """Build the durable checkpointer for a deep-research async job, if configured.

    Async deep-research jobs have no restart safety by default (T3-8): each
    job builds a fresh in-memory-only DeepAgents graph via a new
    DeepResearcherAgent, so a worker crash mid-run loses all execution state
    -- only the SQL JobStore row survives, and the ghost-job reaper eventually
    marks it FAILURE with nothing to resume.

    When ``deep_research_agent.checkpoint_db`` is configured, this builds (and
    caches, via ``aiq_agent.common.get_checkpointer``) a durable checkpointer
    keyed by that database path/DSN. ``DeepResearcherAgent.run()`` then uses
    the job_id as the graph's thread_id, so a re-invocation of the same
    job_id resumes from the last persisted checkpoint instead of starting
    over -- see ``DeepResearcherAgent.run`` for the exact resume contract and
    its current manual-resubmit-only limitation.

    Returns None (current default behavior, no durability) for any agent
    type other than ``deep_research_agent``, or when ``checkpoint_db`` is
    unset -- both keep the prior in-memory-only, non-durable behavior.
    """
    if getattr(fn_config, "type", None) != "deep_research_agent":
        return None
    checkpoint_db = getattr(fn_config, "checkpoint_db", None)
    if not checkpoint_db:
        return None

    from aiq_agent.common import get_checkpointer

    return await get_checkpointer(checkpoint_db)


def _purge_deep_checkpoint(job_id: str) -> None:
    """Best-effort deletion of a finished deep run's durable checkpoint rows.

    The deep-research checkpointer keys ``thread_id == job_id`` in
    ``DEEP_CHECKPOINT_DB`` and writes the full growing state every step, but
    nothing prunes ``checkpoints``/``checkpoint_blobs``/``checkpoint_writes`` — so
    they grow (superlinearly per run) forever. Once a run is terminal the
    checkpoint is dead weight (resume is manual-resubmit, never auto-read), so
    drop it. Never raises.
    """
    dsn = os.environ.get("DEEP_CHECKPOINT_DB")
    if not dsn:
        return
    try:
        from sqlalchemy import text

        from .event_store import EventStore

        engine = EventStore._get_or_create_sync_engine(dsn)
        with engine.connect() as conn:
            for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                # Fixed table names (LangGraph schema); the thread id is bound.
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {table} WHERE thread_id = :tid"),  # noqa: S608
                    {"tid": job_id},
                )
            conn.commit()
    except Exception:
        logger.debug("Deep checkpoint purge skipped for job %s", job_id, exc_info=True)


async def _purge_deep_checkpoint_unless_reclaimed(db_url: str, job_id: str, claim_owner: str | None) -> bool:
    """Purge the run's deep checkpoint at its end, unless the job was reclaimed.

    The rows (``DEEP_CHECKPOINT_DB``, ``thread_id == job_id``) are keyed by
    job, not by worker, so after a reclaim they are the NEW owner's resume
    point. A stalled loser reaching its ``finally`` deleted them from under it,
    and the winner resumed from nothing. ``worker.py`` already skipped its own
    purge on claim loss; the runner's did not. Same positive-loss rule as every
    other gate here (:func:`_lost_claim`): an indeterminate claim still purges,
    and an unclaimed run always does. Both purges are idempotent.

    Returns True when it purged.
    """
    if await _lost_claim(db_url, job_id, claim_owner):
        logger.warning("Job %s lost its queue claim; leaving the deep checkpoint to the owning worker", job_id)
        return False
    _purge_deep_checkpoint(job_id)
    return True


def _load_agent_class(agent_class_path: str) -> type:
    """
    Dynamically load an agent class from its module path.

    Args:
        agent_class_path: Full path like 'aiq_agent.agents.deep_researcher.agent.DeepResearcherAgent'

    Returns:
        The agent class.

    Raises:
        ImportError: If the module or class cannot be found.
    """
    module_path, class_name = agent_class_path.rsplit(".", 1)
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


# NAT function ``_type``s whose single ``llm`` runs on the tool-calling chat model's
# group (``AgentGroup.RESEARCH``) rather than the deep-research default.
_CHAT_MODEL_AGENT_TYPES = frozenset({"research_agent", "project_intake_agent"})

# Agent types the completion-token budget cap guards: fan-out research and the
# intake's long document-reading loop are the run-away-cost shapes it exists for.
_BUDGET_GUARDED_AGENT_TYPES = frozenset({"deep_research_agent", "project_intake_agent"})

# Profiling label per agent type; anything not listed keeps the historical label.
_JOB_PROFILE_NAMES = {"project_intake_agent": "project_intake_job"}


async def _create_llm_provider(builder: Any, fn_config: Any) -> tuple[Any, Any]:
    """Create a role-aware LLM provider from a NAT function config."""
    from aiq_agent.common import AgentGroup
    from aiq_agent.common import LLMProvider
    from aiq_agent.common import LLMRole
    from aiq_agent.common import get_langchain_llm

    # Agent-group tags mirror the sync registrations (deep_researcher/register.py)
    # so per-org runtime model overrides apply identically to async jobs.
    role_config_attrs = (
        (LLMRole.ORCHESTRATOR, "orchestrator_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.ROUTER, "source_router_llm", AgentGroup.DEEP_RESEARCH_ROUTER),
        (LLMRole.PLANNER, "planner_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.RESEARCHER, "researcher_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.REPORT_WRITER, "writer_llm", AgentGroup.DEEP_RESEARCH),
    )
    llm_cache: dict[Any, Any] = {}
    role_llms = {}
    role_groups = {}
    for role, config_attr, group in role_config_attrs:
        llm_ref = getattr(fn_config, config_attr, None)
        if llm_ref:
            if llm_ref not in llm_cache:
                llm_cache[llm_ref] = await get_langchain_llm(builder, llm_ref)
            role_llms[role] = llm_cache[llm_ref]
            role_groups[role] = group

    default_group = AgentGroup.DEEP_RESEARCH
    default_llm = role_llms.get(LLMRole.ORCHESTRATOR)
    if default_llm is None:
        llm_ref = getattr(fn_config, "llm", None)
        if llm_ref:
            if llm_ref not in llm_cache:
                llm_cache[llm_ref] = await get_langchain_llm(builder, llm_ref)
            default_llm = llm_cache[llm_ref]
            # The intake agent is a tool-calling loop like the chat agent, not a
            # planner/researcher/writer pipeline: it runs on the chat model's group.
            if getattr(fn_config, "type", None) in _CHAT_MODEL_AGENT_TYPES:
                default_group = AgentGroup.RESEARCH

    provider = LLMProvider()
    provider.set_default(default_llm, group=default_group)
    for role, llm in role_llms.items():
        provider.configure(role, llm, group=role_groups.get(role))

    return provider, default_llm


def _b64url_encode_text(value: str) -> str:
    """Encode free text for a worker request header (base64url, no padding).

    Starlette ``Headers`` encode values as latin-1, so any raw project text
    with German quotes („U+201E), em-dashes or newlines throws
    ``UnicodeEncodeError`` at injection time — killing the job before the agent
    starts. The header contract on the read side
    (``aiq_agent.project_context._read_encoded_header``) is base64url with a
    raw fallback, so every multi-line/free-text header on this path goes
    through here.
    """
    return base64.urlsafe_b64encode(value.encode()).rstrip(b"=").decode()


def _inject_worker_headers(context_state: Any, headers: dict[str, str]) -> None:
    """Layer ``headers`` onto the worker's request metadata.

    A background worker has no inbound request, so everything a chat turn
    would read from its headers has to be placed there by hand, and every
    reader downstream (`Context.get().metadata.headers`) then works unchanged.
    Layered, not replaced: each call keeps what earlier calls put there.
    """
    request_attrs = context_state.metadata.get()
    existing = dict(request_attrs.headers) if request_attrs and request_attrs.headers else {}
    request_attrs._request.headers = Headers(headers={**existing, **headers})
    context_state.metadata.set(request_attrs)


def _run_user_info(user_info: dict | None, envelope_headers: dict[str, str] | None) -> dict | None:
    """Who the run is for, by name: the submitted ``user_info``, else the run's signed envelope.

    A run submitted from a chat carries the chat turn's ``user_info``. A
    scheduled fire carries none, nobody being signed in, but its envelope does:
    the BFF signs the requester into it at submit and at every renewal
    (``requester``, ADR-0108). Read through the same verification and the same
    rule as a chat turn (``turn.context.user_info_for``); an envelope that does
    not verify names nobody.
    """
    if user_info is not None or not envelope_headers:
        return user_info
    from aiq_agent.project_context import GridRequestContext
    from aiq_agent.turn.context import user_info_for

    request = GridRequestContext.from_headers(envelope_headers, secret=os.environ.get("INTERNAL_API_TOKEN"))
    return user_info_for(request)


def _workflow_reflection_llm_ref(config: Any) -> str | None:
    """The chat workflow's ``memory_reflection_llm`` ref, as a plain str, or None.

    The interactive submit path reads it off the live config and carries it in
    the job; the BFF's scheduled-job submit cannot, because only the worker
    holds the config. Same ref, resolved one step later.
    """
    workflow = getattr(config, "workflow", None)
    ref = getattr(workflow, "memory_reflection_llm", None)
    return str(ref) if ref else None


def _create_agent_instance(
    agent_cls: type,
    llm_provider,
    llm,
    tools: list,
    fn_config,
    verbose: bool,
    callbacks: list,
    job_id: str | None = None,
    checkpointer: Any | None = None,
):
    """Create an agent instance: from its own config when the runner knows it, else by convention.

    Intake and deep research take their budgets and switches from their config.
    Any other agent is tried against the constructor shapes in use, most
    specific first (``_constructed_by_convention``).
    """
    configured = _configured_agent(agent_cls, llm_provider, tools, fn_config, verbose, callbacks, job_id, checkpointer)
    if configured is not None:
        return configured
    return _constructed_by_convention(agent_cls, llm_provider, llm, tools, fn_config, verbose, callbacks)


def _configured_agent(agent_cls, llm_provider, tools, fn_config, verbose, callbacks, job_id, checkpointer) -> Any:
    """An intake or deep-research agent built from its own config, or None for any other agent."""
    from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
    from aiq_agent.agents.intake.register import ProjectIntakeAgentConfig

    if isinstance(fn_config, ProjectIntakeAgentConfig):
        # The reading's budgets are config, so a deployment moves them without a release.
        return agent_cls(
            llm_provider=llm_provider,
            tools=tools,
            verbose=verbose,
            callbacks=callbacks,
            max_tool_steps=fn_config.max_tool_steps,
            max_run_seconds=fn_config.max_run_seconds,
            job_id=job_id,
        )

    if isinstance(fn_config, DeepResearchAgentConfig):
        return agent_cls(
            llm_provider=llm_provider,
            tools=tools,
            verbose=verbose,
            callbacks=callbacks,
            domain_catalog_path=fn_config.domain_catalog_path,
            enable_source_router=fn_config.enable_source_router,
            enable_citation_verification=fn_config.enable_citation_verification,
            skills=fn_config.skills,
            sandbox=fn_config.sandbox,
            job_id=job_id,
            max_research_concurrency=fn_config.max_research_concurrency,
            max_concurrent_source_tool_calls=fn_config.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=fn_config.max_source_tool_batch_size,
            max_run_seconds=fn_config.max_run_seconds,
            checkpointer=checkpointer,
        )
    return None


def _constructed_by_convention(agent_cls, llm_provider, llm, tools, fn_config, verbose, callbacks) -> Any:
    """The first constructor shape ``agent_cls`` accepts, most specific first; else callbacks alone."""
    shapes = (
        # The original deep researcher: provider, tools, verbose.
        {"llm_provider": llm_provider, "tools": tools, "verbose": verbose},
        # Piloti: provider, tools, an iteration cap.
        {
            "llm_provider": llm_provider,
            "tools": tools,
            "max_tool_iterations": getattr(fn_config, "max_tool_iterations", 5),
        },
        # The simplest agents: one model and tools.
        {"llm": llm, "tools": tools},
    )
    for shape in shapes:
        try:
            return agent_cls(**shape, callbacks=callbacks)
        except TypeError:
            continue
    return agent_cls(callbacks=callbacks)


async def _run_agent(
    agent,
    input_text: str,
    monitor: CancellationMonitor,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    event_store: EventStore | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
    plan_documents: PlanDocuments | None = None,
    project_context: str | None = None,
    platform_lessons: str | None = None,
    organization_id: str | None = None,
) -> Any:
    """
    Run the agent, supporting different run() signatures.

    Tries:
    1. run(input_text: str) -> str (simple protocol)
    2. run(state) where state has messages (LangGraph pattern)
    """
    import inspect

    if not hasattr(agent, "run"):
        raise TypeError(f"Agent {type(agent).__name__} does not have a run method")
    params = list(inspect.signature(agent.run).parameters)
    # A first parameter named for the question is the simple protocol: run(input_text).
    if params and params[0] in ("input_text", "query", "input"):
        return await run_with_cancellation(agent.run(input_text), monitor, event_store=event_store)
    # Otherwise the agent takes a state. Mirror the synchronous chat path: the
    # prompts read these off the state, so a job must carry them too. A worker
    # has no request headers, so an agent that resolves per-tenant data (deep
    # research resolves the org's skills) gets the organization captured at
    # submit the same way.
    fields = {
        "user_info": user_info,
        "clarifier_result": clarifier_result,
        "plan_documents": plan_documents,
        "project_context": project_context,
        "platform_lessons": platform_lessons,
        "organization_id": organization_id,
    }
    state_cls = _get_agent_state_class(agent)
    if state_cls:
        state = _model_state(state_cls, input_text, data_sources, available_documents, fields)
    else:
        state = _dict_state(input_text, data_sources, available_documents, fields)
    return await _run_with_reader_controls(agent, state, monitor, event_store)


def _model_state(state_cls: type, input_text: str, data_sources, available_documents, fields: dict) -> Any:
    """The agent's own state model, with each of ``fields`` the model declares and that has a value."""
    from langchain_core.messages import HumanMessage

    state_kwargs: dict[str, Any] = {"messages": [HumanMessage(content=input_text)]}
    if data_sources is not None:
        state_kwargs["data_sources"] = data_sources
    declared = getattr(state_cls, "model_fields", {})
    state_kwargs.update({name: value for name, value in fields.items() if value is not None and name in declared})
    if available_documents:
        try:
            from aiq_agent.knowledge import AvailableDocument

            state_kwargs["available_documents"] = [AvailableDocument(**doc) for doc in available_documents]
            logger.debug("Research worker passing %d available documents to agent state", len(available_documents))
        except ImportError, TypeError:
            # The state does not take AvailableDocument entries: run without them.
            pass
    return state_cls(**state_kwargs)


def _dict_state(input_text: str, data_sources, available_documents, fields: dict) -> dict[str, Any]:
    """A plain dict state, for an agent that names no state model. It never carried the plan or the organization."""
    from langchain_core.messages import HumanMessage

    state: dict[str, Any] = {"messages": [HumanMessage(content=input_text)]}
    if data_sources is not None:
        state["data_sources"] = data_sources
    if available_documents:
        state["available_documents"] = available_documents
    for name in ("user_info", "clarifier_result", "project_context", "platform_lessons"):
        if fields[name] is not None:
            state[name] = fields[name]
    return state


async def _run_with_reader_controls(agent, state: Any, monitor: CancellationMonitor, event_store) -> Any:
    """Run a state-taking agent with the reader's controls bound for the run.

    The reader's „Jetzt schreiben" and the documents they add mid-run reach the
    research tool through per-run bindings; the task ``run_with_cancellation``
    creates inherits them.
    """
    from aiq_agent.agents.deep_researcher.control import bind_added_documents
    from aiq_agent.agents.deep_researcher.control import bind_write_now
    from aiq_agent.agents.deep_researcher.control import reset_added_documents
    from aiq_agent.agents.deep_researcher.control import reset_write_now

    token = bind_write_now(monitor.write_now)
    added_token = bind_added_documents(monitor.added_documents)
    try:
        return await run_with_cancellation(agent.run(state), monitor, event_store=event_store)
    finally:
        reset_added_documents(added_token)
        reset_write_now(token)


def _get_agent_state_class(agent) -> type | None:
    """The state model ``agent.run`` takes, or None.

    An agent that DECLARES ``state_model`` is believed. Everything below it is
    a guess made from the class name, and a guess is what a rename breaks
    without a word: ``ResearcherAgent`` → ``PilotiAgent`` stopped matching
    ``ResearchAgentState`` and the agent was handed a bare dict. Declare the
    attribute on any new agent rather than shaping its class name to fit.
    """
    declared = getattr(type(agent), "state_model", None)
    if isinstance(declared, type):
        return declared

    agent_module = type(agent).__module__
    agent_name = type(agent).__name__

    # Try common patterns for state class names
    # e.g., DeepResearcherAgent -> DeepResearchAgentState, DeepResearcherAgentState
    state_name_patterns = [
        "AgentState",
        f"{agent_name}State",
        f"{agent_name.replace('Agent', '')}AgentState",  # DeepResearcher -> DeepResearcherAgentState
        f"{agent_name.replace('erAgent', '')}AgentState",  # DeepResearcherAgent -> DeepResearchAgentState
        "State",
    ]

    # Try models submodule first
    try:
        models_module = importlib.import_module(agent_module.replace(".agent", ".models"))
        for state_name in state_name_patterns:
            if hasattr(models_module, state_name):
                return getattr(models_module, state_name)

        # Also scan for any class ending with "State" that has a messages field
        for name in dir(models_module):
            if name.endswith("State") and not name.startswith("_"):
                cls = getattr(models_module, name)
                if isinstance(cls, type) and hasattr(cls, "model_fields"):
                    if "messages" in cls.model_fields:
                        return cls
    except ImportError, AttributeError:
        pass

    # Try same module
    try:
        module = importlib.import_module(agent_module)
        for state_name in state_name_patterns:
            if hasattr(module, state_name):
                return getattr(module, state_name)
    except ImportError:
        pass

    return None


@contextlib.contextmanager
def _bound_card_registry() -> Iterator[CardRegistry]:
    """Bind a fresh per-job ``CardRegistry`` for the agent run, and unbind it after.

    The chat turn does the same around ``agent.run`` (``piloti/conversation_register.py``),
    with a conversation-scoped registry it clears per turn. A job has no
    conversation of its own to key on and runs once, so a fresh registry is the
    per-turn state here — the ``ContextVar`` rule in ``packages/agent/src/aiq_agent/AGENTS.md``.
    Reset in ``finally`` so a failed run leaves nothing bound for the next job
    this worker picks up.
    """
    registry = CardRegistry()
    token = set_card_registry(registry)
    try:
        yield registry
    finally:
        reset_card_registry(token)


def _merge_job_cards(emitted: list[dict[str, Any]], generated: list[Any] | None) -> list[Any] | None:
    """The job's cards: what the agent emitted during the run, then what was generated from its report.

    EMITTED FIRST, and this is the ordering contract rather than a preference.
    ``emit_card`` hands the model ``[[card:N]]`` with N = the registry's count
    at emission, and the frontend resolves that marker positionally against the
    ordered ``cards`` array. Keeping the emitted cards at the front, in emission
    order, is what keeps every N the model wrote pointing at the card it meant.
    The post-hoc cards were derived from the finished report and are named by
    no marker, so appending them costs nothing — putting them first would shift
    every emitted index by their count. ``None`` when there is nothing at all,
    matching ``run_result.build_job_output``'s absent-not-empty rule.
    """
    merged = [*emitted, *(generated or [])]
    return merged or None


def _produces_report(agent_cls: type) -> bool:
    """Whether the agent's job output is a report the post-report passes read.

    Defaults to True: every agent before the project intake wrote one. An agent
    that writes to objects instead declares ``produces_report = False``.
    """
    return bool(getattr(agent_cls, "produces_report", True))


async def _run_report_passes(
    *,
    produces_report: bool,
    llm: Any,
    input_text: str,
    report: str,
    organization_id: str | None,
    **reflection_kwargs: Any,
) -> tuple[CardGenerationResult, ReportAnatomy, dict[str, Any] | None]:
    """The model calls over a finished report: grid cards, anatomy, follow-ups, then reflection.

    The first three are independent and best-effort, so they run together. The
    reflection reads the report WITH its findings, after the extraction: a
    Befund with its value and status lands in project memory as a fact, an open
    one as an open point, instead of both being fished back out of the prose.
    ``reflection_kwargs`` go to ``_run_deep_research_reflection`` unchanged.

    A run with no report (``produces_report`` False) makes no model call here
    and returns the empty result of each pass.
    """
    if not produces_report:
        return CardGenerationResult(cards=None), ReportAnatomy(), None
    cards_result, anatomy, follow_ups = await asyncio.gather(
        _generate_grid_cards(llm, input_text, report),
        # The report's anatomy (masthead) and its findings (Befundmatrix), read
        # off the finished report in one structured call, and the follow-up
        # questions the report just made askable. Both post hoc, both additive:
        # a failure costs the reader a layer, never the report.
        _extract_report_anatomy(llm, input_text, report),
        _propose_report_follow_ups(llm, query=input_text, report=report, organization_id=organization_id),
    )
    await _run_deep_research_reflection(
        query=input_text, report=_reflection_text(report, anatomy.findings), **reflection_kwargs
    )
    return cards_result, anatomy, follow_ups


def _reflection_text(report: str, findings: dict[str, Any] | None) -> str:
    """The report as memory reflection reads it: the prose, then its findings as lines.

    One line per Befund — requirement, value, status, and the comment for an
    open one — so the reflection model meets each fact once, in a fixed
    shape, rather than reconstructing it from a paragraph.
    """
    items = (findings or {}).get("items") if isinstance(findings, dict) else None
    if not isinstance(items, list) or not items:
        return report
    lines = []
    for item in items:
        if not isinstance(item, dict) or not item.get("requirement"):
            continue
        value = f" — {item['value']}" if item.get("value") else ""
        comment = f" ({item['comment']})" if item.get("comment") and item.get("status") in ("open", "not_met") else ""
        # A row with no status states none: defaulting it to „offen" would
        # write an open question into memory that the report never raised.
        status = f" — {item['status']}" if item.get("status") else ""
        lines.append(f"- {item['requirement']}{value}{status}{comment}")
    return f"{report.rstrip()}\n\n## Befunde\n" + "\n".join(lines) if lines else report


async def _extract_report_anatomy(llm: Any, query: str, report: str) -> ReportAnatomy:
    """The masthead and the findings of the finished report; never raises."""
    try:
        from aiq_agent.agents.deep_researcher.anatomy import extract_report_anatomy

        anatomy = await extract_report_anatomy(llm, query, report)
        if anatomy.findings:
            logger.info("Extracted %d finding(s) from the deep-research report", len(anatomy.findings["items"]))
        return anatomy
    except Exception as e:  # noqa: BLE001 — additive; the report is already whole
        logger.warning("Report anatomy extraction failed (non-fatal): %s", e)
        return ReportAnatomy(failed=True)


async def _propose_report_follow_ups(
    llm: Any, *, query: str, report: str, organization_id: str | None
) -> dict[str, Any] | None:
    """The follow-up questions a finished report makes askable, as the stage's payload.

    The post-answer stage runs on chat turns and skips a turn that only
    commissioned a run; the report message is where those questions belong,
    so the stage's own handler is called here, under the same org flag and
    the same bound, and its payload is written onto the message the way the
    client would have mirrored a frame. Never raises.
    """
    try:
        from aiq_agent.stages import StageContext
        from aiq_agent.stages import TurnFacts
        from aiq_agent.stages.flags import resolve_enabled_stages
        from aiq_agent.stages.follow_ups import FOLLOW_UPS

        enabled = await resolve_enabled_stages(organization_id=organization_id, memory_reflection_enabled=False)
        if FOLLOW_UPS.id not in enabled:
            return None
        facts = TurnFacts(query=query, answer=report, organization_id=organization_id)
        payload = await asyncio.wait_for(FOLLOW_UPS.handler(StageContext(facts=facts, llm=llm)), FOLLOW_UPS.timeout_s)
        return payload if isinstance(payload, dict) and payload.get("items") else None
    except Exception as e:  # noqa: BLE001 — additive; the report is already whole
        logger.warning("Report follow-ups failed (non-fatal): %s", e)
        return None


async def _generate_grid_cards(llm: Any, query: str, report: str) -> CardGenerationResult:
    """Generate Grid response cards from the final report.

    Best-effort: never raises, so card generation can never crash or fail the
    job. It does say when it LOST — ``failed`` on the result — because a run
    whose card model timed out used to look exactly like a run whose report
    warranted no proposals, and the reader had no way to ask for them again.
    """
    try:
        from aiq_agent.cards.generate import generate_cards_result

        result = await generate_cards_result(llm, query, report)
        if result.cards:
            logger.info("Generated %d Grid card(s) for deep-research report", len(result.cards))
        return result
    except Exception as e:
        logger.warning("Grid card generation failed (non-fatal): %s", e)
        return CardGenerationResult(cards=None, failed=True)


async def _run_deep_research_reflection(
    *,
    builder: Any,
    job_id: str,
    reflection_llm_ref: str | None,
    reflection_enabled: bool,
    query: str,
    report: str,
    usage_context: dict | None,
    memory_digest: str | None,
    org_credential: Any,
    model_overrides: dict[str, str] | None,
    zdr_only: bool = True,
) -> None:
    """Best-effort project-memory reflection over a finished deep-research report.

    The synchronous chat path runs a post-answer reflection stage for
    chat/meta turns but deliberately skips deep-research jobs (see
    piloti/conversation_register.py, ``not deep_research_job_id``) because the report
    does not exist until the async job completes. This closes that gap on the
    worker, where the report and the submitting identity are both in hand.

    Unlike the chat path this is AWAITED, not fire-and-forget: the report has
    already been delivered to the user, and awaiting keeps the builder-owned LLM
    client alive until reflection finishes (the ``async with WorkflowBuilder``
    context is still open at the call site). It only ever delays the job's
    SUCCESS bookkeeping, never the answer, and never raises — reflection is a
    safety net, not part of the job contract.

    Bounded by the same ``REFLECTION_TIMEOUT_S`` the chat path's stage declares
    (``stages/memory_reflection.py``). Without it the only bound was the
    reflection model's own ``request_timeout`` times its retries, close to six
    minutes, during which the job read RUNNING, the thread turn was not written
    and the outcome notification did not go out — over a report the reader
    already had.
    """
    if not reflection_enabled or not reflection_llm_ref or not report:
        return
    identity = _reflection_identity(usage_context)
    if identity is None:
        return
    from aiq_agent.stages.memory_reflection import REFLECTION_TIMEOUT_S

    try:
        reflection_llm = await _reflection_llm(builder, reflection_llm_ref, org_credential, model_overrides, zdr_only)
        await asyncio.wait_for(
            _reflect(reflection_llm, identity, job_id=job_id, query=query, report=report, memory_digest=memory_digest),
            timeout=REFLECTION_TIMEOUT_S,
        )
    except TimeoutError:
        logger.warning(
            "Job %s: deep-research memory reflection timed out after %ss (non-fatal)", job_id, REFLECTION_TIMEOUT_S
        )
    except Exception:
        logger.warning("Job %s: deep-research memory reflection failed (non-fatal)", job_id, exc_info=True)


def _reflection_identity(usage_context: dict | None) -> dict | None:
    """The run's identity when its report may be reflected into project memory, else None.

    The autonomous reflection stage only writes project-scoped memory (audit
    finding S1): an org-only job has nothing it may safely record.

    ADR-0087: no restricted-folder check here, on purpose. A check on this job's
    scope could never fire: the BFF signs a restricted collection only into an
    interactive chat scope (`collection-scope-request.ts`, pinned by
    `collection-scope-request.restricted.spec.ts`), so a run's scope is always
    open. What could carry restricted content into a run is its INPUT, the
    question a confined chat turn wrote, and that is refused where the run is
    commissioned: `commissionResearchRun` and `delegateTask` refuse a
    conversation that drew on a restricted folder, and a turn whose signed scope
    held one (`lib/conversations/restricted-egress.ts`). So the question and the
    report are open content, and reflecting them into open project memory is right.
    """
    identity = (usage_context or {}).get("identity") or {}
    return identity if identity.get("project_id") else None


async def _reflect(
    llm: Any, identity: dict, *, job_id: str, query: str, report: str, memory_digest: str | None
) -> None:
    """One reflection pass over the report, profiled and costed under the run's identity."""
    from aiq_agent.common.cost_tracking import BudgetSnapshot
    from aiq_agent.common.cost_tracking import track_llm_costs
    from aiq_agent.common.profiler import track_agent_profile
    from aiq_agent.memory.reflection import run_memory_reflection

    with (
        track_agent_profile(agent_name="project_memory_reflection", job_id=job_id, identity=identity),
        track_llm_costs(job_id=job_id, identity=identity, budget=BudgetSnapshot()),
    ):
        await run_memory_reflection(
            llm=llm,
            query=query,
            answer=report,
            project_id=identity["project_id"],
            organization_id=identity.get("organization_id"),
            conversation_id=identity.get("conversation_id"),
            # The MEMORY digest, not the intake profile: the pass compares the
            # report against what is already remembered, and against the profile
            # it re-recorded known findings and could never resolve a supersede quote.
            memory_digest=memory_digest,
        )


async def _reflection_llm(
    builder: Any, llm_ref: str, org_credential: Any, model_overrides: dict[str, str] | None, zdr_only: bool
) -> Any:
    """The reflection model with every dial explicit: the org's credential, its override, zero data retention.

    Explicit, not read from context: a research worker has no live request, and
    a getter here would be a blocking BFF call on the worker's loop. The
    credential goes first, so the ZDR pin lands only on a model that still
    points at OpenRouter.
    """
    from aiq_agent.common import AgentGroup
    from aiq_agent.common import apply_model_override
    from aiq_agent.common import apply_org_credential
    from aiq_agent.common import get_langchain_llm
    from aiq_agent.common import sanitize_model_overrides

    llm = await get_langchain_llm(builder, llm_ref)
    overrides = sanitize_model_overrides(model_overrides) if model_overrides else {}
    return apply_model_override(
        apply_org_credential(llm, org_credential), AgentGroup.MEMORY_REFLECTION, overrides, zdr_only=zdr_only
    )
