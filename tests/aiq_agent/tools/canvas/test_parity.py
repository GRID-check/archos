"""What the person asks for, Piloti does in their name: ``mark`` with ``open``, ``update``, ``delete``.

The BFF decides whether the asker may (``lib/annotations/agent.ts``, the route
spec holds that). What is under test here is this tier's half: what the model
can and cannot send, what it is told back, and what lands on the card, so the
person sees each change with what it was before.
"""

from __future__ import annotations

import pytest

from aiq_agent.tools.canvas import calls as canvas_calls
from aiq_agent.tools.canvas.client import CanvasRequestError
from aiq_agent.tools.canvas.register import run_delete
from aiq_agent.tools.canvas.register import run_mark
from aiq_agent.tools.canvas.register import run_update

from .conftest import ANNOTATION
from .conftest import CREATE_BODY
from .conftest import DELETE_BODY
from .conftest import DOCUMENT
from .conftest import LIST_BODY
from .conftest import NAME
from .conftest import PROPOSAL
from .conftest import PROPOSED
from .conftest import UPDATE_BODY
from .conftest import answering

NOTE = "Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert."


class TestAnOpenMark:
    async def test_it_is_set_not_proposed_and_says_so(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, CREATE_BODY)

        result = await run_mark([PROPOSAL], open=True)

        assert calls[0][0]["op"] == "create"
        assert "Gesetzt" in result and "offen" in result and "VORSCHLÄGE" not in result
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
            ({}, "mindestens eine Änderung"),
            ({"status": "archived"}, "`status`"),
            ({"due_on": "20.10.2026"}, "JJJJ-MM-TT"),
            ({"due_on": "2026-02-30"}, "JJJJ-MM-TT"),
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

        assert "Nr. 4" in result and "offen → erledigt" in result and "– → Anna Berger" in result
        assert "Antwort von Piloti" in result
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

        assert "Nichts geändert" in result
        assert registry.snapshot() == []

    async def test_by_number_it_is_guarded_by_the_status_it_read(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, LIST_BODY, UPDATE_BODY)

        await run_update("#4", NOTE, status="resolved")

        assert [payload["op"] for payload, _ in calls] == ["list", "update"]
        assert calls[1][0]["annotationId"] == ANNOTATION and calls[1][0]["expectedStatus"] == "open"

    @pytest.mark.parametrize(
        ("error", "expected"),
        [
            (CanvasRequestError("x", status=409, code="CONFLICT"), "gerade geändert"),
            (CanvasRequestError("x", status=403, code="FORBIDDEN"), "darf an diesem Dokument nichts ändern"),
            (CanvasRequestError("x", status=404, code="NOT_FOUND"), "Diese Anmerkung gibt es"),
            (
                CanvasRequestError("„Anna“ could be Anna Berger, Anna Kurz.", status=422, reason="assignee-ambiguous"),
                "Anna Berger, Anna Kurz",
            ),
            (CanvasRequestError("Nobody", status=422, reason="assignee-unknown"), "wen sie meint"),
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
        assert "Gelöscht" in result and "Nr. 4" in result and "nicht rückgängig" in result
        [card] = registry.snapshot()
        assert card["items"] == [{"action": "deleted", "number": 4, "body": "Fluchtweg im 1. OG zu lang."}]

    async def test_someone_elses_mark_is_refused_with_the_way_out(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, CanvasRequestError("x", status=403, code="FORBIDDEN"))

        result = await run_delete(ANNOTATION)

        assert "selbst gesetzt" in result and "`resolved`" in result
        assert registry.snapshot() == []
