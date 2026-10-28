"""What the canvas tools tell the rest of the turn: which answer a write belongs to, and which thread got a reply.

Every write names the answer this turn writes (``answerMessageId``), so the BFF
records each change Piloti applied against it (ADR-0109). And every write that
speaks in a mark's thread notes it on the turn's thread record
(``agent.turn.annotation_reply``), so the turn does not post its answer
there a second time; ``leave_canvas``, the canvas's end-of-turn call, settles
whether that answer may go where everyone reads.
"""

from __future__ import annotations

import pytest
from agent_testing.canvas import ANNOTATION
from agent_testing.canvas import CREATE_BODY
from agent_testing.canvas import DELETE_BODY
from agent_testing.canvas import DOCUMENT
from agent_testing.canvas import LIST_BODY
from agent_testing.canvas import OK_BODY
from agent_testing.canvas import PROPOSAL
from agent_testing.canvas import PROPOSE_BODY
from agent_testing.canvas import REPLY_BODY
from agent_testing.canvas import UPDATE_BODY
from agent_testing.canvas import answering

from agent.common.focus_file import set_turn_intent
from agent.knowledge.restricted_use import RestrictedUse
from agent.knowledge.restricted_use import bind_restricted_use
from agent.tools.canvas import presence
from agent.tools.canvas.client import CanvasRequestError
from agent.tools.canvas.register import run_delete
from agent.tools.canvas.register import run_highlight
from agent.tools.canvas.register import run_mark
from agent.tools.canvas.register import run_point
from agent.tools.canvas.register import run_reply
from agent.tools.canvas.register import run_update
from agent.turn.annotation_reply import ThreadReply
from agent.turn.annotation_reply import bind_thread_reply
from agent.turn.annotation_reply import reset_thread_reply
from agent.turn.response import answer_message_id

#: The answer the conftest's turn writes: conversation ``s_conv_1``, user message ``m_user_7``.
ANSWER = answer_message_id("s_conv_1", "m_user_7")

WRITES = {
    "mark (proposed)": (lambda: run_mark([PROPOSAL]), PROPOSE_BODY),
    "mark (open)": (lambda: run_mark([PROPOSAL], open=True), CREATE_BODY),
    "update": (lambda: run_update(ANNOTATION, "Erledigt.", status="resolved"), UPDATE_BODY),
    "delete": (lambda: run_delete(ANNOTATION), DELETE_BODY),
    "reply": (lambda: run_reply(ANNOTATION, "Ist korrigiert."), REPLY_BODY),
    "point (labelled)": (lambda: run_point(2, 0.4, 0.5, "Hier"), OK_BODY),
    "highlight": (lambda: run_highlight(1, 0.1, 0.2, 0.3, 0.1, "Hier: Fluchtweg"), OK_BODY),
}


@pytest.fixture
def thread():
    """A turn asked in the thread of :data:`ANNOTATION`, its record bound as the chat socket binds it."""
    record = ThreadReply(annotation_id=ANNOTATION, document_id=DOCUMENT)
    token = bind_thread_reply(record)
    yield record
    reset_thread_reply(token)


@pytest.mark.parametrize("write", WRITES, ids=list(WRITES))
async def test_every_write_names_the_answer_this_turn_writes(write, monkeypatch, calls, registry) -> None:
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
    run, body = WRITES[write]
    answering(monkeypatch, calls, body)

    await run()

    assert calls, "the write sent nothing"
    assert {payload["answerMessageId"] for payload, _ in calls} == {ANSWER}


@pytest.mark.parametrize(
    ("write", "body"),
    [
        (lambda: run_reply(ANNOTATION, "Ist korrigiert."), REPLY_BODY),
        (lambda: run_reply("4", "Ist korrigiert."), [LIST_BODY, REPLY_BODY]),
        (lambda: run_update(ANNOTATION, "Erledigt.", status="resolved"), UPDATE_BODY),
        (lambda: run_delete(ANNOTATION), DELETE_BODY),
    ],
    ids=["reply by id", "reply by number", "update with its note", "delete"],
)
async def test_a_write_that_speaks_in_the_thread_notes_it(write, body, monkeypatch, calls, registry, thread) -> None:
    answering(monkeypatch, calls, *(body if isinstance(body, list) else [body]))

    await write()

    assert thread.answered


async def test_a_change_that_noted_nothing_leaves_the_thread_unanswered(monkeypatch, calls, registry, thread) -> None:
    answering(monkeypatch, calls, {**UPDATE_BODY, "noted": False})

    await run_update(ANNOTATION, "Erledigt.", status="resolved")

    assert not thread.answered


async def test_a_refused_reply_leaves_the_thread_unanswered(monkeypatch, calls, registry, thread) -> None:
    answering(monkeypatch, calls, CanvasRequestError("gone", status=404))

    await run_reply(ANNOTATION, "Ist korrigiert.")

    assert not thread.answered


async def test_a_reply_in_another_marks_thread_does_not_count(monkeypatch, calls, registry, thread) -> None:
    other = "99999999-0000-4000-8000-000000000009"
    answering(monkeypatch, calls, {**REPLY_BODY, "annotationId": other})

    await run_reply(other, "Anderswo.")

    assert not thread.answered


async def test_leaving_the_canvas_settles_whether_the_thread_may_be_answered(thread) -> None:
    await presence.leave_canvas(presence.current_canvas_presence())

    assert thread.settled and thread.refusal is None


async def test_a_confined_turn_settles_to_no(thread) -> None:
    bind_restricted_use(
        RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id=None, confined=True)
    )

    await presence.leave_canvas(None)

    assert thread.settled and thread.refusal is not None
