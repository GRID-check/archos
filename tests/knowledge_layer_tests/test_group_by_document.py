"""``knowledge_search(group_by="document")``: one entry per document (ADR-0127, S7).

The grouping is a pure function over the ranked pool (``document_groups``), so
ranking is untouched: a document's place is its best passage's place. Keyed by
``grid_document_id``, by collection and file name where a point has none. The
end-to-end tests drive the tool through a fake retriever and read the grounding
records back, which is how a citation is checked: only the passages shown are
citable.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.document_groups import document_key
from knowledge_layer.document_groups import group_by_document
from knowledge_layer.document_groups import render_document_groups
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import get_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection

PROJECT = "proj_1"


def _chunk(file_name: str, page: int, *, document_id: str | None = None, collection: str = PROJECT) -> Chunk:
    metadata = {"collection": collection, "page_label": str(page)}
    if document_id:
        metadata["grid_document_id"] = document_id
    return Chunk(
        chunk_id=f"{collection}-{file_name}-{page}",
        content=f"Aufzug Schachtgröße, Seite {page} von {file_name}.",
        score=0.9,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata=metadata,
    )


class TestTheGrouping:
    def test_one_group_per_document_in_the_order_of_its_best_passage(self):
        ordered = [
            _chunk("A.pdf", 3, document_id="d-a"),
            _chunk("A.pdf", 5, document_id="d-a"),
            _chunk("B.pdf", 1, document_id="d-b"),
            _chunk("A.pdf", 9, document_id="d-a"),
            _chunk("C.pdf", 2, document_id="d-c"),
        ]

        groups = group_by_document(ordered)

        assert [group.best.chunk_id for group in groups] == [
            f"{PROJECT}-A.pdf-3",
            f"{PROJECT}-B.pdf-1",
            f"{PROJECT}-C.pdf-2",
        ]
        assert [group.passages for group in groups] == [3, 1, 1]
        assert groups[0].pages == (3, 5, 9)

    def test_the_id_wins_over_the_name_and_the_name_is_the_fallback(self):
        renamed = _chunk("Gutachten_neu.pdf", 1, document_id="d-1")
        same_document = _chunk("Gutachten_alt.pdf", 2, document_id="d-1")
        no_id_here = _chunk("Gutachten_neu.pdf", 3)
        no_id_elsewhere = _chunk("Gutachten_neu.pdf", 4, collection="proj_2")

        groups = group_by_document([renamed, same_document, no_id_here, no_id_elsewhere])

        assert document_key(renamed) == ("id", "d-1")
        assert document_key(no_id_here) == ("file", PROJECT, "Gutachten_neu.pdf")
        assert [group.passages for group in groups] == [2, 1, 1]

    def test_a_document_the_reranker_trimmed_still_counts_and_comes_after_the_kept_ones(self):
        pool = [_chunk("A.pdf", 1), _chunk("B.pdf", 1), _chunk("A.pdf", 2), _chunk("C.pdf", 1)]
        reranked = [pool[1], pool[0]]

        groups = group_by_document(reranked, pool)

        assert [group.best.file_name for group in groups] == ["B.pdf", "A.pdf", "C.pdf"]
        assert [group.passages for group in groups] == [1, 2, 1]

    def test_a_passage_in_both_lists_counts_once(self):
        chunk = _chunk("A.pdf", 1)

        [group] = group_by_document([chunk], [chunk])

        assert group.passages == 1

    def test_the_trailer_names_each_document_its_count_and_its_pages(self):
        groups = group_by_document([_chunk("A.pdf", 3), _chunk("A.pdf", 5), _chunk("B|C.pdf", 1)])

        trailer = render_document_groups(groups, 3)

        assert trailer.startswith("## Documents (2, grouped from 3 ranked passages)")
        assert "| 1 | A.pdf | 2 | 3, 5 |" in trailer
        assert "| 2 | B/C.pdf | 1 | 1 |" in trailer
        assert "a literal search counts every mention" in trailer

    def test_many_pages_are_counted_not_listed(self):
        group = SimpleNamespace(best=SimpleNamespace(file_name="A.pdf"), passages=12, pages=tuple(range(1, 13)))

        assert "1, 2, 3, 4, 5, 6, 7, 8 (+4 more)" in render_document_groups([group], 12)

    def test_no_groups_render_nothing(self):
        assert render_document_groups([], 0) == ""


# ---------------------------------------------------------------------------
# Through the tool
# ---------------------------------------------------------------------------


class _Retriever:
    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, pool: list[Chunk]):
        self.pool = pool
        self.top_k: list[int] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.top_k.append(top_k)
        chunks = [chunk.model_copy(deep=True) for chunk in self.pool[:top_k]] if collection_name == PROJECT else []
        return RetrievalResult(chunks=chunks, query=query, backend="fake", success=True)


@pytest.fixture
def retriever(monkeypatch):
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", lambda collection: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    set_turn_documents([])
    pool = [
        _chunk("Baubeschreibung.pdf", 4, document_id="d-bb"),
        _chunk("Baubeschreibung.pdf", 7, document_id="d-bb"),
        _chunk("Baubeschreibung.pdf", 8, document_id="d-bb"),
        _chunk("Aufzug_Angebot.pdf", 1, document_id="d-auf"),
        _chunk("Baubeschreibung.pdf", 12, document_id="d-bb"),
        _chunk("Brandschutz.pdf", 2, document_id="d-bs"),
    ]
    fake = _Retriever(pool)
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: fake)
    yield fake
    set_turn_documents(None)


async def _search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_session_collection=False,
        project_collections=[PROJECT],
        top_k=2,
        max_chunks_per_document=2,
    )
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _cited(out: str) -> list[str]:
    return [line.split("Citation: ", 1)[1] for line in out.splitlines() if line.startswith("Citation: ")]


class TestThroughTheTool:
    async def test_one_passage_per_document_and_the_table_under_them(self, retriever):
        out = await _search(query="Aufzug", group_by="document")

        assert _cited(out) == ["Baubeschreibung.pdf, p.4", "Aufzug_Angebot.pdf, p.1"]
        assert "| 1 | Baubeschreibung.pdf | 4 | 4, 7, 8, 12 |" in out
        assert "| 2 | Aufzug_Angebot.pdf | 1 | 1 |" in out
        assert "grouped from 6 ranked passages" in out

    async def test_only_the_passages_shown_are_citable(self, retriever):
        token = begin_grounding_capture()
        try:
            out = await _search(query="Aufzug", group_by="document")
            block = get_grounding_block(out)
        finally:
            end_grounding_capture(token)

        assert block is not None
        assert [hit.citation_key for hit in block.hits] == ["Baubeschreibung.pdf, p.4", "Aufzug_Angebot.pdf, p.1"]

    async def test_the_pool_is_overfetched_so_there_are_documents_to_group(self, retriever):
        await _search(query="Aufzug", group_by="document")

        assert max(retriever.top_k) >= 2 * 4

    async def test_without_grouping_the_search_is_as_it_was(self, retriever):
        out = await _search(query="Aufzug")

        assert "## Documents" not in out
        assert _cited(out) == ["Baubeschreibung.pdf, p.4", "Baubeschreibung.pdf, p.7"]

    async def test_an_exact_search_is_told_it_already_counts_per_file(self, retriever):
        out = await _search(query="Aufzug", match="exact", group_by="document")

        assert out.startswith('`group_by="document"` groups a ranked search.')
