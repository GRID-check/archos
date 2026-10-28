"""The request and response models of the async job API."""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

logger = logging.getLogger(__name__)


class JobDocumentRequest(BaseModel):
    """One document the reader adds to a running job's Grundlage (``plan_documents`` row)."""

    name: str = Field(..., min_length=1, max_length=256, description="The file name, as the inventory lists it")
    title: str | None = Field(None, max_length=256, description="The document's display title")
    shelf: str | None = Field(None, max_length=64, description="Where it sits: office_shelf / project / session / base")


class JobSubmitRequest(BaseModel):
    """Request to submit an async job."""

    agent_type: str = Field(..., description="Agent type (e.g., 'deep_researcher')")
    input: str = Field(..., min_length=1, max_length=32000, description="Input query for the agent")
    job_id: str | None = Field(
        None,
        pattern=r"^[a-zA-Z0-9_-]+$",
        max_length=64,
        description="Optional custom job ID (auto-generated if omitted)",
    )
    expiry_seconds: int | None = Field(
        None,
        ge=600,
        le=604800,
        description="Job expiry in seconds (default from config, max 7 days)",
    )
    data_sources: list[str] | None = Field(
        None,
        description=(
            "Optional data source IDs to target. Omit or set null to use all data-source tools "
            "available to the chosen agent. When specific IDs are passed, unmapped utility tools "
            "(e.g., 'think') remain available. Pass an empty list to run the agent with no "
            "data-source tools; unmapped utility tools remain available."
        ),
    )


JOB_SUBMIT_EXAMPLES: dict[str, dict] = {
    "default": {
        "summary": "Default (all data sources)",
        "value": {
            "agent_type": "deep_researcher",
            "input": "What are the latest advances in quantum computing?",
            "expiry_seconds": 86400,
        },
    },
    "scoped": {
        "summary": "Scoped to specific data sources",
        "value": {
            "agent_type": "deep_researcher",
            "input": "What are the latest advances in quantum computing?",
            "data_sources": ["web_search"],
        },
    },
}


class JobStatusResponse(BaseModel):
    """Job status response."""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "job_id": "abc123",
                    "status": "submitted",
                    "agent_type": "deep_researcher",
                    "error": None,
                    "created_at": "2026-02-12T10:30:00Z",
                }
            ]
        }
    )

    job_id: str = Field(..., description="Unique job identifier")
    status: str = Field(
        ...,
        description="Current status: submitted, running, success, failure, interrupted, not_found",
    )
    agent_type: str | None = Field(None, description="Agent type used for this job")
    error: str | None = Field(None, description="Error message if job failed")
    created_at: str | None = Field(None, description="Creation timestamp (ISO format)")


class JobStateResponse(BaseModel):
    """Job state response with artifacts."""

    job_id: str = Field(..., description="Unique job identifier")
    has_state: bool = Field(..., description="Whether state/artifacts are available")
    state: dict | None = Field(None, description="Internal job state")
    artifacts: dict | None = Field(None, description="Tool calls, outputs, and sources collected during execution")


def report_cards(raw: Any) -> list[dict] | None:
    """Narrow a persisted ``output["cards"]`` value to cards, or to nothing.

    Defensive for the same reason the caller wraps the parse in a ``try``: this
    is a READ of a column an older build of the worker wrote, and the route's
    contract is that it delivers the REPORT. Anything that is not a list of
    objects is not cards, so it yields ``None`` instead of reaching the response
    model, where a stray string in the list would turn a finished run into a
    validation error and a non-iterable would raise out of the comprehension.
    Per-item rather than all-or-nothing, matching ``validate_cards``: one
    unusable entry costs its own card, never the batch — and a list that empties
    out that way is reported as no cards, because the consumer's "no section at
    all" state is reached from an absent value, not an empty one.
    """
    if not isinstance(raw, list):
        return None
    cards = [card for card in raw if isinstance(card, dict)]
    return cards or None


class JobReportResponse(BaseModel):
    """The finished report, and the Grid cards the same run produced from it.

    ## Why ``cards`` rides on the report response

    The filed report PDF (``frontends/ui/src/lib/pdf/report-document.ts``) is
    built from the report and the run's cards, and
    ``fileResearchReport`` (``frontends/ui/src/lib/documents/research-report.ts``)
    takes them as an optional argument its only caller could not fill: the BFF
    files the report at the moment it reads it off THIS route, and this route
    returned the report and nothing else. The runner has persisted
    ``output["cards"]`` beside ``output["report"]`` since card generation
    shipped (``aiq_api.jobs.runner``), so the data sat one key away from the one
    consumer that wanted it, and the section stayed dormant — no heading, no
    citations — for want of a field.

    ## Why ``list[dict]`` and not the ``GridCard`` union

    These dicts were validated on the way IN. ``aiq_agent.cards.validate_cards``
    put every one of them through ``grid_card_adapter`` and dumped the model
    back out before the runner wrote them, dropping malformed ones card by card
    and system-card fabrications outright. Typing this field as the union would
    re-run that validation on the way OUT, which adds no guarantee that was not
    already made and costs two real things: the OpenAPI schema of a route whose
    job is delivering a report would grow the entire card union — 72 model
    definitions, ~106 KB of JSON Schema, measured — and a card that
    validated under the schema of the day it was generated but no longer
    validates under today's would turn a completed report into a 500. The report
    is what the user waited minutes for; a display enhancement must not be able
    to take it down. Validation on this path belongs where it already is — at
    generation, and again at render (the BFF's Zod ``validateGridCards``, then
    ``legalBasisSection``'s own narrowing) — not a third time in between, where
    the only new behaviour available to it is failure.

    ## Why every card type

    The „Rechtsgrundlagen" section now reads the report's own quote lines
    (``frontends/ui/src/lib/answer-export/excerpts.ts``), not a card; the
    retired ``legal_basis`` card no longer exists. The run's cards already reach
    the client whole by two other paths — over the socket as the answer streams,
    and on the conversation message row ``write_job_turn`` writes
    (``metadata["cards"]``). A report response carrying a filtered subset would
    be a THIRD and narrower answer to "what cards did this run produce", so the
    filed PDF and the chat thread could disagree about one run. It would also
    put a PDF renderer's present appetite inside the API: the next section the
    export grows would need a backend change and a deploy before the frontend
    could read it. The consumer decides what to render; this route reports what
    the run produced.

    ## Why nothing is truncated here

    The only ceiling on card volume is a prompt one — "Two content cards is a
    turn's ceiling", ``_CARD_RESTRAINT`` in ``aiq_agent.cards.catalog`` — and it
    is advice to a model, not an invariant; no write path enforces a count. So a
    runaway generation is ALREADY persisted in the job output, already on the
    message row, and was already streamed to the browser, and a cap applied only
    here would prevent none of that. What it would do is make the filed PDF
    silently omit a Rechtsgrundlage the chat thread still shows — a citation
    missing from the document that goes to the Behörde is a worse failure than a
    large JSON body. A bound worth having belongs at generation, where it would
    hold for all three readers at once.
    """

    job_id: str = Field(..., description="Unique job identifier")
    project_collection: str | None = Field(
        None,
        description=(
            "Collection of the project this run was commissioned in, recorded at "
            "submit time. The report is filed into THIS project or into none — "
            "never into one the report request names, which is a property of the "
            "reader rather than of the run."
        ),
    )
    has_report: bool = Field(..., description="Whether the final report is available")
    report: str | None = Field(None, description="Final research report from the agent")
    cards: list[dict] | None = Field(
        None,
        description=(
            "Grid response cards generated from this report, as the runner persisted them "
            "(already validated at write time). Null when the run produced none."
        ),
    )
    sources: list[dict] | None = Field(
        None,
        description=(
            "The report's verified sources, each carrying the [N] the report cites it by, "
            "as the runner persisted them. The live event stream discovers sources before "
            "verification numbers them, so this is the only place a reader of the finished "
            "report can learn which row [3] is. Null when the run recorded none."
        ),
    )


def report_sources(raw: Any) -> list[dict] | None:
    """The persisted source list, or ``None`` for anything that is not one.

    Same posture as :func:`report_cards`: written by the runner from
    ``source_entry_to_wire``, so a well-formed value is passed through whole, and
    a malformed one (an older worker, a corrupted blob) degrades to "no sources"
    rather than costing the report.
    """
    if not isinstance(raw, list):
        return None
    sources = [entry for entry in raw if isinstance(entry, dict)]
    return sources or None


class InternalJobOutcomeResponse(BaseModel):
    """A job's verdict as the BFF's run reconciler reads it (internal only).

    Everything the run's own terminal writes would have carried, rebuilt from
    the job store: the status and error for ``/api/internal/jobs/{id}/outcome``,
    the report and cards for filing, and the run message's content and metadata
    for ``/api/internal/runs/by-job/{id}/report``.
    """

    job_id: str
    status: str = Field(..., description="submitted, running, success, failure or interrupted")
    error: str | None = None
    report: str | None = None
    cards: list[dict] | None = None
    message: dict[str, Any] | None = Field(
        None, description="What the run message should hold: {content, metadata}; null while the job runs"
    )


class ResearchRunItem(BaseModel):
    """A single research run (async job) summary."""

    job_id: str = Field(..., description="Unique job identifier")
    status: str = Field(..., description="Current job status")
    created_at: str | None = Field(None, description="Creation timestamp (ISO format)")
    conversation_id: str | None = Field(None, description="Conversation the job was submitted from, if any")
    project_collection: str | None = Field(None, description="Project collection the job was scoped to, if any")


class ResearchRunsResponse(BaseModel):
    """List of research runs matching the requested filters."""

    jobs: list[ResearchRunItem] = Field(..., description="Matching research runs, newest first")
    total: int = Field(..., description="Total number of matching runs (before limit/offset)")


class AgentInfo(BaseModel):
    """Information about a registered agent."""

    agent_type: str = Field(..., description="Agent identifier used in submit requests")
    description: str = Field(..., description="Human-readable description of the agent")


class AgentListResponse(BaseModel):
    """List of available agents."""

    agents: list[AgentInfo] = Field(..., description="Registered agent types")


class DataSource(BaseModel):
    """Information about an available data source."""

    id: str = Field(..., description="Unique identifier for the data source")
    name: str = Field(..., description="Display name")
    description: str | None = Field(default=None, description="Human-readable description")
    requires_auth: bool = Field(default=False, description="Whether user authentication is required")


class DataSourcesResponse(BaseModel):
    """Data sources listing plus derived deployment capabilities.

    ``data_sources`` is the registry listing (unchanged). ``vlm_available`` is a
    DERIVED capability, not a flag: it reflects whether a vision model API key
    resolves on this deployment, so the frontend can offer image upload only
    when ingestion would actually succeed (availability = ``image-upload`` flag
    AND this capability). See ``resolve_vlm_api_key`` for the resolution chain.
    """

    data_sources: list[DataSource] = Field(..., description="Registered data sources")
    vlm_available: bool = Field(
        default=False,
        description="Whether a vision model (VLM) is configured (derived from VLM API key presence)",
    )
