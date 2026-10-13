"""The Chroma -> Qdrant backfill, end to end: a real embedded Chroma, a real Qdrant, the CLI.

The copy must carry every chunk's id, text, metadata and vector without
re-embedding, be safe to repeat, and repair drift both ways (``--prune``).
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import random
import uuid

import pytest
from knowledge_layer.qdrant import mirror
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "backfill_qdrant.py"
DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "fp-test", "aiq:embed_model": "model-test"}


def _load_script():
    spec = importlib.util.spec_from_file_location("backfill_qdrant", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


@pytest.fixture
def stores(tmp_path, monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    from knowledge_layer.llamaindex.adapter import _make_chroma_client

    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"backfill_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"backfill_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.delenv("AIQ_CHROMA_URL", raising=False)
    monkeypatch.delenv("AIQ_CHROMA_HOST", raising=False)
    monkeypatch.setattr(mirror, "facts_by_file", lambda scope, names=None: {"a.pdf": {"tags": ["bescheid"]}})
    # The client the script itself opens: embedded Chroma refuses a second
    # client on one directory with different settings.
    chroma = _make_chroma_client(str(tmp_path / "chroma"))
    client = store_module.make_client()
    yield chroma, str(tmp_path / "chroma")
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)


def _seed(chroma, name: str, count: int):
    collection = chroma.get_or_create_collection(name, metadata={"hnsw:space": "cosine", **IDENTITY})
    ids = [str(uuid.uuid4()) for _ in range(count)]
    texts = [f"Fluchtweg Abschnitt {index}" for index in range(count)]
    collection.add(
        ids=ids,
        documents=texts,
        embeddings=[_vector(text) for text in texts],
        metadatas=[
            {"file_name": "a.pdf" if index % 2 else "b.pdf", "page_label": str(index)} for index in range(count)
        ],
    )
    return collection, ids


def test_backfill_copies_every_chunk_with_its_vector_and_verifies(stores):
    chroma, chroma_dir = stores
    _seed(chroma, "proj_alpha", 37)
    _seed(chroma, "oib_knowledge", 5)

    assert _load_script().main(["--chroma-dir", chroma_dir, "--page-size", "10", "--verify"]) == 0

    store = store_module.QdrantStore(store_module.make_client(), IDENTITY)
    assert store.count("proj_alpha") == 37 and store.count("oib_knowledge") == 5
    # The person-set facts rode along; the vectors are Chroma's own.
    assert store.count("proj_alpha", {"tags": "bescheid"}) == 18
    record = next(store.scroll("proj_alpha", {"page_label": "3"}))
    points = store.client.retrieve(store.alias("proj_alpha"), [record.id], with_vectors=["dense"])
    # Qdrant stores cosine vectors normalised: the same direction, unit length.
    original = _vector("Fluchtweg Abschnitt 3")
    norm = sum(value * value for value in original) ** 0.5
    assert points[0].vector["dense"] == pytest.approx([value / norm for value in original], abs=1e-5)


def test_backfill_is_idempotent_and_prune_repairs_deletes(stores):
    chroma, chroma_dir = stores
    collection, ids = _seed(chroma, "proj_alpha", 12)
    script = _load_script()
    assert script.main(["--chroma-dir", chroma_dir]) == 0
    assert script.main(["--chroma-dir", chroma_dir]) == 0

    collection.delete(ids=ids[:4])  # deleted in Chroma while the mirror was down
    assert script.main(["--chroma-dir", chroma_dir, "--verify"]) == 1  # 8 vs 12: a gap
    assert script.main(["--chroma-dir", chroma_dir, "--prune", "--verify"]) == 0

    store = store_module.QdrantStore(store_module.make_client(), IDENTITY)
    assert store.count("proj_alpha") == 8


def test_dry_run_writes_nothing(stores):
    chroma, chroma_dir = stores
    _seed(chroma, "proj_alpha", 6)
    assert _load_script().main(["--chroma-dir", chroma_dir, "--dry-run"]) == 0
    store = store_module.QdrantStore(store_module.make_client(), IDENTITY)
    assert not store.exists("proj_alpha")


def test_unreachable_qdrant_exits_two(stores, monkeypatch):
    _, chroma_dir = stores
    monkeypatch.setenv("AIQ_QDRANT_URL", "http://127.0.0.1:9")
    assert _load_script().main(["--chroma-dir", chroma_dir]) == 2


def _store() -> store_module.QdrantStore:
    return store_module.QdrantStore(store_module.make_client(), IDENTITY)


def _chunk(collection, store, scope: str, file_name: str, text: str) -> str:
    """Ingest one chunk the way ingestion does: Chroma first, then the mirror."""
    from knowledge_layer.qdrant.payload import ChunkRecord

    chunk_id = str(uuid.uuid4())
    collection.add(ids=[chunk_id], documents=[text], embeddings=[_vector(text)], metadatas=[{"file_name": file_name}])
    store.upsert(scope, [ChunkRecord(chunk_id, text, _vector(text), {"file_name": file_name})])
    return chunk_id


def test_prune_never_deletes_a_chunk_ingested_while_it_runs(stores):
    """Chroma's ids were read first, then Qdrant's: a file ingested in between was pruned as stale."""
    from knowledge_layer.qdrant import backfill

    chroma, chroma_dir = stores
    collection, _ids = _seed(chroma, "proj_alpha", 6)
    assert _load_script().main(["--chroma-dir", chroma_dir]) == 0
    store = _store()
    arrived: list[str] = []

    class IngestDuringRead:
        """The Chroma handle, with an upload landing right after its first read."""

        def __getattr__(self, name):
            return getattr(collection, name)

        def get(self, *args, **kwargs):
            page = collection.get(*args, **kwargs)
            if not arrived:
                arrived.append(_chunk(collection, store, "proj_alpha", "neu.pdf", "Neue Fassung"))
            return page

    assert backfill.prune_scope(IngestDuringRead(), "proj_alpha", store) == 0
    assert store.count("proj_alpha", {"file_name": "neu.pdf"}) == 1


def test_backfill_leaves_the_ids_ingestion_wrote_and_merges_the_rest(stores, monkeypatch):
    chroma, chroma_dir = stores
    collection, ids = _seed(chroma, "proj_alpha", 4)
    store = _store()
    # Ingestion mirrored a.pdf with what only its job knows.
    mirror.mirror_file(
        collection,
        "proj_alpha",
        "a.pdf",
        identity=IDENTITY,
        config={"organization_id": "org_1", "project_id": "p1", "document_id": "doc-a"},
    )
    assert store.count("proj_alpha", {"project_id": "p1"}) == 2
    # A field the payload gained after these points were written, and a fact a person set since.
    store.client.delete_payload(store.alias("proj_alpha"), keys=["paragraph_refs"], points=[ids[1]], wait=True)
    monkeypatch.setattr(mirror, "facts_by_file", lambda scope, names=None: {"a.pdf": {"tags": ["plan"]}})

    assert _load_script().main(["--chroma-dir", chroma_dir, "--verify"]) == 0

    assert store.count("proj_alpha") == 4
    assert store.count("proj_alpha", {"project_id": "p1"}) == 2
    assert store.count("proj_alpha", {"grid_document_id": "doc-a"}) == 2
    assert store.count("proj_alpha", {"office_id": "org_1"}) == 2
    assert store.count("proj_alpha", {"tags": "plan"}) == 2
    [point] = store.client.retrieve(store.alias("proj_alpha"), [ids[1]], with_payload=True)
    assert point.payload["paragraph_refs"] == [] and point.payload["project_id"] == "p1"


def test_a_scope_only_qdrant_holds_is_a_gap_and_prune_removes_it(stores):
    """A failed delete_collection mirror or a reaped conversation leaves a scope no Chroma collection names."""
    chroma, chroma_dir = stores
    _seed(chroma, "proj_alpha", 3)
    script = _load_script()
    assert script.main(["--chroma-dir", chroma_dir]) == 0
    store = _store()
    from knowledge_layer.qdrant.payload import ChunkRecord

    store.upsert("s_conversation", [ChunkRecord(str(uuid.uuid4()), "Anhang", _vector("Anhang"), {"file_name": "x"})])
    store.upsert("oib_retired", [ChunkRecord(str(uuid.uuid4()), "Alt", _vector("Alt"), {"file_name": "y"})])

    assert script.main(["--chroma-dir", chroma_dir, "--verify"]) == 1
    assert store.count("s_conversation") == 1
    # Naming the collections leaves every other scope alone.
    assert script.main(["--chroma-dir", chroma_dir, "--collection", "proj_alpha", "--prune", "--verify"]) == 0
    assert store.count("s_conversation") == 1

    assert script.main(["--chroma-dir", chroma_dir, "--prune", "--verify"]) == 0
    assert store.count("s_conversation") == 0 and store.count("oib_retired") == 0
    assert store.count("proj_alpha") == 3


def test_verify_compares_ids_not_only_counts(stores):
    from knowledge_layer.qdrant import backfill
    from knowledge_layer.qdrant.payload import ChunkRecord

    chroma, chroma_dir = stores
    collection, ids = _seed(chroma, "proj_alpha", 10)
    script = _load_script()
    assert script.main(["--chroma-dir", chroma_dir, "--verify"]) == 0
    store = _store()
    # One point lost, one stray in its place: the counts agree, the sets do not.
    store.delete_chunks("proj_alpha", [ids[0]])
    store.upsert("proj_alpha", [ChunkRecord(str(uuid.uuid4()), "Fremd", _vector("Fremd"), {"file_name": "c.pdf"})])
    assert store.count("proj_alpha") == collection.count()

    # Only verifying, nothing copied: the equal counts alone would pass.
    assert script.main(["--chroma-dir", chroma_dir, "--facts-only", "--verify"]) == 1
    full = backfill.verify_scope(collection, "proj_alpha", store)
    assert (full.missing, full.extra, full.sampled) == (1, 1, False)
    sampled = backfill.verify_scope(collection, "proj_alpha", store, full_limit=5, sample=64)
    assert (sampled.missing, sampled.extra, sampled.sampled) == (1, 1, True)

    # The copy puts the lost point back; the stray is still a gap until pruned.
    assert script.main(["--chroma-dir", chroma_dir, "--verify"]) == 1
    assert script.main(["--chroma-dir", chroma_dir, "--prune", "--verify"]) == 0
