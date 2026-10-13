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
