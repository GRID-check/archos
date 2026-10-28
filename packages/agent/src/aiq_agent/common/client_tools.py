"""The frontend tools the asking page can run this turn (AG-UI's ``RunAgentInput.tools``).

A frontend tool runs on the person's screen, not here, so it exists for a turn
only when the page that asked it says it can run it: ``user_message.client_tools``
(``wire_v2.UserMessage``). A phone with no room beside the chat, a tab one
release older, a background run and an agent at the door declare nothing, and
the model is not offered the tool there at all (``agents/piloti/register.py``,
``_tools_in_scope``). The tool checks again when it is called (ADR-0144).

Per turn, in a ``ContextVar`` set once by ``turn.payload.extract_turn_inputs``.
The value is one mutable record, so a claim made inside a tool call (whose
context is a copy) is seen by the turn's later calls: that is what lets a tool
say "once per turn" (:func:`claim_once`).
"""

from __future__ import annotations

from collections.abc import Iterable
from contextvars import ContextVar
from dataclasses import dataclass
from dataclasses import field

#: The frontend tools this server knows. A name the page sends that is not here is ignored.
KNOWN_CLIENT_TOOLS: frozenset[str] = frozenset({"show_in_viewer"})


@dataclass
class _TurnClientTools:
    declared: frozenset[str]
    claimed: set[str] = field(default_factory=set)


_TURN: ContextVar[_TurnClientTools | None] = ContextVar("turn_client_tools", default=None)


def set_turn_client_tools(names: Iterable[str] | None) -> None:
    """The tools the asking page declared for this turn; every turn sets it, so none outlives its turn."""
    declared = frozenset(name for name in (names or ()) if name in KNOWN_CLIENT_TOOLS)
    _TURN.set(_TurnClientTools(declared))


def client_tool_declared(name: str) -> bool:
    """Whether the asking page can run ``name`` this turn. False off a chat turn."""
    turn = _TURN.get()
    return turn is not None and name in turn.declared


def claim_once(name: str) -> bool:
    """True the first time ``name`` is claimed this turn, False after (and off a turn)."""
    turn = _TURN.get()
    if turn is None or name in turn.claimed:
        return False
    turn.claimed.add(name)
    return True
