"""The ``canvas_activity`` card: one per document per turn, extended by every write.

Pushed by ``mark`` and ``reply`` after the BFF confirmed the write, from what it
returned (the mark's id and number), so the card can never name a mark that
does not exist; the model cannot emit this type at all (``SYSTEM_CARD_TYPES``).
A second write on the same document extends the card instead of adding one,
because „markier die drei Mängel und antworte Anna“ is one piece of work on
one document; a full card (``MAX_CANVAS_ACTIVITY_ITEMS``) or another document
opens a new one. The extension is written back in place, validated, keeping the
card's position in the array: position is a card's identity (``cardKey``), as
``tools/files/cards.py`` explains.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import MAX_CANVAS_ACTIVITY_ITEMS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)

CARD_TYPE = "canvas_activity"

#: How much of a reply the card quotes.
EXCERPT_CHARS = 300


def _open_card(registry: Any, document_id: str) -> dict[str, Any] | None:
    """This turn's card for ``document_id``, when it can take another entry."""
    for card in registry.snapshot():
        if card.get("type") != CARD_TYPE or (card.get("document") or {}).get("id") != document_id:
            continue
        if len(card.get("items") or []) < MAX_CANVAS_ACTIVITY_ITEMS:
            return card
    return None


def excerpt(text: str) -> str:
    """The start of a reply, on one line, at most :data:`EXCERPT_CHARS` long."""
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= EXCERPT_CHARS else flat[: EXCERPT_CHARS - 1].rstrip() + "…"


def record_canvas_activity(document: dict[str, str], items: list[dict[str, Any]]) -> int:
    """Put ``items`` on the document's card; how many entries landed (0 with no card channel or bad data).

    ``document`` is ``{"id", "name"}`` as the BFF returned them. Items beyond a
    full card open the next one, so nothing the BFF confirmed is dropped.
    """
    registry = get_card_registry()
    if registry is None or not items:
        return 0
    landed = 0
    for item in items:
        landed += _add(registry, document, item)
    return landed


def _add(registry: Any, document: dict[str, str], item: dict[str, Any]) -> int:
    existing = _open_card(registry, document.get("id", ""))
    card = {
        "type": CARD_TYPE,
        "document": document,
        "items": [*((existing or {}).get("items") or []), item],
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("A canvas_activity entry did not validate (action=%s)", item.get("action"))
        return 0
    if existing is not None:
        existing.clear()
        existing.update(validated)
    else:
        registry.add(validated)
    return 1
