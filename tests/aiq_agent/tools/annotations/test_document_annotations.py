"""``document_annotations``: what it refuses, what it says, and what it never claims.

The HTTP call is the only thing faked (``conftest.answering``). What is under
test is the seam: the signed bytes leave unchanged, a run with no envelope
sends nothing, the BFF's refusals reach the model as sentences it can relay, a
list reads as text a model can cite by number, and a proposal is never
reported as a finding that was recorded.
"""

from __future__ import annotations

import pytest

from aiq_agent import project_context
from aiq_agent.tools.annotations import register as annotations
from aiq_agent.tools.annotations.client import AnnotationRequestError
from aiq_agent.tools.annotations.register import run_document_annotations

from .conftest import ANNOTATION
from .conftest import HEADER
from .conftest import LIST_BODY
from .conftest import PROPOSAL
from .conftest import PROPOSE_BODY
from .conftest import REPLY_BODY
from .conftest import SIGNATURE
from .conftest import answering
from .conftest import listed


class TestWhoItActsAs:
    async def test_it_echoes_the_envelope_unchanged(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)
        await run_document_annotations("list")

        envelope = calls[0][1]
        assert (envelope.header, envelope.signature) == (HEADER, SIGNATURE)

    async def test_a_run_with_no_envelope_sends_nothing_and_says_so(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_document_annotations("propose", proposals=[PROPOSAL])

        assert calls == []
        assert result.startswith("Fehler:") and "Sitzungsnachweis" in result

    async def test_a_run_with_no_conversation_names_no_answer(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: None)
        answering(monkeypatch, calls, LIST_BODY)
        await run_document_annotations("list")

        assert "answerMessageId" not in calls[0][0]


class TestRefusals:
    @pytest.mark.parametrize(
        ("error", "operation", "expected"),
        [
            (
                AnnotationRequestError("x", status=422, code="UNPROCESSABLE", reason="no-document-subject"),
                "list",
                "keinem Dokument",
            ),
            (AnnotationRequestError("x", status=403, code="FORBIDDEN"), "propose", "Nicht möglich"),
            (AnnotationRequestError("x", status=404, code="NOT_FOUND"), "reply", "Diese Anmerkung gibt es"),
            (AnnotationRequestError("x", status=404, code="NOT_FOUND"), "list", "Das Dokument dieses Chats"),
            (AnnotationRequestError("x", status=409, code="CONFLICT"), "reply", "gerade geändert"),
            (AnnotationRequestError("Too long", status=400, code="BAD_REQUEST"), "propose", "Too long"),
            (AnnotationRequestError("x", status=422, code="UNPROCESSABLE"), "propose", "Korrigiere"),
            (AnnotationRequestError("x", status=500), "list", "nicht erreichbar"),
            (AnnotationRequestError("the annotations route could not be reached"), "list", "nicht erreichbar"),
        ],
    )
    async def test_each_refusal_is_a_sentence_the_model_can_relay(
        self, monkeypatch, calls, error, operation, expected
    ) -> None:
        answering(monkeypatch, calls, error)
        arguments = {
            "list": {},
            "propose": {"proposals": [PROPOSAL]},
            "reply": {"annotation": ANNOTATION, "body": "Erledigt."},
        }[operation]

        result = await run_document_annotations(operation, **arguments)

        assert expected in result

    async def test_no_document_subject_wins_over_the_status(self, monkeypatch, calls) -> None:
        """The reason is what tells „open the document first“ from a malformed request."""
        answering(monkeypatch, calls, AnnotationRequestError("x", status=422, reason="no-document-subject"))

        result = await run_document_annotations("propose", proposals=[PROPOSAL])

        assert "Dokument öffnen" in result and "Korrigiere" not in result

    @pytest.mark.parametrize(
        ("change", "expected"),
        [
            ({"x": 120.0}, "keine Pixel"),
            ({"page": 0}, "ab 1"),
            ({"w": None}, "`w` und `h`"),
            ({"x": 0.9, "w": 0.5}, "über die Seite"),
            ({"body": "   "}, "`body`"),
            ({"kind": "remark"}, "ungültig"),
        ],
    )
    async def test_a_bad_proposal_is_refused_before_anything_is_sent(
        self, monkeypatch, calls, change, expected
    ) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_document_annotations("propose", proposals=[{**PROPOSAL, **change}])

        assert calls == [] and expected in result

    async def test_too_many_proposals_are_refused(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_document_annotations("propose", proposals=[PROPOSAL] * 21)

        assert calls == [] and "Höchstens 20" in result

    async def test_an_unknown_operation_is_refused(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_document_annotations("delete")

        assert calls == [] and "`operation`" in result


class TestWhatItSays:
    async def test_a_list_reads_as_text_a_model_can_cite(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_document_annotations("list")

        for expected in (
            "Nr. 4",
            "S. 2",
            "Mangel",
            "offen",
            "Martin Huber",
            "Fluchtweg im 1. OG zu lang.",
            "Grundlage: OIB-RL 2, Pkt. 5.1.1",
            "Zuständig: Anna Berger, fällig 2026-10-20",
            "Anna Berger: Prüfe ich.",
            "Bereich x 0.10–0.35, y 0.20–0.40",
            f"id {ANNOTATION}",
        ):
            assert expected in result, expected

    async def test_live_marks_come_first_and_proposals_say_nobody_took_them_over(self, monkeypatch, calls) -> None:
        body = {
            "documentId": "d",
            "annotations": [
                listed(id="a", number=1, page=1, status="resolved"),
                listed(id="b", number=2, page=3, status="proposed", authorKind="piloti", shape="point"),
            ],
        }
        answering(monkeypatch, calls, body)

        result = await run_document_annotations("list")

        assert result.index("Nr. 2") < result.index("Nr. 1")
        assert "Vorschlag, noch nicht übernommen" in result and "von Piloti, für Martin Huber" in result
        assert "Punkt x 0.10, y 0.20" in result

    async def test_an_older_fassung_is_named(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, {"documentId": "d", "annotations": [listed(onCurrentFassung=False)]})

        assert "früheren Fassung" in await run_document_annotations("list")

    async def test_an_empty_document_says_so(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, {"documentId": "d", "annotations": []})

        assert "noch keine Anmerkungen" in await run_document_annotations("list")

    async def test_a_proposal_is_never_reported_as_recorded(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_document_annotations("propose", proposals=[PROPOSAL])

        assert "Nr. 5 auf S. 1" in result
        assert "VORSCHLÄGE" in result and "NOCH NICHTS bestätigt" in result
        assert "übernimmt oder verwirft" in result

    async def test_a_reply_by_number_looks_the_id_up_first(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY, REPLY_BODY)

        result = await run_document_annotations("reply", annotation="Nr. 4", body="Ist korrigiert.")

        assert [payload["op"] for payload, _ in calls] == ["list", "reply"]
        assert calls[1][0]["annotationId"] == ANNOTATION
        assert "Anmerkung Nr. 4" in result

    async def test_a_reply_to_a_number_the_document_lacks_is_refused(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_document_annotations("reply", annotation="9", body="Ist korrigiert.")

        assert [payload["op"] for payload, _ in calls] == ["list"]
        assert "Diese Anmerkung gibt es" in result


class TestObservability:
    async def test_every_call_tags_the_turn_and_records_counts_not_text(self, monkeypatch, calls) -> None:
        tags: list[str] = []
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(annotations, "add_trace_tag", tags.append)
        monkeypatch.setattr(annotations, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, LIST_BODY)

        await run_document_annotations("list")

        assert tags == ["feature:annotations"]
        name, _, outcome = spans[0]
        assert name == "annotate.list"
        assert outcome == {"document": LIST_BODY["documentId"], "annotations": 1, "live": 1, "by_kind": {"defect": 1}}
        assert "Fluchtweg" not in str(spans)

    async def test_a_refusal_is_recorded_by_its_code(self, monkeypatch, calls) -> None:
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(annotations, "add_trace_tag", lambda tag: None)
        monkeypatch.setattr(annotations, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, AnnotationRequestError("x", status=422, reason="no-document-subject"))

        await run_document_annotations("list")

        assert spans[0][2] == {"refused": "no_document_subject"}
