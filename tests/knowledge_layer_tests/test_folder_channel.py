"""The folder channel of a ranked ``knowledge_search``: a search can land on a folder (ADR-0127, S11c).

The store side (folder points never reach a chunk read; the folder query finds
them; a restricted folder's card is invisible without its scope) runs on a real
Qdrant in ``sources/knowledge_layer/tests/test_qdrant_scope_kind.py``. Here the
tool: the lines it prints, that they are no citation, when the channel asks at
all, and that it never costs the search its answer.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import get_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src import folder_channel
from sources.knowledge_layer.src.qdrant.folders import FolderHit
from sources.knowledge_layer.src.qdrant.folders import render_folder_hits
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import knowledge_retrieval

PROJECT = "proj_1"
BASE = "oib_knowledge"
HIT = FolderHit(PROJECT, "Einreichung/Pläne", "Einreichpläne Index C, Grundrisse und Schnitte.", "fresh", 0.81)


class TestTheLines:
    def test_a_folder_line_names_the_path_the_abstract_and_the_way_in(self):
        text = render_folder_hits([HIT], "Grundriss EG")

        assert "Folder: Einreichung/Pläne — Einreichpläne Index C, Grundrisse und Schnitte." in text
        # A fact, no tool: three agents with different tools read it (ADR-0133 slice 6).
        assert 'list Einreichung/Pläne or search inside it ("Grundriss EG")' in text
        assert "not a source" in text

    def test_a_stale_card_says_so_and_a_long_abstract_is_cut(self):
        hit = FolderHit(PROJECT, "A", "x" * 400, "stale", 0.5)

        line = render_folder_hits([hit]).splitlines()[1]

        assert line.endswith("… (card may be out of date)")
        assert len(line) < 330

    def test_no_hits_no_lines(self):
        assert render_folder_hits([]) == ""


class _Retriever:
    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, chunks):
        self.chunks = chunks

    async def retrieve(self, query, collection_name, top_k, filters=None):
        chunks = [chunk.model_copy(deep=True) for chunk in self.chunks] if collection_name == PROJECT else []
        return RetrievalResult(chunks=chunks, query=query, backend="fake", success=True)


def _chunk(file_name: str) -> Chunk:
    return Chunk(
        chunk_id=f"{file_name}-1",
        content="Grundriss Erdgeschoss, Maßstab 1:100.",
        score=0.9,
        file_name=file_name,
        page_number=1,
        display_citation=f"{file_name}, p.1",
        content_type=ContentType.TEXT,
        metadata={"collection": PROJECT, "page_label": "1"},
    )


@pytest.fixture
def channel(monkeypatch):
    """A project and the base corpus in scope, one passage, and the channel's store read stood in for."""
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", lambda collection: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(BASE, Shelf.BASE), ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    set_turn_documents(
        [
            AvailableDocument(
                file_name="Grundriss_EG.pdf", collection=PROJECT, shelf="project", folder_path="Einreichung"
            )
        ]
    )
    retriever = _Retriever([_chunk("Grundriss_EG.pdf")])
    monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: retriever)
    from aiq_agent.knowledge.folder_cards import gate

    gate.forget()
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: True)
    monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: "org_1")
    asked: list[dict] = []

    def routes(retriever_, scopes, query_text, folder, hint):
        asked.append({"retriever": retriever_, "scopes": scopes, "query": query_text, "folder": folder})
        return render_folder_hits([HIT], hint)

    monkeypatch.setattr(folder_channel, "_routes", routes)
    yield asked
    set_turn_documents(None)


async def _search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(
        collection_name=BASE, include_base_collection=True, include_session_collection=False, top_k=5
    )
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestThroughTheTool:
    async def test_the_folder_follows_the_passages_and_is_no_citation(self, channel):
        token = begin_grounding_capture()
        try:
            out = await _search(query="Grundriss EG")
            block = get_grounding_block(out)
        finally:
            end_grounding_capture(token)

        assert "Folder: Einreichung/Pläne — " in out
        assert out.index("Citation: Grundriss_EG.pdf, p.1") < out.index("Folder: Einreichung/Pläne")
        assert block is not None
        assert [hit.file_name for hit in block.hits] == ["Grundriss_EG.pdf"]

    async def test_only_the_office_scopes_are_asked_with_the_folder_the_search_is_in(self, channel):
        await _search(query="Grundriss EG", folder="Einreichung")

        [asked] = channel
        assert asked["scopes"] == [PROJECT]
        assert asked["folder"] == "Einreichung"

    async def test_a_named_file_asks_no_folder(self, channel):
        out = await _search(query="Grundriss EG", file_name="Grundriss_EG.pdf")

        assert channel == []
        assert "Folder:" not in out

    async def test_off_without_the_organizations_flag(self, channel, monkeypatch):
        from aiq_agent.knowledge.folder_cards import gate

        gate.forget()
        monkeypatch.setattr(gate, "_fetch", lambda organization_id: False)

        out = await _search(query="Grundriss EG")

        assert channel == []
        assert "Folder:" not in out

    async def test_a_store_that_fails_costs_the_lines_not_the_search(self, channel, monkeypatch):
        def broken(*_args):
            raise RuntimeError("qdrant down")

        monkeypatch.setattr(folder_channel, "_routes", broken)

        out = await _search(query="Grundriss EG")

        assert "Citation: Grundriss_EG.pdf, p.1" in out
        assert "Folder:" not in out

    async def test_an_empty_search_still_points_at_the_folder(self, channel, monkeypatch):
        monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: _Retriever([]))

        out = await _search(query="Grundriss EG")

        assert "Folder: Einreichung/Pläne" in out
