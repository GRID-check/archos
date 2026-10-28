"""A thread question is answered in its thread (``agent.turn.annotation_reply``).

The record, the decision and the post are driven directly; the canvas tools
marking the record are in ``packages/agent/tests/tools/canvas/test_thread_reply.py``,
and the chat socket calling it at the end of a turn in
``apps/backend/tests/test_chat_socket.py``. The body the fallback builds is
validated against the schema the BFF's route exports, as the tool's own are.
"""

from __future__ import annotations

import contextvars
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

from agent.common.bff_http import SignedEnvelope
from agent.common.wire_v2 import FocusRegion
from agent.common.wire_v2 import RunFinishedBody
from agent.common.wire_v2 import TurnResult
from agent.common.wire_v2 import UserMessage
from agent.knowledge.restricted_use import RestrictedUse
from agent.knowledge.restricted_use import bind_cross_project_turn
from agent.knowledge.restricted_use import bind_restricted_use
from agent.knowledge.restricted_use import reset_cross_project_turn
from agent.knowledge.restricted_use import reset_restricted_use
from agent.observability.langfuse_trace_attributes import begin_trace_contributions
from agent.observability.langfuse_trace_attributes import end_trace_contributions
from agent.observability.langfuse_trace_attributes import snapshot_contributions
from agent.tools.canvas.client import CanvasRequestError
from agent.turn import annotation_reply
from agent.turn.annotation_reply import MAX_REPLY_CHARS
from agent.turn.annotation_reply import ThreadReply
from agent.turn.annotation_reply import bind_thread_reply
from agent.turn.annotation_reply import current_thread_reply
from agent.turn.annotation_reply import fallback_reply_request
from agent.turn.annotation_reply import note_thread_post
from agent.turn.annotation_reply import post_fallback_reply
from agent.turn.annotation_reply import reset_thread_reply
from agent.turn.annotation_reply import settle_thread_reply
from agent.turn.annotation_reply import thread_text

ROOT = Path(__file__).resolve().parents[4]
ANNOTATIONS_SCHEMA = ROOT / "apps" / "workspace" / "tests" / "fixtures" / "document-annotations.schema.json"

ANNOTATION = "33333333-0000-4000-8000-000000000003"
DOCUMENT = "11111111-0000-4000-8000-000000000001"
ANSWER = "55555555-0000-4000-8000-000000000005"
ENVELOPE = SignedEnvelope(header="eyJzaWduZWQiOiJ0dXJuIn0", signature="c0ffee")


def _message(**fields: Any) -> UserMessage:
    return UserMessage(v=2, conversation_id="conv-1", message_id="t1", text="?", **fields)


def _thread_message(annotation_id: str = ANNOTATION) -> UserMessage:
    region = FocusRegion(page=2, x=0.1, y=0.2, w=0.3, h=0.2, annotation_id=annotation_id)
    return _message(focus_region=region, reply_in_thread=True, focus_document_id=DOCUMENT)


def _finished(text: str = "Die Breite reicht nicht [1].", outcome: str = "answered") -> RunFinishedBody:
    return RunFinishedBody(outcome=outcome, result=TurnResult(message_id=ANSWER, text=text))


def _settled(record: ThreadReply | None = None) -> ThreadReply:
    """A record whose turn said a shared write may go out."""
    record = record or ThreadReply.requested_by(_thread_message())
    assert record is not None
    record.settled = True
    return record


@pytest.fixture(autouse=True)
def _nothing_restricted():
    """Nothing restricted and no thread bound, and whatever a test binds is undone: the tests share one context."""
    use = bind_restricted_use(None)
    cross = bind_cross_project_turn(None)
    token = bind_thread_reply(None)
    yield
    reset_thread_reply(token)
    reset_cross_project_turn(cross)
    reset_restricted_use(use)


@pytest.fixture
def posted(monkeypatch) -> list[tuple[dict[str, Any], SignedEnvelope]]:
    made: list[tuple[dict[str, Any], SignedEnvelope]] = []

    def fake(payload: dict[str, Any], envelope: SignedEnvelope, **_: Any) -> dict[str, Any]:
        made.append((payload, envelope))
        return {"documentId": DOCUMENT, "documentName": "x.pdf", "annotationId": ANNOTATION, "number": 4}

    monkeypatch.setattr(annotation_reply, "post_canvas", fake)
    return made


class TestWhichTurnAsks:
    def test_a_thread_question_names_its_mark_and_document(self) -> None:
        record = ThreadReply.requested_by(_thread_message())

        assert record is not None
        assert (record.annotation_id, record.document_id) == (ANNOTATION, DOCUMENT)
        assert not record.answered and not record.settled

    @pytest.mark.parametrize(
        "fields",
        [
            {},
            {"reply_in_thread": True},
            {"focus_region": FocusRegion(page=1, x=0, y=0, w=1, h=1, annotation_id=ANNOTATION)},
            {"focus_region": FocusRegion(page=1, x=0, y=0, w=1, h=1), "reply_in_thread": True},
        ],
    )
    def test_no_other_turn_keeps_a_record(self, fields) -> None:
        assert ThreadReply.requested_by(_message(**fields)) is None


class TestTheDecision:
    def test_an_answered_turn_that_never_replied_posts_its_answer(self, posted) -> None:
        request = fallback_reply_request(_settled(), _finished(), answer_message_id=ANSWER)

        assert request == {
            "op": "reply",
            "annotationId": ANNOTATION,
            "body": "Die Breite reicht nicht.",
            "answerMessageId": ANSWER,
            "documentId": DOCUMENT,
        }

    def test_the_body_is_one_the_route_accepts(self) -> None:
        schema = json.loads(ANNOTATIONS_SCHEMA.read_text(encoding="utf-8"))
        validator = Draft202012Validator(
            {**schema["$defs"]["InternalAnnotationRequest"], "$defs": schema["$defs"]}, format_checker=FormatChecker()
        )
        long_answer = _finished("Absatz. " * 600)

        request = fallback_reply_request(_settled(), long_answer, answer_message_id=ANSWER)

        assert request is not None
        validator.validate(request)

    def test_a_turn_the_tool_already_answered_posts_nothing(self) -> None:
        record = _settled()
        token = bind_thread_reply(record)
        try:
            note_thread_post(ANNOTATION.upper())
        finally:
            reset_thread_reply(token)

        assert record.answered
        assert fallback_reply_request(record, _finished(), answer_message_id=ANSWER) is None

    def test_a_reply_on_another_mark_does_not_count(self) -> None:
        record = _settled()
        token = bind_thread_reply(record)
        try:
            note_thread_post("99999999-0000-4000-8000-000000000009")
        finally:
            reset_thread_reply(token)

        assert fallback_reply_request(record, _finished(), answer_message_id=ANSWER) is not None

    def test_a_turn_that_asked_nothing_posts_nothing(self) -> None:
        assert fallback_reply_request(None, _finished(), answer_message_id=ANSWER) is None

    @pytest.mark.parametrize("outcome", ["cancelled", "refused", "handed_off"])
    def test_only_an_answered_turn_posts(self, outcome) -> None:
        assert fallback_reply_request(_settled(), _finished(outcome=outcome), answer_message_id=ANSWER) is None

    @pytest.mark.parametrize("text", ["", "   ", "[1] [[card:1]]", "[[callout]]\n[2]"])
    def test_an_empty_answer_posts_nothing(self, text) -> None:
        assert fallback_reply_request(_settled(), _finished(text), answer_message_id=ANSWER) is None

    def test_a_record_its_turn_never_settled_posts_nothing(self) -> None:
        record = ThreadReply.requested_by(_thread_message())

        assert fallback_reply_request(record, _finished(), answer_message_id=ANSWER) is None

    @pytest.mark.parametrize("use", [{"confined": True}, {"admitted": {"r_1"}}])
    def test_a_confined_conversation_posts_nothing_where_everyone_reads(self, use) -> None:
        record = ThreadReply.requested_by(_thread_message())
        bind_restricted_use(
            RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id=None, **use)
        )
        token = bind_thread_reply(record)
        try:
            settle_thread_reply()
        finally:
            reset_thread_reply(token)

        assert record.settled and record.refusal is not None
        assert fallback_reply_request(record, _finished(), answer_message_id=ANSWER) is None

    def test_an_open_conversation_settles_to_yes(self) -> None:
        record = ThreadReply.requested_by(_thread_message())
        token = bind_thread_reply(record)
        try:
            settle_thread_reply()
        finally:
            reset_thread_reply(token)

        assert record.settled and record.refusal is None

    def test_a_mark_named_by_something_other_than_an_id_is_not_guessed(self) -> None:
        record = _settled(ThreadReply.requested_by(_thread_message(annotation_id="Nr. 4")))

        assert fallback_reply_request(record, _finished(), answer_message_id=ANSWER) is None


class TestTheText:
    def test_markers_go_and_the_prose_stays(self) -> None:
        text = "Die Tür ist zu schmal [1][2]. Siehe [[card:1]]\n\n\n\nOIB-RL 4 verlangt 0,90 m [3, 4]."

        assert thread_text(text) == "Die Tür ist zu schmal. Siehe\n\nOIB-RL 4 verlangt 0,90 m."

    def test_a_long_answer_is_cut_to_what_the_route_takes(self) -> None:
        cut = thread_text("Wort " * 1000)

        assert len(cut) <= MAX_REPLY_CHARS == 2000
        assert cut.endswith("…")


class TestThePost:
    async def test_it_goes_out_as_the_asker_with_the_envelope_echoed(self, posted) -> None:
        assert await post_fallback_reply(_settled(), _finished(), answer_message_id=ANSWER, envelope=ENVELOPE)

        [(payload, envelope)] = posted
        assert envelope is ENVELOPE
        assert (payload["op"], payload["annotationId"], payload["answerMessageId"]) == ("reply", ANNOTATION, ANSWER)

    async def test_without_an_envelope_nothing_is_sent(self, posted) -> None:
        assert not await post_fallback_reply(_settled(), _finished(), answer_message_id=ANSWER, envelope=None)
        assert posted == []

    @pytest.mark.parametrize("error", [CanvasRequestError("gone", status=404), RuntimeError("boom")])
    async def test_a_refused_or_broken_post_never_raises(self, monkeypatch, error) -> None:
        def failing(*_: Any, **__: Any) -> dict[str, Any]:
            raise error

        monkeypatch.setattr(annotation_reply, "post_canvas", failing)

        assert not await post_fallback_reply(_settled(), _finished(), answer_message_id=ANSWER, envelope=ENVELOPE)


class TestPerTurn:
    def test_a_record_bound_for_one_turn_is_not_the_next_turns(self) -> None:
        first = ThreadReply.requested_by(_thread_message())

        def turn(record: ThreadReply | None) -> ThreadReply | None:
            bind_thread_reply(record)
            note_thread_post(ANNOTATION)
            return current_thread_reply()

        assert contextvars.copy_context().run(turn, first) is first
        assert first is not None and first.answered
        # The turn's binding died with its context, and the next turn binds its own.
        assert current_thread_reply() is None
        second = ThreadReply.requested_by(_thread_message())
        assert contextvars.copy_context().run(turn, None) is None
        assert second is not None and not second.answered

    def test_marking_outside_a_thread_turn_is_a_no_op(self) -> None:
        note_thread_post(ANNOTATION)
        settle_thread_reply()

        assert current_thread_reply() is None


class TestOnTheTrace:
    """How often the model skips ``canvas__reply`` is the cause the fallback papers over: it stays measurable."""

    @pytest.mark.parametrize(
        ("replied", "confined", "verdict"),
        [(True, False, "replied"), (False, False, "skipped"), (False, True, "skipped_withheld")],
    )
    def test_settling_records_whether_the_model_answered_in_the_thread(self, replied, confined, verdict) -> None:
        record = ThreadReply.requested_by(_thread_message())
        if confined:
            bind_restricted_use(
                RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id=None, confined=True)
            )
        contributions = begin_trace_contributions()
        token = bind_thread_reply(record)
        try:
            if replied:
                note_thread_post(ANNOTATION)
            settle_thread_reply()
            snapshot = snapshot_contributions()
        finally:
            reset_thread_reply(token)
            end_trace_contributions(contributions)

        assert snapshot is not None
        assert snapshot["metadata"]["thread_reply"] == verdict

    @pytest.mark.parametrize(
        ("replied", "confined", "scores"),
        [
            (True, False, {"thread-answered-in-place": 1.0}),
            (False, False, {"thread-answered-in-place": 0.0}),
            (False, True, {}),
        ],
    )
    def test_settling_scores_whether_the_model_answered_in_the_thread(
        self, monkeypatch, replied, confined, scores
    ) -> None:
        sent: list[tuple[str, float]] = []
        monkeypatch.setattr(
            annotation_reply,
            "emit_scores",
            lambda batch, *, writer, trace_id=None: sent.extend((score.name, score.value) for score in batch),
        )
        record = ThreadReply.requested_by(_thread_message())
        if confined:
            bind_restricted_use(
                RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id=None, confined=True)
            )
        token = bind_thread_reply(record)
        try:
            if replied:
                note_thread_post(ANNOTATION)
            settle_thread_reply()
        finally:
            reset_thread_reply(token)

        assert dict(sent) == scores

    def test_a_turn_that_asked_nothing_in_a_thread_scores_nothing(self, monkeypatch) -> None:
        sent: list[object] = []
        monkeypatch.setattr(annotation_reply, "emit_scores", lambda batch, **_: sent.extend(batch))

        settle_thread_reply()

        assert sent == []
