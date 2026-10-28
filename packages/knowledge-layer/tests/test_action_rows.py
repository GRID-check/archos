"""One Herleitung row per evidence call (ADR-0132): ``knowledge_search``, ``read_passage``, ``list_files``.

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

        monkeypatch.setattr("knowledge_layer.fusion.merge_results", _boom)

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

    async def test_the_row_counts_a_place_once_not_its_breadcrumb_nor_its_overlap(
        self, corpus, rows, monkeypatch
    ) -> None:
        store = corpus([])
        overlap = "Die Fluchtwegbreite im Stiegenhaus beträgt an jeder Stelle mindestens einen Meter zwanzig."
        path = "3 Flucht- und Rettungswege"
        part_one = _chunk(OIB, 12, "3.1").model_copy(
            update={
                "content": f"{OIB}\n3 Flucht- und Rettungswege\n\n3.1 Fluchtwege. Einleitung. {overlap}",
                "metadata": {"chunking": "clause", "clause_id": "3.1", "clause_path": f"{path} › 3.1 Fluchtwege"},
            }
        )
        part_two = part_one.model_copy(
            update={"chunk_id": "two", "content": f"{overlap} Danach folgt der Rest des Punktes."}
        )
        part_one.metadata["chunk_ordinal"], part_two.metadata = 4, {**part_one.metadata, "chunk_ordinal": 5}

        async def _find_text(collection, pattern, filters=None, limit=None, **options):
            return [part_one.model_copy(deep=True), part_two.model_copy(deep=True)]

        async def _reads(search_config, narrowed, folder):
            return {BASE: 30}

        store.find_text = _find_text
        monkeypatch.setattr(browse, "_searched_documents", _reads)

        await _search(query="Flucht", match="exact")

        # Before: 4 (the ancestor line in the header, the Punkt's own line, the overlap twice).
        assert _one_call(rows)[1].counts.hits == 2

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


#: A restricted folder's collection (``proj_<id>_r<12 hex>``), drawable but not admitted unless a test admits it.
RESTRICTED = "proj_a_r0123456789ab"
SECRET = "Gehaltsliste.pdf"


@pytest.fixture
def restricted(corpus, monkeypatch):
    """Scope the turn to one restricted folder holding :data:`SECRET`; ``admit()`` admits it for the turn."""

    def install(chunks: list[Chunk]) -> _Store:
        store = corpus(
            [chunk.model_copy(update={"metadata": {**chunk.metadata, "collection": RESTRICTED}}) for chunk in chunks]
        )

        async def _documents(collection: str):
            if collection != RESTRICTED:
                return []
            return [SimpleNamespace(file_name=SECRET, display_title=None, summary=None, tags=None)]

        monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
            lambda: [ScopedCollection(RESTRICTED, Shelf.PROJECT)],
        )
        return store

    return install


@pytest.fixture
def admit(monkeypatch):
    """Call it to admit :data:`RESTRICTED` for the turn."""
    from aiq_agent.knowledge.restricted_use import RestrictedUse

    def _admit() -> None:
        use = RestrictedUse("org", "user", "conv", "proj", drawable={RESTRICTED}, admitted={RESTRICTED})
        monkeypatch.setattr("aiq_agent.knowledge.restricted_use.current_restricted_use", lambda: use)

    return _admit


class TestRestrictedFoldersStayUnnamedOnTheRow:
    """A row settles before the round is admitted: it names and counts only what the model may be told (ADR-0088)."""

    async def _read(self, **kwargs) -> str:
        return await TestReadPassageRow._read(self, **kwargs)

    async def test_a_search_does_not_count_unadmitted_hits(self, restricted, rows) -> None:
        restricted([_chunk(SECRET, 1), _chunk(SECRET, 2, "3.6")])

        await _search(query="Gehalt")

        finished = _one_call(rows)[1]
        assert finished.status == "ok"
        assert finished.counts is None

    async def test_a_search_counts_once_the_folder_is_admitted(self, restricted, rows, admit) -> None:
        restricted([_chunk(SECRET, 1), _chunk(SECRET, 2, "3.6")])
        admit()

        await _search(query="Gehalt")

        assert _one_call(rows)[1].counts.hits == 2

    async def test_an_exact_search_does_not_count_unadmitted_matches(self, restricted, rows, monkeypatch) -> None:
        store = restricted([])
        chunk = _chunk(SECRET, 3).model_copy(
            update={"content": "Gehalt hier. Gehalt dort.", "metadata": {"collection": RESTRICTED}}
        )

        async def _find_text(collection, pattern, filters=None, limit=None, **options):
            return [chunk.model_copy(deep=True)]

        async def _reads(search_config, narrowed, folder):
            return {}

        store.find_text = _find_text
        monkeypatch.setattr(browse, "_searched_documents", _reads)

        await _search(query="Gehalt", match="exact")

        finished = _one_call(rows)[1]
        assert finished.status == "ok"
        assert finished.counts is None

    async def test_a_read_that_finds_nothing_names_no_file(self, restricted, rows) -> None:
        restricted([])

        await self._read(document="gehaltsliste.pdf", clause="1")

        started, finished = _one_call(rows)
        assert finished.status == "error"
        assert finished.target == started.target == "gehaltsliste.pdf"
        assert finished.counts is None

    async def test_a_read_keeps_the_asked_name_and_counts_nothing(self, restricted, rows) -> None:
        restricted([_chunk(SECRET, 12, "3.5")])

        await self._read(document="gehaltsliste.pdf", clause="3.5")

        finished = _one_call(rows)[1]
        assert finished.status == "ok"
        assert finished.target == "gehaltsliste.pdf"
        assert finished.counts is None

    async def test_an_outline_of_an_unadmitted_document_names_no_file(self, restricted, rows) -> None:
        restricted([])

        await self._read(document="gehaltsliste.pdf")

        finished = _one_call(rows)[1]
        assert (finished.status, finished.target, finished.counts) == ("error", "gehaltsliste.pdf", None)

    async def test_a_page_range_of_an_unadmitted_document_names_no_file(self, restricted, rows) -> None:
        restricted([])

        await self._read(document="gehaltsliste.pdf", pages="2-3")

        finished = _one_call(rows)[1]
        assert (finished.status, finished.target, finished.counts) == ("error", "gehaltsliste.pdf", None)

    async def test_an_admitted_read_names_the_file_and_counts(self, restricted, rows, admit) -> None:
        restricted([_chunk(SECRET, 12, "3.5")])
        admit()

        await self._read(document="gehaltsliste.pdf", clause="3.5")

        finished = _one_call(rows)[1]
        assert (finished.status, finished.target, finished.counts.hits) == ("ok", SECRET, 1)


class TestExactSearchPartialFailure:
    async def test_no_match_while_a_collection_failed_is_an_error(self, corpus, rows, monkeypatch) -> None:
        store = corpus([])
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
            lambda: [ScopedCollection(BASE, Shelf.BASE), ScopedCollection("proj_1", Shelf.PROJECT)],
        )

        async def _find_text(collection, pattern, filters=None, limit=None, **options):
            if collection == "proj_1":
                raise RuntimeError("store down")
            return []

        async def _reads(search_config, narrowed, folder):
            return {}

        store.find_text = _find_text
        monkeypatch.setattr(browse, "_searched_documents", _reads)

        result = await _search(query="Brandabschnitt", match="exact")

        assert "NOT a no" in result
        assert _one_call(rows)[1].status == "error"
