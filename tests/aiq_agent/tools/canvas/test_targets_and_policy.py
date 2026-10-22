"""Which document a canvas tool acts on, and what it may show to everyone."""

from __future__ import annotations

import pytest

from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.knowledge.restricted_use import CrossProjectTurn
from aiq_agent.knowledge.restricted_use import RestrictedUse
from aiq_agent.knowledge.restricted_use import bind_cross_project_turn
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.knowledge.restricted_use import current_restricted_use
from aiq_agent.tools.canvas import calls as canvas_calls
from aiq_agent.tools.canvas import target as canvas_target
from aiq_agent.tools.canvas.policy import withhold_restricted_for_thread
from aiq_agent.tools.canvas.register import run_delete
from aiq_agent.tools.canvas.register import run_highlight
from aiq_agent.tools.canvas.register import run_mark
from aiq_agent.tools.canvas.register import run_marks
from aiq_agent.tools.canvas.register import run_point
from aiq_agent.tools.canvas.register import run_reply
from aiq_agent.tools.canvas.register import run_update

from .conftest import ANNOTATION
from .conftest import DOCUMENT
from .conftest import LIST_BODY
from .conftest import OK_BODY
from .conftest import OTHER_DOCUMENT
from .conftest import PROPOSAL
from .conftest import PROPOSE_BODY
from .conftest import answering


def _use(**fields) -> RestrictedUse:
    return RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id="p", **fields)


class TestWhichDocument:
    async def test_without_a_name_or_a_focus_the_subject_is_asked_for(self, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        await run_marks()

        assert "documentId" not in calls[0][0]

    async def test_the_document_open_on_the_canvas_comes_first(self, monkeypatch, calls) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        answering(monkeypatch, calls, LIST_BODY)

        await run_marks()

        assert calls[0][0]["documentId"] == DOCUMENT

    async def test_a_named_file_is_resolved_against_the_inventory_then_its_id_asked_for(
        self, monkeypatch, calls, lookups
    ) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        answering(monkeypatch, calls, LIST_BODY)

        await run_marks(document="Grundriss_OG")

        assert lookups == [("proj_1", "Grundriss_OG.pdf")]
        assert calls[0][0]["documentId"] == OTHER_DOCUMENT

    async def test_an_id_is_taken_as_it_is_and_the_bff_checks_it(self, monkeypatch, calls, lookups) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        await run_marks(document=OTHER_DOCUMENT)

        assert lookups == [] and calls[0][0]["documentId"] == OTHER_DOCUMENT

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Grundriss", "Ambiguous"),
            ("Ansicht Nord", "Not found"),
            # The platform corpus is nobody's to mark: never resolved.
            ("OIB-RL2.pdf", "Not found"),
        ],
    )
    async def test_a_name_that_is_not_one_document_is_a_question(
        self, monkeypatch, calls, lookups, name, expected
    ) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_marks(document=name)

        assert calls == [] and lookups == [] and expected in result

    async def test_an_older_bff_that_returns_no_id_is_said_plainly(self, monkeypatch, calls) -> None:
        monkeypatch.setattr(canvas_target, "lookup_document_id", lambda *_: None)
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_marks(document="Grundriss_OG.pdf")

        assert calls == [] and "cannot be addressed by its name" in result


class TestWhatEveryoneSees:
    @pytest.mark.parametrize(
        "use",
        [
            _use(confined=True),
            _use(admitted={"proj_1_r0123456789ab"}),
        ],
        ids=["conversation-recorded-a-restricted-folder", "this-turn-admitted-one"],
    )
    @pytest.mark.parametrize("tool", ["mark", "open mark", "update", "delete", "reply", "highlight", "labelled point"])
    async def test_a_confined_conversation_writes_nothing_everyone_reads(self, monkeypatch, calls, use, tool):
        bind_restricted_use(use)
        answering(monkeypatch, calls, PROPOSE_BODY)
        run = {
            "mark": lambda: run_mark([PROPOSAL]),
            "open mark": lambda: run_mark([PROPOSAL], open=True),
            "update": lambda: run_update(ANNOTATION, "Erledigt: passt.", status="resolved"),
            "delete": lambda: run_delete(ANNOTATION),
            "reply": lambda: run_reply(ANNOTATION, "Passt."),
            "highlight": lambda: run_highlight(1, 0.1, 0.1, 0.2, 0.2, "Hier"),
            "labelled point": lambda: run_point(1, 0.1, 0.1, "Hier"),
        }[tool]

        result = await run()

        assert calls == []
        assert "restricted access" in result

    async def test_another_projects_content_shuts_the_door_too(self, monkeypatch, calls) -> None:
        bind_cross_project_turn(CrossProjectTurn(drew_on_others=True))
        answering(monkeypatch, calls, PROPOSE_BODY)

        assert "another project" in await run_mark([PROPOSAL])
        assert calls == []

    async def test_reading_and_a_bare_pointer_stay_open(self, monkeypatch, calls) -> None:
        bind_restricted_use(_use(confined=True))
        answering(monkeypatch, calls, OK_BODY)

        await run_point(1, 0.5, 0.5)

        assert [payload["op"] for payload, _ in calls] == ["point"]

    async def test_an_open_conversation_may_post(self, monkeypatch, calls, registry) -> None:
        bind_restricted_use(_use(drawable={"proj_1_r0123456789ab"}))
        answering(monkeypatch, calls, PROPOSE_BODY)

        await run_mark([PROPOSAL])

        assert [payload["op"] for payload, _ in calls] == ["propose"]

    async def test_the_refusal_is_on_the_trace(self, monkeypatch, calls) -> None:
        spans: list[tuple[str, dict, dict]] = []
        monkeypatch.setattr(canvas_calls, "add_trace_tag", lambda tag: None)
        monkeypatch.setattr(canvas_calls, "emit_step_span", lambda name, i, o: spans.append((name, i, o)))
        bind_restricted_use(_use(confined=True))
        answering(monkeypatch, calls, PROPOSE_BODY)

        await run_reply(ANNOTATION, "Passt.")

        assert spans == [("canvas.reply", {"step": "reply"}, {"refused": "restricted"})]

    def test_a_thread_question_runs_without_restricted_folders_in_scope(self) -> None:
        bind_restricted_use(_use(drawable={"proj_1_r0123456789ab", "proj_1_r00000000000a"}))

        withhold_restricted_for_thread()

        use = current_restricted_use()
        assert use is not None and use.drawable == set()
        assert not use.allows("proj_1_r0123456789ab")

    def test_withholding_outside_a_restricted_turn_is_a_no_op(self) -> None:
        bind_restricted_use(None)

        withhold_restricted_for_thread()

        assert current_restricted_use() is None
