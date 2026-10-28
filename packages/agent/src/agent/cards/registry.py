"""Session-scoped registry for the cards a turn produces.

Cards are a first-class agent output, and every path that makes one lands
here: on chat, the answer envelope's ``cards`` field
(``cards/envelope.py``, registered after the answer; Piloti no longer binds
``emit_card``); in deep research, the ``emit_card`` tool; and a system card
(``document_draft``, ``document_grid``) is pushed by the tool that did the
work. The chat entrypoint reads the registry after the turn and attaches the
cards to the response — the same ContextVar pattern the citation registry
uses (:mod:`agent.citations.session`).
"""

from __future__ import annotations

import contextvars
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

logger = logging.getLogger(__name__)


class CardRegistry:
    """Accumulates validated card dicts emitted during a single turn."""

    def __init__(self) -> None:
        self._cards: list[dict[str, Any]] = []
        self._held: dict[str, list[Any]] = {}

    def add(self, card: dict[str, Any]) -> None:
        """Append one validated card dict."""
        self._cards.append(card)

    def __len__(self) -> int:
        """How many cards this turn has emitted so far.

        This is what makes a card addressable from the prose: a tool that
        pushes a card hands the model back ``[[card:N]]`` where N is this
        count after the add, and the frontend resolves N against the same
        ordered array. A count read off ``snapshot()`` would copy the whole
        list to do it.
        """
        return len(self._cards)

    def replace(self, index: int, card: dict[str, Any]) -> None:
        """Swap the card at ``index`` (0-based) for a rewritten copy; its position, and so its marker, stays."""
        self._cards[index] = card

    def snapshot(self) -> list[dict[str, Any]]:
        """Return a shallow copy of the accumulated cards."""
        return list(self._cards)

    def hold(self, kind: str, entry: Any) -> int:
        """Keep ``entry`` for a card the answer decides on; how many of ``kind`` are held now.

        Some system cards can only be built once the answer is final, because
        which entries belong on them depends on what the answer relies on (the
        ``look`` card, ``tools/look/cards.py``). The tool that did the work
        holds its entry here, on the turn's registry, because a ContextVar set
        inside a tool call never reaches the node that finishes the answer.
        """
        held = self._held.setdefault(kind, [])
        held.append(entry)
        return len(held)

    def take_held(self, kind: str) -> list[Any]:
        """The entries held under ``kind``, in the order they were held; the hold is emptied."""
        return self._held.pop(kind, [])

    def clear(self) -> None:
        """Drop all accumulated cards and held entries (call at turn boundaries)."""
        self._cards.clear()
        self._held.clear()


def extend_or_add(
    registry: CardRegistry,
    item: dict[str, Any],
    *,
    owns: Callable[[dict[str, Any]], bool],
    build: Callable[[list[dict[str, Any]]], dict[str, Any]],
    max_items: int,
) -> int | None:
    """Put ``item`` on this turn's card that ``owns`` says is its own, or on a new one; the card's position.

    One card per subject per turn (a document's ``canvas_activity``, its
    ``look``), extended by every further entry, a full card opening the next.
    ``build(items)`` returns the validated card for an item list and raises
    :class:`ValidationError` on bad data, which costs the entry and never the
    card. An extended card is rewritten IN PLACE: position is a card's identity
    (``[[card:N]]``, ``cardKey``), so a card never moves. Returns the card's
    1-based position, or None when the entry did not validate.
    """
    existing = next(
        (
            (index, card)
            for index, card in enumerate(registry.snapshot())
            if owns(card) and len(card.get("items") or []) < max_items
        ),
        None,
    )
    items = [*((existing[1].get("items") or []) if existing else []), item]
    try:
        card = build(items)
    except ValidationError:
        logger.exception("A card entry did not validate (card owner %s)", getattr(owns, "__name__", "?"))
        return None
    if existing is not None:
        registry.replace(existing[0], card)
        return existing[0] + 1
    registry.add(card)
    return len(registry)


_session_card_registry: contextvars.ContextVar[CardRegistry | None] = contextvars.ContextVar(
    "_session_card_registry", default=None
)

_MAX_SESSION_REGISTRIES = 1000
_session_registries: OrderedDict[str, CardRegistry] = OrderedDict()
_session_registries_lock = threading.Lock()


def get_or_create_card_registry(session_id: str | None) -> CardRegistry:
    """Get or create a conversation-scoped ``CardRegistry`` (LRU, max 1000).

    When ``session_id`` is None (CLI / batch with no conversation), a fresh
    isolated registry is returned every call so concurrent anonymous requests
    never share card state. Registries are reused across turns of the same
    conversation, so callers must ``clear()`` at the start of a turn.
    """
    if session_id is None:
        return CardRegistry()
    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            return _session_registries[session_id]
        registry = CardRegistry()
        _session_registries[session_id] = registry
        while len(_session_registries) > _MAX_SESSION_REGISTRIES:
            _session_registries.popitem(last=False)
        return registry


def set_card_registry(registry: CardRegistry | None) -> contextvars.Token:
    """Bind the card registry for the current async context."""
    return _session_card_registry.set(registry)


def reset_card_registry(token: contextvars.Token) -> None:
    """Restore the previously bound card registry."""
    _session_card_registry.reset(token)


def get_card_registry() -> CardRegistry | None:
    """Return the card registry bound to the current async context, if any."""
    return _session_card_registry.get()
