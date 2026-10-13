"""knowledge_search's narrowing as pre-filters inside the Qdrant query (ADR-0105).

Pure units pin the translation; the rest run against a real Qdrant (see
``test_qdrant_store.py`` for why and how) and drive ``knowledge_search`` itself
through the real adapter, so the join from ``register.search`` through
``prefilter`` and ``scope_filter`` to the server is what is under test, not
each part alone. The metadata store (Postgres, the authority) is stood in for.
"""

from __future__ import annotations

import os
import random
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
from knowledge_layer.qdrant import mirror
from knowledge_layer.qdrant import prefilter
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import document_facts
from knowledge_layer.qdrant.prefilter import Pushdown
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _folder_matches
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection

DIM = 8
PROJECT = "proj_prefilter"
BASE = "oib_knowledge"
TOP_K = 5
#: Dokumentarten from the real vocabulary (``is_valid_doc_class`` refuses others).
REPORT, PERMIT, DRAWING = "sonstiges", "gesetz", "norm_extern"


# ---------------------------------------------------------------- pure units


def test_chroma_gets_no_pushdown_and_keeps_its_over_fetch(monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    assert prefilter.plan(doc_class="plan", folder="A", file_name=None) is None
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")  # dual still READS Chroma
    assert prefilter.plan(doc_class="plan", folder="A", file_name=None) is None
    for narrowing in ({"doc_class": "plan"}, {"folder": "A"}, {"title_contains": "x"}, {"file_name": "a.pdf"}):
        args = {"doc_class": None, "title_contains": None, "file_name": None, "folder": None, **narrowing}
        assert prefilter.post_filtered(None, **args) is True


def test_only_filters_left_after_the_search_over_fetch_on_qdrant(monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    pushdown = prefilter.plan(doc_class="plan", folder="A", file_name=None)
    base = {"doc_class": "plan", "title_contains": None, "file_name": None, "folder": "A"}
    assert prefilter.post_filtered(pushdown, **base) is False
    assert prefilter.post_filtered(pushdown, **{**base, "title_contains": "Statik"}) is True
    assert prefilter.post_filtered(pushdown, **{**base, "file_name": "a.pdf"}) is True


def test_narrow_only_ever_adds_conditions():
    base = {"chunking": {"$ne": "page"}}
    pushdown = Pushdown(doc_class="gesetz", folder="brandschutz")
    assert pushdown.narrow(base, user_shelf=False) == {
        "$and": [base, {"doc_class": "gesetz"}, {"folder_ancestors": "brandschutz"}]
    }
    assert pushdown.narrow(None, user_shelf=True) == {
        "$and": [{"doc_class": "gesetz"}, {"folder_ancestors": "brandschutz"}, {"superseded": {"$ne": True}}]
    }
    assert Pushdown(hide_superseded=False).narrow(base, user_shelf=True) is base
    assert Pushdown().narrow(None, user_shelf=False) is None


def test_trace_fields_name_fields_never_values():
    assert Pushdown(doc_class="gesetz", folder="a").fields(user_shelves=True) == [
        "doc_class",
        "folder_ancestors",
        "superseded",
    ]
    assert Pushdown(hide_superseded=False).fields(user_shelves=True) == []
    assert Pushdown().fields(user_shelves=False) == []


PATHS = [None, "", "Brandschutz", "brandschutz", "Brandschutz/Fluchtwege", "Brandschutz/Fluchtwege/EG"]
PATHS += ["Brandschutzkonzepte", "/Brandschutz/", "Statik", "Pläne/Brandschutz"]


@pytest.mark.parametrize("stored", PATHS)
@pytest.mark.parametrize("requested", [path for path in PATHS if path])
def test_the_folder_pre_filter_agrees_with_the_post_filter(stored, requested):
    """``register._folder_matches`` is the oracle: the payload match must say the same, case and slashes included."""
    key = prefilter.folder_key(requested)
    assert (key in prefilter.folder_ancestors(stored)) is _folder_matches(stored, requested)


def test_facts_state_a_root_folder_so_a_move_to_the_root_clears_the_old_one():
    facts = document_facts(SimpleNamespace(tags=[], topics=[], superseded_by=None, doc_class=None, folder_path=None))
    assert facts["folder_path"] is None and facts["folder_ancestors"] == []
    assert "doc_class" not in facts  # the chunk's own class stands, as for the post-filter


def test_payload_derives_ancestors_from_the_folder_that_won():
    record = ChunkRecord("c1", "Text", [0.1], {"file_name": "a.pdf"})
    payload = build_payload(PROJECT, record, {"folder_path": "Brandschutz/EG", "folder_ancestors": ["bogus"]})
    assert payload["folder_ancestors"] == ["brandschutz", "brandschutz/eg"]
    assert schema.INDEXED_FIELDS >= {"folder_ancestors", "doc_class", "superseded"}


def test_without_files_drops_only_the_named_files():
    chunks = [SimpleNamespace(file_name=name) for name in ("a.pdf", "b.pdf", "a.pdf")]
    assert [chunk.file_name for chunk in prefilter.without_files(chunks, ["a.pdf"])] == ["b.pdf"]


# ---------------------------------------------------------------- real Qdrant


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


@pytest.fixture
def qdrant_env(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"prefilter_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"prefilter_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    store_module.reset_store()
    yield
    client = store_module.make_client()
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)
    store_module.reset_store()


@pytest.fixture
def retriever(qdrant_env, monkeypatch) -> LlamaIndexRetriever:
    instance = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    instance._initialized = True
    monkeypatch.setattr(instance, "_embed_query_cached", lambda query: _vector(query))
    return instance


class _Chroma:
    """The slice of a Chroma collection the mirror reads."""

    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows

    def get(self, *, where: dict[str, Any], include: list[str]) -> dict[str, Any]:
        rows = [row for row in self.rows if row["metadata"]["file_name"] == where["file_name"]]
        return {
            "ids": [row["id"] for row in rows],
            "documents": [row["text"] for row in rows],
            "metadatas": [row["metadata"] for row in rows],
            "embeddings": [row["embedding"] for row in rows],
        }


def _doc(file_name: str, *, folder: str | None = None, doc_class: str | None = None, replaced_by: str | None = None):
    return AvailableDocument(
        file_name=file_name,
        collection=PROJECT,
        shelf="project",
        folder_path=folder,
        doc_class=doc_class,
        superseded_by=replaced_by,
    )


#: The project as the metadata store holds it. ``Altbescheid`` was replaced by
#: ``Bescheid``; ``Plan`` carries the class a person set over its chunks' own guess.
DOCS = [
    _doc("Fluchtwege.pdf", folder="Brandschutz/Fluchtwege", doc_class=REPORT),
    _doc("Brandschutz.pdf", folder="Brandschutz", doc_class=REPORT),
    _doc("Konzept.pdf", folder="Brandschutzkonzepte", doc_class=REPORT),
    _doc("Root.pdf", folder=None, doc_class=REPORT),
    _doc("Bescheid.pdf", folder="Behörde", doc_class=PERMIT),
    _doc("Altbescheid.pdf", folder="Behörde", doc_class=PERMIT, replaced_by="Bescheid.pdf"),
    _doc("Plan.pdf", folder="Behörde", doc_class=DRAWING),
]
#: Chunk-level guesses written at ingestion; the store's class must beat them.
CHUNK_CLASS = {"Plan.pdf": PERMIT}


def _ingest(retriever: LlamaIndexRetriever, monkeypatch, docs=DOCS, skip_facts: frozenset[str] = frozenset()) -> None:
    rows = [
        {
            "id": str(uuid.uuid4()),
            "text": f"Fluchtweg Brandabschnitt Auflage {doc.file_name} Absatz {page}",
            "embedding": _vector(f"{doc.file_name}-{page}"),
            "metadata": {
                "file_name": doc.file_name,
                "page_label": str(page),
                "doc_class": CHUNK_CLASS.get(doc.file_name),
            },
        }
        for doc in docs
        for page in (1, 2)
    ]
    for row in rows:
        row["metadata"] = {key: value for key, value in row["metadata"].items() if value is not None}
    facts = {doc.file_name: document_facts(doc) for doc in docs if doc.file_name not in skip_facts}
    monkeypatch.setattr(
        mirror, "facts_by_file", lambda scope, names=None: {n: facts[n] for n in names or facts if n in facts}
    )
    for doc in docs:
        mirror.mirror_file(_Chroma(rows), PROJECT, doc.file_name, identity=retriever._identity())


async def _files(retriever, filters) -> set[str]:
    result = await retriever.retrieve("Fluchtweg Auflage", PROJECT, top_k=50, filters=filters)
    assert result.success, result.error_message
    return {chunk.file_name for chunk in result.chunks}


async def test_doc_class_narrows_and_the_stored_class_beats_the_chunks_guess(retriever, monkeypatch):
    _ingest(retriever, monkeypatch)
    found = await _files(retriever, Pushdown(doc_class=PERMIT, hide_superseded=False).narrow(None, user_shelf=True))
    # Plan.pdf's chunks guess PERMIT; a person said DRAWING, and the person wins.
    assert found == {"Bescheid.pdf", "Altbescheid.pdf"}


async def test_folder_reads_the_subtree_and_nothing_beside_it(retriever, monkeypatch):
    _ingest(retriever, monkeypatch)
    narrowing = Pushdown(folder=prefilter.folder_key("/brandschutz/"), hide_superseded=False)
    assert await _files(retriever, narrowing.narrow(None, user_shelf=True)) == {"Brandschutz.pdf", "Fluchtwege.pdf"}
    deeper = Pushdown(folder=prefilter.folder_key("Brandschutz/Fluchtwege"), hide_superseded=False)
    assert await _files(retriever, deeper.narrow(None, user_shelf=True)) == {"Fluchtwege.pdf"}


async def test_superseded_is_hidden_on_user_shelves_unless_a_file_is_named(retriever, monkeypatch):
    _ingest(retriever, monkeypatch, skip_facts=frozenset({"Root.pdf"}))
    everything = {doc.file_name for doc in DOCS}
    hidden = await _files(retriever, Pushdown().narrow(None, user_shelf=True))
    # A point the mirror never stamped (Root.pdf) is kept: `$ne` keeps a missing field.
    assert hidden == everything - {"Altbescheid.pdf"}
    assert await _files(retriever, Pushdown(hide_superseded=False).narrow(None, user_shelf=True)) == everything
    assert await _files(retriever, Pushdown().narrow(None, user_shelf=False)) == everything


def test_ingest_keeps_the_jobs_folder_until_the_store_has_one(retriever, monkeypatch):
    """The store row may not hold the folder yet when the chunks land; its None must not erase the job's."""
    doc = _doc("Neu.pdf", folder=None)
    monkeypatch.setattr(mirror, "facts_by_file", lambda scope, names=None: {"Neu.pdf": document_facts(doc)})
    row = {"id": str(uuid.uuid4()), "text": "Text", "embedding": _vector("neu"), "metadata": {"file_name": "Neu.pdf"}}
    config = {"folder_path": "Brandschutz/EG"}
    mirror.mirror_file(_Chroma([row]), PROJECT, "Neu.pdf", identity=retriever._identity(), config=config)
    store = store_module.get_store()
    assert store.count(PROJECT, {"folder_ancestors": "brandschutz"}) == 1

    mirror.refresh_facts(PROJECT, ["Neu.pdf"])  # the store now says: the root
    assert store.count(PROJECT, {"folder_ancestors": "brandschutz"}) == 0


def test_a_collection_made_before_the_field_gets_its_index_on_first_read(qdrant_env, monkeypatch):
    """The migration: an old collection lacks ``folder_ancestors``; strict mode refuses it until a process adds it."""
    from qdrant_client import models

    store = store_module.get_store({"aiq:embed_fingerprint": "fp", "aiq:embed_model": "m"})
    current_fields = schema.INDEXED_FIELDS
    old_fields = current_fields - {"folder_ancestors"}
    monkeypatch.setattr(schema, "INDEXED_FIELDS", old_fields)
    store.upsert(PROJECT, [ChunkRecord(str(uuid.uuid4()), "Text", _vector("x"), {"file_name": "a.pdf"})])
    alias = store.alias(PROJECT)
    assert "folder_ancestors" not in store.client.get_collection(alias).payload_schema
    folder = models.Filter(must=[models.FieldCondition(key="folder_ancestors", match=models.MatchValue(value="a"))])
    with pytest.raises(Exception, match="(?i)index"):
        store.client.count(alias, count_filter=folder, exact=True)

    monkeypatch.setattr(schema, "INDEXED_FIELDS", current_fields)  # this code's list again
    reader = store_module.QdrantStore(store.client)  # a fresh process that only reads
    assert reader.exists(PROJECT)
    assert "folder_ancestors" in store.client.get_collection(alias).payload_schema
    assert reader.count(PROJECT, {"folder_ancestors": "a"}) == 0
    assert schema.ensure_payload_indexes(store.client, alias) == []  # idempotent


# ---------------------------------------------------------------- knowledge_search, end to end


class _Recording:
    """The real adapter, with every ``retrieve`` call's budget and filter written down."""

    def __init__(self, inner: LlamaIndexRetriever):
        self.inner = inner
        self.calls: list[dict[str, Any]] = []

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.calls.append({"collection": collection_name, "top_k": top_k, "filters": filters})
        return await self.inner.retrieve(query, collection_name, top_k=top_k, filters=filters)


def _harness(monkeypatch, inner: Any):
    """``knowledge_search`` over base + project on ``inner``, Postgres stood in by DOCS."""
    by_name = {doc.file_name: doc for doc in DOCS}
    replaced = {PROJECT: {d.file_name: d.superseded_by for d in DOCS if d.superseded_by}}
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)

    def column(name: str):
        return lambda _c, files: {
            f: getattr(by_name[f], name) for f in files if f in by_name and getattr(by_name[f], name)
        }

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_document_doc_classes", column("doc_class"))
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_document_folder_paths", column("folder_path"))
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_document_display_titles", lambda _c, _f: {})
    monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", lambda collection: replaced.get(collection, {}))
    scope = [ScopedCollection(BASE, Shelf.BASE), ScopedCollection(PROJECT, Shelf.PROJECT)]
    monkeypatch.setattr("aiq_agent.knowledge.scoping.get_scoped_collections_from_context", lambda: scope)
    spans: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "aiq_agent.observability.retrieval_trace.emit_retrieval_span",
        lambda *, tool_name, search_input, picks: spans.append(search_input),
    )
    recording = _Recording(inner)
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: recording)
    set_turn_documents(DOCS)

    async def run(**kwargs) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
        recording.calls.clear()
        config = KnowledgeRetrievalConfig(
            collection_name=BASE,
            include_base_collection=True,
            include_session_collection=False,
            generate_summary=False,
            top_k=TOP_K,
            max_chunks_per_document=0,
        )
        async with knowledge_retrieval(config, MagicMock()) as info:
            out = await info.single_fn(info.input_schema(query="Fluchtweg Auflage", **kwargs))
        return out, list(recording.calls), spans[-1]

    return run


@pytest.fixture
def search(retriever, monkeypatch):
    """``knowledge_search`` on the real store."""
    run = _harness(monkeypatch, retriever)
    run.ingest = lambda **kw: _ingest(retriever, monkeypatch, **kw)
    yield run
    set_turn_documents(None)


class _Nothing:
    """A store that finds nothing: for tests about what is ASKED of it."""

    backend_name = "fake"
    embed_model_name = "fake-embedder"

    async def retrieve(self, query, collection_name, top_k, filters=None):
        return RetrievalResult(chunks=[], query=query, backend="fake", success=True)


async def test_chroma_keeps_its_over_fetch_and_file_lists(monkeypatch):
    """The default backend is untouched: 3 x top_k, ``$in`` for a folder, ``$nin`` for replaced Fassungen."""
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    run = _harness(monkeypatch, _Nothing())
    try:
        _, calls, span = await run(doc_class=REPORT, folder="Behörde")
    finally:
        set_turn_documents(None)
    project = [call for call in calls if call["collection"] == PROJECT]
    assert calls and all(call["top_k"] == TOP_K * 3 for call in calls)
    names = sorted(doc.file_name for doc in DOCS if doc.folder_path == "Behörde")
    assert project[0]["filters"] == {
        "$and": [{"file_name": {"$in": names}}, {"file_name": {"$nin": ["Altbescheid.pdf"]}}]
    }
    assert "prefiltered" not in span and span["vector_backend"] == "chroma"


def _cited_files(out: str) -> set[str]:
    return {
        line.split("Citation: ", 1)[1].split(",")[0].split(" (")[0]
        for line in out.splitlines()
        if line.startswith("Citation: ")
    }


def _uses_file_lists(filters: Any) -> bool:
    return "file_name" in repr(filters)


async def test_doc_class_and_folder_run_inside_the_search_with_no_over_fetch(search):
    search.ingest()
    out, calls, span = await search(doc_class=REPORT, folder="Brandschutz")

    assert calls and all(call["top_k"] == TOP_K for call in calls)  # no 3x over-fetch
    project = [call["filters"] for call in calls if call["collection"] == PROJECT]
    assert project and not any(_uses_file_lists(flt) for flt in project)
    assert all("folder_ancestors" in repr(flt) and "doc_class" in repr(flt) for flt in project)
    assert _cited_files(out) == {"Brandschutz.pdf", "Fluchtwege.pdf"}
    assert span["vector_backend"] == "qdrant"
    assert span["prefiltered"] == ["doc_class", "folder_ancestors", "superseded"]


async def test_a_replaced_fassung_stays_out_without_a_file_list(search):
    search.ingest()
    out, calls, _ = await search(doc_class=PERMIT)
    assert not any(_uses_file_lists(call["filters"]) for call in calls)
    assert all(call["top_k"] == TOP_K for call in calls)
    assert _cited_files(out) == {"Bescheid.pdf"}


async def test_a_stale_mirror_never_shows_a_replaced_fassung(search):
    """Postgres says replaced, the payload never heard: the backstop still drops it."""
    search.ingest(skip_facts=frozenset({"Altbescheid.pdf"}))
    # `title_contains` over-fetches the whole pool (3 x 5 >= 14 chunks), so the
    # unstamped Fassung IS retrieved: only the backstop stands between it and the answer.
    out, calls, _ = await search(title_contains="bescheid")
    assert all(call["top_k"] >= 2 * len(DOCS) for call in calls)
    assert _cited_files(out) == {"Bescheid.pdf"}


async def test_title_contains_is_still_a_post_filter_and_over_fetches(search):
    search.ingest()
    out, calls, span = await search(title_contains="bescheid")
    assert calls and all(call["top_k"] == TOP_K * 3 for call in calls)
    assert _cited_files(out) == {"Bescheid.pdf"}
    assert span["prefiltered"] == ["superseded"]
