"""The two stores, filled from one set of vectors, and the retriever that reads either.

Everything here builds the production objects rather than lookalikes:

* **Chroma**: an embedded ``chromadb`` client, a collection created with production's
  ``hnsw:space=cosine`` and embedder fingerprint, filled through LlamaIndex's
  ``ChromaVectorStore.add`` (so rows carry ``_node_content`` exactly as ingestion
  writes them).
* **The German mirror**: ``ChunkTextStore`` on a throwaway PostgreSQL cluster when
  server binaries exist (the production channel: ``to_tsvector('german')``, GIN,
  ``ts_rank_cd``), else on SQLite (the degraded Python analyzer), and the report
  states which one ran.
* **Qdrant**: the production collection shape (``qdrant/schema.py``: dense + server
  BM25 with ``BM25_OPTIONS``, TurboQuant 4-bit, strict mode, payload indexes),
  under uniquely named aliases so a shared server is never touched outside them,
  filled by the migration's own copy: ``deploy/migration/chroma_export.py`` into the
  neutral format, ``qdrant/import_vectors.py`` from it.
* **The retriever**: ``LlamaIndexRetriever`` with its query-embedding cache
  pre-filled, so ``_retrieve_sync`` runs the store path with no embedding call in
  it, and ``AIQ_VECTOR_BACKEND`` picks the store per call, as it does in
  production.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from collections.abc import Iterator
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

#: The logical collection the parity corpus is indexed under. Not ``oib_knowledge``:
#: that name switches on the static result cache, which would time the cache.
SCOPE = "oib_parity"


@dataclass(frozen=True)
class IndexedChunk:
    """One chunk as both stores hold it."""

    chunk_id: str
    text: str
    file_name: str
    page: int
    metadata: dict[str, Any]


# ---------------------------------------------------------------- Postgres


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _pg_bin() -> Path | None:
    configured = os.environ.get("PGBIN")
    candidates = [Path(configured)] if configured else sorted(Path("/usr/lib/postgresql").glob("*/bin"))
    for candidate in reversed(candidates):
        if (candidate / "initdb").exists() and (candidate / "pg_ctl").exists():
            return candidate
    return None


@contextlib.contextmanager
def throwaway_postgres() -> Iterator[str | None]:
    """A PostgreSQL cluster in a temp dir for the run, its URL; None without server binaries.

    The same recipe as ``scripts/rls-test-db.sh``: initdb refuses root, so on a root
    host every server command runs as the ``postgres`` system user. The cluster and
    its directory are removed on exit; no existing cluster is touched.
    """
    pg_bin = _pg_bin()
    if pg_bin is None:
        yield None
        return
    run_as = "postgres" if os.geteuid() == 0 else None
    workdir = Path(tempfile.mkdtemp(prefix="qdrant-parity-pg-"))
    data = workdir / "data"
    port = _free_port()

    def run(*args: str) -> None:
        command = [str(pg_bin / args[0]), *args[1:]]
        if run_as:
            command = ["su", run_as, "-c", " ".join(f"'{part}'" for part in command)]
        subprocess.run(command, check=True, capture_output=True)

    if run_as:
        data.mkdir()
        shutil.chown(workdir, run_as)
        shutil.chown(data, run_as)
    try:
        run("initdb", "-D", str(data), "-U", "postgres", "--auth=trust")
        run("pg_ctl", "-D", str(data), "-o", f"-p {port} -k {workdir}", "-l", str(data / "server.log"), "-w", "start")
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        with contextlib.suppress(Exception):
            run("pg_ctl", "-D", str(data), "-m", "immediate", "stop")
        shutil.rmtree(workdir, ignore_errors=True)


def lexical_store(db_url: str) -> Any:
    """The process-wide ``ChunkTextStore`` pointed at ``db_url`` (what the retriever reads)."""
    from aiq_agent.knowledge.chunk_text_store import ChunkTextStore
    from aiq_agent.knowledge.chunk_text_store import configure_chunk_text_store

    ChunkTextStore._tables_initialized.discard(db_url)
    return configure_chunk_text_store(db_url)


def fill_lexical(store: Any, chunks: Sequence[IndexedChunk]) -> int:
    """Mirror every chunk's text, as ingestion does after the Chroma write."""
    from aiq_agent.knowledge.chunk_text_store import ChunkTextRow

    rows = [
        ChunkTextRow(chunk_id=chunk.chunk_id, body=chunk.text, file_name=chunk.file_name, page_label=str(chunk.page))
        for chunk in chunks
    ]
    return store.upsert_many(SCOPE, rows)


# ---------------------------------------------------------------- Chroma


def identity(model: str, base_url: str) -> dict[str, str]:
    """The embedder fingerprint both stores record, as production computes it."""
    from knowledge_layer.llamaindex.adapter import embed_fingerprint_metadata

    return embed_fingerprint_metadata(model, base_url)


def chroma_client(persist_dir: Path) -> Any:
    """An embedded Chroma client, as ``_make_chroma_client`` builds one without a server URL."""
    import chromadb
    from chromadb.config import Settings

    return chromadb.PersistentClient(path=str(persist_dir), settings=Settings(anonymized_telemetry=False))


def fill_chroma(client: Any, chunks: Sequence[IndexedChunk], vectors: np.ndarray, fingerprint: dict[str, str]) -> Any:
    """The parity collection, written through LlamaIndex as ingestion writes it."""
    from llama_index.core.schema import TextNode
    from llama_index.vector_stores.chroma import ChromaVectorStore

    with contextlib.suppress(Exception):
        client.delete_collection(SCOPE)
    collection = client.get_or_create_collection(name=SCOPE, metadata={"hnsw:space": "cosine", **fingerprint})
    store = ChromaVectorStore(chroma_collection=collection)
    nodes = [
        TextNode(id_=chunk.chunk_id, text=chunk.text, metadata=dict(chunk.metadata), embedding=vectors[i].tolist())
        for i, chunk in enumerate(chunks)
    ]
    for start in range(0, len(nodes), 500):
        store.add(nodes[start : start + 500])
    return collection


# ---------------------------------------------------------------- Qdrant


@contextlib.contextmanager
def isolated_qdrant(url: str, api_key: str | None = None) -> Iterator[str]:
    """The knowledge layer's Qdrant store on uniquely named aliases; collections dropped on exit.

    The aliases are the one name the package addresses each physical collection by,
    so renaming them for the run puts every read and write of the production code
    on throwaway collections. Yields the run's suffix.
    """
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant.store import make_client
    from knowledge_layer.qdrant.store import reset_store

    suffix = uuid.uuid4().hex[:8]
    saved = dict(schema.ALIASES)
    saved_env = {key: os.environ.get(key) for key in ("AIQ_QDRANT_URL", "AIQ_QDRANT_API_KEY")}
    os.environ["AIQ_QDRANT_URL"] = url
    if api_key:
        os.environ["AIQ_QDRANT_API_KEY"] = api_key
    for physical in schema.Physical:
        schema.ALIASES[physical] = f"parity_{suffix}_{physical.value}"
    reset_store()
    try:
        yield suffix
    finally:
        client = make_client()
        for physical in schema.Physical:
            with contextlib.suppress(Exception):
                name = schema.ALIASES[physical] + schema.FIRST_VERSION
                if client.collection_exists(name):
                    client.delete_collection(name)
        schema.ALIASES.clear()
        schema.ALIASES.update(saved)
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        reset_store()


def _chroma_exporter():
    """``deploy/migration/chroma_export.py``, loaded by path: it is a script, not a package."""
    import importlib.util

    path = Path(__file__).resolve().parents[6] / "deploy" / "migration" / "chroma_export.py"
    spec = importlib.util.spec_from_file_location("chroma_export", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fill_qdrant(chroma_collection: Any, fingerprint: dict[str, str]) -> tuple[int, int]:
    """Copy the Chroma collection into Qdrant the way the migration does; ``(chroma, qdrant)`` counts.

    The exporter writes it in the neutral format and the importer loads that,
    so what is measured is the copy production gets.
    """
    from knowledge_layer.qdrant import import_vectors
    from knowledge_layer.qdrant.store import get_store

    exporter = _chroma_exporter()
    store = get_store(fingerprint)
    with tempfile.TemporaryDirectory(prefix="parity-export-") as tmp:
        root = Path(tmp)
        entry = exporter.export_collection(chroma_collection, root / "collections" / SCOPE, exporter.DEFAULT_BATCH)
        exporter.write_manifest(root, {SCOPE: entry}, {"mode": "persist", "location": "parity"})
        # No metadata store holds person-set facts for a benchmark corpus; the
        # importer's lookup of them is replaced by "none", which is what it finds.
        original = import_vectors.facts_by_file
        import_vectors.facts_by_file = lambda scope: {}
        try:
            _report, ids = import_vectors.import_scope(import_vectors.Export.open(root), SCOPE, store)
        finally:
            import_vectors.facts_by_file = original
    verification = import_vectors.verify_scope(ids, SCOPE, store)
    # The id sets, not only the counts: equal counts can hide a swap.
    if verification.missing or verification.extra:
        raise RuntimeError(f"stores differ after the import: {verification}")
    return verification.export_count, verification.qdrant_count


def wait_until_indexed(timeout_s: float = 600.0) -> dict[str, Any]:
    """Block until the corpus collection's optimizer is idle; its index state for the report.

    Until HNSW and the quantized copy are built a search is a brute-force scan, so a
    latency or recall measured earlier would not be of the configuration under test.
    """
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant.store import get_store

    client = get_store().client
    alias = schema.ALIASES[schema.Physical.CORPUS]
    deadline = time.monotonic() + timeout_s
    info = client.get_collection(alias)
    while time.monotonic() < deadline:
        info = client.get_collection(alias)
        status = str(getattr(info.status, "value", info.status))
        optimizer = str(getattr(info, "optimizer_status", "ok"))
        if status == "green" and "ok" in optimizer.lower():
            break
        time.sleep(1.0)
    return {
        "status": str(getattr(info.status, "value", info.status)),
        "points": int(info.points_count or 0),
        "indexed_vectors": int(info.indexed_vectors_count or 0),
        "segments": int(info.segments_count or 0),
    }


# ---------------------------------------------------------------- the retriever


def retriever(client: Any, model: str, base_url: str, queries: Sequence[str], query_vectors: np.ndarray) -> Any:
    """``LlamaIndexRetriever`` over ``client``, its query-embedding cache holding every query.

    ``_retrieve_sync`` then runs exactly as in production, minus the embedding round
    trip: the store calls are what is timed and scored.
    """
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from llama_index.core.embeddings import MockEmbedding

    instance = LlamaIndexRetriever({"embed_model": model, "embed_base_url": base_url, "hybrid_search": True})
    instance._chroma_client = client
    instance._embed_model = MockEmbedding(embed_dim=int(query_vectors.shape[1]))
    instance._initialized = True
    for query, vector in zip(queries, query_vectors, strict=True):
        key = (model, query)
        instance._embed_cache[key] = [float(value) for value in vector]
        instance._embed_cache_order.append(key)
    return instance


@contextlib.contextmanager
def backend(name: str) -> Iterator[None]:
    """``AIQ_VECTOR_BACKEND`` set to ``name`` for the block (read per call by the adapter)."""
    previous = os.environ.get("AIQ_VECTOR_BACKEND")
    os.environ["AIQ_VECTOR_BACKEND"] = name
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("AIQ_VECTOR_BACKEND", None)
        else:
            os.environ["AIQ_VECTOR_BACKEND"] = previous
