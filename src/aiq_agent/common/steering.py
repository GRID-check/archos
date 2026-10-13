"""Mid-turn steering: a note a person types while Piloti works, read at the next round.

A person watching Piloti act („nicht die Tür, die Treppe“) used to have one
control, Stop, which threw away the rounds already done. A ``steer`` message
(``wire_v2.Steer``) is the other one: it reaches the running turn without
cancelling it, and the model decides its next round with it in view. The
design is ``docs/api/websocket-protocol.md`` (``steer``) and the steering
research it cites; this module is the one place both tiers meet.

Three halves, one object
------------------------

* **The socket** (``aiq_api.chat_socket``) owns a :class:`SteerInbox` per
  turn and binds it with :func:`bind_steer_inbox` before the workflow runs, the
  pattern of ``tools/canvas/presence.py``: the graph's tasks copy the context,
  so they all see the one object. It :meth:`SteerInbox.offer`\\ s each note
  (masked, authorised, capped, idempotent on ``steer_id``).
* **The agent node** (``agents/piloti/agent.py``) :meth:`SteerInbox.take`\\ s
  what arrived at the top of every model decision and records each note with
  the index of ``state.messages`` it arrived at. The note is spliced into the
  model REQUEST at that index (:func:`with_steering`) and never written to
  ``state.messages``: every reader that treats a ``HumanMessage`` as a turn
  boundary (``answer_pipeline.this_turn``, the turn index, history pruning,
  tool search) sees exactly what it saw before. A note at a fixed index keeps
  the request prefix byte-stable from round to round, so the provider's prompt
  cache holds.
* **The tools node** asks :meth:`SteerInbox.has_pending` before it runs a
  round: a note that arrived after the model chose its calls holds back the
  round's WRITE calls (:func:`is_write_call`). Reads still run. The model sees
  each held call answered with :data:`HELD_FOR_STEER` and decides again with
  the note in view.

Outside a chat socket (an eval, ``nat run``, a job) no inbox is bound, every
call here is a no-op, and a turn is byte-identical to one before this module.
"""

from __future__ import annotations

import contextvars
import time
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from pydantic import BaseModel
from pydantic import ConfigDict

from aiq_agent.common.turn_status import tool_basename
from aiq_agent.common.wire_v2 import FocusRegion

#: Notes one turn takes. The gateway's frame limiter counts only questions
#: (``ws-frames.js``), so this is the bound on what steering can cost: each
#: note is about a hundred tokens and maybe one more round.
MAX_STEERS_PER_TURN = 5

#: The basenames of the tools that WRITE something other people see or that
#: changes state: the canvas writes (``tools/canvas``: marks, replies, the
#: pointer and the highlight, and the update and delete still to come), the
#: draft filed into the project and a proposed file operation. A round the
#: model chose before a note arrived does not run these; it runs its reads.
#: A basename, so ``canvas__mark`` and a bare ``mark`` both match.
WRITE_TOOL_BASENAMES: frozenset[str] = frozenset(
    {
        "mark",
        "reply",
        "highlight",
        "point",
        "update",
        "delete",
        "file_draft",
        "propose_file_change",
    }
)

#: What a held-back write is answered with. German like the other withholding
#: notices, and an INSTRUCTION: the call did not fail, the person said
#: something since, and the useful move is to read it and choose again.
HELD_FOR_STEER = (
    "Nicht ausgeführt: Die Person hat inzwischen etwas ergänzt, nachdem du diesen Aufruf gewählt hattest. "
    "Lies die Ergänzung und entscheide neu; stell den Aufruf nur dann noch einmal, wenn er danach noch stimmt."
)


def is_write_call(call: Any) -> bool:
    """Whether one tool call writes (:data:`WRITE_TOOL_BASENAMES`). A call with no name reads."""
    name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
    return bool(name) and tool_basename(str(name)) in WRITE_TOOL_BASENAMES


@dataclass(frozen=True)
class SteerNote:
    """One note as the socket took it: already masked and authorised."""

    steer_id: str
    text: str
    #: Who wrote it, by the verified display name; None when the socket has none.
    author: str | None = None
    focus_region: FocusRegion | None = None
    #: ``time.monotonic()`` when the inbox took it, for the span's wait time.
    received_at: float = field(default_factory=time.monotonic)


Offered = Literal["received", "duplicate", "limit"]


class SteerInbox:
    """One turn's notes: offered by the socket, taken by the agent node.

    Single-threaded by construction: the socket and the graph run on one event
    loop, and no method awaits, so an offer and a take never interleave.
    """

    def __init__(self, *, limit: int = MAX_STEERS_PER_TURN) -> None:
        self.limit = limit
        self._pending: list[SteerNote] = []
        self._seen: set[str] = set()
        #: How many notes the graph took, in the order it took them.
        self.applied: list[SteerNote] = []

    def offer(self, note: SteerNote) -> Offered:
        """Take ``note`` for the turn. ``duplicate`` for an id already taken, ``limit`` past the cap."""
        if note.steer_id in self._seen:
            return "duplicate"
        if len(self._seen) >= self.limit:
            return "limit"
        self._seen.add(note.steer_id)
        self._pending.append(note)
        return "received"

    def has_pending(self) -> bool:
        """Whether a note arrived that no model decision has read yet."""
        return bool(self._pending)

    def take(self) -> list[SteerNote]:
        """Every note not read yet, oldest first; they count as applied from here."""
        taken, self._pending = self._pending, []
        self.applied.extend(taken)
        return taken

    @property
    def received(self) -> int:
        """How many distinct notes the turn took."""
        return len(self._seen)


_INBOX: contextvars.ContextVar[SteerInbox | None] = contextvars.ContextVar("grid_steer_inbox", default=None)


def bind_steer_inbox(inbox: SteerInbox | None) -> contextvars.Token[SteerInbox | None]:
    """Bind ``inbox`` for one turn (the socket, before the workflow); reset it with the token."""
    return _INBOX.set(inbox)


def unbind_steer_inbox(token: contextvars.Token[SteerInbox | None]) -> None:
    """Restore what was bound before :func:`bind_steer_inbox`."""
    _INBOX.reset(token)


def current_steer_inbox() -> SteerInbox | None:
    """The running turn's inbox, or None outside a chat socket."""
    return _INBOX.get()


class AppliedSteer(BaseModel):
    """A note the turn read, as the agent state keeps it: rendered once, spliced at a fixed index.

    ``at`` is ``len(state.messages)`` when the note was taken: the request puts
    it right after the messages that existed then, in every later round too.
    """

    model_config = ConfigDict(frozen=True)

    steer_id: str
    content: str
    at: int
    round: int


def _region_line(region: FocusRegion) -> str:
    return (
        f"[Bereich: S. {region.page}, x {region.x:.2f}–{region.x + region.w:.2f}, "
        f"y {region.y:.2f}–{region.y + region.h:.2f}]"
    )


def render_note(note: SteerNote, round_index: int) -> str:
    """The note as the model reads it: the person's words, where they point, and how it ranks.

    The instruction travels in the note rather than in the static prompt, so
    steering needs no prompt publish, and a turn without a note carries none
    of it. The author's name is the verified one; the text is the person's own
    (masked) and is quoted, never merged into an instruction.
    """
    author = f' von="{note.author}"' if note.author else ""
    lines = [f'<ergaenzung{author} waehrend="Runde {round_index}">', note.text.strip()]
    if note.focus_region is not None:
        lines.append(_region_line(note.focus_region))
    lines.append("</ergaenzung>")
    lines.append(
        "Die Person hat das geschrieben, während du gearbeitet hast. Es gilt ab jetzt und geht der "
        "ursprünglichen Frage vor, wo beide sich widersprechen. Was du schon vorgeschlagen hast, bleibt "
        "stehen, bis jemand es verwirft; nenne es in deiner Antwort, wenn es nicht mehr stimmt."
    )
    return "\n".join(lines)


def with_steering(request: Sequence[BaseMessage], applied: Sequence[AppliedSteer], *, offset: int = 1) -> list[Any]:
    """``request`` with one request-only ``HumanMessage`` per applied note, each at its own index. Pure.

    ``offset`` is how many messages precede ``state.messages`` in the request
    (the system message). Notes taken at the same index keep the order they
    were taken in. Without notes, the request is returned as a new list of the
    same messages.
    """
    messages = list(request)
    if not applied:
        return messages
    notes_at: dict[int, list[HumanMessage]] = {}
    for steer in applied:
        position = min(len(messages), offset + steer.at)
        notes_at.setdefault(position, []).append(HumanMessage(content=steer.content))
    spliced: list[Any] = []
    for index, message in enumerate(messages):
        spliced.extend(notes_at.pop(index, ()))
        spliced.append(message)
    for position in sorted(notes_at):
        spliced.extend(notes_at[position])
    return spliced
