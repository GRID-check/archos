"""``marks``, ``mark``, ``reply``: what they refuse, what they say, and what they never claim.

The HTTP call is the only thing faked (``conftest.answering``). What is under
test is the seam: the signed bytes leave unchanged, a run with no envelope
sends nothing, the BFF's refusals reach the model as sentences it can relay, a
list reads as text a model can cite by number, a proposal is never reported as
a finding that was recorded, and what the BFF confirmed lands on the card.
"""

from __future__ import annotations

import pytest
from agent_testing.canvas import ANNOTATION
from agent_testing.canvas import DOCUMENT
from agent_testing.canvas import HEADER
from agent_testing.canvas import LIST_BODY
from agent_testing.canvas import NAME
from agent_testing.canvas import PROPOSAL
from agent_testing.canvas import PROPOSE_BODY
from agent_testing.canvas import PROPOSED
from agent_testing.canvas import REPLY_BODY
from agent_testing.canvas import SIGNATURE
from agent_testing.canvas import answering
from agent_testing.canvas import listed

from agent import project_context
from agent.tools.canvas import calls as canvas_calls
from agent.tools.canvas.client import CanvasRequestError
from agent.tools.canvas.register import run_mark
from agent.tools.canvas.register import run_marks
from agent.tools.canvas.register import run_reply


class TestWhoItActsAs:
    async def test_it_echoes_the_envelope_unchanged(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)
        await run_marks()

        envelope = calls[0][1]
        assert (envelope.header, envelope.signature) == (HEADER, SIGNATURE)

    async def test_a_run_with_no_envelope_sends_nothing_and_says_so(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_mark([PROPOSAL])

        assert calls == []
        assert result.startswith("Error:") and "signed session credential" in result

    async def test_a_run_with_no_conversation_names_no_answer(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: None)
        answering(monkeypatch, calls, LIST_BODY)
        await run_marks()

        assert "answerMessageId" not in calls[0][0]


class TestRefusals:
    @pytest.mark.parametrize(
        ("error", "tool", "expected"),
        [
            (
                CanvasRequestError("x", status=422, code="UNPROCESSABLE", reason="no-document-subject"),
                "marks",
                "Name it in `document`",
            ),
            (CanvasRequestError("x", status=403, code="FORBIDDEN"), "mark", "Not possible"),
            (CanvasRequestError("x", status=404, code="NOT_FOUND"), "reply", "This annotation does not exist"),
            (CanvasRequestError("x", status=404, code="NOT_FOUND"), "marks", "This document does not exist"),
            (CanvasRequestError("x", status=409, code="CONFLICT"), "reply", "just changed"),
            (CanvasRequestError("Too long", status=400, code="BAD_REQUEST"), "mark", "Too long"),
            (CanvasRequestError("x", status=422, code="UNPROCESSABLE"), "mark", "Correct the arguments"),
            (CanvasRequestError("x", status=500), "marks", "not reachable"),
            (CanvasRequestError("the canvas route could not be reached"), "marks", "not reachable"),
        ],
    )
    async def test_each_refusal_is_a_sentence_the_model_can_relay(self, monkeypatch, calls, error, tool, expected):
        answering(monkeypatch, calls, error)
        run = {
            "marks": lambda: run_marks(),
            "mark": lambda: run_mark([PROPOSAL]),
            "reply": lambda: run_reply(ANNOTATION, "Erledigt."),
        }[tool]

        assert expected in await run()

    @pytest.mark.parametrize("reason", ["mark-discussed", "mark-carried"])
    def test_a_kept_mark_is_said_as_kept_not_as_a_race(self, reason) -> None:
        """A delete the thread or a carry refuses is a 409 too, but rereading would not change it."""
        refused = canvas_calls.refusal_for(
            CanvasRequestError("x", status=409, code="CONFLICT", reason=reason), "delete"
        )

        assert "Not deleted" in str(refused) and "just changed" not in str(refused)

    async def test_no_document_subject_wins_over_the_status(self, monkeypatch, calls) -> None:
        """The reason is what tells „name the document“ from a malformed request."""
        answering(monkeypatch, calls, CanvasRequestError("x", status=422, reason="no-document-subject"))

        result = await run_mark([PROPOSAL])

        assert "`document`" in result and "Correct the arguments" not in result

    @pytest.mark.parametrize(
        ("change", "expected"),
        [
            ({"x": 120.0}, "not pixels"),
            ({"page": 0}, "from 1"),
            ({"w": None}, "`w` and `h`"),
            ({"x": 0.9, "w": 0.5}, "beyond the page"),
            ({"body": "   "}, "`body`"),
            ({"kind": "remark"}, "invalid"),
            ({"page": None}, "on a sketch `element_ids`"),
            ({"element_ids": [" "]}, "`element_ids` names 1 to 20"),
            ({"element_ids": [f"el-{n}" for n in range(21)]}, "`element_ids` names 1 to 20"),
        ],
    )
    async def test_a_bad_proposal_is_refused_before_anything_is_sent(self, monkeypatch, calls, change, expected):
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_mark([{**PROPOSAL, **change}])

        assert calls == [] and expected in result

    async def test_too_many_proposals_are_refused(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_mark([PROPOSAL] * 21)

        assert calls == [] and "At most 20" in result


class TestWhatItSays:
    async def test_a_list_reads_as_text_a_model_can_cite(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_marks()

        for expected in (
            f"„{NAME}“",
            "No. 4",
            "p. 2",
            "defect",
            "open",
            "Martin Huber",
            "Fluchtweg im 1. OG zu lang.",
            "Basis: OIB-RL 2, Pkt. 5.1.1",
            "Assignee: Anna Berger, due 2026-10-20",
            "Anna Berger: Prüfe ich.",
            "region x 0.10–0.35, y 0.20–0.40",
            f"id {ANNOTATION}",
        ):
            assert expected in result, expected

    async def test_live_marks_come_first_and_proposals_say_nobody_took_them_over(self, monkeypatch, calls) -> None:
        body = {
            "documentId": DOCUMENT,
            "documentName": NAME,
            "annotations": [
                listed(id="a", number=1, page=1, status="resolved"),
                listed(id="b", number=2, page=3, status="proposed", authorKind="piloti", shape="point"),
            ],
        }
        answering(monkeypatch, calls, body)

        result = await run_marks()

        assert result.index("No. 2") < result.index("No. 1")
        assert "proposal, not yet taken over" in result and "by Piloti, for Martin Huber" in result
        assert "point x 0.10, y 0.20" in result

    async def test_an_older_revision_is_named(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, {**LIST_BODY, "annotations": [listed(onCurrentRevision=False)]})

        assert "earlier Fassung" in await run_marks()

    async def test_a_bff_that_has_not_rolled_yet_names_the_older_revision_the_old_way(self, monkeypatch, calls) -> None:
        mark = {key: value for key, value in listed().items() if key != "onCurrentRevision"}
        answering(monkeypatch, calls, {**LIST_BODY, "annotations": [{**mark, "onCurrentFassung": False}]})

        assert "earlier Fassung" in await run_marks()

    async def test_a_mark_on_a_sketch_names_its_elements_and_a_lost_one_says_so(self, monkeypatch, calls) -> None:
        pinned = listed(elementIds=["stair", "door"], anchorLost=True)
        answering(monkeypatch, calls, {**LIST_BODY, "annotations": [pinned]})

        result = await run_marks()

        assert "on sketch elements stair, door" in result and "elements were deleted" in result

    async def test_a_mark_on_a_3d_model_view_has_no_page_and_comes_last(self, monkeypatch, calls) -> None:
        view = listed(
            id="v",
            number=1,
            page=None,
            shape=None,
            box=None,
            viewpoint={"id": "vp", "cameraKind": "perspective", "selectionCount": 3, "hasSection": True, "hasSnapshot": False},
        )
        page_mark = listed(id="p", number=2, page=5)
        answering(monkeypatch, calls, {**LIST_BODY, "annotations": [view, page_mark]})

        result = await run_marks()

        assert "None" not in result and "?" not in result
        assert "No. 1 · 3D view ·" in result
        assert "on a 3D model view (3 elements selected), with a section" in result
        assert result.index("No. 2") < result.index("No. 1")

    async def test_an_empty_document_says_so(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, {**LIST_BODY, "annotations": []})

        assert "no annotations on" in await run_marks()

    async def test_a_proposal_is_never_reported_as_recorded(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        result = await run_mark([PROPOSAL])

        assert "no. 5 on p. 1" in result
        assert "PROPOSALS" in result and "NOTHING has been confirmed YET" in result
        assert "until a person takes over or dismisses" in result

    async def test_a_reply_by_number_looks_the_id_up_first(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, LIST_BODY, REPLY_BODY)

        result = await run_reply("Nr. 4", "Ist korrigiert.")

        assert [payload["op"] for payload, _ in calls] == ["list", "reply"]
        assert calls[1][0]["annotationId"] == ANNOTATION
        assert "annotation no. 4" in result

    async def test_a_reply_to_a_number_the_document_lacks_is_refused(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_reply("9", "Ist korrigiert.")

        assert [payload["op"] for payload, _ in calls] == ["list"]
        assert "This annotation does not exist" in result

    async def test_a_reply_without_an_annotation_is_refused_before_anything_is_sent(self, monkeypatch, calls):
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_reply("die da", "Ist korrigiert.")

        assert calls == [] and "`annotation`" in result


class TestTheActivityCard:
    async def test_a_proposal_lands_on_the_card_with_what_the_bff_returned(self, monkeypatch, calls, registry):
        answering(monkeypatch, calls, PROPOSE_BODY)

        await run_mark([PROPOSAL])

        [card] = registry.snapshot()
        assert card["type"] == "canvas_activity"
        assert card["document"] == {"id": DOCUMENT, "name": NAME}
        assert card["items"] == [
            {
                "action": "proposed",
                "annotation_id": PROPOSED,
                "number": 5,
                "page": 1,
                "shape": "region",
                "x": 0.12,
                "y": 0.3,
                "w": 0.2,
                "h": 0.1,
                "kind": "defect",
                "body": "Treppenlaufbreite 1,10 m statt 1,20 m.",
            }
        ]

    async def test_a_reply_extends_the_same_documents_card(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY, REPLY_BODY)

        await run_mark([PROPOSAL])
        await run_reply(ANNOTATION, "Ist im Index C korrigiert.")

        [card] = registry.snapshot()
        assert [item["action"] for item in card["items"]] == ["proposed", "replied"]
        assert card["items"][1] == {
            "action": "replied",
            "annotation_id": ANNOTATION,
            "number": 4,
            "excerpt": "Ist im Index C korrigiert.",
        }

    async def test_a_refused_write_puts_nothing_on_the_card(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, CanvasRequestError("x", status=403))

        await run_mark([PROPOSAL])

        assert registry.snapshot() == []


class TestObservability:
    async def test_every_call_tags_the_turn_and_records_counts_not_text(self, monkeypatch, calls) -> None:
        tags: list[str] = []
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(canvas_calls, "add_trace_tag", tags.append)
        monkeypatch.setattr(canvas_calls, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, LIST_BODY)

        await run_marks()

        assert tags == ["feature:canvas"]
        name, _, outcome = spans[0]
        assert name == "canvas.marks"
        assert outcome == {"document": DOCUMENT, "annotations": 1, "live": 1, "by_kind": {"defect": 1}}
        assert "Fluchtweg" not in str(spans)

    async def test_a_refusal_is_recorded_by_its_code(self, monkeypatch, calls) -> None:
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(canvas_calls, "add_trace_tag", lambda tag: None)
        monkeypatch.setattr(canvas_calls, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        answering(monkeypatch, calls, CanvasRequestError("x", status=422, reason="no-document-subject"))

        await run_marks()

        assert spans[0][2] == {"refused": "no_document_subject"}


class TestOnASketch:
    async def test_a_proposal_on_a_sketch_sends_its_elements_and_no_box(self, monkeypatch, calls, registry) -> None:
        answering(monkeypatch, calls, PROPOSE_BODY)

        await run_mark([{"element_ids": ["stair", "stair", "door"], "kind": "hint", "body": "Breite prüfen."}])

        proposal = calls[0][0]["proposals"][0]
        assert proposal == {"elementIds": ["stair", "door"], "kind": "hint", "body": "Breite prüfen."}
