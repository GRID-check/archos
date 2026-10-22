"""The steering inbox and the request splice (``common/steering.py``), each half on its own.

The graph-level proof (a note read in the next round, a write held back) is
``tests/aiq_agent/agents/piloti/test_steering_turn.py``; this pins the pure
pieces both nodes rely on.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage

from aiq_agent.common.steering import MAX_STEERS_PER_TURN
from aiq_agent.common.steering import AppliedSteer
from aiq_agent.common.steering import SteerInbox
from aiq_agent.common.steering import SteerNote
from aiq_agent.common.steering import current_steer_inbox
from aiq_agent.common.steering import is_write_call
from aiq_agent.common.steering import render_note
from aiq_agent.common.steering import with_steering
from aiq_agent.common.wire_v2 import FocusRegion


def _note(steer_id: str, text: str = "die Treppe") -> SteerNote:
    return SteerNote(steer_id=steer_id, text=text)


class TestTheInbox:
    def test_a_note_is_taken_once_and_counted_as_applied(self):
        inbox = SteerInbox()

        assert inbox.offer(_note("a")) == "received"
        assert inbox.has_pending()
        assert [note.steer_id for note in inbox.take()] == ["a"]
        assert not inbox.has_pending()
        assert inbox.take() == []
        assert [note.steer_id for note in inbox.applied] == ["a"]

    def test_a_resent_steer_id_is_a_duplicate_even_after_it_was_read(self):
        inbox = SteerInbox()
        inbox.offer(_note("a"))
        inbox.take()

        assert inbox.offer(_note("a")) == "duplicate"
        assert not inbox.has_pending()
        assert inbox.received == 1

    def test_the_cap_refuses_the_note_past_it(self):
        inbox = SteerInbox()
        for index in range(MAX_STEERS_PER_TURN):
            assert inbox.offer(_note(f"s{index}")) == "received"

        assert inbox.offer(_note("one-too-many")) == "limit"
        assert inbox.received == MAX_STEERS_PER_TURN

    def test_nothing_is_bound_outside_a_socket(self):
        assert current_steer_inbox() is None


class TestTheSplice:
    def _request(self) -> list:
        return [
            SystemMessage(content="sys"),
            HumanMessage(content="Frage"),
            AIMessage(content="", tool_calls=[{"name": "look", "args": {}, "id": "l"}]),
            ToolMessage(content="Seite", tool_call_id="l"),
        ]

    def test_a_note_sits_after_the_messages_that_existed_when_it_arrived(self):
        applied = [AppliedSteer(steer_id="a", content="NOTE", at=3, round=2)]

        spliced = with_steering(self._request(), applied)

        assert [getattr(m, "content", None) for m in spliced][-1] == "NOTE"
        assert spliced[:4] == self._request()

    def test_a_later_round_keeps_the_note_where_it_was(self):
        applied = [AppliedSteer(steer_id="a", content="NOTE", at=1, round=1)]
        later = [*self._request(), AIMessage(content="Antwort")]

        spliced = with_steering(later, applied)

        assert [m.content for m in spliced[:3]] == ["sys", "Frage", "NOTE"]
        assert spliced[3:] == later[2:]

    def test_notes_at_one_index_keep_the_order_they_were_taken_in(self):
        applied = [
            AppliedSteer(steer_id="a", content="erste", at=3, round=2),
            AppliedSteer(steer_id="b", content="zweite", at=3, round=2),
        ]

        spliced = with_steering(self._request(), applied)

        assert [m.content for m in spliced[-2:]] == ["erste", "zweite"]

    def test_without_notes_the_request_is_unchanged(self):
        request = self._request()

        assert with_steering(request, []) == request


class TestWhatTheModelReads:
    def test_the_note_says_who_when_and_where(self):
        region = FocusRegion(page=3, x=0.41, y=0.22, w=0.17, h=0.18)
        note = SteerNote(steer_id="a", text="  nicht die Tür, die Treppe ", author="Anna", focus_region=region)

        rendered = render_note(note, 3)

        assert rendered.startswith('<user_update author="Anna" during="round 3">\nnicht die Tür, die Treppe\n')
        assert "[Region: p. 3, x 0.41–0.58, y 0.22–0.40]" in rendered
        assert "takes precedence over the" in rendered

    def test_writes_are_told_apart_from_reads_by_basename(self):
        assert is_write_call({"name": "canvas__mark"})
        assert is_write_call({"name": "canvas__reply"})
        assert is_write_call({"name": "file_draft"})
        assert is_write_call({"name": "propose_file_change"})
        assert not is_write_call({"name": "look"})
        assert not is_write_call({"name": "canvas__marks"})
        assert not is_write_call({"name": "knowledge_search"})
        assert not is_write_call({})
