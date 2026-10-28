"""The state the research worker hands the Erfassungs-Agent (ADR-0111).

The runner builds it from the job (``backend.jobs.runner._run_agent``): the
messages, and each of its optional fields this model declares. The intake reads
only the organization (for the decision model's tenant) and the BFF's
instruction text; everything it needs about the project it asks the intake API
for (``op: 'needs'``). ``extra="ignore"``, because the runner hands over
``available_documents`` to any state that will take it, and this one has no use
for a prompt inventory: ``list_files`` and ``needs.unreadFiles`` are uncapped
where an inventory is not.
"""

from __future__ import annotations

from typing import Annotated
from typing import Any

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field


class IntakeAgentState(BaseModel):
    """One reading of a project's documents."""

    model_config = ConfigDict(extra="ignore", arbitrary_types_allowed=True)

    messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)
    #: The tenant, captured at submit (a worker has no request of its own to read it from).
    organization_id: str | None = None
    #: The project's profile as the prompt view renders it. Carried because the
    #: runner fills it for any state that declares it; the agent does not put it
    #: in its prompt, since ``intake_needs`` answers from the same profile, live.
    project_context: str | None = None
    #: What the run did, for the job's output and the trace: filled at the end.
    outcome: dict[str, Any] = Field(default_factory=dict)
