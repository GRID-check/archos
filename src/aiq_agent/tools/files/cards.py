"""The ``file_operation_proposal`` card, and the server proposal behind it.

Pushed by ``propose_file_change`` the way ``remember`` pushes
``memory_proposal``. The model cannot emit this type at all
(``SYSTEM_CARD_TYPES``), so a card that says „diese Datei verschieben" names a
file the turn actually resolved.

## The card points at a server object

Each call first asks the BFF to store the proposal (``client.py``,
``POST /api/internal/proposals``, ADR-0105) and the card carries the id it gets
back as ``proposal_id``. Accepting that card asks the server to apply the
proposal in the DECIDING person's session; the browser no longer executes it.

## One call, one proposal

A stored proposal cannot grow: the internal route has ``create`` and nothing
else, so there is no way to add a second move to the first one. A card that
grew on the client while its server object did not would show four moves and
apply one. Re-creating the proposal on every call would leave every earlier one
behind as a ``proposed`` row nobody can see and anybody with the id could
apply. So a card that carries a ``proposal_id`` is closed, and the next call
opens its own card with its own proposal. „Räum die Einreichunterlagen
zusammen" is then four cards, each its own decision. That is the price; the
fix is to create the proposal once the turn's cards are final, which needs a
hook in the turn's finish (``agents/piloti/conversation_register.py``) that
this module does not own.

## Without the server, the old card, extended as before

When the route is not there (an older BFF, a run with no envelope) the card
goes out without ``proposal_id`` and the browser executes it, exactly as
before the route existed. Those cards still EXTEND: a call whose open card is
for the SAME operation appends to it, up to ``MAX_FILE_OPERATIONS``, because
four cards would ask one question four times and a reader who accepts three
has left the project half-tidied. A different operation opens its own card, and
so does any call after a server-backed card, so the order on screen is the
order of the calls.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import MAX_FILE_OPERATIONS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

from .client import create_proposal

logger = logging.getLogger(__name__)

CARD_TYPE = "file_operation_proposal"


def _open_card(registry: Any, operation: str) -> dict[str, Any] | None:
    """The browser-executed card this turn already opened for ``operation``, if it can take more.

    Only the LAST file-operation card is a candidate: one for another
    operation, or one the server holds, closes the run. ``snapshot()`` is a
    SHALLOW copy, so the dict it hands back is the one the registry will
    deliver, which is what lets this extend a card in place.
    """
    for card in reversed(registry.snapshot()):
        if card.get("type") != CARD_TYPE:
            continue
        if card.get("operation") != operation or card.get("proposal_id"):
            return None
        return card if len(card.get("operations") or []) < MAX_FILE_OPERATIONS else None
    return None


def _validated(card: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build file_operation_proposal card (operation=%s)", card.get("operation"))
        return None


async def propose_file_operation(*, operation: str, title: str, item: dict[str, Any], note: str | None = None) -> bool:
    """Put one proposed operation in front of the reader; ``True`` when a card took it.

    ``False`` means there is no card channel bound (a CLI run, an eval, the job
    worker), and the caller must then tell the model plainly that it could not
    propose anything: a tool that silently swallows the proposal and reports
    success makes the answer claim a change nobody was ever offered. No card
    channel, no server proposal either: a proposal nobody is shown is a row
    nobody decides.
    """
    registry = get_card_registry()
    if registry is None:
        return False
    single = _validated({"type": CARD_TYPE, "title": title, "operation": operation, "operations": [item], "note": note})
    if single is None:
        return False

    proposal_id = await create_proposal(operation, single["operations"], single.get("note"))
    if proposal_id is not None:
        registry.add({**single, "proposal_id": proposal_id})
        logger.info("Proposed %s file operation as proposal %s", operation, proposal_id)
        return True

    # No await from here on: the read-modify-write of an open card must not
    # interleave with a parallel call's.
    existing = _open_card(registry, operation)
    if existing is None:
        registry.add(single)
        logger.info("Proposed %s file operation (browser-executed card)", operation)
        return True
    # The title of a card that has grown is the LAST one written: it was
    # composed knowing how many rows there are.
    grown = _validated({**single, "operations": [*existing["operations"], *single["operations"]]})
    if grown is None:
        return False
    # Position is identity for a card: `cardKey` is `type-index` and the
    # frontend resolves a persisted decision against it, so the grown card
    # replaces the registered dict in place.
    existing.clear()
    existing.update(grown)
    logger.info("Proposed %s file operation (%d on the card)", operation, len(grown["operations"]))
    return True
