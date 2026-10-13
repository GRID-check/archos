"""The LlamaIndex adapter on Qdrant: reads under ``AIQ_VECTOR_BACKEND=qdrant``, the ingest mirror.

Against a real Qdrant (see ``test_qdrant_store.py`` for why and how). The
embedding API and Chroma are stood in for: what is under test is the seam,
that the adapter's contract (``retrieve``, ``find_text``, the chunk a caller
gets) holds on the new store, and that every write the adapter makes to
Chroma lands in Qdrant too.
"""

from __future__ import annotations

import math
import os
import random
import uuid
from typing import Any

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
from knowledge_layer.qdrant import mirror
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module

DIM = 8


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


@pytest.fixture
def qdrant_env(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"adapter_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"adapter_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    monkeypatch.setattr(mirror, "facts_by_file", lambda scope, names=None: {})
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


class FakeChroma:
    """The slice of a Chroma collection the mirror reads: ``get`` by file name."""

    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows

    def get(self, *, where: dict[str, Any], include: list[str]) -> dict[str, Any]:
        rows = [row for row in self.rows if row["metadata"].get("file_name") == where["file_name"]]
        return {
            "ids": [row["id"] for row in rows],
            "documents": [row["text"] for row in rows],
            "metadatas": [row["metadata"] for row in rows],
            "embeddings": [row["embedding"] for row in rows],
        }


def _row(text: str, file_name: str, **metadata: Any) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "text": text,
        "embedding": _vector(text),
        "metadata": {"file_name": file_name, "page_label": "2", "_node_content": "{...}", **metadata},
    }


def _ingest(retriever: LlamaIndexRetriever, scope: str, rows: list[dict[str, Any]], **config: Any) -> None:
    chroma = FakeChroma(rows)
    for file_name in sorted({row["metadata"]["file_name"] for row in rows}):
        mirror.mirror_file(chroma, scope, file_name, identity=retriever._identity(), config=config)


async def test_retrieve_answers_from_qdrant_with_the_chroma_chunk_contract(retriever):
    rows = [
        _row("Die Fluchtwege sind in Gebäudeklasse 4 rauchfrei auszuführen.", "brandschutz.pdf"),
        _row("Die Tragwerksplanung berücksichtigt die Holzbauweise.", "statik.pdf"),
    ]
    _ingest(retriever, "proj_a", rows, organization_id="org_1", project_id="p1", document_id="d1")

    result = await retriever.retrieve("Fluchtweg", "proj_a", top_k=2)

    assert result.success and result.chunks
    top = result.chunks[0]
    assert top.file_name == "brandschutz.pdf" and top.page_number == 2
    assert top.chunk_id == rows[0]["id"]
    assert top.score == pytest.approx(max(0.0, _cosine(_vector("Fluchtweg"), rows[0]["embedding"])), abs=1e-3)
    # The chunk carries the metadata it carried from Chroma, not the mirror's own fields.
    assert "office_id" not in top.metadata and "_node_content" not in top.metadata
    assert [chunk.retrieval_rank for chunk in result.chunks] == list(range(len(result.chunks)))


async def test_retrieve_applies_the_callers_filter(retriever):
    _ingest(
        retriever,
        "oib_knowledge",
        [_row("Punkt eins", "rl2.pdf", punkt_id="1"), _row("Seite", "rl2.pdf", chunking="page")],
    )
    result = await retriever.retrieve("Punkt", "oib_knowledge", top_k=5, filters={"chunking": {"$ne": "page"}})
    assert [chunk.content for chunk in result.chunks] == ["Punkt eins"]


async def test_a_foreign_embedder_fails_the_retrieval_loudly(retriever, monkeypatch):
    _ingest(retriever, "proj_a", [_row("x", "a.pdf")])
    store_module.reset_store()
    monkeypatch.setattr(retriever, "embed_model_name", "another-model")
    result = await retriever.retrieve("x", "proj_a")
    assert not result.success and "embedding mismatch" in (result.error_message or "")


async def test_find_text_applies_the_phrase_pattern(retriever):
    from knowledge_layer.browse import phrase_pattern

    _ingest(
        retriever,
        "proj_a",
        [_row("Die Fluchtstiege ist zu beleuchten.", "a.pdf"), _row("Keine Stiege hier: Rampe.", "b.pdf")],
    )
    chunks = await retriever.find_text("proj_a", phrase_pattern(["Fluchtstiege"]))
    assert [chunk.file_name for chunk in chunks] == ["a.pdf"]


def test_mirror_carries_the_ids_the_collection_name_implied(retriever):
    _ingest(retriever, "archiv_org_9", [_row("Ablage", "a.pdf")], document_id="doc-1")
    store = store_module.get_store()
    assert store.count("archiv_org_9", {"office_id": "org_9"}) == 1
    assert store.count("archiv_org_9", {"grid_document_id": "doc-1"}) == 1


def test_mirror_skips_the_version_being_replaced(retriever):
    old, new = _row("alt", "a.pdf"), _row("neu", "a.pdf")
    mirror.mirror_file(
        FakeChroma([old, new]), "proj_a", "a.pdf", identity=retriever._identity(), exclude_ids=[old["id"]]
    )
    assert store_module.get_store().count("proj_a") == 1


def test_mirror_deletes_follow_chroma(retriever):
    rows = [_row("eins", "a.pdf"), _row("zwei", "a.pdf"), _row("drei", "b.pdf")]
    _ingest(retriever, "proj_a", rows)
    store = store_module.get_store()
    mirror.delete_chunks("proj_a", [rows[0]["id"]])
    assert store.count("proj_a") == 2
    mirror.delete_file("proj_a", "a.pdf")
    assert store.count("proj_a") == 1
    mirror.delete_scope("proj_a")
    assert store.count("proj_a") == 0


def test_dual_swallows_a_mirror_failure_and_qdrant_raises(qdrant_env, monkeypatch):
    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectionError("qdrant down")

    monkeypatch.setattr(store_module.QdrantStore, "delete_file", broken)
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    mirror.delete_file("proj_a", "a.pdf")
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    with pytest.raises(ConnectionError):
        mirror.delete_file("proj_a", "a.pdf")


def test_chroma_backend_never_touches_qdrant(monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    monkeypatch.setattr(store_module, "get_store", lambda *a, **k: pytest.fail("Qdrant touched under chroma"))
    mirror.delete_file("proj_a", "a.pdf")
    mirror.delete_chunks("proj_a", ["x"])
    mirror.delete_scope("proj_a")
    mirror.refresh_facts("proj_a")
    assert not mirror.enabled()


def test_adapter_never_imports_qdrant_client():
    """The adapter reaches Qdrant only through ``knowledge_layer.qdrant`` (ADR-0104)."""
    source = open(adapter_module.__file__, encoding="utf-8").read()
    assert "qdrant_client" not in source


def test_refresh_facts_copies_a_persons_edit_onto_the_points(retriever, monkeypatch):
    _ingest(retriever, "proj_a", [_row("eins", "a.pdf"), _row("zwei", "b.pdf")])
    facts = {"a.pdf": {"tags": ["bescheid"], "superseded": True, "doc_class": "Baubescheid"}}
    monkeypatch.setattr(mirror, "facts_by_file", lambda scope, names=None: {n: facts[n] for n in (names or facts)})
    mirror.refresh_facts("proj_a", ["a.pdf"])
    store = store_module.get_store()
    assert store.count("proj_a", {"tags": "bescheid"}) == 1
    assert store.count("proj_a", {"superseded": True}) == 1
    assert store.count("proj_a", {"doc_class": "Baubescheid"}) == 1


def test_an_ingest_job_stamps_the_projects_facts_on_its_chunks(retriever):
    """A new document is boosted and filtered like its siblings from its first search."""
    facts = {"bundesland": "wien", "gebaeudeklasse": [4], "bauweise": ["holzbau"]}
    _ingest(retriever, "proj_a", [_row("eins", "a.pdf")], project_facts=facts, project_status="closed")
    _ingest(retriever, "proj_a", [_row("zwei", "b.pdf")])
    store = store_module.get_store()
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau", "project_status": "closed"}) == 1
    # A job with a status it does not know writes no facts rather than failing the file.
    _ingest(retriever, "proj_a", [_row("drei", "c.pdf")], project_facts=facts, project_status="archived")
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau"}) == 1


async def test_search_grouped_carries_each_chunks_fused_score(retriever):
    from aiq_agent.knowledge.base import FUSED_SCORE_KEY

    _ingest(retriever, "proj_a", [_row("Fluchttreppe aus Holz", "a.pdf")])
    _ingest(retriever, "proj_b", [_row("Fluchttreppe", "b.pdf")])
    groups = await retriever.search_grouped("Fluchttreppe", ["proj_a", "proj_b"], groups=5, group_size=2)
    fused = [chunk.metadata[FUSED_SCORE_KEY] for _, chunks in groups for chunk in chunks]
    assert fused == sorted(fused, reverse=True) and all(score > 0 for score in fused)
    assert retriever.supports_grouped_search()


async def test_search_grouped_ranks_projects_in_one_query(retriever):
    _ingest(retriever, "proj_a", [_row("Fluchttreppe aus Holz", "a.pdf"), _row("Fassade", "a2.pdf")])
    _ingest(retriever, "proj_b", [_row("Fluchttreppe als Sicherheitstreppenhaus", "b.pdf")])
    _ingest(retriever, "proj_c", [_row("Fluchttreppe", "c.pdf")])

    groups = await retriever.search_grouped("Fluchttreppe", ["proj_a", "proj_b"], groups=5, group_size=2)

    assert {scope for scope, _ in groups} == {"proj_a", "proj_b"}  # proj_c was not asked for
    assert all(chunk.metadata.get("file_name") for _, chunks in groups for chunk in chunks)


async def test_search_grouped_needs_qdrant(retriever, monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    with pytest.raises(NotImplementedError):
        await retriever.search_grouped("x", ["proj_a"], groups=1, group_size=1)
