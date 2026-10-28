"""The proposal cards, each waiting for the person's yes.

A project-profile patch, a memory and a workspace operation.
"""

from typing import Any
from typing import Literal

from pydantic import Field
from pydantic import field_validator

from aiq_agent.cards.card_model import CardModel

# Canonical project-profile fact keys (mirrors the intake definition in
# apps/workspace/bff/project-profile/intake-definition.ts). Included in the
# emit_card guidance so the model patches known keys with valid values instead
# of inventing near-duplicates ("gebaeudeklasse" vs "building_class").
PROFILE_FACT_VOCABULARY = (
    "main_use: residential|office|lodging|assembly|healthcare|agriculture|manufacturing|storage|other; "
    "building_class: GK1|GK2|GK3|GK4|GK5; "
    "escape_level: <=7m|7-11m|11-22m|>22m; "
    "existing_or_new: existing|new_build|extension_and_conversion; "
    "land_designation: building_land|traffic_area|open_land|core|mixed; "
    "development_pattern: open|semi_detached|closed; "
    "safety_category: low|medium|high; "
    "existing_age: <10|10-30|30-50|>50; "
    "storeys_above_ground / storeys_below_ground / bed_count / unit_count: number; "
    "plot_boundary / building_line / protection_zone / deviating_development_plan: boolean; "
    "high_rise_details: free text"
)


#: A server proposal's id (``POST /api/internal/proposals``, ADR-0105).
PROPOSAL_ID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


#: Fields of a model-composed card that only the server may fill. Stripped from
#: whatever the model writes (``cards/envelope.validate_model_card``) and hidden
#: from the shapes the model is taught (``cards/catalog._shape``): an id the model
#: made up would point a person's Accept at somebody else's proposal.
SERVER_FILLED_CARD_FIELDS = frozenset({"proposal_id"})


class ProjectProfilePatchOperation(CardModel):
    """A JSON Patch operation targeting a project profile section."""

    op: Literal["add", "replace", "remove"]
    path: str = Field(
        description=(
            'For a confirmed hard fact use "/facts/<key>" with op "add" (works for both new and changed '
            'values). For an uncertain inference use "/assumptions/<key>". Known fact keys and values: '
            + PROFILE_FACT_VOCABULARY
        )
    )
    value: Any = Field(
        default=None,
        description=(
            'The PLAIN value only (e.g. "GK4", 3, true) — never wrap it in an object; the app adds '
            "provenance metadata when the user accepts."
        ),
    )

    @field_validator("path")
    @classmethod
    def _validate_path(cls, v: str) -> str:
        allowed_prefixes = ("/facts", "/goals", "/unknowns", "/assumptions")
        if not v.startswith(allowed_prefixes):
            raise ValueError(f"Patch path must start with one of {allowed_prefixes}")
        segments = v.split("/")
        if ".." in segments:
            raise ValueError("Patch path must not contain '..' segments")
        return v


class ProjectProfilePatchPreviewItem(CardModel):
    """A before/after preview for a single patched field."""

    label: str
    before: str
    after: str


class ProjectProfilePatchCard(CardModel):
    """Propose an update to the project brief (hard project facts) — applied only if the user accepts."""

    type: Literal["project_profile_patch"] = "project_profile_patch"
    title: str = Field(description='Short action title, e.g. "Projektkontext aktualisieren: Fluchtniveau"')
    rationale: str = Field(
        description="One or two sentences: what was learned in this conversation and why it changes the brief"
    )
    patch: list[ProjectProfilePatchOperation]
    preview: list[ProjectProfilePatchPreviewItem] = Field(
        default_factory=list,
        description=(
            "Optional and not rendered or recorded. The card builds its before/after rows from the "
            "PATCH and the live profile (`buildPatchPreviewRows`), never from a model-supplied "
            "preview — what the user consents to has to be what is written. Kept as an "
            "optional field rather than removed so an older stored card still validates."
        ),
    )
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals), set where the answer's "
            "cards become final and never by the model. Absent: the browser applies the patch, as before "
            "proposals were server objects"
        ),
    )


class MemoryProposalCard(CardModel):
    """A proposal to save a finding to long-term memory, confirmed by the user.

    System-emitted by the `remember` tool when an org-scoped write needs human
    authorization. With `proposal_id` the note is a stored proposal (kind
    `memory`) the server files in the accepting person's session, org-wide or,
    if they choose, in the project; without one the browser writes it through the
    reader's own session."""

    type: Literal["memory_proposal"]
    title: str = Field(min_length=1, description="Short title for the memory proposal")
    content: str = Field(min_length=1, description="The finding to remember (shown to the user verbatim)")
    kind: Literal["decision", "constraint", "open_question", "derived_fact", "preference"]
    confidence: Literal["low", "medium", "high"] = Field(default="medium")
    supersedes: str | None = Field(
        default=None,
        max_length=500,
        description="The earlier note this one corrects, quoted verbatim; accepting the proposal retires it",
    )
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals). Absent: the browser "
            "writes the note through the reader's own session, as before proposals were server objects"
        ),
    )


class OperationProposalCard(CardModel):
    """A workspace operation the agent PROPOSES through the MCP surface and a person runs.

    System-emitted for a write operation Piloti called on the product's own MCP
    server (ADR-0122): the call changed nothing, it stored an ``operation``
    proposal (ADR-0105) and this card shows it. Accepting runs the operation
    as the ACCEPTING person through the operation's own route, so that route's
    authorization decides; dismissing runs nothing. ``proposal_id`` is
    required: a call that stored no proposal has no card, and says so in its
    own result text.
    """

    type: Literal["operation_proposal"] = "operation_proposal"
    title: str = Field(min_length=1, description="The one-line English description of what accepting would do")
    operation: str = Field(min_length=1, description="The catalog operation's name, e.g. 'folder-rename'")
    input: dict[str, Any] = Field(
        default_factory=dict,
        description="What the operation is called with: params, query and body, shown to the person",
    )
    proposal_id: str = Field(
        pattern=PROPOSAL_ID_PATTERN,
        description="The server proposal this card shows (kind 'operation'); the person accepts or dismisses it there",
    )
