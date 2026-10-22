"""``room``, ``point``, ``highlight``, and leaving at the end of the turn."""

from __future__ import annotations

import pytest

from aiq_agent.tools.canvas import presence
from aiq_agent.tools.canvas.register import run_highlight
from aiq_agent.tools.canvas.register import run_point
from aiq_agent.tools.canvas.register import run_room

from .conftest import DOCUMENT
from .conftest import OK_BODY
from .conftest import ROOM_BODY
from .conftest import answering


class TestTheRoom:
    async def test_it_says_who_is_where_in_words_a_model_resolves_here_against(self, monkeypatch, calls):
        answering(monkeypatch, calls, ROOM_BODY)

        result = await run_room()

        assert calls[0][0]["op"] == "room"
        for expected in (
            "Anna Berger (Person): is viewing p. 2, about 35 % down",
            "has selected annotation no. 4",
            "is drawing a frame: p. 2, x 0.30–0.40, y 0.50–0.60",
            "- Martin Huber (Person)\n",
            "5 open, 2 proposals",
        ):
            assert expected in result, expected

    async def test_an_empty_room_says_so(self, monkeypatch, calls):
        answering(monkeypatch, calls, {**ROOM_BODY, "peers": []})

        assert "Nobody has it open right now" in await run_room()

    async def test_the_room_op_names_the_answer_this_turn_writes(self, monkeypatch, calls):
        """The BFF admits the document against the conversation's audience, and marks the answer."""
        answering(monkeypatch, calls, ROOM_BODY)

        await run_room()

        assert "answerMessageId" in calls[0][0]


class TestPointingAndHighlighting:
    async def test_a_point_moves_the_cursor_and_the_turn_remembers_to_leave(self, monkeypatch, calls):
        answering(monkeypatch, calls, OK_BODY)

        result = await run_point(2, 0.4, 0.5, "Hier")

        sent = {key: value for key, value in calls[0][0].items() if key != "answerMessageId"}
        assert sent == {"op": "point", "page": 2, "x": 0.4, "y": 0.5, "label": "Hier"}
        assert "p. 2" in result
        assert presence.current_canvas_presence().documents == {presence.SUBJECT}

    async def test_a_highlight_carries_its_label_and_is_clamped_onto_the_page(self, monkeypatch, calls):
        answering(monkeypatch, calls, OK_BODY)

        await run_highlight(1, 0.9, 0.2, 0.11, 0.1, "Hier: Fluchtweg 1,10 m")

        sent = {key: value for key, value in calls[0][0].items() if key != "answerMessageId"}
        assert sent == {
            "op": "highlight",
            "page": 1,
            "x": 0.9,
            "y": 0.2,
            "w": 0.1,
            "h": 0.1,
            "label": "Hier: Fluchtweg 1,10 m",
        }

    @pytest.mark.parametrize(
        ("arguments", "expected"),
        [
            ((0, 0.1, 0.1, 0.1, 0.1, "x"), "from 1"),
            ((1, 120, 0.1, 0.1, 0.1, "x"), "not pixels"),
            ((1, 0.1, 0.1, 0.0, 0.1, "x"), "greater than 0"),
            ((1, 0.8, 0.1, 0.5, 0.1, "x"), "beyond the page"),
            ((1, 0.1, 0.1, 0.1, 0.1, "  "), "`label`"),
            ((1, 0.1, 0.1, 0.1, 0.1, "x" * 121), "at most 120"),
        ],
    )
    async def test_a_bad_highlight_is_refused_before_anything_is_sent(self, monkeypatch, calls, arguments, expected):
        answering(monkeypatch, calls, OK_BODY)

        result = await run_highlight(*arguments)

        assert calls == [] and expected in result

    async def test_the_turn_leaves_every_document_it_appeared_on(self, monkeypatch, calls, lookups):
        answering(monkeypatch, calls, OK_BODY)

        await run_point(1, 0.5, 0.5)
        await run_highlight(1, 0.1, 0.1, 0.2, 0.2, "Hier", document="Grundriss_OG.pdf")
        await presence.leave_canvas(presence.current_canvas_presence())

        leaves = [payload for payload, _ in calls if payload["op"] == "leave"]
        assert {"op": "leave"} in leaves, leaves
        assert any(payload.get("documentId") for payload in leaves)
        assert presence.current_canvas_presence().documents == set()

    async def test_a_turn_that_never_pointed_sends_no_leave(self, monkeypatch, calls):
        answering(monkeypatch, calls, OK_BODY)

        await presence.leave_canvas(presence.current_canvas_presence())

        assert calls == []

    async def test_leaving_never_raises(self, monkeypatch, calls):
        def broken(*_args, **_kwargs):
            raise RuntimeError("socket gone")

        monkeypatch.setattr(presence, "post_canvas", broken)
        presence.note_presence(DOCUMENT)

        await presence.leave_canvas(presence.current_canvas_presence())
