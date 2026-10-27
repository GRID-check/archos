"""The persist and finish phases of a research job, and its failure path.

``persist`` turns the agent's raw result into the job's output: the post-report
passes (cards, anatomy, follow-ups, memory reflection), the cards re-emitted
with the report, and the marks the run left on its answer. ``finish`` writes the
terminal SUCCESS and only then the thread turn and the notification.
``finish_failed`` is the same for a run that raised.

EVERY PUBLISH IS GATED ON OWNING THE VERDICT. Terminal statuses are sticky: a
job the reaper or the cancel route already finalized (FAILURE, INTERRUPTED) is
never flipped back, and a worker whose queue claim was reclaimed lost the race
even while ``job_info`` still reads RUNNING. A run that does not own the
verdict writes no thread turn, no notice and no notification: thread, Report
and status would otherwise tell three different stories about one run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.turn_status import DEGRADED_CARDS_GENERATION_FAILED
from aiq_agent.observability.turn_trace import current_trace_id_hex

from .conversation_output import FAILURE_NOTICE
from .conversation_output import write_job_notice
from .conversation_output import write_job_turn
from .event_store import BatchingEventStore
from .event_store import EventStore
from .outcome_notify import notify_job_outcome
from .phase_events import PHASE_DONE
from .phase_events import emit_phase_event
from .runner import _DEGRADED_EVENT_FIELDS
from .runner import JOB_DEGRADED_EVENT_TYPE
from .runner import _build_job_output
from .runner import _extract_answer_transparency
from .runner import _extract_result
from .runner import _extract_skills_activated
from .runner import _extract_verified_sources
from .runner import _lost_claim
from .runner import _mark_degraded
from .runner import _merge_job_cards
from .runner import _produces_report
from .runner import _run_report_passes
from .runner import _should_notify_outcome
from .runner import _should_write_notice
from .runner import _update_status_if_not_terminal
from .runner import _workflow_reflection_llm_ref
from .runner import sanitize_job_error

if TYPE_CHECKING:
    from .agent_job import JobRequest
    from .agent_job import JobScope
    from .agent_job_setup import JobModels
    from .agent_job_setup import RunContext

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobOutcome:
    """What a finished run produced, read once and handed to every surface that shows it."""

    report: str
    cards: list[Any] | None
    transparency: dict[str, Any]
    # The answer's structured provenance: the job output feeds the live Report
    # panel, the thread turn the thread on reload, and both get this one list.
    sources: list[dict[str, Any]] | None
    skills_activated: list[str] | None
    output: Any


async def persist(
    scope: JobScope,
    request: JobRequest,
    run: RunContext,
    result: Any,
    *,
    agent_cls: type,
    models: JobModels,
    builder: Any,
    config: Any,
) -> JobOutcome:
    """The post-report passes, the cards and the answer's marks, folded into the job output.

    Everything here is bookkeeping ABOUT a finished answer: each step is
    best-effort and none of them can fail the job.
    """
    report = _extract_result(result)
    # Grid cards, anatomy and follow-ups run together, then the memory reflection,
    # which the chat path skips for deep jobs because the report exists only now.
    # An agent that declares ``produces_report = False`` gets none of them.
    cards_result, anatomy, follow_ups = await _run_report_passes(
        produces_report=_produces_report(agent_cls),
        llm=models.llm,
        input_text=request.input_text,
        report=report,
        organization_id=request.organization_id,
        builder=builder,
        job_id=request.job_id,
        # A scheduled job's submitter (the BFF) knows the flag, not the config's LLM ref.
        reflection_llm_ref=request.memory_reflection_llm or _workflow_reflection_llm_ref(config),
        reflection_enabled=request.memory_reflection_enabled,
        usage_context=request.usage_context,
        memory_digest=run.memory_digest,
        org_credential=models.org_credential,
        model_overrides=request.model_overrides,
        zdr_only=models.zdr,
    )
    cards = _merge_job_cards(scope.card_snapshot, cards_result.cards)
    if cards:
        try:
            scope.agent_event_callback.emit_final_report(report, cards=cards)
        except Exception:
            logger.warning("Job %s: failed to emit final report with cards (non-fatal)", request.job_id)
    transparency = _transparency(scope, request, result, anatomy, follow_ups, cards_failed=cards_result.failed)
    if getattr(models.fn_config, "type", None) == "deep_research_agent":
        emit_phase_event(scope.event_store, PHASE_DONE)
    # Flush buffered events before the status changes.
    if hasattr(scope.event_store, "flush"):
        scope.event_store.flush()
    sources = _extract_verified_sources(result)
    return JobOutcome(
        report=report,
        cards=cards,
        transparency=transparency,
        sources=sources,
        skills_activated=_extract_skills_activated(result),
        output=_build_job_output(report, cards=cards, transparency=transparency, sources=sources),
    )


def _transparency(
    scope: JobScope, request: JobRequest, result: Any, anatomy: Any, follow_ups: Any, *, cards_failed: bool
) -> dict[str, Any]:
    """The marks the run left on its own answer (cut off, degraded, citations stripped), and its anatomy.

    Read once, one step before the job is finalized, so the persisted output and
    the live ``job.degraded`` event come from the same read. Never raises.
    """
    transparency: dict[str, Any] = {}
    try:
        transparency = _extract_answer_transparency(result)
        if anatomy.answer_meta:
            transparency["answer_meta"] = anatomy.answer_meta
        if anatomy.findings:
            transparency["findings"] = anatomy.findings
        if follow_ups:
            transparency["stages"] = {"followUps": follow_ups}
        # Post-hoc card generation is the runner's own step, so its failure is
        # recorded here: the report is whole, the proposals derived from it are not.
        if cards_failed:
            _mark_degraded(transparency, DEGRADED_CARDS_GENERATION_FAILED)
        if scope.event_store is not None and (
            transparency.get("research_truncated") or transparency.get("degraded_reasons")
        ):
            # Its own event, NOT a status change: the run succeeded with a marked
            # answer, and a live listener would otherwise learn it only by
            # re-reading the finished job. Stable tokens only; the reader's caveat
            # rides the report's own banner.
            data = {key: transparency[key] for key in _DEGRADED_EVENT_FIELDS if key in transparency}
            scope.event_store.store({"type": JOB_DEGRADED_EVENT_TYPE, "data": data})
    except Exception:
        logger.warning("Job %s: failed to record answer transparency (non-fatal)", request.job_id, exc_info=True)
    return transparency


async def finish(scope: JobScope, request: JobRequest, outcome: JobOutcome) -> None:
    """Write SUCCESS unless the verdict is not this run's; then the thread turn and the notification."""
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    lost_claim = await _lost_claim(request.db_url, request.job_id, request.claim_owner)
    if lost_claim:
        logger.warning(
            "Job %s lost its queue claim; skipping SUCCESS write and thread publish (the owning worker publishes)",
            request.job_id,
        )
        finalized = False
    else:
        finalized = await _update_status_if_not_terminal(
            scope.job_store, request.job_id, JobStatus.SUCCESS, output=outcome.output
        )
    if not finalized:
        logger.info(
            "Job %s finished without a thread turn (%s); the standing verdict owns the thread",
            request.job_id,
            "queue claim lost" if lost_claim else "terminal status already set",
        )
        return
    await _write_thread_turn(scope, request, outcome)
    await notify_job_outcome(
        job_id=request.job_id,
        usage_context=request.usage_context,
        status="success",
        report=outcome.report,
        cards=outcome.cards,
        expect_run=request.expect_run,
    )
    logger.info(
        "Job %s completed (report: %d chars, cards: %d)",
        request.job_id,
        len(outcome.report),
        len(outcome.cards) if outcome.cards else 0,
    )


async def _write_thread_turn(scope: JobScope, request: JobRequest, outcome: JobOutcome) -> None:
    """Put the run INTO the conversation it was given when it fired, so somebody can open it and keep typing.

    Best-effort by contract: the report is already stored on the job, and a
    conversation write must never unmake a good run.
    """
    landed_in = await write_job_turn(
        conversation_id=request.parent_conversation_id,
        job_id=request.job_id,
        usage_context=request.usage_context,
        prompt=request.input_text,
        answer=outcome.report,
        cards=outcome.cards,
        skills_activated=outcome.skills_activated,
        sources=outcome.sources,
        # The same marks the job output got: the thread reads only this row, so
        # a salvaged run would otherwise reopen tomorrow as a clean answer.
        transparency=outcome.transparency,
        expect_run=request.expect_run,
        # The trace this run is in: the BFF scores votes on the report there.
        trace_id=current_trace_id_hex(),
    )
    # The message the report was written into, for the run's ledger. No file id
    # yet: this tier does not file the report.
    if scope.ledger is not None:
        scope.ledger.note_result(report_message_id=landed_in or None)


async def finish_failed(scope: JobScope, request: JobRequest, exc: Exception) -> None:
    """Record a run that raised: FAILURE unless the verdict is not this run's, the notice, the error event.

    The full exception is logged here; only the sanitized message is persisted
    and streamed.
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    logger.exception("Job %s failed: %s", request.job_id, type(exc).__name__)
    safe_error = sanitize_job_error(exc)
    finalized = False
    lost_claim = await _lost_claim(request.db_url, request.job_id, request.claim_owner)
    if lost_claim:
        logger.warning(
            "Job %s lost its queue claim; skipping FAILURE write and notice (the owning worker publishes)",
            request.job_id,
        )
    elif scope.job_store:
        finalized = await _update_status_if_not_terminal(
            scope.job_store, request.job_id, JobStatus.FAILURE, error=safe_error
        )
    verdict = JobStatus.FAILURE.value
    # The conversation was created when the job fired; left alone, a failed run
    # leaves an empty thread that reads as a broken product.
    if await _should_write_notice(
        job_store=scope.job_store, job_id=request.job_id, verdict=verdict, finalized=finalized
    ):
        await write_job_notice(
            conversation_id=request.parent_conversation_id,
            job_id=request.job_id,
            usage_context=request.usage_context,
            notice=FAILURE_NOTICE,
            expect_run=request.expect_run,
        )
    # A standing FAILURE (the reaper's) is reported by the reaper too; a repeat
    # here is harmless. A reclaimed loser reports nothing.
    if not lost_claim and await _should_notify_outcome(
        job_store=scope.job_store, job_id=request.job_id, verdict=verdict, finalized=finalized
    ):
        await notify_job_outcome(
            job_id=request.job_id,
            usage_context=request.usage_context,
            status="failure",
            error=safe_error,
            expect_run=request.expect_run,
        )
    if scope.event_store is None:
        scope.event_store = BatchingEventStore(EventStore(request.db_url, request.job_id))
    scope.event_store.store({"type": "job.error", "data": {"error": safe_error, "error_type": type(exc).__name__}})
    if hasattr(scope.event_store, "flush"):
        scope.event_store.flush()
