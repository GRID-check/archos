"""The ``operation_proposal`` card, for a write the server turned into a proposal (ADR-0122, ADR-0105).

When ``workspace__call`` runs a WRITE operation, the server (``lib/agent-api/discovery.ts``)
changes nothing: it stores an ``operation`` proposal in the turn's conversation and answers with
``structuredContent`` ``{ decision: 'propose', proposalId, summary, operation }``. That is the
contract this module reads, and nothing else of the result. The proposal already exists, so unlike
``propose_file_change`` (``tools/files/cards.py``) this tier asks the BFF for nothing: it puts the
card in front of the reader, carrying the server's ``proposal_id``, and the card shows and decides
that object.

The card is added to the turn's registry and never replaced, so its position (``cardKey`` is
``type-index``) stays stable. A model that repeats a call gets the SAME ``proposal_id`` back (the
server files one open proposal per call), and a second card for it would be a second control for one
decision, so a proposal that already has a card in the registry gets none.

No card channel (a CLI run, an eval, the job worker) means no card: the proposal still waits in the
person's inbox, and the caller says so in the result text.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)

CARD_TYPE = "operation_proposal"

#: ``structuredContent.decision`` of a write the server proposed instead of running.
PROPOSE_DECISION = "propose"


@dataclass(frozen=True)
class OperationProposal:
    """The proposal a write came back as: what the card shows and which server object it decides."""

    proposal_id: str
    operation: str
    summary: str


def proposal_from(structured: object) -> OperationProposal | None:
    """The proposal in a ``call-operation`` result's ``structuredContent``, or ``None`` when it is not one.

    A read, a refusal and any other answer carry no ``decision: 'propose'`` and come back ``None``.
    A proposal whose id is not a UUID is not trusted either: an id on a card is always one the BFF
    returned, and the card schema refuses anything else.
    """
    if not isinstance(structured, dict) or structured.get("decision") != PROPOSE_DECISION:
        return None
    proposal_id, operation, summary = (structured.get(key) for key in ("proposalId", "operation", "summary"))
    if not (isinstance(proposal_id, str) and isinstance(operation, str) and isinstance(summary, str)):
        return None
    try:
        proposal_id = str(uuid.UUID(proposal_id))
    except ValueError:
        return None
    if not operation.strip() or not summary.strip():
        return None
    return OperationProposal(proposal_id=proposal_id, operation=operation, summary=summary)


def emit_operation_proposal_card(proposal: OperationProposal, call_input: dict[str, Any] | None) -> bool:
    """Show ``proposal`` as a card; ``True`` when the reader has one for it (new, or already there).

    ``call_input`` is what the model called the operation with, ``{params, query, body}``, shown to
    the person beside the summary. ``False`` means there is no card channel bound or the card does
    not validate, and the proposal then waits in the inbox only.
    """
    registry = get_card_registry()
    if registry is None:
        return False
    if any(card.get("proposal_id") == proposal.proposal_id for card in registry.snapshot()):
        return True
    try:
        card = grid_card_adapter.validate_python(
            {
                "type": CARD_TYPE,
                "title": proposal.summary,
                "operation": proposal.operation,
                "input": call_input or {},
                "proposal_id": proposal.proposal_id,
            }
        ).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build operation_proposal card (operation=%s)", proposal.operation)
        return False
    registry.add(card)
    logger.info("Showed operation %s as proposal %s", proposal.operation, proposal.proposal_id)
    return True
