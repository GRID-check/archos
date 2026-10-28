"""Whether an organization has written folder cards: the ``folder-cards`` WorkOS flag (ADR-0127).

An office capability's on/off switch is a WorkOS flag, decided per organization
by the BFF (``GET /api/internal/stages``, ``features.folderCards``). This tier has
no WorkOS client; it asks the BFF the way the per-turn stage read does
(``agent.stages.flags.fetch_turn_flags``) and keeps the answer for
:data:`TTL_SECONDS`, because a mark happens once per changed document and a
bulk import changes hundreds.

Two ways to ask, for two kinds of caller:

* :func:`enabled_for` never raises and answers ``False`` for anything short of a
  yes (no organization, no token, a BFF that is down). The hooks and the listing
  use it: a lost mark is found by the nightly reconcile once the flag answers.
* :func:`check` raises when the BFF cannot be asked. The builder uses it, so a
  claimed folder is retried through the queue instead of being dropped on a blip.
"""

from __future__ import annotations

import threading
import time

from agent.stages.flags import fetch_turn_flags

#: How long one organization's answer is reused. The BFF keeps its own 30 s cache underneath.
TTL_SECONDS = 60
_MAX_ORGANIZATIONS = 1000

_lock = threading.Lock()
_answers: dict[str, tuple[bool, float]] = {}


def _fetch(organization_id: str) -> bool:
    return fetch_turn_flags(organization_id=organization_id).folder_cards_allowed


def check(organization_id: str | None) -> bool:
    """Whether ``organization_id`` has the flag; ``False`` without one. Raises when the BFF cannot be asked."""
    if not organization_id:
        return False
    now = time.monotonic()
    with _lock:
        held = _answers.get(organization_id)
    if held is not None and now - held[1] < TTL_SECONDS:
        return held[0]
    answer = _fetch(organization_id)
    with _lock:
        _answers.pop(organization_id, None)
        _answers[organization_id] = (answer, now)
        if len(_answers) > _MAX_ORGANIZATIONS:
            del _answers[next(iter(_answers))]
    return answer


def enabled_for(organization_id: str | None) -> bool:
    """:func:`check`, with every failure read as off. Never raises. Blocking; call off the event loop."""
    try:
        return check(organization_id)
    except Exception:  # noqa: BLE001 - off is the safe answer for an entitlement
        return False


def forget() -> None:
    """Drop every kept answer (tests)."""
    with _lock:
        _answers.clear()
