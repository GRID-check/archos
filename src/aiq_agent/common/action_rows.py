"""Action rows (ADR-0132): one row per tool call that does something, and the callback that writes them."""

from __future__ import annotations

import logging
import time
from contextvars import ContextVar
from contextvars import Token
from typing import Any
from typing import Literal
from uuid import UUID
from uuid import uuid4

from langchain_core.callbacks import AsyncCallbackHandler

from aiq_agent.common import turn_status
from aiq_agent.common.tool_calls import FILESYSTEM_READ_TOOLS
from aiq_agent.common.tool_calls import tool_basename
from aiq_agent.common.turn_status import clip
from aiq_agent.common.turn_status import current_retrieval_round
from aiq_agent.common.turn_status import current_subagent
from aiq_agent.common.wire_v2 import ActionCounts
from aiq_agent.common.wire_v2 import ActionStep
from aiq_agent.common.wire_v2 import ActionVerb
from aiq_agent.common.wire_v2 import ToolStep

logger = logging.getLogger(__name__)

#: Step id prefix of an action row (ADR-0132); a fresh id per call follows.
ACTION_STEP_PREFIX = "action:"


#: The action row of the tool call running RIGHT NOW, so the sources it returns
#: name the same call (ADR-0132). Each parallel call runs in its own task, so
#: siblings never see each other's id.
_action_call: ContextVar[str | None] = ContextVar("grid_action_call", default=None)


def current_action_call() -> str | None:
    """The call id of the action row open in this task, or ``None``."""
    return _action_call.get()


class ActionRow:
    """One call's row in the Herleitung work list: emitted ``running`` now, settled by :meth:`finish`.

    The tool holds the row for the length of its call and fills in what it
    found from its own typed values. Fail-open everywhere: a row that does not
    validate is logged and dropped, never raised into the tool.
    """

    def __init__(self, verb: ActionVerb, **fields: Any) -> None:
        self.call_id = uuid4().hex[:16]
        self._id = f"{ACTION_STEP_PREFIX}{self.call_id}"
        self._started = time.monotonic()
        self._fields: dict[str, Any] = {
            "verb": verb,
            "call_id": self.call_id,
            "round": current_retrieval_round(),
            **_clip_action(fields),
        }
        self._token: Token[str | None] | None = _action_call.set(self.call_id)
        self._done = False
        self._emit(started=True)

    def finish(
        self,
        status: Literal["ok", "empty", "error"] = "ok",
        *,
        counts: dict[str, int | None] | None = None,
        **fields: Any,
    ) -> None:
        """Settle the row once: its outcome, its counts and its time. A second call is ignored.

        A settled ``mount`` is the whole place the call reached: it replaces the running row's ``mount`` and
        ``target``, so a place's root (no ``target``) never keeps the name the running row showed.
        """
        if self._done:
            return
        self._done = True
        self._release_call()
        if "mount" in fields:
            self._fields.pop("mount", None)
            self._fields.pop("target", None)
        self._fields.update(_clip_action(fields))
        self._fields["status"] = status
        self._fields["elapsed_ms"] = max(0, round((time.monotonic() - self._started) * 1000))
        kept = {k: v for k, v in (counts or {}).items() if v is not None}
        if kept:
            self._fields["counts"] = kept
        self._emit(started=False)

    def _release_call(self) -> None:
        token, self._token = self._token, None
        if token is None:
            return
        try:
            _action_call.reset(token)
        except ValueError:
            # Settled from another context than the one that opened it: that
            # context ends with its task, and the id goes with it.
            pass

    def _emit(self, *, started: bool) -> None:
        try:
            fields = dict(self._fields)
            counts = fields.pop("counts", None)
            step = ActionStep(id=self._id, counts=ActionCounts(**counts) if counts else None, **fields)
        except ValueError:
            logger.warning("An action row did not validate (%s)", self._fields.get("verb"), exc_info=True)
            return
        turn_status.emit_step(step, started=started)


_ACTION_CLIPS = {"query": 160, "target": 300, "pages": 40, "shelf": 40}


def _clip_action(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in fields.items():
        if value is None or value == "":
            continue
        limit = _ACTION_CLIPS.get(key)
        out[key] = clip(str(value), limit) if limit else value
    return out


#: Slot prefix of the technical record a literal-mode ``knowledge_search`` (``match="exact"`` or
#: ``"regex"``) leaves. A tool step carries the tool's name and never its arguments, so this record is
#: how a reader of the turn (the ``file-tools-used`` score) tells a literal search, which the eval's
#: ``navigate`` arm counts as navigation, from a ranked one (ADR-0127).
LITERAL_SEARCH_SLOT = "literal-search"


def emit_literal_search(mode: str) -> None:
    """Record that one ``knowledge_search`` call ran in a literal mode; one record per call."""
    turn_status.emit_technical(f"{LITERAL_SEARCH_SLOT}:{uuid4().hex[:12]}", match=mode)


def is_literal_search(step: Any) -> bool:
    """Whether ``step`` is the record :func:`emit_literal_search` left."""
    slot = getattr(step, "slot", None)
    return (
        getattr(step, "kind", None) == "status" and isinstance(slot, str) and slot.startswith(f"{LITERAL_SEARCH_SLOT}:")
    )


class ToolStepCallback(AsyncCallbackHandler):
    """Every tool call of a graph run as a ``tool`` step: its basename and outcome, never its I/O.

    Added once to the conversation graph's run config. NAT's profiler still
    bills and traces tools through its own handler; this one only tells the
    reader a tool ran. One instance per run: it remembers each running call's
    name until the call ends.
    """

    def __init__(self) -> None:
        self._running: dict[UUID, tuple[str, str | None, str | None]] = {}

    async def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: UUID, **kwargs: Any) -> None:
        tool = tool_basename(str(serialized.get("name") or kwargs.get("name") or "")) or "tool"
        mount = _tool_mount(tool, kwargs.get("inputs"))
        subagent = _tool_subagent(kwargs.get("tool_call_id"))
        self._running[run_id] = (tool, mount, subagent)
        turn_status.emit_step(
            ToolStep(id=f"tool:{run_id}", tool=tool, mount=mount), started=True, subagent_run_id=subagent
        )

    async def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, "ok")

    async def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, "error")

    def _finish(self, run_id: UUID, status: Literal["ok", "error"]) -> None:
        running = self._running.pop(run_id, None)
        if running is not None:
            tool, mount, subagent = running
            turn_status.emit_step(
                ToolStep(id=f"tool:{run_id}", tool=tool, status=status, mount=mount), subagent_run_id=subagent
            )


def _tool_subagent(tool_call_id: Any) -> str | None:
    """Which invocation a tool call belongs to. The call that SPAWNED a subagent is its parent's.

    A subagent is bound around the tool that spawns it (deepagents' ``task``),
    so that tool's own callbacks already see it; they hand the row up a level.
    """
    frame = current_subagent()
    if frame is None:
        return None
    if frame.tool_call_id is not None and isinstance(tool_call_id, str) and tool_call_id[:128] == frame.tool_call_id:
        return frame.parent_run_id
    return frame.run_id


def _tool_mount(tool: str, inputs: Any) -> str | None:
    """The mount a file tool's call reached, for the wire's ``mount`` (ADR-0133); ``None`` for any other tool.

    The step stores the tool's name and never its arguments, so without this an
    estate ``read_file`` and a draft ``read_file`` were one step, drawn as a draft.
    """
    from aiq_agent.common.estate_paths import WRITE_TOOLS
    from aiq_agent.common.estate_paths import call_mount

    if tool not in FILESYSTEM_READ_TOOLS and tool not in WRITE_TOOLS:
        return None
    return call_mount(tool, inputs if isinstance(inputs, dict) else None)
