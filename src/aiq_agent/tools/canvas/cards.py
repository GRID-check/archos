"""The ``canvas_activity`` card: one per document per turn, extended by every write.

Pushed by ``mark`` and ``reply`` after the BFF confirmed the write, from what it
returned (the mark's id and number), so the card can never name a mark that
does not exist; the model cannot emit this type at all (``SYSTEM_CARD_TYPES``).
A second write on the same document extends the card instead of adding one,
because „markier die drei Mängel und antworte Anna“ is one piece of work on
one document; a full card (``MAX_CANVAS_ACTIVITY_ITEMS``) or another document
opens a new one. The extension is written back in place, validated, keeping the
card's position in the array (``cards/registry.extend_or_add``): position is a
card's identity (``cardKey``), as ``tools/files/cards.py`` explains.
"""

from __future__ import annotations

from typing import Any

from aiq_agent.cards.canvas_activity_card import MAX_CANVAS_ACTIVITY_ITEMS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import extend_or_add
from aiq_agent.cards.registry import get_card_registry

CARD_TYPE = "canvas_activity"

#: How much of a reply the card quotes.
EXCERPT_CHARS = 300


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
    def owns(card: dict[str, Any]) -> bool:
        return card.get("type") == CARD_TYPE and (card.get("document") or {}).get("id") == document.get("id", "")

    def build(items: list[dict[str, Any]]) -> dict[str, Any]:
        card = {"type": CARD_TYPE, "document": document, "items": items}
        return grid_card_adapter.validate_python(card).model_dump(exclude_none=True)

    position = extend_or_add(registry, item, owns=owns, build=build, max_items=MAX_CANVAS_ACTIVITY_ITEMS)
    return 0 if position is None else 1
