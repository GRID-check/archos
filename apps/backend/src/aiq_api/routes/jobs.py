"""Agent-agnostic async job API routes.

Routes:
    GET  /v1/jobs/async/agents                            - List available agent types
    POST /v1/jobs/async/submit                            - Submit a new job for any agent
    GET  /v1/jobs/async/job/{job_id}                      - Get job status
    GET  /v1/jobs/async/job/{job_id}/stream               - SSE stream from beginning
    GET  /v1/jobs/async/job/{job_id}/stream/{last_event_id} - SSE stream from event ID
    POST /v1/jobs/async/job/{job_id}/cancel               - Cancel running job
    GET  /v1/jobs/async/job/{job_id}/state                - Get artifacts from event store
    GET  /v1/jobs/async/job/{job_id}/report               - Get final report
    GET  /v1/internal/jobs/{job_id}/outcome               - A job's verdict for the BFF's run reconciler
                                                            (service token, never on the external allowlist)
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING
from typing import Any

from fastapi import FastAPI
from fastapi import Request

from aiq_agent.common.data_source_registry import get_all_sources
from aiq_agent.common.db_utils import redact_db_url

if TYPE_CHECKING:
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker

from ..jobs.ingest_dispatch import enqueue_only
from .internal_auth import _require_internal_token
from .job_event_cleanup import run_event_cleanup
from .job_models import AgentListResponse
from .job_models import DataSourcesResponse
from .job_models import InternalJobOutcomeResponse
from .job_models import JobReportResponse
from .job_models import JobStateResponse
from .job_models import JobStatusResponse
from .job_models import ResearchRunsResponse
from .job_reaper import checkpoint_retention_seconds
from .job_reaper import job_info_delete_grace_seconds
from .job_reaper import reap_stale_jobs_once

logger = logging.getLogger(__name__)


#: The catalog routes, answered without a job store: (method, path, handler in `job_handlers`, metadata).
_CATALOG_ROUTES: tuple[tuple[str, str, str, dict[str, Any]], ...] = (
    (
        "GET",
        "/v1/jobs/async/agents",
        "list_agents",
        dict(
            response_model=AgentListResponse,
            tags=["async jobs"],
            summary="List available agents",
            description="Returns all registered agent types that can be used with the submit endpoint.",
        ),
    ),
    (
        "GET",
        "/v1/data_sources",
        "list_data_sources",
        dict(
            response_model=DataSourcesResponse,
            tags=["data sources"],
            summary="List data sources and deployment capabilities",
        ),
    ),
)

#: The job routes, registered in this order on a `JobRouteHandlers` bound to the job store.
_JOB_ROUTES: tuple[tuple[str, str, str, dict[str, Any]], ...] = (
    (
        "POST",
        "/v1/jobs/async/submit",
        "submit_job",
        dict(
            response_model=JobStatusResponse,
            tags=["async jobs"],
            summary="Submit a new async job",
            description=(
                "Submit a research query to a registered agent. Returns a job ID for tracking progress via SSE stream."
            ),
            responses={
                400: {"description": "Unknown agent type or invalid request"},
                409: {"description": "A job with the supplied job_id already exists"},
                422: {"description": "One or more unknown or agent-unavailable data source IDs"},
            },
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/job/{job_id}",
        "get_job_status",
        dict(
            response_model=JobStatusResponse,
            tags=["async jobs"],
            summary="Get job status",
            description="Get the current status of an async job by its ID.",
            responses={404: {"description": "Job not found"}},
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/job/{job_id}/stream",
        "stream_job_events",
        dict(
            tags=["async jobs"],
            summary="Stream job events",
            description=(
                "Server-Sent Events (SSE) stream of job progress from the beginning."
                " Includes tool calls, intermediate results, and the final report."
            ),
            responses={404: {"description": "Job not found"}},
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/job/{job_id}/stream/{last_event_id}",
        "stream_job_events_from",
        dict(
            tags=["async jobs"],
            summary="Resume job event stream",
            description=(
                "Resume an SSE stream from a specific event ID. Use for reconnection after network interruption."
            ),
            responses={404: {"description": "Job not found"}},
        ),
    ),
    (
        "POST",
        "/v1/jobs/async/job/{job_id}/cancel",
        "cancel_job",
        dict(
            tags=["async jobs"],
            summary="Cancel a submitted or running job",
            description=(
                "Request cancellation of a submitted or running job. The job status will be set to INTERRUPTED."
            ),
            responses={
                400: {"description": "Job is not in a cancellable (SUBMITTED or RUNNING) state"},
                404: {"description": "Job not found"},
            },
        ),
    ),
    (
        "POST",
        "/v1/jobs/async/job/{job_id}/write-now",
        "write_now",
        dict(
            tags=["async jobs"],
            summary="Ask a running deep research to write its report from what it has",
            description=(
                "Records the reader's request; the worker stops researching after the current batch "
                "and writes the report from the notes gathered so far. The job keeps running until the report is filed."
            ),
            responses={
                400: {"description": "Job is not running"},
                404: {"description": "Job not found"},
            },
        ),
    ),
    (
        "POST",
        "/v1/jobs/async/job/{job_id}/documents",
        "add_document",
        dict(
            tags=["async jobs"],
            summary="Add a document to the Grundlage of a running deep research",
            description=(
                "Records the reader's addition; the worker plans one dedicated research query for the "
                "document in its next batch and the run block lists it beside the other Grundlage."
            ),
            responses={
                400: {"description": "Job is not running"},
                404: {"description": "Job not found"},
            },
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/job/{job_id}/state",
        "get_job_state",
        dict(
            response_model=JobStateResponse,
            tags=["async jobs"],
            summary="Get job artifacts",
            description="Get tool calls, outputs, and sources collected during job execution.",
            responses={404: {"description": "Job not found"}},
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/job/{job_id}/report",
        "get_job_report",
        dict(
            response_model=JobReportResponse,
            tags=["async jobs"],
            summary="Get final report",
            description="Get the final research report from a completed job.",
            responses={404: {"description": "Job not found"}},
        ),
    ),
    (
        "POST",
        "/v1/internal/jobs/kill-active",
        "kill_active_jobs",
        dict(
            tags=["async jobs", "internal"],
            summary="Kill every submitted or running job, across every organization (internal)",
            description=(
                "Service-token guarded; the BFF's platform maintenance button is the one caller. Each job gets "
                "the cancel route's treatment: INTERRUPTED and its queue row dropped, "
                "and the verdict reported so the BFF closes its run row."
            ),
            responses={403: {"description": "Missing or invalid internal token"}},
        ),
    ),
    (
        "GET",
        "/v1/internal/jobs/{job_id}/outcome",
        "get_internal_job_outcome",
        dict(
            response_model=InternalJobOutcomeResponse,
            tags=["async jobs", "internal"],
            summary="A job's verdict for the BFF's run reconciler (internal)",
            description=(
                "Service-token guarded. The run reconciler holds no user token and no signed envelope, "
                "so the user-scoped status route cannot answer it."
            ),
            responses={
                403: {"description": "Missing or invalid internal token"},
                404: {"description": "Job not found"},
            },
        ),
    ),
    (
        "GET",
        "/v1/jobs/async/jobs",
        "list_research_runs",
        dict(
            response_model=ResearchRunsResponse,
            tags=["async jobs"],
            summary="List research runs",
            description=(
                "List async job runs (research runs), optionally filtered by project collection, "
                "conversation, and/or status. Scoped to the runs a single-job read would open: the "
                "caller's own, and those in the project or conversation its signed envelope names "
                "(ADR-0084)."
            ),
        ),
    ),
)


def _add_routes(app: FastAPI, handlers: Any, routes: tuple[tuple[str, str, str, dict[str, Any]], ...]) -> None:
    """Register each route on ``app``, as ``@app.get`` / ``@app.post`` would, with its metadata."""
    for method, path, name, metadata in routes:
        app.add_api_route(path, getattr(handlers, name), methods=[method], **metadata)


async def register_job_routes(app: FastAPI, builder: WorkflowBuilder, worker: FastApiFrontEndPluginWorker) -> None:
    """
    Register agent-agnostic async job routes.

    Uses NAT's JobStore for job metadata. Research runs on the database-claimed
    queue (ADR-0021). The /v1/data_sources endpoint is always registered.
    """
    from .builder_state import set_active_builder

    # Publish the builder so the internal skills submit route (registered
    # without one) can reuse validate_data_sources_for_agent.
    set_active_builder(builder)

    from nat.front_ends.fastapi.async_jobs.job_store import JobStore

    from ..jobs import queue
    from ..jobs.access import ensure_job_access_table
    from ..jobs.event_store import EventStore
    from . import job_handlers

    if not get_all_sources():
        logger.warning(
            "No data sources registered. Add a 'data_sources' function with "
            "_type: data_source_registry to your YAML config to enable "
            "data source toggles in the UI."
        )
    _add_routes(app, job_handlers, _CATALOG_ROUTES)
    logger.info("Registered /v1/data_sources and /v1/jobs/async/agents routes")

    db_url = getattr(worker, "_db_url", None) or os.environ.get("NAT_JOB_STORE_DB_URL", "sqlite:///./data/jobs.db")
    # The job store the routes read and write. Research runs on the database-claimed
    # queue (ADR-0021), so there is no scheduler: JobStore only stores the address
    # it is given, and every call here goes to the database.
    job_store = JobStore(scheduler_address="", db_url=db_url)
    # submit_agent_job resolves the database from the environment only; publish the
    # worker-provided value so a NAT-config-only deployment (no env vars) doesn't
    # register routes whose every submission then fails.
    os.environ.setdefault("NAT_JOB_STORE_DB_URL", db_url)
    config_path = getattr(worker, "_config_file_path", None) or os.environ.get("NAT_CONFIG_FILE", "")
    if not config_path:
        logger.error("Config file path not available - NAT_CONFIG_FILE not set")
        return

    front_end_config = getattr(worker, "_front_end_config", None)
    default_expiry_seconds = getattr(front_end_config, "expiry_seconds", 86400) if front_end_config else 86400
    logger.info("Registering async job routes: db=%s, expiry=%ds", redact_db_url(db_url), default_expiry_seconds)
    await asyncio.get_running_loop().run_in_executor(None, ensure_job_access_table, db_url)
    await asyncio.get_running_loop().run_in_executor(None, queue.ensure_research_queue_table, db_url)
    handlers = job_handlers.JobRouteHandlers(builder, job_store, db_url, default_expiry_seconds)
    _add_routes(app, handlers, _JOB_ROUTES)
    logger.info("Registered async job routes at /v1/jobs/async")

    # Ensure job_events table exists before reaper runs (reaper queries it via raw SQL;
    # table is otherwise created lazily on first EventStore write).
    EventStore._ensure_table_exists(db_url)

    # Housekeeping runs only through these routes, one cycle per call, on a
    # schedule outside the process (the housekeeping CronJobs; Compose's
    # housekeeping service). ADR-0082 step A1.
    _add_housekeeping_routes(app, job_store, db_url, default_expiry_seconds)


def _add_housekeeping_routes(app: FastAPI, job_store, db_url: str, expiry_seconds: int) -> None:
    """One cycle of each housekeeping job, behind the internal token.

    The first three take the same Postgres advisory lock as their loop did, so a
    call that overlaps a running cycle (a slow previous call) skips and reports
    nothing done. The base-corpus cycle instead waits on the cross-replica
    ``oib-sync`` lock and then finds nothing left to queue. It ingests nothing itself: it
    records the ingest jobs that finished and queues one for each file that needs it.
    """

    @app.post("/v1/maintenance/housekeeping/ghost-jobs", tags=["maintenance"], include_in_schema=False)
    async def housekeeping_ghost_jobs(request: Request) -> dict:
        _require_internal_token(request)
        reaped = await reap_stale_jobs_once(job_store, db_url)
        return {"reaped": reaped}

    @app.post("/v1/maintenance/housekeeping/job-events", tags=["maintenance"], include_in_schema=False)
    async def housekeeping_job_events(request: Request) -> dict:
        _require_internal_token(request)
        return await run_event_cleanup(
            db_url, expiry_seconds, db_url.startswith("postgres"), job_info_delete_grace_seconds()
        )

    @app.post("/v1/maintenance/housekeeping/chat-checkpoints", tags=["maintenance"], include_in_schema=False)
    async def housekeeping_chat_checkpoints(request: Request) -> dict:
        from ..jobs.checkpoint_retention import reap_idle_threads

        _require_internal_token(request)
        dsn = os.environ.get("GRID_CHECKPOINT_DB")
        if not dsn:
            return {"threads_reaped": 0, "skipped": "GRID_CHECKPOINT_DB is not set"}
        retention_seconds = checkpoint_retention_seconds()
        return {"threads_reaped": await asyncio.to_thread(reap_idle_threads, dsn, retention_seconds)}

    @app.post("/v1/maintenance/housekeeping/base-corpus", tags=["maintenance"], include_in_schema=False)
    async def housekeeping_base_corpus(request: Request) -> dict:
        from aiq_agent import oib_sync

        _require_internal_token(request)
        result = await asyncio.to_thread(oib_sync.sync, enqueue=enqueue_only)
        return {
            "enqueued": result.enqueued,
            "ingested_recorded": result.ingested_recorded,
            "failed": result.failed,
            "total": result.total,
        }
