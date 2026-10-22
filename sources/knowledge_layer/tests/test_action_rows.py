"""One Herleitung row per evidence call (ADR-0131): ``knowledge_search``, ``read_passage``, ``list_files``.

Each call emits one ``running`` step and settles it under the same id, from the values the tool holds
(chunks ranked, groups counted, rows listed), never from its text.
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer import browse
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection

rp = importlib.import_module("knowledge_layer.read_passage")

BASE = "oib_knowledge"
OIB = "oib-rl_2_ausgabe_mai_2023.pdf"


@pytest.fixture
def rows(monkeypatch) -> list:
    """The action steps written during the test, in order."""
    bodies: list = []
    monkeypatch.setattr("aiq_agent.common.turn_status.get_stream_writer", lambda: bodies.append)
    return bodies


def _actions(bodies: list) -> list:
    return [body.step for body in bodies if body.step.kind == "action"]


def _one_call(bodies: list):
    """Exactly one start and one finish under one id; returns (started, finished)."""
    steps = _actions(bodies)
    assert [step.status for step in steps][0] == "running"
    assert len(steps) == 2
    assert steps[0].id == steps[1].id
    return steps[0], steps[1]


def _chunk(file_name: str, page: int, clause: str = "3.5") -> Chunk:
    return Chunk(
        chunk_id=f"{file_name}:{page}:{clause}",
        content=f"{clause} Text",
        score=0.7,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={
            "chunking": "clause",
            "clause_id": clause,
            "clause_depth": 2,
            "clause_title": "T",
            "page_label": str(page),
        },
    )


class _Store:
    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, chunks: list[Chunk], error: str | None = None):
        self.chunks = chunks
        self.error = error

    async def retrieve(self, query, collection_name, top_k, filters=None):
        if self.error:
            raise RuntimeError(self.error)
        return RetrievalResult(
            chunks=[c.model_copy(deep=True) for c in self.chunks], query=query, backend="fake", success=True
        )


@pytest.fixture
def corpus(monkeypatch):
    def install(chunks: list[Chunk], error: str | None = None) -> _Store:
        store = _Store(chunks, error)

        async def _documents(collection: str):
            return [SimpleNamespace(file_name=OIB, display_title=None, summary=None, tags=None)]

        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: store)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: store)
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
            lambda: [ScopedCollection(BASE, Shelf.BASE)],
        )
        for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
            monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        return store

    return install


def _config() -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name=BASE,
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
    )


async def _search(**kwargs) -> str:
    async with knowledge_retrieval(_config(), MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestKnowledgeSearchRow:
    async def test_a_ranked_search_states_query_mode_and_counts(self, corpus, rows) -> None:
        corpus([_chunk(OIB, 12), _chunk(OIB, 13, "3.6"), _chunk("other.pdf", 2)])

        await _search(query="Fluchtweglänge", folder="", shelf="base")

        started, finished = _one_call(rows)
        assert (started.verb, started.query, started.mode, started.shelf) == (
            "search",
            "Fluchtweglänge",
            "meaning",
            "base",
        )
        assert finished.status == "ok"
        assert finished.counts.hits == 3
        assert finished.counts.documents == 2
        assert finished.elapsed_ms is not None

    async def test_nothing_found_settles_empty(self, corpus, rows) -> None:
        corpus([])

        await _search(query="Fluchtweglänge")

        assert _one_call(rows)[1].status == "empty"
        assert _one_call(rows)[1].counts.hits == 0

    async def test_a_search_that_raises_settles_error(self, corpus, rows, monkeypatch) -> None:
        corpus([_chunk(OIB, 1)])

        def _boom(*args, **kwargs):
            raise RuntimeError("boom")

        monkeypatch.setattr("knowledge_layer.register._merge_results", _boom)

        await _search(query="Fluchtweglänge")

        assert _one_call(rows)[1].status == "error"

    async def test_a_refusal_is_an_error_row(self, corpus, rows) -> None:
        corpus([_chunk(OIB, 1)])

        await _search(query="x", match="exact", group_by="document")

        started, finished = _one_call(rows)
        assert started.mode == "exact"
        assert finished.status == "error"

    async def test_an_exact_search_counts_matches_files_and_the_denominator(self, corpus, rows, monkeypatch) -> None:
        store = corpus([])
        chunk = _chunk(OIB, 12).model_copy(update={"content": "Brandabschnitt hier. Brandabschnitt dort."})

        async def _find_text(collection, pattern, filters=None, limit=None, **options):
            return [chunk.model_copy(deep=True)]

        async def _reads(search_config, narrowed, folder):
            return {BASE: 30}

        store.find_text = _find_text
        monkeypatch.setattr(browse, "_searched_documents", _reads)

        await _search(query="Brandabschnitt", match="exact")

        started, finished = _one_call(rows)
        assert (started.verb, started.mode) == ("search", "exact")
        assert finished.status == "ok"
        assert (finished.counts.hits, finished.counts.documents, finished.counts.searched) == (2, 1, 30)

    async def test_an_exact_search_with_no_match_is_empty_and_keeps_its_denominator(
        self, corpus, rows, monkeypatch
    ) -> None:
        store = corpus([])

        async def _find_text(collection, pattern, filters=None, limit=None, **options):
            return []

        async def _reads(search_config, narrowed, folder):
            return {BASE: 30}

        store.find_text = _find_text
        monkeypatch.setattr(browse, "_searched_documents", _reads)

        await _search(query="Brandabschnitt", match="exact")

        finished = _one_call(rows)[1]
        assert finished.status == "empty"
        assert finished.counts.searched == 30

    async def test_the_folder_is_the_target(self, corpus, rows) -> None:
        corpus([_chunk(OIB, 1)])

        await _search(query="Brandabschnitt", folder="/Einreichung/")

        assert _one_call(rows)[0].target == "Einreichung"


class TestReadPassageRow:
    async def _read(self, **kwargs) -> str:
        builder = MagicMock()
        builder.get_function_config = MagicMock(return_value=_config())
        async with rp.read_passage(rp.ReadPassageConfig(), builder) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_a_clause_read_names_document_and_clause(self, corpus, rows) -> None:
        corpus([_chunk(OIB, 12, "3.5")])

        await self._read(document=OIB, clause="3.5")

        started, finished = _one_call(rows)
        assert (started.verb, started.target, started.pages) == ("read", OIB, "Pkt. 3.5")
        assert finished.status == "ok"
        assert finished.counts.hits == 1

    async def test_a_page_range_travels_raw(self, corpus, rows) -> None:
        corpus([_chunk(OIB, 2)])

        await self._read(document=OIB, pages="2-3")

        assert _one_call(rows)[0].pages == "2-3"

    async def test_an_unknown_document_is_an_error_row(self, corpus, rows) -> None:
        corpus([])

        await self._read(document="gibt-es-nicht.pdf", clause="1")

        assert _one_call(rows)[1].status == "error"


def _file(name: str, folder: str) -> browse.FileRow:
    return browse.FileRow(file_name=name, shelf="project", collection="proj_1", folder=folder)


class TestListFilesRow:
    @pytest.fixture
    def listed(self, monkeypatch):
        files = [_file("a.pdf", "Einreichung/Pläne"), _file("b.pdf", "Einreichung/Pläne"), _file("c.pdf", "Statik")]

        async def _rows(search_config):
            return files

        monkeypatch.setattr(browse, "_turn_rows", _rows)
        monkeypatch.setattr(browse, "_in_flight", lambda collections: [])

    async def _list(self, **kwargs) -> str:
        builder = MagicMock()
        builder.get_function_config = MagicMock(return_value=_config())
        async with browse.list_files(browse.ListFilesConfig(), builder) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_a_folder_listing_counts_files_and_folders(self, listed, rows) -> None:
        await self._list(folder="Einreichung")

        started, finished = _one_call(rows)
        assert (started.verb, started.target) == ("list", "Einreichung")
        assert finished.status == "ok"
        assert (finished.counts.files, finished.counts.folders) == (2, 1)

    async def test_a_name_filter_is_the_query_and_no_match_is_empty(self, listed, rows) -> None:
        await self._list(name_contains="zzz")

        started, finished = _one_call(rows)
        assert started.query == "zzz"
        assert finished.status == "empty"

    async def test_a_refusal_is_an_error_row(self, listed, rows) -> None:
        await self._list(sort="sideways")

        assert _one_call(rows)[1].status == "error"
