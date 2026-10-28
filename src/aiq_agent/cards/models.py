"""Pydantic models for Grid response cards: the discriminated union of every card type, and its validator.

Each card's model lives in a module named after it (``card_model`` holds the
base and the plain-text rule every text field follows)."""

from typing import Annotated

from pydantic import Field
from pydantic import TypeAdapter

from aiq_agent.cards.calculation_card import CalculationCard
from aiq_agent.cards.canvas_activity_card import CanvasActivityCard

# The catalog imports this module only inside functions, so this is no cycle.
from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.file_operation_card import FileOperationProposalCard
from aiq_agent.cards.formula_card import FormulaCard
from aiq_agent.cards.ifc_cards import IfcComplianceCard
from aiq_agent.cards.ifc_cards import IfcDiffCard
from aiq_agent.cards.ifc_cards import IfcElementCard
from aiq_agent.cards.ifc_cards import IfcModelPickerCard
from aiq_agent.cards.ifc_cards import IfcScheduleCard
from aiq_agent.cards.ifc_cards import IfcViewerCard
from aiq_agent.cards.look_card import LookCard
from aiq_agent.cards.proposal_cards import MemoryProposalCard
from aiq_agent.cards.proposal_cards import OperationProposalCard
from aiq_agent.cards.proposal_cards import ProjectProfilePatchCard
from aiq_agent.cards.revision_compare_card import RevisionCompareCard
from aiq_agent.cards.schematic_cards import BuildingSectionCard
from aiq_agent.cards.schematic_cards import DaylightIncidenceCard
from aiq_agent.cards.schematic_cards import DimensionDiagramCard
from aiq_agent.cards.schematic_cards import EgressDiagramCard
from aiq_agent.cards.schematic_cards import FireAccessPlanCard
from aiq_agent.cards.schematic_cards import GuardrailCheckCard
from aiq_agent.cards.schematic_cards import SetbackPlanCard
from aiq_agent.cards.schematic_cards import StairDiagramCard
from aiq_agent.cards.surface_card import SurfaceCard
from aiq_agent.cards.workspace_cards import DocumentDraftCard
from aiq_agent.cards.workspace_cards import DocumentGridCard
from aiq_agent.cards.workspace_cards import TaskCreatedCard

GridCard = (
    ProjectProfilePatchCard
    | CalculationCard
    | FormulaCard
    | BuildingSectionCard
    | StairDiagramCard
    | DimensionDiagramCard
    | SetbackPlanCard
    | EgressDiagramCard
    | DaylightIncidenceCard
    | GuardrailCheckCard
    | FireAccessPlanCard
    | MemoryProposalCard
    | OperationProposalCard
    | DocumentGridCard
    | DocumentDraftCard
    | TaskCreatedCard
    | FileOperationProposalCard
    | CanvasActivityCard
    | LookCard
    | RevisionCompareCard
    | IfcViewerCard
    | IfcComplianceCard
    | IfcScheduleCard
    | IfcElementCard
    | IfcDiffCard
    | IfcModelPickerCard
    | SurfaceCard
)


# Discriminated-union adapter — the canonical validator for a raw card dict.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])


__all__ = [
    "GridCard",
    "grid_card_adapter",
    "validate_cards",
]


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of model-produced card dicts and return the validated dicts.

    Per-card: one malformed card is logged and skipped instead of discarding
    the whole batch (LLM output regularly contains one bad item among good
    ones, and cards are a progressive enhancement — never fail the answer).

    System cards (``SYSTEM_CARD_TYPES``) are dropped here too: this is the
    post-hoc / batch generation path fed by *model* output, and a system card
    must only ever come from its owning tool on a sanctioned path (e.g.
    ``document_grid`` from ``surface_documents``, ``memory_proposal`` from
    ``remember``). The model is never told these types exist, so any occurrence
    here is a fabrication — enforce the same invariant ``emit_card`` and the
    DSML salvage already enforce, closing the last emission path.

    A retired type (``RETIRED_CARD_TYPES``) is no union member at all and
    fails validation like any unknown name: the report's own Markdown carries
    its content. Chat-only types (``CHAT_ONLY_CARD_TYPES``) likewise: a surface's
    ``Text`` ``[N]`` are recited on the chat pipeline only.
    """
    import logging

    logger = logging.getLogger(__name__)
    validated: list[dict] = []
    withheld = SYSTEM_CARD_TYPES | CHAT_ONLY_CARD_TYPES
    for item in raw:
        if isinstance(item, dict) and item.get("type") in withheld:
            logger.warning("Dropping model-fabricated system/chat-only card (type=%s)", item.get("type"))
            continue
        try:
            validated.append(grid_card_adapter.validate_python(item).model_dump(exclude_none=True))
        except Exception as exc:
            logger.warning(
                "Dropping invalid card (type=%s): %s",
                item.get("type") if isinstance(item, dict) else type(item).__name__,
                exc,
            )
    return validated
