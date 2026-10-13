"""What the chat turn does for the review canvas, around the graph: nothing posted, one ``leave``.

The canvas tools act only when the model calls them. The harness adds two
things and no more: a question asked in a thread runs without restricted
folders in scope, and Piloti's cursor leaves every document it appeared on once
the turn is over, however it ended.
"""

from __future__ import annotations

from aiq_agent.agents.piloti import conversation_register as cr
from aiq_agent.common.wire_v2 import FocusRegion
from aiq_agent.tools.canvas import presence
from aiq_agent.turn.payload import TurnInputs

from .test_settled_replaced import _terminal
from .test_settled_replaced import workflow  # noqa: F401 - the shared `_run` harness

REGION = FocusRegion(page=2, x=0.1, y=0.2, w=0.3, h=0.2, annotation_id="a-1")


async def test_the_turn_leaves_every_document_it_pointed_at_after_the_ledgers(workflow, monkeypatch):  # noqa: F811
    left: list[set[str]] = []

    async def leave(record):
        left.append(set(record.documents))
        workflow["order"].append("left")

    monkeypatch.setattr(cr, "leave_canvas", leave)
    run = workflow["run"]([], _terminal("A."))

    async for _ in run:
        presence.note_presence("doc-1")

    assert left == [{"doc-1"}]
    assert workflow["order"] == ["ledgers flushed", "left"]


async def test_a_thread_question_runs_without_restricted_folders(workflow, monkeypatch):  # noqa: F811
    withheld: list[bool] = []
    monkeypatch.setattr(cr, "withhold_restricted_for_thread", lambda: withheld.append(True))
    monkeypatch.setattr(
        cr, "extract_turn_inputs", lambda _q: TurnInputs("q", [], None, None, focus_region=REGION, reply_in_thread=True)
    )

    [_ async for _ in workflow["run"]([], _terminal("A."))]

    assert withheld == [True]


async def test_a_box_alone_keeps_the_turns_scope(workflow, monkeypatch):  # noqa: F811
    withheld: list[bool] = []
    monkeypatch.setattr(cr, "withhold_restricted_for_thread", lambda: withheld.append(True))
    monkeypatch.setattr(cr, "extract_turn_inputs", lambda _q: TurnInputs("q", [], None, None, focus_region=REGION))

    [_ async for _ in workflow["run"]([], _terminal("A."))]

    assert withheld == []
