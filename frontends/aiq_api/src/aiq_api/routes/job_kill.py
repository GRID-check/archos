"""The platform operator's kill.

Every submitted or running job interrupted, its queue row dropped, its verdict reported.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from ..jobs.outcome_notify import notify_job_outcome_from_access
from ..jobs.runner import _update_status_if_not_terminal

logger = logging.getLogger(__name__)


KILL_REASON = "killed by platform operator"


# One press of the button, bounded like every other list here. A fleet with
# more live jobs than this is killed by pressing again.
KILL_BATCH = 1000


async def stop_interrupted_job(db_url: str, job_id: str, *, reason: str) -> None:
    """Stop the worker of a job whose INTERRUPTED status the caller just wrote, and report it.

    Shared by the cancel route and the platform kill. Dropping the queue row
    keeps a job no worker has claimed from ever running; a running worker sees
    the INTERRUPTED status through its CancellationMonitor and stops on its own
    (ADR-0021).
    """
    from ..jobs import queue
    from ..jobs.event_store import EventStore

    loop = asyncio.get_running_loop()

    def _record_cancellation_event() -> None:
        # EventStore construction and store() are blocking DB I/O; keep them
        # off the event loop like the rest of this module.
        EventStore(db_url, job_id).store({"type": "job.cancellation_requested", "data": {"reason": reason}})

    await loop.run_in_executor(None, _record_cancellation_event)
    await loop.run_in_executor(None, queue.mark_done, db_url, job_id)

    # The caller wrote the verdict, so it reports it. A running worker reports
    # the same INTERRUPTED again when its abort lands, which the BFF absorbs;
    # but a job no worker ever claimed (its queue row was just dropped) has no
    # runner left to report anything, and the BFF's run row would stay `running`
    # forever. No error text, exactly like the runner's own report, so the two
    # reports write the same row.
    await notify_job_outcome_from_access(job_id=job_id, db_url=db_url, status="interrupted")


def _find_active_job_ids(db_url: str, statuses: tuple[str, ...], limit: int) -> list[str]:
    """Every job in one of ``statuses``, oldest first. Sync; run it in an executor."""
    from sqlalchemy import bindparam
    from sqlalchemy import inspect
    from sqlalchemy import text

    from ..jobs.event_store import EventStore

    engine = EventStore._get_or_create_sync_engine(db_url)
    if not inspect(engine).has_table("job_info"):
        return []
    # A literal statement with an expanding bind: no SQL is built from strings.
    query = text(
        "SELECT job_id FROM job_info WHERE status IN :statuses ORDER BY created_at, job_id LIMIT :limit"
    ).bindparams(bindparam("statuses", expanding=True))
    with engine.connect() as conn:
        rows = conn.execute(query, {"statuses": list(statuses), "limit": limit})
        return [row[0] for row in rows]


async def kill_every_active_job(job_store, db_url: str) -> dict:
    """Interrupt every SUBMITTED or RUNNING job and stop its worker.

    Each job goes through the cancel route's conditional write, so a job that
    finishes while the sweep runs keeps its own verdict and is counted as
    already finished. One job's failure is logged and counted; it never stops
    the others from being killed.
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    loop = asyncio.get_running_loop()
    statuses = (JobStatus.RUNNING.value, JobStatus.SUBMITTED.value)
    job_ids = await loop.run_in_executor(None, _find_active_job_ids, db_url, statuses, KILL_BATCH)

    killed: list[str] = []
    already_finished = 0
    failed: list[dict[str, str]] = []
    for job_id in job_ids:
        try:
            written = await _update_status_if_not_terminal(job_store, job_id, JobStatus.INTERRUPTED, error=KILL_REASON)
            if not written:
                already_finished += 1
                continue
            await stop_interrupted_job(db_url, job_id, reason=KILL_REASON)
            killed.append(job_id)
        except Exception as exc:
            logger.warning("kill-active: job %s could not be killed: %s", job_id, exc)
            failed.append({"job_id": job_id, "error": str(exc)})

    logger.warning(
        "kill-active: killed %d job(s), %d had already finished, %d failed", len(killed), already_finished, len(failed)
    )
    return {
        "found": len(job_ids),
        "killed": killed,
        "already_finished": already_finished,
        "failed": failed,
        "truncated": len(job_ids) >= KILL_BATCH,
    }
