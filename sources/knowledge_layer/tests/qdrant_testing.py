"""One real Qdrant for every test that needs a store (ADR-0115).

What a test of the store or the adapter checks is the server's behaviour as
the knowledge layer drives it (filters, strict mode, BM25, deletes by filter),
so these run against the server at ``GRID_QDRANT_TEST_URL``: the CI backend job
runs a Qdrant 1.19 service container and sets it for every step. Locally,
without the variable, a test that asks for the store skips; on CI it fails
instead, so the suites cannot quietly stop covering it.

:func:`qdrant_store` points the process-wide store at a pair of physical
collections this process shares (a unique alias suffix, ``schema.ALIASES``
monkeypatched), so the adapter, the routes and the test all read and write the
same pair, and empties both after every test. Creating a pair is 62 payload
indexes, one request each: over four seconds, which every test used to pay.
A test of the collection's own life (created or adopted, its indexes, its
metadata, its aliases) asks for :func:`fresh_qdrant_store`, a pair of its own
deleted afterwards. Imported by path
(``sources.knowledge_layer.tests.qdrant_testing``), as ``sources/AGENTS.md``
asks, and registered as fixtures by each suite's ``conftest.py``.
"""

from __future__ import annotations

import atexit
import os
import random
import uuid
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant import writes
from knowledge_layer.qdrant.payload import ChunkRecord
from qdrant_client import models

#: Dense size of every test vector: small, so a test collection costs nothing.
DIM = 8
#: The embedder identity test collections are created with.
IDENTITY = {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"}


def server_url() -> str:
    """The test server's URL; skips locally without one, fails on CI."""
    url = os.environ.get("GRID_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("GRID_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("GRID_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


def vector(seed: str) -> list[float]:
    """A deterministic test vector for ``seed``: the same text always embeds the same."""
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


class FakeEmbedder:
    """Stands in for the embedding API on the ingest and query paths: :func:`vector` per text."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    def get_text_embedding_batch(self, texts: Sequence[str], **_kwargs: Any) -> list[list[float]]:
        self.batches.append(list(texts))
        return [vector(text) for text in texts]

    def get_query_embedding(self, query: str) -> list[float]:
        return vector(query)


def record(text: str, file_name: str, *, chunk_id: str | None = None, **metadata: Any) -> ChunkRecord:
    """One chunk as ingestion writes it: a fresh node id, the text's vector, ``file_name`` and page 1 unless given."""
    return ChunkRecord(
        chunk_id=chunk_id or str(uuid.uuid4()),
        text=text,
        embedding=vector(text),
        metadata={"file_name": file_name, "page_label": "1", **metadata},
    )


def write(scope: str, records: Sequence[ChunkRecord], config: Mapping[str, Any] | None = None) -> int:
    """Write ``records`` into ``scope`` with the enrichment an ingest job gives them (no metadata-store facts)."""
    return store_module.get_store(IDENTITY).upsert(scope, records, writes.enrichment(scope, config))


def chunk_texts(scope: str, filters: dict[str, Any] | None = None) -> dict[str, str]:
    """``chunk_id -> text`` of every point of ``scope`` (matching ``filters``)."""
    return {
        str((point.payload or {}).get(schema.CHUNK_ID_FIELD)): str((point.payload or {}).get(schema.TEXT_FIELD))
        for point in store_module.get_store().scroll(scope, filters)
    }


#: The alias suffix of the pair each test module shares, by module; made on first use.
_SHARED_SUFFIXES: dict[str, str] = {}


def _point_at(monkeypatch, suffix: str) -> store_module.QdrantStore:
    url = server_url()
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"test_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"test_office_{suffix}")
    monkeypatch.setenv("GRID_QDRANT_URL", url)
    monkeypatch.delenv("GRID_QDRANT_API_KEY", raising=False)
    store_module.reset_store()
    return store_module.get_store(IDENTITY)


def _collections() -> list[str]:
    return [schema.ALIASES[physical] + schema.FIRST_VERSION for physical in schema.Physical]


def _delete_shared_collections() -> None:
    """At exit, the shared pair, so a local server does not collect one per run."""
    if not os.environ.get("GRID_QDRANT_TEST_URL", "").strip():
        return
    try:
        from qdrant_client import QdrantClient

        client = QdrantClient(url=os.environ["GRID_QDRANT_TEST_URL"], check_compatibility=False)
        for suffix in _SHARED_SUFFIXES.values():
            for prefix in ("test_corpus_", "test_office_"):
                name = f"{prefix}{suffix}{schema.FIRST_VERSION}"
                if client.collection_exists(name):
                    client.delete_collection(name)
    except Exception:  # noqa: BLE001 - a cleanup at exit must not fail the run
        pass


atexit.register(_delete_shared_collections)


#: What the shared pair looked like when a test found it, by collection name.
_SIGNATURES: dict[str, Any] = {}


def _signature(client: Any, name: str) -> Any:
    """A collection's config, metadata and payload indexes: what a test may change besides points."""
    if not client.collection_exists(name):
        return None
    info = client.get_collection(name)
    indexes = {field: (index.data_type, index.params) for field, index in (info.payload_schema or {}).items()}
    return (info.config.model_dump(), indexes)


def shared_store(monkeypatch, request) -> Iterator[store_module.QdrantStore]:
    """The process-wide store, on collections its test module shares; emptied after the test.

    One pair per module, not per process: a module writes with one embedder
    identity, which the collection then carries. A pair the first test made is
    held to the indexes the schema asks for; what it left (config, metadata,
    indexes) is what every later test is held to. A test that changed more
    than the points leaves a pair the next must not inherit, so the pair is
    then deleted and the next test makes it again.
    """
    suffix = _SHARED_SUFFIXES.setdefault(request.module.__name__, uuid.uuid4().hex[:10])
    store = _point_at(monkeypatch, suffix)
    client = store_module.make_client()
    names = _collections()
    # Read before the test runs: a test may monkeypatch the list itself.
    wanted_indexes = set(schema.INDEXED_FIELDS)
    try:
        yield store
    finally:
        aliases = {alias.alias_name: alias.collection_name for alias in client.get_aliases().aliases}
        moved = any(aliases.get(name.removesuffix(schema.FIRST_VERSION)) not in (None, name) for name in names)
        for name in names:
            before, after = _SIGNATURES.get(name), _signature(client, name)
            if after is None:
                _SIGNATURES.pop(name, None)
                continue
            reshaped = set(after[1]) != wanted_indexes if before is None else before != after
            if moved or reshaped:
                client.delete_collection(name)
                _SIGNATURES.pop(name, None)
            else:
                client.delete(name, points_selector=models.FilterSelector(filter=models.Filter()), wait=True)
                _SIGNATURES[name] = after
        store_module.reset_store()


def fresh_store(monkeypatch) -> Iterator[store_module.QdrantStore]:
    """The process-wide store, on collections of this test's own; both deleted afterwards."""
    store = _point_at(monkeypatch, uuid.uuid4().hex[:10])
    try:
        yield store
    finally:
        client = store_module.make_client()
        for name in _collections():
            if client.collection_exists(name):
                client.delete_collection(name)
        store_module.reset_store()


# The fixtures, for a conftest that loads this module up front. One that every
# test loads takes them from `qdrant_fixtures.py` instead, which imports this
# module only when a test asks for a store.
@pytest.fixture
def qdrant_store(monkeypatch, request) -> Iterator[store_module.QdrantStore]:
    """:func:`shared_store` as a fixture."""
    yield from shared_store(monkeypatch, request)


@pytest.fixture
def fresh_qdrant_store(monkeypatch) -> Iterator[store_module.QdrantStore]:
    """:func:`fresh_store` as a fixture."""
    yield from fresh_store(monkeypatch)


#: The payload indexes a test of a collection's copy and length tuning filters on.
FEW_INDEXES = frozenset({"scope", "kind", "file_name", "chunk_id", schema.TEXT_FIELD})


@pytest.fixture
def few_payload_indexes(monkeypatch) -> None:
    """Collections made with :data:`FEW_INDEXES` instead of all 62: each index is
    made on the server, about 70 ms, and a rebuild test makes a pair or more. The
    index set itself is the store's tests' to pin (``test_qdrant_store.py``)."""
    monkeypatch.setattr(schema, "INDEXED_FIELDS", FEW_INDEXES)


def capture_indexed_documents(monkeypatch, into: list[list[Any]] | None = None) -> list[list[Any]]:
    """Record the documents each ingest hands to chunking and embedding, one list per file; the write still runs.

    What ``VectorStoreIndex.from_documents``'s call list told a test before
    ingestion embedded and wrote its chunks itself. ``into`` is the list to
    record in (cleared first), for a module-level helper that reads it.
    """
    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

    calls: list[list[Any]] = into if into is not None else []
    calls.clear()
    real = LlamaIndexIngestor._embedded_records

    def recording(self: Any, documents: list[Any], **kwargs: Any) -> list[ChunkRecord]:
        calls.append(list(documents))
        return real(self, documents, **kwargs)

    monkeypatch.setattr(LlamaIndexIngestor, "_embedded_records", recording)
    return calls
