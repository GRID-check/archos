"""The dedicated ingestion worker tier (ADR-0076).

Run as its own container: ``PROCESS_ROLE=ingest-worker`` makes the entrypoint start
``python -m agent_host.jobs.ingest_worker``. It builds the NAT workflow once, which
activates the ingestor exactly as the web roles do (same summary model, same
shared Qdrant, same object store), attaches the durable queue to it, and then
does nothing but claim: its ``INGEST_MAX_WORKERS`` threads take the next job
fairly across every organisation, run it, and come back for another.

No web server, no port, no state of its own: jobs live in Postgres, vectors in
the shared Qdrant cluster. So the tier scales on the one number that says how much
ingestion is waiting, the depth of ``ingest_job_queue``, from zero workers when
nothing is queued to as many as the provider's rate limit allows.

On SIGTERM it stops claiming and waits up to ``INGEST_WORKER_DRAIN_SECONDS``
for the jobs it holds (a claim in flight counts as held). A job still running
when that budget ends is given back to the queue at no cost in attempts, and
another worker claims it at once; re-indexing replaces a file's chunks, so the
second run is the one that counts. A pod that is killed instead (OOM, node loss)
leaves its claims to go stale and be claimed again.

Config (env):
  CONFIG_FILE / NAT_CONFIG_FILE        the NAT config the web tier runs
  INGEST_MAX_WORKERS               jobs this process runs at once (default 2)
  INGEST_WORKER_DRAIN_SECONDS     drain budget on SIGTERM (default 600)
  WORKER_LIVENESS_FILE            touched while the loop is alive
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import time

from agent.common.logging_utils import suppress_noisy_dependency_logs
from agent.knowledge.leader_lock import require_direct_dsns

from . import ingest_dispatch
from . import lease_policy

logger = logging.getLogger(__name__)

_DEFAULT_CONFIG = "/app/configs/config_oib_openrouter.yml"
_LIVENESS_EVERY_SECONDS = 15


def _drain_seconds() -> int:
    """Not a number is the default; a negative budget is none."""
    return max(0, lease_policy.int_env("INGEST_WORKER_DRAIN_SECONDS", lease_policy.DRAIN_SECONDS))


async def run(stop: asyncio.Event) -> None:
    """Build the ingestor, claim until ``stop``, then drain."""
    from agent.knowledge.factory import get_active_ingestor
    from agent.observability import boot_timing
    from agent.observability import ensure_registered as register_grid_telemetry
    from agent.observability.boot_timing import BootClock
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.runtime.loader import load_config

    config_file = os.environ.get("CONFIG_FILE") or os.environ.get("NAT_CONFIG_FILE") or _DEFAULT_CONFIG
    liveness = os.environ.get("WORKER_LIVENESS_FILE", "/tmp/ingest-worker.alive")
    # Grid's telemetry `_type`s register at import; load_config fails without them.
    register_grid_telemetry()
    clock = BootClock("ingest-worker")
    with clock.phase("load_config"):
        config = load_config(config_file)
    building = time.monotonic()
    async with WorkflowBuilder.from_config(config=config):
        clock.record("workflow_build", time.monotonic() - building)
        ingestor = get_active_ingestor()
        if ingestor is None:
            raise RuntimeError(f"{config_file} activates no ingestor; there is nothing to run jobs with")
        if not ingest_dispatch.attach(ingestor):
            raise RuntimeError("the ingest queue is off or has no database (INGEST_QUEUE, SUMMARY_DB)")
        logger.info("Ingest worker %s claiming", ingest_dispatch.worker_id())
        clock.ready()
        boot_timing.flush()
        cards = _start_folder_cards(stop)
        while not stop.is_set():
            lease_policy.touch_liveness(liveness)
            try:
                await asyncio.wait_for(stop.wait(), timeout=_LIVENESS_EVERY_SECONDS)
            except TimeoutError:
                pass
        await _drain(ingestor)
        if cards is not None:
            await cards


def _start_folder_cards(stop: asyncio.Event) -> asyncio.Task | None:
    """The folder card builder's loop, beside the claim loop.

    It always runs: whether an organization has cards is its ``folder-cards`` WorkOS
    flag, which the builder asks the BFF per claimed folder (ADR-0127), so a
    deployment where no organization has the flag finds an empty queue.
    """
    from agent.knowledge.folder_cards import worker

    logger.info("Ingest worker builds folder cards")
    return asyncio.create_task(worker.loop(stop), name="folder-cards")


async def _drain(ingestor) -> None:
    ingestor.detach_job_source()
    budget = _drain_seconds()
    logger.info("Ingest worker draining %d job(s) for up to %ds", ingestor.busy_workers, budget)
    waited = 0.0
    while ingestor.busy_workers and waited < budget:
        await asyncio.sleep(1)
        waited += 1
    if ingestor.busy_workers:
        # Not lost, and not a failed attempt: another worker takes them now,
        # where a claim left to go stale would wait out the stale window and
        # count against the job's attempts.
        released = ingest_dispatch.release_held()
        logger.warning(
            "Ingest worker stopping with %d job(s) running; %d claim(s) given back to the queue",
            ingestor.busy_workers,
            released,
        )


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    suppress_noisy_dependency_logs()
    # Every file takes a `keyed_lock` while it replaces its predecessor, which
    # needs the direct DSN (ADR-0083). It never LISTENs. Fail the boot, not the
    # first file.
    require_direct_dsns(listen=False)
    stop = asyncio.Event()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        loop.run_until_complete(run(stop))
    finally:
        loop.close()


if __name__ == "__main__":
    main()
