"""The look tool suites' stored PDF and canvas room."""

from __future__ import annotations

import io

import knowledge_layer.llamaindex.adapter as llm_adapter
import knowledge_layer.view_image as view
import pypdfium2 as pdfium
import pytest

from agent_testing.canvas import answering


def _pdf() -> bytes:
    doc = pdfium.PdfDocument.new()
    doc.new_page(595, 842)
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def stored(monkeypatch):
    """A project PDF the lookup finds in ``proj_1`` (or wherever asked) and the store hands back."""
    asked: list[tuple[str, str]] = []

    async def locate(collection, file_name, organization_id=None, image_index=None):
        asked.append((collection, file_name))
        return ("key", None) if collection == "proj_1" else None

    monkeypatch.setenv("GRID_VIEW_IMAGES_ENABLED", "true")
    monkeypatch.setattr(llm_adapter, "_get_vlm_api_key", lambda: "sk-test")
    monkeypatch.setattr(view, "_find_pdf", lambda _name: None)
    monkeypatch.setattr(view, "_resolve_storage_location", locate)
    monkeypatch.setattr(view, "_fetch_seaweed_bytes", lambda *_: _pdf())
    monkeypatch.setattr(view, "turn_sees", _sees)
    return asked


@pytest.fixture(autouse=True)
def room(monkeypatch, calls):
    """The canvas route answers every glow; a test that needs another answer calls ``answering`` again."""
    answering(monkeypatch, calls, {"ok": True})
    return calls


async def _sees():
    return True
