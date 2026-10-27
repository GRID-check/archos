"""``show_in_viewer`` (ADR-0142): one allow-listed viewer action, only on a document the person may see.

Only the HTTP calls are faked (the canvas route the document is read through,
and the document-id lookup). The resolver, the wire model and the emitter are
the real ones, so the event a test reads is the frame a turn would send.
"""

from __future__ import annotations

import knowledge_layer.view_image as view
import pytest

from aiq_agent import project_context
from aiq_agent.common import turn_status
from aiq_agent.common.wire_v2 import ViewerActionBody
from aiq_agent.common.wire_v2 import ViewerActionName
from aiq_agent.tools.canvas.client import CanvasRequestError
from aiq_agent.tools.viewer.register import ACTIONS
from aiq_agent.tools.viewer.register import DESCRIPTION
from aiq_agent.tools.viewer.register import run_show_in_viewer
from tests.aiq_agent.tools.canvas.conftest import LIST_BODY
from tests.aiq_agent.tools.canvas.conftest import OTHER_DOCUMENT
from tests.aiq_agent.tools.canvas.conftest import answering

GLOBAL_ID = "1kTvQ9x8n5RfBW2$hK0aZq"


@pytest.fixture(autouse=True)
def no_base_corpus(monkeypatch):
    """No file of these tests is a platform-corpus file, unless a test says so."""
    monkeypatch.setattr(view, "_find_pdf", lambda _name: None)


@pytest.fixture
def sent(monkeypatch) -> list[ViewerActionBody]:
    """The viewer actions the turn put on its stream."""
    seen: list[ViewerActionBody] = []
    monkeypatch.setattr(turn_status, "emit", lambda body: seen.append(body))
    from aiq_agent.tools.viewer import register

    monkeypatch.setattr(register, "emit", lambda body: seen.append(body))
    return seen


class TestTheAllowList:
    def test_the_tool_offers_exactly_the_wire_s_actions(self) -> None:
        from typing import get_args

        assert ACTIONS == get_args(ViewerActionName)
        for action in ACTIONS:
            assert f"`{action}`" in DESCRIPTION

    async def test_an_action_off_the_list_is_refused_before_anything_is_asked(self, calls, sent) -> None:
        result = await run_show_in_viewer("navigate_to_url", "Grundriss_EG.pdf")

        assert result.startswith("Not possible") and "`open_document`" in result
        assert calls == [] and sent == []


class TestADocumentThePersonMaySee:
    async def test_a_passage_is_proposed_after_the_bff_read_the_document_as_the_person(
        self, monkeypatch, calls, lookups, sent
    ) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_show_in_viewer(
            "highlight_passage", "Grundriss_EG.pdf", page=4, passage="  Die Fluchtwege sind 1,20 m breit. "
        )

        assert result.startswith("Proposed to the person's viewer")
        assert [payload["op"] for payload, _ in calls] == ["list"]
        assert calls[0][0]["documentId"] == OTHER_DOCUMENT
        [body] = sent
        assert body.value.tool_call_name == "highlight_passage"
        assert body.value.args.model_dump(exclude_none=True) == {
            "document_id": OTHER_DOCUMENT,
            "document_name": "Grundriss_EG.pdf",
            "page": 4,
            "passage": "Die Fluchtwege sind 1,20 m breit.",
        }

    async def test_a_comparison_names_both_revisions(self, monkeypatch, calls, lookups, sent) -> None:
        answering(monkeypatch, calls, LIST_BODY)
        ids = iter(["aaaaaaaa-0000-4000-8000-00000000000a", "bbbbbbbb-0000-4000-8000-00000000000b"])
        from aiq_agent.tools.canvas import target as canvas_target

        monkeypatch.setattr(canvas_target, "lookup_document_id", lambda *_: next(ids))

        result = await run_show_in_viewer("compare_revisions", "Grundriss_EG.pdf", against="Grundriss_OG.pdf")

        assert result.startswith("Proposed")
        args = sent[0].value.args
        assert (args.document_id, args.against_document_id) == (
            "aaaaaaaa-0000-4000-8000-00000000000a",
            "bbbbbbbb-0000-4000-8000-00000000000b",
        )
        assert args.against_document_name == "Grundriss_OG.pdf"

    async def test_a_region_off_the_page_is_refused_and_nothing_is_sent(
        self, monkeypatch, calls, lookups, sent
    ) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_show_in_viewer("highlight_region", "Grundriss_EG.pdf", page=1, region=[0.9, 0, 0.3, 0.2])

        assert result.startswith("Not shown") and sent == []


class TestADocumentThePersonMayNotSee:
    @pytest.mark.parametrize("status", [403, 404])
    async def test_the_bff_s_refusal_is_relayed_and_nothing_reaches_the_page(
        self, monkeypatch, calls, lookups, sent, status: int
    ) -> None:
        answering(monkeypatch, calls, CanvasRequestError("no", status=status))

        result = await run_show_in_viewer("open_document", "Grundriss_EG.pdf", page=2)

        assert "may not read it" in result or "may not change anything" in result
        assert sent == []

    async def test_a_name_the_turn_cannot_see_is_never_looked_up(self, monkeypatch, calls, lookups, sent) -> None:
        async def nowhere(_name: str) -> str:
            return ""

        from aiq_agent.tools.look import resolve

        monkeypatch.setattr(resolve, "_probe", nowhere)

        result = await run_show_in_viewer("open_document", "Geheim.pdf")

        assert result.startswith("Not found") and calls == [] and lookups == [] and sent == []

    async def test_without_the_person_s_envelope_nothing_is_shown(self, monkeypatch, calls, lookups, sent) -> None:
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))

        result = await run_show_in_viewer("open_document", "Grundriss_EG.pdf")

        assert "no signed session credential" in result and calls == [] and lookups == [] and sent == []

    async def test_a_platform_corpus_file_has_no_viewer_of_the_office(self, monkeypatch, calls, sent, tmp_path) -> None:
        pdf = tmp_path / "OIB-RL2.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        monkeypatch.setattr(view, "_find_pdf", lambda name: str(pdf) if name == "OIB-RL2.pdf" else None)

        result = await run_show_in_viewer("open_document", "OIB-RL2.pdf")

        assert "not a document of the office or the project" in result and sent == []


class TestAModelElement:
    async def test_a_drawing_has_no_element_to_select(self, monkeypatch, calls, lookups, sent) -> None:
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_show_in_viewer("focus_ifc_element", "Grundriss_EG.pdf", element=GLOBAL_ID)

        assert "no building model" in result and sent == []

    async def test_an_element_of_a_model_is_proposed(self, monkeypatch, calls, lookups, sent) -> None:
        from aiq_agent.knowledge import AvailableDocument
        from aiq_agent.knowledge.inventory import set_turn_documents

        set_turn_documents([AvailableDocument(file_name="Haus A.ifc", shelf="project", collection="proj_1")])
        answering(monkeypatch, calls, LIST_BODY)

        result = await run_show_in_viewer("focus_ifc_element", "Haus A.ifc", element=GLOBAL_ID)

        assert result.startswith("Proposed")
        assert sent[0].value.args.element == GLOBAL_ID
