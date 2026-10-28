"""The handlers behind the async job routes (`jobs.py` registers them, with their OpenAPI metadata)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import TYPE_CHECKING
from typing import Annotated
from typing import Any

from fastapi import Body
from fastapi import HTTPException
from fastapi import Request
from fastapi.responses import StreamingResponse

from agent.common.data_source_registry import get_all_sources
from agent.common.job_admission import JobAdmissionError

from ..jobs.access import JobCaller
from ..jobs.access import require_verified_principal
from ..jobs.access import signed_job_scope
from ..registry import AGENT_REGISTRY
from ..registry import get_agent_config

if TYPE_CHECKING:
    from nat.builder.workflow_builder import WorkflowBuilder

from ..jobs.runner import DOCUMENT_ADDED_EVENT_TYPE
from ..jobs.runner import WRITE_NOW_EVENT_TYPE
from ..jobs.runner import _update_status_if_not_terminal
from .internal_auth import _require_internal_token
from .job_artifacts import get_job_artifacts
from .job_data_sources import validate_data_sources_for_agent
from .job_event_stream import sse_generator
from .job_kill import kill_every_active_job
from .job_kill import stop_interrupted_job
from .job_models import JOB_SUBMIT_EXAMPLES
from .job_models import AgentInfo
from .job_models import AgentListResponse
from .job_models import DataSource
from .job_models import DataSourcesResponse
from .job_models import InternalJobOutcomeResponse
from .job_models import JobDocumentRequest
from .job_models import JobReportResponse
from .job_models import JobStateResponse
from .job_models import JobStatusResponse
from .job_models import JobSubmitRequest
from .job_models import ResearchRunItem
from .job_models import ResearchRunsResponse
from .job_models import report_cards
from .job_models import report_sources
from .research_runs import find_research_runs
from .research_runs import format_created_at

logger = logging.getLogger(__name__)


def _job_caller(request: Request) -> JobCaller:
    """The verified principal, and the job scope its request's signed envelope grants (ADR-0084)."""
    principal = require_verified_principal()
    return JobCaller(principal=principal, scope=signed_job_scope(request.headers, principal))


def _job_status_value(status: Any) -> str:
    """The job store's status as its lowercase wire word, enum or string alike."""
    return str(getattr(status, "value", status)).lower()


async def internal_job_outcome(
    job_store: Any, db_url: str, job_id: str, organization_id: str
) -> InternalJobOutcomeResponse:
    """The job's verdict for one organization, or a 404.

    The tenant is checked against the job's ``job_access`` row, written at
    submit: the service token names no organization, and a reconciler that
    asked about another tenant's job id must learn nothing about it, not even
    that it exists.
    """
    from ..jobs.access import get_job_access
    from ..jobs.conversation_output import run_message_for_outcome

    job = await job_store.get_job(job_id)
    access = await asyncio.get_running_loop().run_in_executor(None, get_job_access, job_id, db_url) if job else None
    if not job or not access or access.get("organization_id") != organization_id:
        raise HTTPException(404, f"Job not found: {job_id}")

    status = _job_status_value(job.status)
    output: dict[str, Any] | None = None
    if job.output:
        try:
            parsed = json.loads(job.output) if isinstance(job.output, str) else job.output
            output = parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError, TypeError:
            output = None

    report = output.get("report") if output and status == "success" else None
    return InternalJobOutcomeResponse(
        job_id=job_id,
        status=status,
        error=job.error if status in ("failure", "interrupted") else None,
        report=report if isinstance(report, str) and report else None,
        cards=report_cards(output.get("cards")) if output and report else None,
        message=run_message_for_outcome(job_id=job_id, status=status, output=output),
    )


async def _submitted(req: JobSubmitRequest, request: Request, principal: Any, expiry: int) -> tuple[str, bool]:
    """Persist the job and its queue row; the job id, and whether the run acts as its requester.

    Every failure is a status code with a user-safe message: arbitrary internal
    error text (hosts, DSNs, stack details) is logged here and never echoed.
    """
    from agent.auth import get_auth_token

    from ..jobs.run_envelope import capture_request_envelope
    from ..jobs.submit import DuplicateJobIdError
    from ..jobs.submit import MissingPrincipalError
    from ..jobs.submit import submit_agent_job

    # The envelope the BFF signed for this submit, carried so the run's
    # person-acting tools act as the person who asked (ADR-0108). Only one
    # that verifies for THIS principal; anything else and the run acts as nobody.
    request_envelope = capture_request_envelope(request.headers, user_id=principal.sub)
    try:
        job_id = await submit_agent_job(
            agent_type=req.agent_type,
            input_text=req.input,
            owner=principal.email or principal.sub,
            principal=principal,
            job_id=req.job_id,
            expiry_seconds=expiry,
            data_sources=req.data_sources,
            # Propagated to the research worker for requires_auth data sources.
            auth_token=get_auth_token(),
            request_envelope=request_envelope,
        )
    except JobAdmissionError as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after_seconds)})
    except DuplicateJobIdError as e:
        # Caller-supplied job_id collides with an existing job; letting the
        # submission proceed would rewrite the original job's ownership.
        raise HTTPException(409, str(e))
    except MissingPrincipalError as e:
        # Static, user-safe message defined in jobs/submit.py.
        raise HTTPException(403, str(e))
    except RuntimeError:
        logger.exception("Runtime error submitting async %s job", req.agent_type)
        raise HTTPException(500, "Failed to submit async job")
    except Exception as e:
        logger.warning("Failed to submit authorized job: %s", e)
        raise HTTPException(500, "Failed to persist async job authorization metadata")
    return job_id, request_envelope is not None


async def list_agents() -> AgentListResponse:
    """List available agent types for async job submission."""
    agents = [
        AgentInfo(agent_type=agent_type, description=config.description)
        for agent_type, config in AGENT_REGISTRY.items()
    ]
    return AgentListResponse(agents=agents)


async def list_data_sources() -> DataSourcesResponse:
    """List data sources from the registry plus derived capabilities.

    ``vlm_available`` is derived from the knowledge layer's single VLM-key
    resolver (``vlm_configured``) — the same seam the ingestion path uses —
    so the advertised image-upload capability can never drift from what
    ingestion will actually attempt. Resolves defensively: any import/lookup
    failure reports ``vlm_available=False`` (fail-closed, no false offer).
    """
    try:
        from knowledge_layer.llamaindex.adapter import vlm_configured

        vlm_available = vlm_configured()
    except Exception:  # noqa: BLE001 — capability probe must never break the listing
        logger.warning("VLM capability probe failed; reporting vlm_available=False", exc_info=True)
        vlm_available = False

    return DataSourcesResponse(
        data_sources=[
            DataSource(
                id=source.id,
                name=source.name,
                description=source.description,
                requires_auth=source.requires_auth,
            )
            for source in get_all_sources()
        ],
        vlm_available=vlm_available,
    )


class JobRouteHandlers:
    """The async job routes' handlers, bound once at registration to the job store and the builder."""

    def __init__(
        self, builder: WorkflowBuilder | None, job_store: Any, db_url: str, default_expiry_seconds: int
    ) -> None:
        self.builder = builder
        self.job_store = job_store
        self.db_url = db_url
        self.default_expiry_seconds = default_expiry_seconds

    async def submit_job(
        self,
        req: Annotated[JobSubmitRequest, Body(openapi_examples=JOB_SUBMIT_EXAMPLES)],
        request: Request,
    ) -> JobStatusResponse:
        """Submit a new async job for deep research or other registered agents."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        try:
            agent_config = get_agent_config(req.agent_type)
        except KeyError as e:
            raise HTTPException(400, str(e))

        expiry = req.expiry_seconds if req.expiry_seconds is not None else self.default_expiry_seconds
        # Authenticate the caller (raises 401/403 if unverified). The returned principal
        # is also forwarded to submit_agent_job(...) for ownership recording.
        principal = require_verified_principal()
        validation_start = time.perf_counter()
        await validate_data_sources_for_agent(
            builder=self.builder,
            agent_type=req.agent_type,
            agent_config_name=agent_config.config_name,
            data_sources=req.data_sources,
        )
        logger.info(
            "Validated data_sources for agent %s in %.1fms (requested=%s)",
            req.agent_type,
            (time.perf_counter() - validation_start) * 1000,
            len(req.data_sources) if req.data_sources is not None else "none",
        )
        job_id, acts_as_requester = await _submitted(req, request, principal, expiry)
        logger.info(
            "Submitted %s job %s (expiry=%ds) for principal %s:%s (acts as requester: %s)",
            req.agent_type,
            job_id,
            expiry,
            principal.type,
            principal.sub,
            acts_as_requester,
        )
        return JobStatusResponse(
            job_id=job_id,
            status=JobStatus.SUBMITTED.value,
            agent_type=req.agent_type,
        )

    async def get_job_status(self, job_id: str, request: Request) -> JobStatusResponse:
        """Get the current status of a job."""

        from ..jobs.access import authorize_job_access

        job = await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "read")

        return JobStatusResponse(
            job_id=job_id,
            status=job.status,
            error=job.error,
            created_at=job.created_at.isoformat() if job.created_at else None,
        )

    async def stream_job_events(self, job_id: str, request: Request) -> StreamingResponse:
        """SSE stream for job events from beginning."""
        from ..jobs.access import authorize_job_access

        await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "read")

        return StreamingResponse(
            sse_generator(self.job_store, job_id, self.db_url, start_event_id=0),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def stream_job_events_from(self, job_id: str, last_event_id: int, request: Request) -> StreamingResponse:
        """SSE stream for job events from specific event ID (for reconnection)."""
        from ..jobs.access import authorize_job_access

        await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "read")

        return StreamingResponse(
            sse_generator(self.job_store, job_id, self.db_url, start_event_id=last_event_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def cancel_job(self, job_id: str, request: Request) -> dict:
        """Cancel a submitted or running job."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        from ..jobs.access import authorize_job_access

        job = await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "control")

        # SUBMITTED is cancellable too: a job stuck before its first status
        # transition would otherwise be un-cancellable while still consuming
        # its organization's running-job quota.
        if job.status not in (JobStatus.RUNNING.value, JobStatus.SUBMITTED.value):
            raise HTTPException(400, f"Job not cancellable: {job_id} (status: {job.status})")

        # Conditional, like every other terminal writer: the run may have
        # finished between the read above and this write, and an unconditional
        # write would relabel its SUCCESS as a cancel (and, with the report
        # below, tell the BFF so). The loser of that race gets the same 400 as
        # a job that had already ended.
        written = await _update_status_if_not_terminal(
            self.job_store, job_id, JobStatus.INTERRUPTED, error="cancelled by user"
        )
        if not written:
            raise HTTPException(400, f"Job not cancellable: {job_id} (already finished)")

        await stop_interrupted_job(self.db_url, job_id, reason="cancelled by user")
        logger.info("Cancel requested for job %s: status updated", job_id)

        return {"job_id": job_id, "status": JobStatus.INTERRUPTED.value}

    async def write_now(self, job_id: str, request: Request) -> dict:
        """Ask a running job to write its report now."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        from ..jobs.access import authorize_job_access
        from ..jobs.event_store import EventStore

        job = await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "control")

        if job.status != JobStatus.RUNNING.value:
            raise HTTPException(400, f"Job is not running: {job_id} (status: {job.status})")

        def _record() -> None:
            EventStore(self.db_url, job_id).store(
                {"type": WRITE_NOW_EVENT_TYPE, "data": {"reason": "requested by user"}}
            )

        await asyncio.get_running_loop().run_in_executor(None, _record)
        logger.info("Write-now requested for job %s", job_id)
        return {"job_id": job_id, "write_now": True}

    async def add_document(self, job_id: str, body: JobDocumentRequest, request: Request) -> dict:
        """Add one document to the Grundlage of a running job."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        from ..jobs.access import authorize_job_access
        from ..jobs.event_store import EventStore

        job = await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "control")

        if job.status != JobStatus.RUNNING.value:
            raise HTTPException(400, f"Job is not running: {job_id} (status: {job.status})")

        data = body.model_dump(exclude_none=True)

        def _record() -> None:
            EventStore(self.db_url, job_id).store({"type": DOCUMENT_ADDED_EVENT_TYPE, "data": data})

        await asyncio.get_running_loop().run_in_executor(None, _record)
        logger.info("Document added to the Grundlage of job %s: %s", job_id, body.name)
        return {"job_id": job_id, "document": data}

    async def get_job_state(self, job_id: str, request: Request) -> JobStateResponse:
        """Get artifacts from event store."""
        from ..jobs.access import authorize_job_access

        await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "read")

        artifacts = await get_job_artifacts(self.db_url, job_id)
        return JobStateResponse(
            job_id=job_id,
            has_state=artifacts is not None,
            state=None,
            artifacts=artifacts,
        )

    async def get_job_report(self, job_id: str, request: Request) -> JobReportResponse:
        """Get the final report from a completed job."""
        from ..jobs.access import authorize_job_access
        from ..jobs.access import get_job_project_collection

        job = await authorize_job_access(self.job_store, self.db_url, job_id, _job_caller(request), "read")

        report = None
        cards = None
        sources = None
        if job.output:
            try:
                output = json.loads(job.output) if isinstance(job.output, str) else job.output
                report = output.get("report")
                # Gated on the report, not read independently: without one there
                # is no report for these to be the cards OF, and a body saying
                # `has_report: false` while carrying that report's citations
                # describes a state the runner cannot produce — it writes both
                # keys in the same `output` dict or neither.
                cards = report_cards(output.get("cards")) if report else None
                # Gated the same way, for the same reason: they are the sources
                # OF this report, numbered as it cites them.
                sources = report_sources(output.get("sources")) if report else None
            except json.JSONDecodeError, AttributeError:
                pass

        # Only when there is something to file. A poll that finds no report yet
        # is the common case on this route and must not pay for a second read.
        project_collection = await get_job_project_collection(job_id, self.db_url) if report else None

        return JobReportResponse(
            job_id=job_id,
            has_report=bool(report),
            report=report,
            cards=cards,
            sources=sources,
            project_collection=project_collection,
        )

    async def kill_active_jobs(self, request: Request) -> dict:
        """Interrupt every non-terminal job and stop its worker."""
        _require_internal_token(request)
        return await kill_every_active_job(self.job_store, self.db_url)

    async def get_internal_job_outcome(
        self, job_id: str, organization_id: str, request: Request
    ) -> InternalJobOutcomeResponse:
        """The job's status, error, report and run-message content, for one organization."""
        _require_internal_token(request)
        return await internal_job_outcome(self.job_store, self.db_url, job_id, organization_id)

    async def list_research_runs(
        self,
        request: Request,
        project_collection: str | None = None,
        conversation_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> ResearchRunsResponse:
        """List research runs matching the given filters, newest first."""
        caller = _job_caller(request)

        clamped_limit = max(1, min(limit, 200))
        clamped_offset = max(0, offset)

        # Mirrors authorize_job_access: access is only enforced when REQUIRE_AUTH=true.
        visible_to = caller if os.environ.get("REQUIRE_AUTH", "false").lower() == "true" else None

        loop = asyncio.get_running_loop()
        rows, total = await loop.run_in_executor(
            None,
            find_research_runs,
            self.db_url,
            visible_to,
            project_collection,
            conversation_id,
            status,
            clamped_limit,
            clamped_offset,
        )

        jobs = [
            ResearchRunItem(
                job_id=row["job_id"],
                status=row["status"],
                created_at=format_created_at(row["created_at"]),
                conversation_id=row["conversation_id"],
                project_collection=row["project_collection"],
            )
            for row in rows
        ]
        return ResearchRunsResponse(jobs=jobs, total=total)
