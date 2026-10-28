"""``look``: which file it reads, from which collection, and who sees the box glow (ADR-0128).

The bytes are a real one-page PDF; only the lookups, the object-store fetch and
the canvas POST are faked. What is under test is which file ``look`` picks in
each context (a base-corpus file with no envelope, an inventory name in a chat,
the document open on the canvas, the conversation's subject, a file only a
collection probe finds), that it goes through the renderer's scope check,
budget and region crop, and that the glow is sent for a workspace document only.
"""

from __future__ import annotations

import knowledge_layer.view_image as view
import pytest
from agent_testing import look
from agent_testing.canvas import DOCUMENT
from agent_testing.canvas import LIST_BODY
from agent_testing.canvas import OTHER_DOCUMENT
from agent_testing.canvas import answering
from agent_testing.look import _pdf

from agent import project_context
from agent.common import image_view_budget
from agent.common.focus_file import set_turn_intent
from agent.tools.look import resolve
from agent.tools.look.register import DESCRIPTION
from agent.tools.look.register import run_look

# The look suites' fixtures, under the names these tests ask for.
stored = look.stored
room = look.room


def _glows(calls) -> list[dict]:
    return [payload for payload, _ in calls if payload["op"] == "look"]


class TestWhichFile:
    async def test_the_canvas_document_is_looked_at_with_its_inventory_collection(self, stored) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        token = image_view_budget.begin_image_view_budget()
        try:
            result = await run_look(page=1, region=[0.1, 0.1, 0.3, 0.2])
            budget = image_view_budget.get_image_view_budget()
            assert budget is not None and budget.regions_viewed == 1
        finally:
            image_view_budget.end_image_view_budget(token)

        assert stored == [("proj_1", "Grundriss_EG.pdf")]
        assert isinstance(result, list) and result[0]["text"].startswith("Region [x=0.100")
        assert "from collection 'proj_1'" in result[0]["text"]

    async def test_the_subject_is_named_by_the_bff_when_the_turn_does_not_know_its_file(
        self, stored, monkeypatch, calls
    ) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_look(page=1)

        # The room hears what Piloti reads while the subject's name is read for the render.
        assert sorted(payload["op"] for payload, _ in calls) == ["list", "look"]
        assert {"op": "look", "page": 1} in [payload for payload, _ in calls]
        assert isinstance(result, list) and "Rendered page 1 of 'Grundriss_EG.pdf'" in result[0]["text"]

    async def test_a_base_corpus_file_needs_no_envelope_and_glows_nowhere(
        self, stored, monkeypatch, calls, tmp_path
    ) -> None:
        pdf = tmp_path / "OIB-RL2.pdf"
        pdf.write_bytes(_pdf())
        monkeypatch.setattr(view, "_find_pdf", lambda name: str(pdf) if name == "OIB-RL2.pdf" else None)
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))

        result = await run_look("OIB-RL2.pdf", page=1)

        assert isinstance(result, list) and "Rendered page 1 of 'OIB-RL2.pdf'" in result[0]["text"]
        assert stored == [] and calls == []

    async def test_an_inventory_name_in_a_chat_is_read_from_its_collection_and_glows_there(
        self, stored, calls, lookups
    ) -> None:
        result = await run_look("Grundriss_OG", page=1, region=[0.5, 0.5, 0.2, 0.2])

        assert lookups == [("proj_1", "Grundriss_OG.pdf")]
        assert stored == [("proj_1", "Grundriss_OG.pdf")]
        assert isinstance(result, list)
        [glow] = _glows(calls)
        assert (glow["documentId"], glow["page"], glow["x"]) == (OTHER_DOCUMENT, 1, 0.5)

    async def test_the_canvas_documents_own_name_is_the_canvas_document(self, stored, calls, lookups) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look("Grundriss_EG.pdf", page=1)

        assert lookups == []  # the id is the focus's, never asked again
        assert _glows(calls)[0]["documentId"] == DOCUMENT

    async def test_a_name_that_means_two_files_is_a_question(self, stored, lookups) -> None:
        result = await run_look("Grundriss", page=1)

        assert isinstance(result, str) and result.startswith("Ambiguous")
        assert stored == [] and lookups == []

    async def test_a_file_the_inventory_does_not_list_is_found_in_the_turns_collections(
        self, stored, monkeypatch, lookups
    ) -> None:
        monkeypatch.setattr(resolve, "probe_collections", lambda: ["proj_9", "proj_1"])

        result = await run_look("Brandschutz_Nachweis.pdf", page=1)

        assert stored == [
            ("proj_9", "Brandschutz_Nachweis.pdf"),
            ("proj_1", "Brandschutz_Nachweis.pdf"),
            ("proj_1", "Brandschutz_Nachweis.pdf"),
        ]
        assert lookups == [("proj_1", "Brandschutz_Nachweis.pdf")]
        assert isinstance(result, list)

    async def test_a_file_no_collection_holds_is_not_guessed(self, stored, monkeypatch) -> None:
        monkeypatch.setattr(resolve, "probe_collections", lambda: ["proj_9"])

        result = await run_look("Erfunden.pdf", page=1)

        assert isinstance(result, str) and result.startswith("Not found")

    async def test_without_an_envelope_an_inventory_name_is_still_read_without_a_glow(
        self, stored, monkeypatch, calls, lookups
    ) -> None:
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))

        result = await run_look("Grundriss_OG.pdf", page=1)

        assert isinstance(result, list) and stored == [("proj_1", "Grundriss_OG.pdf")]
        assert lookups == [] and calls == []


class TestTheRenderersChecks:
    async def test_an_invalid_region_is_refused_in_looks_own_name(self, stored) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        result = await run_look(page=1, region=[0.9, 0.1, 0.3, 0.2])

        assert isinstance(result, str) and result.startswith("[look] Invalid region")

    async def test_a_collection_outside_the_turns_scope_is_never_fetched(self, stored, monkeypatch) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        monkeypatch.setattr(view, "_may_read", lambda _collection: False)

        result = await run_look(page=1)

        assert stored == [] and isinstance(result, str) and "not in a collection this turn may read" in result
        assert "Collection:" not in result  # the model is never asked for a collection

    async def test_a_look_reports_the_collection_it_read(self, stored, monkeypatch) -> None:
        """What ``admit_tool_results`` admits: a restricted folder's page reaches the model only once admitted."""
        reported: list[list[str]] = []
        monkeypatch.setattr(view, "note_collections_read", lambda collections: reported.append(list(collections)))
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        result = await run_look(page=1, region=[0.0, 0.0, 0.5, 0.5])

        assert isinstance(result, list)
        assert reported == [["proj_1"]]


class TestTheBudget:
    async def test_two_whole_pages_then_only_regions_and_every_look_says_what_is_left(self, stored) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        token = image_view_budget.begin_image_view_budget()
        try:
            first = await run_look(page=1)
            second = await run_look(page=1)
            third = await run_look(page=1)
            region = await run_look(page=1, region=[0.1, 0.1, 0.2, 0.2])
        finally:
            image_view_budget.end_image_view_budget(token)

        assert isinstance(first, list) and first[0]["text"].endswith("5 looks left this turn (1 of them whole pages).")
        assert isinstance(second, list) and second[0]["text"].endswith("(0 of them whole pages).")
        assert isinstance(third, str) and third.startswith("[look] Whole-page cap reached")
        assert "region=[x, y, w, h]" in third and "4 looks left this turn" in third
        assert isinstance(region, list)
        assert region[0]["text"].endswith("3 looks left this turn (0 of them whole pages).")

    async def test_the_sixth_look_is_the_last(self, stored) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        token = image_view_budget.begin_image_view_budget()
        try:
            looks = [await run_look(page=1, region=[0.1, 0.1, 0.2, 0.2]) for _ in range(6)]
            capped = await run_look(page=1, region=[0.1, 0.1, 0.2, 0.2])
        finally:
            image_view_budget.end_image_view_budget(token)

        assert all(isinstance(result, list) for result in looks)
        assert isinstance(capped, str) and capped.startswith("[look] Look cap reached")

    def test_the_description_states_both_limits(self) -> None:
        assert "At most 6 looks per turn, at most 2 of them whole pages" in DESCRIPTION


class TestTheRoom:
    async def test_the_room_sees_the_box_piloti_reads(self, stored, calls) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look(page=2, region=[0.1, 0.2, 0.3, 0.25])

        [glow] = _glows(calls)
        assert (glow["page"], glow["x"], glow["y"], glow["w"], glow["h"]) == (2, 0.1, 0.2, 0.3, 0.25)

    async def test_a_room_that_cannot_be_told_never_stops_the_look(self, stored, monkeypatch, calls) -> None:
        from agent.tools.canvas.client import CanvasRequestError

        answering(monkeypatch, calls, CanvasRequestError("down", status=503))
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        result = await run_look(page=1)

        assert isinstance(result, list)

    async def test_a_look_outside_a_chat_turn_never_glows(self, stored, monkeypatch, calls) -> None:
        """The door and a background run send no ``leave``: a glow from them would stay on the canvas."""
        from agent.tools.look import register

        monkeypatch.setattr(register, "current_canvas_presence", lambda: None)
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        result = await run_look(page=1)

        assert isinstance(result, list) and _glows(calls) == []


class TestTheRow:
    """One ``look`` row per call (ADR-0132): started, then settled under the same id with the document it read."""

    @staticmethod
    def _one_call(emitted) -> tuple:
        actions = [step for step in emitted.steps if step.kind == "action"]
        assert len(actions) == 2
        started, finished = actions
        assert (started.id, started.status, started.verb) == (finished.id, "running", "look")
        return started, finished

    async def test_a_look_names_the_document_its_page_and_its_id(self, stored, emitted) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look(page=1, region=[0.1, 0.1, 0.3, 0.2])

        started, finished = self._one_call(emitted)
        assert (started.pages, started.target) == ("1", None)
        assert (finished.status, finished.target, finished.document_id) == ("ok", "Grundriss_EG.pdf", DOCUMENT)
        # The row finds its crop: the same name and id as the `look` step.
        look = next(step for step in emitted.steps if step.kind == "look")
        assert look.document_name == finished.target and look.document_id == finished.document_id

    async def test_a_base_corpus_look_has_no_document_id(self, stored, monkeypatch, emitted, tmp_path) -> None:
        pdf = tmp_path / "OIB-RL2.pdf"
        pdf.write_bytes(_pdf())
        monkeypatch.setattr(view, "_find_pdf", lambda name: str(pdf) if name == "OIB-RL2.pdf" else None)

        await run_look("OIB-RL2.pdf", page=1)

        finished = self._one_call(emitted)[1]
        assert (finished.status, finished.target, finished.document_id) == ("ok", "OIB-RL2.pdf", None)

    async def test_a_refused_look_is_an_error_row(self, stored, monkeypatch, emitted) -> None:
        monkeypatch.setattr(resolve, "probe_collections", lambda: ["proj_9"])

        await run_look("Erfunden.pdf", page=1)

        finished = self._one_call(emitted)[1]
        assert (finished.status, finished.target) == ("error", "Erfunden.pdf")

    async def test_an_unadmitted_restricted_file_carries_no_id(self, stored, monkeypatch, emitted, lookups) -> None:
        """The row settles before the round is admitted: no resolved file name, no id (ADR-0088)."""
        restricted = "proj_1_r0123456789ab"
        monkeypatch.setattr(resolve, "probe_collections", lambda: [restricted])

        async def locate(collection, file_name, organization_id=None, image_index=None):
            return ("key", None) if collection == restricted else None

        monkeypatch.setattr(view, "_resolve_storage_location", locate)
        monkeypatch.setattr(view, "_may_read", lambda _collection: True)

        await run_look("gehaltsliste.pdf", page=1)

        finished = self._one_call(emitted)[1]
        assert lookups == [(restricted, "gehaltsliste.pdf")]  # the resolver knew the id; the row does not say it
        assert (finished.status, finished.target, finished.document_id) == ("ok", "gehaltsliste.pdf", None)
        # Nor does a `look` step: its name, id and reading wait for the admission too.
        assert [step for step in emitted.steps if step.kind == "look"] == []

    async def test_an_admitted_restricted_file_is_named_with_its_id(
        self, stored, monkeypatch, emitted, lookups
    ) -> None:
        """Once the turn admitted the folder, the row and the `look` step name the file and its id."""
        from agent.knowledge.restricted_use import RestrictedUse
        from agent.knowledge.restricted_use import bind_restricted_use
        from agent.knowledge.restricted_use import reset_restricted_use

        restricted = "proj_1_r0123456789ab"
        monkeypatch.setattr(resolve, "probe_collections", lambda: [restricted])

        async def locate(collection, file_name, organization_id=None, image_index=None):
            return ("key", None) if collection == restricted else None

        monkeypatch.setattr(view, "_resolve_storage_location", locate)
        monkeypatch.setattr(view, "_may_read", lambda _collection: True)
        use = RestrictedUse("org", "user", "conversation", "proj_1", drawable={restricted}, admitted={restricted})
        token = bind_restricted_use(use)
        try:
            await run_look("gehaltsliste.pdf", page=1)
        finally:
            reset_restricted_use(token)

        finished = self._one_call(emitted)[1]
        (look,) = [step for step in emitted.steps if step.kind == "look"]
        assert finished.document_id is not None
        assert (look.document_name, look.document_id) == (finished.target, finished.document_id)

    async def test_a_look_that_raises_settles_error(self, stored, monkeypatch, emitted) -> None:
        async def boom(_document):
            raise RuntimeError("boom")

        monkeypatch.setattr("agent.tools.look.register.resolve_document", boom)

        with pytest.raises(RuntimeError):
            await run_look("Grundriss_EG.pdf", page=1)

        assert self._one_call(emitted)[1].status == "error"
