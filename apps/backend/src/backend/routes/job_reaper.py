"""Ghost jobs: runs with no heartbeat for too long are failed, once per cycle, under an advisory lock."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from ..jobs.outcome_notify import notify_job_outcome_from_access
from ..jobs.runner import _update_status_if_not_terminal

logger = logging.getLogger(__name__)


GHOST_JOB_TIMEOUT_SECONDS = 300  # 5 minutes without events = ghost job


GHOST_JOB_ERROR = "Job timed out (no heartbeat received from worker)"


# Active jobs whose last event is older than the timeout, per dialect.
_STALE_SQL = {
    "postgres": (
        "SELECT DISTINCT je.job_id FROM job_events je "
        "INNER JOIN job_info ji ON je.job_id = ji.job_id "
        "WHERE ji.status IN ({statuses}) "
        "GROUP BY je.job_id "
        "HAVING MAX(je.created_at) < NOW() - :timeout * INTERVAL '1 second'"
    ),
    "sqlite": (
        "SELECT DISTINCT je.job_id FROM job_events je "
        "INNER JOIN job_info ji ON je.job_id = ji.job_id "
        "WHERE ji.status IN ({statuses}) "
        "GROUP BY je.job_id "
        "HAVING MAX(je.created_at) < datetime('now', :timeout_interval)"
    ),
}

# Active jobs that never produced a single event. The INNER JOIN above can't
# match them, but they are exactly the crash class the reaper exists for: a
# worker that died during agent setup (RUNNING, before the first
# heartbeat/callback event). Timestamps come from job_info since these jobs
# have no events at all.
_EVENTLESS_SQL = {
    "postgres": (
        "SELECT ji.job_id FROM job_info ji "
        "LEFT JOIN job_events je ON je.job_id = ji.job_id "
        "WHERE ji.status IN ({statuses}) AND je.job_id IS NULL "
        "AND COALESCE(ji.updated_at, ji.created_at) < NOW() - :timeout * INTERVAL '1 second'"
    ),
    "sqlite": (
        "SELECT ji.job_id FROM job_info ji "
        "LEFT JOIN job_events je ON je.job_id = ji.job_id "
        "WHERE ji.status IN ({statuses}) AND je.job_id IS NULL "
        "AND datetime(COALESCE(ji.updated_at, ji.created_at)) < datetime('now', :timeout_interval)"
    ),
}


def _with_statuses(template: str, statuses: tuple[str, ...]):
    """``template`` as a statement with one bound ``:sN`` placeholder per status, and its parameters."""
    from sqlalchemy import text

    placeholders = ", ".join(f":s{i}" for i in range(len(statuses)))
    params: dict[str, Any] = {f"s{i}": status for i, status in enumerate(statuses)}
    # The template is a module literal and the placeholders are generated; every status is bound.
    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    return text(template.format(statuses=placeholders)), params


def _find_stale_jobs(db_url: str, active_statuses: tuple[str, ...]) -> list[str]:
    """
    Sync helper to query for ghost jobs in any of the given non-terminal statuses.

    Runs in a thread via run_in_executor to avoid blocking the async event loop
    with DB I/O.
    """
    from sqlalchemy import inspect

    from ..jobs.event_store import EventStore

    EventStore._ensure_table_exists(db_url)
    engine = EventStore._get_or_create_sync_engine(db_url)
    if not inspect(engine).has_table("job_events"):
        return []

    dialect = "postgres" if db_url.startswith("postgres") else "sqlite"
    if dialect == "postgres":
        timeout: dict[str, Any] = {"timeout": GHOST_JOB_TIMEOUT_SECONDS}
    else:
        timeout = {"timeout_interval": f"-{GHOST_JOB_TIMEOUT_SECONDS} seconds"}

    stale_ids: list[str] = []
    with engine.connect() as conn:
        for templates in (_STALE_SQL, _EVENTLESS_SQL):
            query, params = _with_statuses(templates[dialect], active_statuses)
            stale_ids.extend(row[0] for row in conn.execute(query, {**params, **timeout}))
    return stale_ids


async def reap_stale_jobs_once(job_store, db_url: str) -> list[str]:
    """Run a single reap cycle: mark stale jobs FAILURE so their workers stop.

    Returns the list of reaped job IDs. Factored out of _reap_ghost_jobs for
    testability.
    """
    from agent.knowledge.leader_lock import leader_lock_async

    # Only one replica runs the cycle (advisory lock), so N web replicas don't
    # redundantly re-detect and re-mark the same ghosts. A session lock, so it is
    # taken on the direct LOCK_DB_URL connection, never on db_url (ADR-0083).
    async with leader_lock_async(_PG_REAPER_LOCK_ID) as is_leader:
        if not is_leader:
            return []
        return await _do_reap_cycle(job_store, db_url, asyncio.get_running_loop())


async def _do_reap_cycle(job_store, db_url: str, loop) -> list[str]:
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    from ..jobs.event_store import EventStore

    # A SUBMITTED job is a HEALTHY queued row waiting for a free worker (it
    # legitimately has zero events until claimed), so it must NOT be reaped — the
    # whole point of the queue is to absorb bursts. Crashed CLAIMED jobs are
    # recovered by the queue's own heartbeat reclaim / reap_exhausted, not here.
    # Only genuinely abandoned RUNNING jobs (no events for the ghost window) are
    # reaped.
    stale_job_ids = await loop.run_in_executor(None, _find_stale_jobs, db_url, (JobStatus.RUNNING.value,))

    reaped: list[str] = []
    for stale_job_id in stale_job_ids:
        logger.warning("Reaping ghost job %s (no events for %ds)", stale_job_id, GHOST_JOB_TIMEOUT_SECONDS)
        try:
            # Conditional write: the worker may have finalized this job after
            # it was detected as stale (a SUCCESS racing the reaper). An
            # unconditional update_status here would flip that verdict back to
            # FAILURE — the mirror image of the runner-overwrites-reaper race.
            written = await _update_status_if_not_terminal(
                job_store,
                stale_job_id,
                JobStatus.FAILURE,
                error=GHOST_JOB_ERROR,
            )
            if not written:
                logger.info(
                    "Ghost job %s reached a terminal status before reaping; leaving the existing verdict",
                    stale_job_id,
                )
                continue
            event_store = EventStore(db_url, stale_job_id)
            event_store.store(
                {
                    "type": "job.error",
                    "data": {
                        "error": GHOST_JOB_ERROR,
                        "error_type": "GhostJobTimeout",
                    },
                }
            )
            # The worker stops by itself: its CancellationMonitor polls the
            # FAILURE it just wrote and aborts the run.
            # The run is dead or will lose every later write, so nothing else
            # will tell the BFF; its run row closes on this report.
            await notify_job_outcome_from_access(
                job_id=stale_job_id,
                db_url=db_url,
                status="failure",
                error=GHOST_JOB_ERROR,
            )
            reaped.append(stale_job_id)
        except Exception as e:
            logger.warning("Failed to reap ghost job %s: %s", stale_job_id, e)

    return reaped


def _int_env(name: str, default: int) -> int:
    """Positive-int env override, falling back to ``default`` on unset/invalid/≤0."""

    try:
        val = int(os.environ.get(name, ""))
        return val if val > 0 else default
    except TypeError, ValueError:
        return default


"""Module-level reference for graceful shutdown cancellation."""


"""Module-level reference for the chat checkpoint reaper (shutdown cancellation)."""


# Advisory lock ID for PostgreSQL — ensures only one pod runs cleanup at a time.
# Arbitrary constant; change if it collides with another lock in your deployment.
PG_ADVISORY_LOCK_ID = 0x41495143_4C45414E  # "AIQCLEAN" in hex


# Distinct lock for the ghost-job reaper so N web replicas don't double-reap.
_PG_REAPER_LOCK_ID = PG_ADVISORY_LOCK_ID + 1


def checkpoint_retention_seconds() -> int:
    return _int_env("CHAT_CHECKPOINT_RETENTION_SECONDS", 1209600)  # 14d


def job_info_delete_grace_seconds() -> int:
    """How long an expired, terminal job's rows are kept before the event cleanup deletes them."""
    return _int_env("JOB_INFO_DELETE_GRACE_SECONDS", 604800)  # 7d
