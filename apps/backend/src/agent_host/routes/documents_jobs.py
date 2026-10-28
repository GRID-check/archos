"""The ingestion job routes: one job's status, a batch of them, and cancel.

Split from ``documents.py``, which registers these through ``_add_document_job_routes``
at the end of its own routes, the position they always had.
"""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from pydantic import BaseModel
from pydantic import Field

from agent.knowledge.base import BaseIngestor
from agent.knowledge.schema import IngestionJobStatus

from ..jobs import ingest_dispatch
from .collections import _require_ingestor

# The name these routes logged under before the split, so log filters keep matching.
logger = logging.getLogger("agent_host.routes.documents")

# Upper bound on job ids per batch-status request (request validation).
BATCH_STATUS_MAX_IDS = 200


def _job_statuses(ingestor: BaseIngestor, job_ids: list[str]) -> dict[str, Any]:
    """Each job's status, or None when unknown or failing. One thread hop for the batch, not one per id."""
    statuses: dict[str, Any] = {}
    for job_id in job_ids:
        try:
            status = ingestor.get_job_status(job_id)
            statuses[job_id] = status.model_dump(mode="json") if status is not None else None
        except Exception:
            statuses[job_id] = None
    ingest_dispatch.stamp_queue_ahead(statuses)
    return statuses


async def get_job_status(
    job_id: str,
    ingestor: BaseIngestor = Depends(_require_ingestor),
) -> IngestionJobStatus:
    """Get the status of an ingestion job."""
    try:
        status = await asyncio.to_thread(ingestor.get_job_status, job_id)
        if status is None:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

        return status
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get job status: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to get job status")


class BatchStatusRequest(BaseModel):
    job_ids: list[str] = Field(default_factory=list, max_length=BATCH_STATUS_MAX_IDS)


async def get_job_statuses_batch(
    request: BatchStatusRequest,
    ingestor: BaseIngestor = Depends(_require_ingestor),
) -> dict[str, Any]:
    """Batch variant of the per-job status endpoint.

    The BFF reconciles every in-flight document row on document-list
    reads; per-job round-trips made that read O(n) HTTP calls. Unknown
    or failing job ids map to null (the caller falls back to the
    collection file list), mirroring the single endpoint's 404.
    """
    return {"statuses": await asyncio.to_thread(_job_statuses, ingestor, request.job_ids)}


async def cancel_job(job_id: str) -> dict[str, Any]:
    """Stop a queued or running ingestion job.

    The BFF has already decided the caller may act on the document this job
    belongs to; this tier only stops the job. ``result`` is one of the
    cancel outcomes (``ingest_dispatch.cancel``): ``cancelled`` when a live
    job was stopped, ``finished`` when the queue holds no live row for it,
    and ``unavailable`` when the queue is off or has no database (an
    in-memory job runs in a process this one cannot reach).
    """
    try:
        return {"result": await asyncio.to_thread(ingest_dispatch.cancel, job_id)}
    except Exception as e:
        logger.error("Failed to cancel ingestion job %s: %s", job_id, type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to cancel ingestion job")


def _add_document_job_routes(router: APIRouter) -> None:
    """Register the ingestion job routes on the document router."""
    router.get(
        "/v1/documents/{job_id}/status",
        response_model=IngestionJobStatus,
        tags=["documents"],
        summary="Get ingestion job status",
    )(get_job_status)
    router.post(
        "/v1/documents/status/batch",
        tags=["documents"],
        summary="Get ingestion job statuses in batch",
    )(get_job_statuses_batch)
    router.post(
        "/v1/documents/{job_id}/cancel",
        tags=["documents"],
        summary="Cancel an ingestion job",
    )(cancel_job)
