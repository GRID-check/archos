"""Telling the user what the turn is actually doing, while it does it.

Everything a Grid turn currently reports about itself is an accident of
observability. NAT's ``StepAdaptor`` watches the LangChain instrumentation and
turns LLM/tool/function spans into ``system_intermediate_message`` frames; the
frontend then guesses an activity label by regex-matching the raw NAT function
name. Nothing in this repo ever *said* anything. The holes that leaves are not
edge cases — they are the longest stretches of the turn: context loading before
the graph starts, and the whole answer phase behind a generic label.

This module is the other direction: the agent states what it is doing at the
moment it does it.

Keys, not sentences
-------------------

It states it as a **stable key plus interpolation values**, never as a finished
sentence. The first cut of this module emitted German prose in a ``text``
field and the frontend rendered it verbatim, so an English-locale reader got
German — a regression the whole product rule exists to prevent: **nothing in
emitted data is language-specific**. What travels now is

``key``
    a stable dotted id (``status.retrieval.withQuery``, ``status.escalation``)
    that the frontend resolves against its own dictionary. It is an identifier,
    not copy: renaming one is a wire change.
``values``
    the interpolation data ONLY, ``dict[str, str]``. Everything else the event
    knows (an intent, a depth, a source count, the classifier's reason) travels
    as its own field, because those are telemetry for the details panel and not
    slots in a sentence.

Which means every value in ``values`` must survive being dropped into an
English sentence. Three rules, applied per value:

1. **A proper noun travels as itself.** A skill's authored ``grid-title``
   ("Brandschutznachweis") is that office's name for their own working method;
   it is the same word in every locale, and translating it would be inventing a
   name nobody uses.
2. **A name the PRODUCT chose travels as an id.** "OIB-Wissen", "Ihre
   Unterlagen", "im Gebäudemodell" are product copy wearing a proper noun's
   clothes — and the preposition and the conjunction joining two of them are
   pure German grammar. So a corpus travels as ``knowledge``/``ris``/``web``/
   ``documents``/``ifc`` and the frontend both names and joins them.
3. **Prose is never a value.** An escalation ``reason`` is a free-text sentence
   an LLM wrote; it cannot be interpolated into an English line without
   smuggling a German clause into it. The live line therefore says only the
   DECISION, from a fixed enum, phrased entirely by the frontend. The reason
   still travels — as the ``reason`` FIELD, which the Herleitung already renders
   as the model's own words, attributed and secondary. (Because it is still
   read by a user there, ``intent_classification.j2`` no longer pins it to
   German: it asks for the language of the user's own query.)

The user query quoted in a retrieval line is the reader's own words echoed
back, so it is neither prose we wrote nor a name we chose — it goes back out
exactly as it came in.

What earns a line
-----------------

A status line must complete the sentence "…so the reader knows that ___" with
a noun from an ARCHITECT's world — a law, a document, a working method, a
check. If the only honest completion names a mechanism (a function, a class, a
catalog size, a character count), it is telemetry, and telemetry travels with
``channel="technical"`` so it can sit in the opt-in panel and never on the
live line. Two further rules follow from that:

- **A constant is not an event.** Something that is true on every single turn
  tells the reader nothing by being announced. Where a phase cannot vary, it
  is either not emitted or gated on the thing that does vary.
- **Volume is a design constraint.** The live line REPLACES rather than
  accumulates, so a phase that would fire several times a second is aggregated
  into one event instead. One good sentence beats three true ones.

How it reaches the user
-----------------------

**Each event is a typed step on the chat wire** (``common/wire_v2.py``,
``docs/design/chat-wire-v2.md`` §b). :func:`emit_step` writes it to the running
graph's custom stream through LangGraph's own ``get_stream_writer()``, and the
chat socket stamps and sends it. Outside a graph run there is no stream, so a
producer that runs there (the setup phase in ``_run``) builds its step with a
``*_step`` builder and ``_run`` yields it. Under ``ainvoke`` (a deep-research
job worker) the writer is a no-op.

**The step id is load-bearing.** The same id again replaces the row, so each
status gets its own ``status:<slot>`` id and the skills substrate
(``skills.events``) one per skill."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from collections.abc import Iterator
from contextlib import asynccontextmanager
from contextlib import contextmanager
from contextvars import ContextVar
from contextvars import Token
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from langgraph.config import get_stream_writer
from langgraph.errors import GraphBubbleUp

from aiq_agent.common.wire_v2 import Channel
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import Scalar
from aiq_agent.common.wire_v2 import Scope
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import Step
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import StepStartedBody
from aiq_agent.common.wire_v2 import SubagentErrorBody
from aiq_agent.common.wire_v2 import SubagentFinishedBody
from aiq_agent.common.wire_v2 import SubagentStartedBody

logger = logging.getLogger(__name__)


def emit(body: EventBody) -> None:
    """Write one wire body to the running graph's custom stream. Outside a graph run, nothing."""
    try:
        writer = get_stream_writer()
    except (RuntimeError, KeyError):  # no graph run: outside any runnable, or in a runnable outside a graph
        return
    writer(body)


#: Which agent is taking the steps emitted in this context. The deep researcher
#: binds ``deep`` around its run (:func:`step_scope`), so every step its nodes,
#: tools and callbacks emit is drawn as deep research's, with no producer
#: having to know which agent called it.
_step_scope: ContextVar[Scope] = ContextVar("grid_step_scope", default="chat")


@contextmanager
def step_scope(scope: Scope) -> Iterator[None]:
    """Stamp every step emitted inside this block with ``scope``."""
    token = _step_scope.set(scope)
    try:
        yield
    finally:
        _step_scope.reset(token)


@dataclass
class SubagentFrame:
    """The subagent invocation the code running here belongs to (AG-UI 1.0 subagents)."""

    run_id: str
    parent_run_id: str | None
    #: The tool call that spawned it, when the subagent is a tool (deepagents' ``task``).
    tool_call_id: str | None = None
    #: Its SUBAGENT_ERROR is sent: the invocation is closed, and no FINISHED follows.
    failed: bool = False


#: The innermost subagent invocation running in this context, or None for the
#: turn's own agent. Bound by :func:`subagent_run` and inherited the way every
#: ContextVar is: by the tasks LangGraph and ``asyncio.gather`` start inside it,
#: so a subagent's nodes, tools and callbacks see it without being told.
_subagent: ContextVar[SubagentFrame | None] = ContextVar("grid_subagent", default=None)


#: What a person reads when a subagent fails. The exception stays in the logs
#: and the trace: its text may carry a tool's output, which never rides the wire.
SUBAGENT_FAILED_MESSAGE = "The subagent failed; the turn goes on without its result."


def current_subagent() -> SubagentFrame | None:
    """The subagent invocation running in this context, if any."""
    return _subagent.get()


def _clip(text: str | None, limit: int) -> str | None:
    """``text`` on one line and at most ``limit`` characters, or None when empty."""
    flat = " ".join((text or "").split())
    if not flat:
        return None
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


@asynccontextmanager
async def subagent_run(
    name: str, *, description: str | None = None, parent_tool_call_id: str | None = None
) -> AsyncIterator[SubagentFrame]:
    """Run the block as one subagent invocation: SUBAGENT_STARTED, its steps attributed, then FINISHED or ERROR.

    A nested block names the enclosing invocation as its parent. A failure is
    reported and re-raised: whether the turn goes on is the caller's to decide,
    as AG-UI leaves it to the parent agent. A cancellation reports nothing (the
    turn's terminal closes every open group), and neither does LangGraph's
    ``GraphBubbleUp``, which is a pause, not a failure: pausing a run is
    ADR-0140's. Outside a graph run every emit is a no-op, so a deep-research
    job worker pays nothing for it.
    """
    parent = _subagent.get()
    frame = SubagentFrame(
        run_id=f"sa_{uuid4().hex[:20]}",
        parent_run_id=parent.run_id if parent else None,
        tool_call_id=parent_tool_call_id[:128] if parent_tool_call_id else None,
    )
    emit(
        SubagentStartedBody(
            subagent_run_id=frame.run_id,
            name=name[:64],
            description=_clip(description, 160),
            parent_subagent_run_id=frame.parent_run_id,
            parent_tool_call_id=frame.tool_call_id,
        )
    )
    token = _subagent.set(frame)
    try:
        yield frame
    except GraphBubbleUp:
        raise
    except Exception as exc:
        logger.info("Subagent %s (%s) failed: %s", name, frame.run_id, type(exc).__name__)
        fail_subagent(frame, type(exc).__name__)
        raise
    else:
        if not frame.failed:
            emit(SubagentFinishedBody(subagent_run_id=frame.run_id))
    finally:
        _subagent.reset(token)


def fail_subagent(frame: SubagentFrame, code: str) -> None:
    """Report ``frame`` failed, once: also for a spawning tool that came back as an error result instead of raising.

    An invocation ends exactly once, so the block it runs in sends no
    SUBAGENT_FINISHED after this.
    """
    if frame.failed:
        return
    frame.failed = True
    emit(SubagentErrorBody(subagent_run_id=frame.run_id, message=SUBAGENT_FAILED_MESSAGE, code=code[:64] or None))


#: ``emit_step``'s default: attribute the row to the subagent running here.
_INHERIT: Any = object()


def emit_step(step: Step, *, started: bool = False, subagent_run_id: str | None = _INHERIT) -> None:
    """Emit one Herleitung row: STEP_STARTED for a step with a duration, else STEP_FINISHED.

    The row is attributed to the subagent running here, unless the caller
    names the invocation itself (``None``: the turn's own agent).
    """
    scope = _step_scope.get()
    if scope != step.scope:
        step = step.model_copy(update={"scope": scope})
    if subagent_run_id is _INHERIT:
        frame = _subagent.get()
        subagent_run_id = frame.run_id if frame else None
    emit(
        StepStartedBody(step=step, subagent_run_id=subagent_run_id)
        if started
        else StepFinishedBody(step=step, subagent_run_id=subagent_run_id)
    )


#: Which retrieval round the agent is in RIGHT NOW — the slot ``emit_retrieval``
#: just announced. Knowledge-layer Trace-Lanes read this so a hit is stamped
#: with the fetch that produced it, even after the UI merges two
#: ``knowledge_search`` completions onto one thinking step.
#:
#: **It has to be set where the tool RUNS.** ``emit_retrieval`` sets it too, but
#: that call happens in Piloti's *agent* node, and LangGraph runs every
#: node in its own task built with ``copy_context()``: the tools node inherits
#: the context the RUN started with, never the one the previous node mutated.
#: For a release every hit was therefore unstamped and the Herleitung fell back
#: to stream order, which puts both fetches on the first checkpoint. The
#: authoritative set is ``PilotiAgent._tools_node`` via
#: :func:`retrieval_round_scope`, immediately around the ToolNode invocation —
#: parallel tool calls copy the context when their sibling tasks are created,
#: so setting it once in the parent covers the whole batch.
_retrieval_round: ContextVar[int | None] = ContextVar("grid_retrieval_round", default=None)


def current_retrieval_round() -> int | None:
    """The fetch slot the running tool result belongs to, or ``None``."""
    return _retrieval_round.get()


def stamp_retrieval_round(round_index: int) -> None:
    """Make ``round_index`` the current fetch slot for the rest of this context, with no reset.

    The round announcement stamps it, so tool results that land later (and are
    merged onto one thinking step) still know which fetch they belong to.
    """
    _retrieval_round.set(round_index)


@contextmanager
def retrieval_round_scope(round_index: int | None) -> Iterator[None]:
    """Stamp every hit fetched inside this block with ``round_index``.

    ``None`` is a real value: an action-only round (``remember`` / ``emit_card``)
    is not a fetch and its results belong to no layer of the spine. Resets on
    exit, so a round never leaks into the next node or the next turn.
    """
    token = _retrieval_round.set(round_index)
    try:
        yield
    finally:
        _retrieval_round.reset(token)


#: Which tool's results are being turned into lane hits RIGHT NOW.
#:
#: The round stamp says WHEN a hit was fetched; this says by WHAT. The
#: retrieval ledger needs both: "did an earlier round OPEN this document, or
#: merely rank it" decides whether reading it again is a re-fetch, and a round
#: that searched and opened in one batch returns hits from both calls with
#: nothing on the hit to tell them apart.
#:
#: Set by the producing TOOL around the call that renders its fan-out, for the
#: same reason the round is set in the tools node: the value has to be live in
#: the context the emitter runs in. ``asyncio.to_thread`` copies the context
#: when the call is made, so a tool that formats off the loop enters the scope
#: BEFORE that await, never inside the thread.
#:
#: Unset is a real state, not a defect: a tool that never enters the scope
#: (RIS, web, the surfacing tools) records unstamped hits, and the ledger has
#: a coarser fallback for a round whose hits carry no stamp.
_lane_tool: ContextVar[str | None] = ContextVar("grid_lane_tool", default=None)


def current_lane_tool() -> str | None:
    """The tool whose results are being recorded as lane hits, or ``None``."""
    return _lane_tool.get()


@contextmanager
def lane_tool_scope(tool: str | None) -> Iterator[None]:
    """Stamp every lane hit recorded inside this block with ``tool``.

    The basename, as :data:`LOCATOR_TOOL_BASENAMES` and the ledger spell it —
    ``knowledge_search``, ``read_passage`` — not a display name. Resets on
    exit, so one tool's scope never colours the next one's hits.
    """
    token = _lane_tool.set((tool or "").strip() or None)
    try:
        yield
    finally:
        _lane_tool.reset(token)


#: Lane hits this turn's tools returned, as the emitters stated them: one
#: entry per hit with the round stamp, the producing tool, name, title, detail
#: and shelf the Trace-Lanes block carries. The round is read HERE, off the same
#: ContextVar the stamp reads, so a captured hit and its stamped twin can never
#: disagree.
#:
#: ``tool`` is IN-PROCESS only. It travels from this capture to
#: :func:`~aiq_agent.common.retrieval_ledger.build_retrieval_ledger` and stops
#: there: the ledger's wire docs carry name/title/detail/shelf and nothing
#: else, because which tool fetched a passage is how the repeat verdict is
#: DERIVED, not something a reader is shown.
#:
#: Why a SECOND capture beside the turn_sources log: that log dedups
#: documents across rounds (right for citation-health denominators, wrong for
#: a per-round ledger). This one keeps every round's hits apart, in order.
_lane_captured_hits: ContextVar[list[dict[str, Any]] | None] = ContextVar("grid_lane_captured_hits", default=None)


def begin_lane_capture() -> Token:
    """Start recording this turn's lane hits. Pair with :func:`end_lane_capture`."""
    return _lane_captured_hits.set([])


def end_lane_capture(token: Token) -> None:
    """Stop recording this turn's lane hits."""
    _lane_captured_hits.reset(token)


def record_lane_hit(
    name: str,
    *,
    title: str | None = None,
    detail: str | None = None,
    shelf: str | None = None,
) -> None:
    """Note one lane hit a tool result carries. No-op when not recording.

    Best-effort by contract (module rule above): emitters call this beside
    the Trace-Lanes entry they build, and a capture must never break a tool
    result. Only JSON primitives are stored, so the capture is wire-ready.

    The round and the producing tool are read off their ContextVars rather
    than passed, so an emitter cannot state one and be running under the
    other. Both are absent when nothing set them.
    """
    try:
        log = _lane_captured_hits.get()
        clean = (name or "").strip()
        if log is None or not clean:
            return
        entry: dict[str, Any] = {"round": current_retrieval_round(), "name": clean}
        tool = current_lane_tool()
        if tool:
            entry["tool"] = tool
        if title and title.strip():
            entry["title"] = title.strip()
        if detail and detail.strip():
            entry["detail"] = detail.strip()
        if shelf and shelf.strip():
            entry["shelf"] = shelf.strip()
        log.append(entry)
    except Exception:  # noqa: BLE001 — capture must never take a turn down
        logger.debug("Lane hit not captured", exc_info=True)


def get_lane_captures() -> list[dict[str, Any]]:
    """Every lane hit recorded this turn, in capture order. Caller owns the list."""
    return list(_lane_captured_hits.get() or [])


#: Step-id prefix for the status rows in this module. The suffix is the SLOT
#: (``status:context``, ``status:routing``, …): the same id replaces the row,
#: so one slot is one row.
STATUS_STEP_PREFIX = "status:"


#: ``channel`` on the step. ``live`` may be shown as the single running
#: one-liner; ``technical`` is for the opt-in details panel ONLY. The
#: distinction is the difference between what the reader is told and what an
#: operator can go look up, and the frontend must not blur it: this product
#: already shipped a phantom "web search" line because an availability signal
#: was rendered as activity.
CHANNEL_LIVE: Channel = "live"


CHANNEL_TECHNICAL: Channel = "technical"


#: Room for the quoted retrieval query inside a status line, after the label
#: and the punctuation around it. Budgeted here rather than in the frontend
#: because the backend is the only side that sees the untruncated query, and a
#: status that overflows its one line is worse than one that says slightly
#: less. (The line as a whole is budgeted by the dictionary copy: every
#: template under ``chat.thinking.turnStatus`` is written to fit one narrow
#: row with this much query in it.)
MAX_QUERY_CHARS = 32


#: Reason strings (routing, escalation) travel in full-ish as a separate field
#: rather than being crammed into the one-liner.
MAX_REASON_CHARS = 160


def clip(text: str, limit: int) -> str:
    """``text`` shortened to ``limit`` characters, ellipsis included in the count.

    The one-liners are budgeted, not truncated by the reader: a status that
    overflows its line is worse than one that says slightly less.
    """
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def status_step(
    slot: str,
    key: str | None = None,
    *,
    values: dict[str, Any] | None = None,
    channel: Channel = CHANNEL_LIVE,
    **detail: Scalar | list[str] | None,
) -> StatusStep:
    """One status row, id ``status:<slot>``.

    Args:
        slot: The status slot (``context``, ``routing``, …). Also the step id's
            suffix, so a second event in the same slot replaces the first.
        key: The stable dotted id the frontend resolves to a sentence. NOT copy
            (see the module docstring), and absent on a technical record.
        values: Interpolation data ONLY, stringified. Empty values are dropped
            so a template placeholder is either filled or visibly not.
        channel: :data:`CHANNEL_LIVE` or :data:`CHANNEL_TECHNICAL`.
        detail: Structured detail that is NOT part of the sentence (a count, a
            reason, a token). ``None`` is omitted, so absent stays absent.
    """
    clean = {name: str(value).strip() for name, value in (values or {}).items() if value is not None}
    return StatusStep(
        id=f"{STATUS_STEP_PREFIX}{slot}",
        slot=slot,
        key=key,
        values={name: text for name, text in clean.items() if text},
        channel=channel,
        detail={name: value for name, value in detail.items() if value is not None},
    )


def emit_status(
    slot: str,
    key: str | None = None,
    *,
    values: dict[str, Any] | None = None,
    channel: Channel = CHANNEL_LIVE,
    **detail: Scalar | list[str] | None,
) -> None:
    """Emit one :func:`status_step`."""
    emit_step(status_step(slot, key, values=values, channel=channel, **detail))


def emit_technical(slot: str, **detail: Scalar | list[str] | None) -> None:
    """Emit one technical record: no key, no values, only detail an operator counts."""
    emit_status(slot, channel=CHANNEL_TECHNICAL, **detail)
