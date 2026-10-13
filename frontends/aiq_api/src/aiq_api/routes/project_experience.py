"""The project-experience route (`POST /v1/internal/project-experience`).

Called by the BFF's close dialog and by the archive import, once per project. The reading is
`aiq_agent.knowledge.project_experience`; this route only supplies the retriever's summary model
and its chunks, read from the project's collection. It fails open like `note_embeddings`: any
fault is answered as `error` with empty lists, never as a non-200. A bad request body is FastAPI's
422, as everywhere else.
"""

import asyncio
import logging

from fastapi import APIRouter
from fastapi import Request

from aiq_agent.knowledge.project_experience import ProjectExperienceRequest
from aiq_agent.knowledge.project_experience import ProjectExperienceResponse
from aiq_agent.knowledge.project_experience import read_project_experience

from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)


def _read_project(request: ProjectExperienceRequest) -> ProjectExperienceResponse:
    """The blocking half: the retriever's summary model and chunks. Runs on a worker thread and never raises."""
    try:
        from aiq_agent.knowledge.collection_pages import read_pages
        from aiq_agent.knowledge.factory import get_active_retriever
        from aiq_agent.knowledge.factory import get_available_documents

        retriever = get_active_retriever()
        return read_project_experience(
            request,
            llm=getattr(retriever, "summary_llm", None),
            list_documents=get_available_documents,
            fetch_pages=read_pages,
        )
    except Exception:  # noqa: BLE001 - the contract answers 200 with error=extraction_failed
        logger.exception("Project experience: no retriever to read the project with")
        return ProjectExperienceResponse(error="extraction_failed")


def add_project_experience_routes(router: APIRouter) -> None:
    """Register the project-experience endpoint."""

    @router.post(
        "/v1/internal/project-experience",
        response_model=ProjectExperienceResponse,
        tags=["platform"],
        summary="Read a closed project's documents for its fingerprint and decisions",
        description=(
            "Chooses the project's documents from its inventory, then reads them once for the values the "
            "vocabulary asks (each with a verbatim quote) and for the decisions and constraints they state. "
            "Every value is a suggestion the caller shows a person to confirm."
        ),
    )
    async def project_experience(request: ProjectExperienceRequest, http_request: Request) -> ProjectExperienceResponse:
        """Read the project's documents, or say why it could not be done."""
        _require_internal_token(http_request)
        return await asyncio.to_thread(_read_project, request)
