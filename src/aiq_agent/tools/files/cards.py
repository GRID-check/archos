"""The ``file_operation_proposal`` card, and the server proposal behind it.

Pushed by ``propose_file_change`` the way ``remember`` pushes
``memory_proposal``. The model cannot emit this type at all
(``SYSTEM_CARD_TYPES``), so a card that says „diese Datei verschieben" names a
file the turn actually resolved.

## The card points at a server object

Each call puts its card in the registry and asks the BFF to store the proposal
(``tools/proposals_client.py``, ``POST /api/internal/proposals``, ADR-0105); the
card then carries the id it gets back as ``proposal_id``. Accepting that card
asks the server to apply the proposal in the DECIDING person's session; the
browser executes nothing. The card goes in first so that the index the request
names (``originCardIndex``, the idempotency key) is the position the card
really has, and calls of this tool run one at a time per turn, so the cards
come out in the order of the calls.

## One call, one proposal

A stored proposal cannot grow: the internal route has ``create`` and nothing
else, so there is no way to add a second move to the first one. A card that
grew on the client while its server object did not would show four moves and
apply one. Re-creating the proposal on every call would leave every earlier one
behind as a ``proposed`` row nobody can see and anybody with the id could
apply. So every call opens its own card with its own proposal. „Räum die
Einreichunterlagen zusammen" is then four cards, each its own decision. That is
the price; the fix is to create the proposal once the turn's cards are final,
which is where the model's own ``project_profile_patch`` card gets its proposal
(``cards/envelope.py``, ``register_envelope_card``); this tool's cards are not
the model's, so they do not pass through it.

## Without the server, a notice and a failure

The browser executes no file operation any more. When the server does not take
the proposal (an older BFF, a run with no envelope, a refusal, an unreachable
route) the card stays in the registry WITHOUT a ``proposal_id`` and the UI
draws it read-only, saying it could not be created as a proposal. The tool
reports ``False``, so the model is told the same thing and does not announce a
proposal the reader cannot accept. The card is not taken back out: its position
is its identity (``cardKey`` is ``type-index``, and ``originCardIndex`` is the
idempotency key of every proposal after it), so removing it would shift its
siblings.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import get_card_registry
from aiq_agent.tools.proposals_client import add_card

logger = logging.getLogger(__name__)

CARD_TYPE = "file_operation_proposal"

#: One lock per turn's registry: a call's card, its index and the request that
#: names it are one step, so no sibling call of this tool is between them.
_registry_locks: weakref.WeakKeyDictionary[CardRegistry, asyncio.Lock] = weakref.WeakKeyDictionary()


def _lock_for(registry: CardRegistry) -> asyncio.Lock:
    lock = _registry_locks.get(registry)
    if lock is None:
        lock = _registry_locks[registry] = asyncio.Lock()
    return lock


def _validated(card: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build file_operation_proposal card (operation=%s)", card.get("operation"))
        return None


async def propose_file_operation(*, operation: str, title: str, item: dict[str, Any], note: str | None = None) -> bool:
    """Put one proposed operation in front of the reader; ``True`` when the server stored it.

    ``False`` means nothing was proposed, and the caller must then tell the
    model plainly that it could not propose anything: a tool that silently
    swallows the proposal and reports success makes the answer claim a change
    nobody was ever offered. Two cases end here. There is no card channel bound
    (a CLI run, an eval, the job worker), so no card and no server proposal
    either: a proposal nobody is shown is a row nobody decides. Or the card went
    out and the server did not take its proposal; the card then stays, without
    ``proposal_id``, as the read-only notice the UI draws, because taking it back
    out of the registry would shift the position of every card after it.
    """
    registry = get_card_registry()
    if registry is None:
        return False
    single = _validated({"type": CARD_TYPE, "title": title, "operation": operation, "operations": [item], "note": note})
    if single is None:
        return False

    payload: dict[str, Any] = {"operation": operation, "operations": single["operations"]}
    if single.get("note"):
        payload["note"] = single["note"]
    async with _lock_for(registry):
        proposal_id = await add_card(registry, single, kind="file_operation", payload=payload)
    if proposal_id is None:
        logger.warning("Could not store the %s file operation as a proposal; its card stays read-only", operation)
        return False
    logger.info("Proposed %s file operation as proposal %s", operation, proposal_id)
    return True
