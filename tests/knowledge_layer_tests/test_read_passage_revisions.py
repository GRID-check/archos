"""`read_passage` reads an older Fassung on request, and says that it is one.

A file a person confirmed as replaced stays readable by name: „was stand in Index B“ is a
real question. What the read must not do is hand the passage over as the document's current
state, so the result opens with one line naming the current Fassung, through the same notice
slot „Ältere Fassungen ausgeblendet“ uses in the search (the block's hash still matches). The
current Fassung itself, and a file nobody replaced, read exactly as before.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.read_passage import ReadPassageConfig
from sources.knowledge_layer.src.read_passage import _current_revision
from sources.knowledge_layer.src.read_passage import read_passage
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

PROJECT = "proj_1"
NOTICE = "Ältere Fassung:"


def _doc(name: str, **extra) -> AvailableDocument:
    return AvailableDocument(file_name=name, collection=PROJECT, shelf="project", **extra)


DOCS = [
    _doc("Statik_Index_A.pdf", superseded_by="Statik_Index_B.pdf"),
    _doc("Statik_Index_B.pdf", superseded_by="Statik_Index_C.pdf", supersedes=["Statik_Index_A.pdf"]),
    _doc("Statik_Index_C.pdf", supersedes=["Statik_Index_B.pdf"]),
    _doc("Brandschutz.pdf"),
]


def _chunk(name: str = "Statik_Index_B.pdf") -> Chunk:
    return Chunk(
        chunk_id=f"{name}-1",
        content="Die Bewehrung der Decke beträgt 10 mm.",
        score=0.7,
        file_name=name,
        page_number=1,
        display_citation=f"{name}, p.1",
        content_type=ContentType.TEXT,
        metadata={"punkt_id": "2.1", "page_label": "1", "collection": PROJECT},
    )


class _Store:
    def __init__(self, chunk: Chunk):
        self.chunk = chunk
        self.calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters):
        self.calls.append({"collection": collection_name, "filters": filters})
        return SimpleNamespace(chunks=[self.chunk.model_copy(deep=True)], success=True, error_message=None)


@pytest.fixture
def store(monkeypatch):
    handle = _Store(_chunk())
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: handle)

    async def _documents(collection: str):
        return list(DOCS) if collection == PROJECT else []

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    return handle


async def _read(**kwargs) -> str:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name=PROJECT, include_base_collection=False)
    )
    async with read_passage(ReadPassageConfig(), builder) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestAnOlderRevisionIsReadOnRequestAndSaysSo:
    async def test_it_is_read_not_refused_and_the_passage_is_there(self, store):
        out = await _read(document="Statik_Index_B.pdf", punkt="2.1")

        assert "Die Bewehrung der Decke beträgt 10 mm." in out
        assert "Citation: Statik_Index_B.pdf, p.1" in out
        # The read addresses the older file: nothing was excluded from the fetch.
        assert all("$nin" not in repr(call["filters"]) for call in store.calls)

    async def test_the_first_line_names_the_current_revision_at_the_end_of_the_chain(self, store):
        out = await _read(document="Statik_Index_A.pdf", punkt="2.1")

        first = out.splitlines()[0]
        assert first.startswith(NOTICE)
        assert "Statik_Index_A.pdf" in first and "Statik_Index_C.pdf" in first
        assert "Statik_Index_B.pdf" not in first

    async def test_one_line_only_and_before_the_block(self, store):
        out = await _read(document="Statik_Index_B.pdf", punkt="2.1")

        assert out.count(NOTICE) == 1
        assert out.index(NOTICE) < out.index("Citation:")

    async def test_the_outline_of_an_older_revision_says_so_too(self, store):
        out = await _read(document="Statik_Index_B.pdf")

        assert out.splitlines()[0].startswith(NOTICE)

    async def test_the_current_revision_reads_without_a_notice(self, store):
        out = await _read(document="Statik_Index_C.pdf", punkt="2.1")

        assert NOTICE not in out

    async def test_a_file_nobody_replaced_reads_without_a_notice(self, store):
        out = await _read(document="Brandschutz.pdf", punkt="2.1")

        assert NOTICE not in out


class TestTheNoticeKeepsTheBlockReadable:
    async def test_the_citation_registry_still_reads_the_records_not_the_text(self, store):
        """The notice rides the block's slot, so the hash of the bytes the model reads still matches."""
        from aiq_agent.common.grounding_block import begin_grounding_capture
        from aiq_agent.common.grounding_block import end_grounding_capture
        from aiq_agent.common.grounding_block import get_grounding_block

        token = begin_grounding_capture()
        try:
            out = await _read(document="Statik_Index_B.pdf", punkt="2.1")
            block = get_grounding_block(out)
        finally:
            end_grounding_capture(token)

        assert block is not None
        assert [hit.file_name for hit in block.hits] == ["Statik_Index_B.pdf"]


class TestTheChainIsFollowedSafely:
    def test_a_replacement_that_is_gone_leaves_the_file_current(self):
        docs = [_doc("a.pdf", superseded_by="weg.pdf")]
        assert _current_revision(docs[0], docs) is None

    def test_a_loop_stops_where_it_closes(self):
        docs = [_doc("a.pdf", superseded_by="b.pdf"), _doc("b.pdf", superseded_by="a.pdf")]
        assert _current_revision(docs[0], docs) == "b.pdf"

    def test_a_row_without_the_field_is_current(self):
        plain = SimpleNamespace(file_name="x.pdf", display_title=None)
        assert _current_revision(plain, [plain]) is None
