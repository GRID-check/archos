"""What the person asks for, Piloti does in their name: ``mark`` with ``open``, ``update``, ``delete``.

The BFF decides whether the asker may (``lib/annotations/agent.ts``, the route
spec holds that). What is under test here is this tier's half: what the model
can and cannot send, what it is told back, and what lands on the card, so the
person sees each change with what it was before.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from aiq_agent.tools.canvas import calls as canvas_calls
from aiq_agent.tools.canvas import client as canvas_client
from aiq_agent.tools.canvas.client import CanvasRequestError
from aiq_agent.tools.canvas.register import DESCRIPTIONS
from aiq_agent.tools.canvas.register import run_delete
from aiq_agent.tools.canvas.register import run_mark
from aiq_agent.tools.canvas.register import run_reply
from aiq_agent.tools.canvas.register import run_update
from aiq_agent.turn.annotation_reply import ThreadReply
from aiq_agent.turn.annotation_reply import bind_thread_reply
from aiq_agent.turn.annotation_reply import reset_thread_reply

from .conftest import ANNOTATION
from .conftest import CREATE_BODY
from .conftest import DELETE_BODY
from .conftest import DOCUMENT
from .conftest import LIST_BODY
from .conftest import NAME
from .conftest import PROPOSAL
from .conftest import PROPOSE_BODY
from .conftest import PROPOSED
from .conftest import REPLY_BODY
from .conftest import UPDATE_BODY
from .conftest import answering

NOTE = "Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert."


class TestAnOpenMark:
    async def test_it_is_set_not_proposed_and_says_so(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, CREATE_BODY)

        result = await run_mark([PROPOSAL], open=True)

        assert calls[0][0]["op"] == "create"
        assert "Set:" in result and "open" in result and "PROPOSALS" not in result
        [card] = registry.snapshot()
        assert card["items"][0]["action"] == "created"
        assert card["items"][0]["annotation_id"] == PROPOSED

    async def test_without_open_it_stays_a_proposal(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, {**CREATE_BODY, "proposed": CREATE_BODY["created"]})

        await run_mark([PROPOSAL])

        assert calls[0][0]["op"] == "propose"
        assert registry.snapshot()[0]["items"][0]["action"] == "proposed"


class TestAnUpdate:
    async def test_it_sends_only_what_changes_and_the_note(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, UPDATE_BODY)

        await run_update(ANNOTATION, NOTE, status="erledigt", assignee="Anna Berger", due_on="-")

        payload = calls[0][0]
        assert payload["op"] == "update" and payload["annotationId"] == ANNOTATION
        assert payload["status"] == "resolved" and payload["assignee"] == "Anna Berger"
        assert payload["dueOn"] is None and payload["note"] == NOTE
        assert "kind" not in payload and "body" not in payload

    @pytest.mark.parametrize(
        ("change", "expected"),
        [
            ({"note": "  "}, "`note`"),
            ({}, "at least one change"),
            ({"status": "archived"}, "`status`"),
            ({"due_on": "20.10.2026"}, "YYYY-MM-DD"),
            ({"due_on": "2026-02-30"}, "YYYY-MM-DD"),
            ({"kind": "remark"}, "`kind`"),
        ],
    )
    async def test_a_bad_change_is_refused_before_anything_is_sent(self, monkeypatch, calls, change, expected):
        answering(monkeypatch, calls, UPDATE_BODY)
        arguments = {"note": NOTE, **change}

        result = await run_update(ANNOTATION, **arguments)

        assert calls == [] and expected in result

    async def test_it_reports_before_and_after_and_the_note_in_the_thread(self, monkeypatch, calls, registry):
        answering(monkeypatch, calls, UPDATE_BODY)

        result = await run_update(ANNOTATION, NOTE, status="resolved", assignee="Anna Berger")

        assert "no. 4" in result and "open → resolved" in result and "– → Anna Berger" in result
        assert "reply from Piloti" in result
        [card] = registry.snapshot()
        assert card["document"] == {"id": DOCUMENT, "name": NAME}
        assert card["items"] == [
            {
                "action": "changed",
                "annotation_id": ANNOTATION,
                "number": 4,
                "status": "resolved",
                "changes": [
                    {"field": "status", "before": "open", "after": "resolved"},
                    {"field": "assignee", "after": "user_anna", "after_label": "Anna Berger"},
                ],
                "note": NOTE,
            }
        ]

    async def test_a_change_that_moved_nothing_puts_nothing_on_the_card(self, monkeypatch, calls, registry):
        answering(monkeypatch, calls, {**UPDATE_BODY, "before": {}, "after": {}, "noted": False})

        result = await run_update(ANNOTATION, NOTE, status="resolved")

        assert "Nothing changed" in result
        assert registry.snapshot() == []

    async def test_by_number_it_is_guarded_by_the_status_it_read(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, LIST_BODY, UPDATE_BODY)

        await run_update("#4", NOTE, status="resolved")

        assert [payload["op"] for payload, _ in calls] == ["list", "update"]
        assert calls[1][0]["annotationId"] == ANNOTATION and calls[1][0]["expectedStatus"] == "open"

    @pytest.mark.parametrize(
        ("error", "expected"),
        [
            (CanvasRequestError("x", status=409, code="CONFLICT"), "just changed"),
            (CanvasRequestError("x", status=403, code="FORBIDDEN"), "may not change anything on this document"),
            (CanvasRequestError("x", status=404, code="NOT_FOUND"), "This annotation does not exist"),
            (
                CanvasRequestError("„Anna“ could be Anna Berger, Anna Kurz.", status=422, reason="assignee-ambiguous"),
                "Anna Berger, Anna Kurz",
            ),
            (CanvasRequestError("Nobody", status=422, reason="assignee-unknown"), "whom they mean"),
        ],
    )
    async def test_each_refusal_is_a_sentence_and_lands_nothing(self, monkeypatch, calls, registry, error, expected):
        answering(monkeypatch, calls, error)

        result = await run_update(ANNOTATION, NOTE, status="resolved", assignee="Anna")

        assert expected in result
        assert registry.snapshot() == []

    async def test_the_trace_records_which_fields_never_the_text(self, monkeypatch, calls, registry) -> None:
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(canvas_calls, "add_trace_tag", lambda tag: None)
        monkeypatch.setattr(canvas_calls, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, UPDATE_BODY)

        await run_update(ANNOTATION, NOTE, status="resolved", assignee="Anna Berger")

        name, request, outcome = spans[0]
        assert name == "canvas.update"
        assert request == {"fields": ["assignee", "status"]}
        assert outcome["noted"] is True and outcome["status"] == "resolved"
        assert "Breite" not in str(spans) and "Anna" not in str(spans)


class TestADelete:
    async def test_it_says_what_went_and_puts_it_on_the_card(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, DELETE_BODY)

        result = await run_delete(ANNOTATION)

        assert calls[0][0]["op"] == "delete"
        assert "Deleted" in result and "no. 4" in result and "cannot be undone" in result
        [card] = registry.snapshot()
        assert card["items"] == [{"action": "deleted", "number": 4, "body": "Fluchtweg im 1. OG zu lang."}]

    async def test_someone_elses_mark_is_refused_with_the_way_out(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, CanvasRequestError("x", status=403, code="FORBIDDEN"))

        result = await run_delete(ANNOTATION)

        assert "set themselves" in result and "`resolved`" in result
        assert registry.snapshot() == []


#: What the BFF answers while the organization has Piloti propose only (``PilotiActsOffError``, ``agent.ts``).
def _acts_off() -> CanvasRequestError:
    return CanvasRequestError(
        "This organization has Piloti propose only.", status=403, code="PILOTI_ACTS_OFF", reason="piloti-acts-off"
    )


class TestAnOfficeThatHasPilotiProposeOnly:
    """``piloti-acts`` off: the BFF refuses what Piloti would apply, and the model is told what to do instead."""

    async def test_an_open_mark_is_refused_with_the_way_to_propose_it(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, _acts_off())

        result = await run_mark([PROPOSAL], open=True)

        assert result.startswith("Not set")
        assert "only propose" in result and "`mark` without `open`" in result and "take it over" in result
        assert registry.snapshot() == []

    async def test_the_proposal_it_asks_for_goes_through(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, _acts_off(), PROPOSE_BODY)

        await run_mark([PROPOSAL], open=True)
        result = await run_mark([PROPOSAL])

        assert [payload["op"] for payload, _ in calls] == ["create", "propose"]
        assert "PROPOSALS" in result
        assert registry.snapshot()[0]["items"][0]["action"] == "proposed"

    @pytest.mark.parametrize(
        "run",
        [
            lambda: run_update(ANNOTATION, NOTE, status="resolved"),
            lambda: run_update(ANNOTATION, "Übernommen.", status="open"),
            lambda: run_delete(ANNOTATION),
        ],
        ids=["resolve", "take over", "delete"],
    )
    async def test_a_change_is_refused_and_left_to_the_person(self, monkeypatch, calls, registry, run) -> None:
        answering(monkeypatch, calls, _acts_off())

        result = await run()

        assert result.startswith("Not changed")
        assert "only propose" in result and "themselves" in result and "do not retry" in result
        # Not the missing-permission sentence: the person may well do it, Piloti may not do it for them.
        assert "may not change anything on this document" not in result and "set themselves" not in result
        assert registry.snapshot() == []

    async def test_a_refused_change_leaves_the_thread_to_the_answer(self, monkeypatch, calls, registry) -> None:
        record = ThreadReply(annotation_id=ANNOTATION, document_id=DOCUMENT)
        token = bind_thread_reply(record)
        try:
            answering(monkeypatch, calls, _acts_off())
            await run_update(ANNOTATION, NOTE, status="resolved")
        finally:
            reset_thread_reply(token)

        # Nothing was said in the thread, so the turn's answer still goes there.
        assert record.posted == set()

    async def test_a_reply_is_not_an_act(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, REPLY_BODY)

        result = await run_reply(ANNOTATION, "Steht im Schnitt B-B.")

        assert "reply" in result and calls[0][0]["op"] == "reply"

    async def test_the_refusal_is_recorded_by_its_own_code(self, monkeypatch, calls, registry) -> None:
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(canvas_calls, "add_trace_tag", lambda tag: None)
        monkeypatch.setattr(canvas_calls, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, _acts_off())

        await run_delete(ANNOTATION)

        assert spans == [("canvas.delete", {"step": "delete"}, {"refused": "piloti_acts_off"})]

    def test_the_bff_envelope_is_read_into_the_reason(self) -> None:
        body = {
            "error": "This organization has Piloti propose only.",
            "code": "PILOTI_ACTS_OFF",
            "details": {"reason": "piloti-acts-off", "op": "update"},
        }
        exc = urllib.error.HTTPError("http://frontend/api", 403, "Forbidden", {}, io.BytesIO(json.dumps(body).encode()))

        refusal = canvas_client._refusal(exc)

        assert (refusal.status, refusal.code, refusal.reason) == (403, "PILOTI_ACTS_OFF", "piloti-acts-off")

    @pytest.mark.parametrize("tool", ["mark", "update", "delete"])
    def test_each_acting_tool_says_so_in_its_description(self, tool) -> None:
        assert "only propose" in DESCRIPTIONS[tool]


def test_a_check_of_what_is_fixed_is_answered_in_each_thread_and_changes_no_status() -> None:
    """„Piloti prüfen lassen, was behoben ist“: a verdict per mark, in its thread; closing it stays the person's."""
    assert "check whether something is fixed asks for no change" in DESCRIPTIONS["update"]
    reply = DESCRIPTIONS["reply"]
    assert "„In <Fassung> behoben:“" in reply
    assert "„Weiterhin offen:“" in reply
    assert "You do not change the status in doing so" in reply
