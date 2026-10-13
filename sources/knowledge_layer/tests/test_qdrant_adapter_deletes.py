"""Every delete the adapter makes, against a real embedded Chroma AND a real Qdrant (ADR-0104).

Under ``AIQ_VECTOR_BACKEND=qdrant`` retrieval reads Qdrant while Chroma stays
the write-side record. A delete that took Chroma first and then failed on
Qdrant left the deleted (or retired, or quarantined) content answering every
search, and its raise skipped the Chroma-side cleanup behind it. What these
pin, per operation:

* under ``qdrant`` Qdrant goes first; when it fails nothing is deleted
  anywhere, so the content is never gone from the record and still readable
  (Chroma empty while Qdrant answers), and a retry finishes the job;
* under ``dual`` Chroma goes first and a failed mirror never skips the
  metadata row, the lexical mirror or the collection version bump;
* a retried ``delete_file`` (Chroma already empty) takes Qdrant's points by
  every stored spelling of the name, not only the exact one.
"""

from __future__ import annotations

import os
import random
import uuid
from typing import Any
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _PreviousVersion
from knowledge_layer.qdrant import mirror
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module

DIM = 8
SCOPE = "proj_deletes"


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


class QdrantOutage:
    """Makes every Qdrant delete fail while ``down``, as an unreachable server does (after the store's retries)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch):
        self.down = False
        self.calls = 0
        real = store_module.QdrantStore._delete

        def delete(store: store_module.QdrantStore, scope: str, *conditions: Any) -> None:
            self.calls += 1
            if self.down:
                raise ConnectionError("qdrant unreachable")
            real(store, scope, *conditions)

        monkeypatch.setattr(store_module.QdrantStore, "_delete", delete)


@pytest.fixture
def env(tmp_path, monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.chunk_text_store import configure_chunk_text_store
    from aiq_agent.knowledge.chunk_text_store import reset_chunk_text_store

    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"deletes_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"deletes_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    monkeypatch.delenv("AIQ_CHROMA_URL", raising=False)
    monkeypatch.delenv("AIQ_CHROMA_HOST", raising=False)
    summary_db = f"sqlite:///{tmp_path / 'summaries.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", summary_db)
    factory._document_metadata_store = None
    configure_summary_db(summary_db)
    text_store = configure_chunk_text_store(f"sqlite:///{tmp_path / 'mirror.db'}")
    bumped: list[str] = []
    monkeypatch.setattr(adapter_module, "bump_collection_version", bumped.append)
    monkeypatch.setattr(store_module, "_sleep", lambda seconds: None)
    store_module.reset_store()

    ingestor = LlamaIndexIngestor(
        {"persist_dir": str(tmp_path / "chroma"), "generate_summary": False, "summary_llm": MagicMock()}
    )
    ingestor._embed_model = MagicMock()
    ingestor._initialized = True
    yield {"ingestor": ingestor, "text": text_store, "bumped": bumped, "outage": QdrantOutage(monkeypatch)}

    client = store_module.make_client()
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)
    store_module.reset_store()
    factory._document_metadata_store = None
    reset_chunk_text_store()


def _seed(env: dict[str, Any], file_name: str, count: int = 3, *, stored_as: str | None = None) -> list[str]:
    """``count`` chunks of ``file_name`` in Chroma, Qdrant, the lexical mirror and the metadata store."""
    from aiq_agent.knowledge import register_summary

    stored = stored_as or file_name
    collection = env["ingestor"]._get_chroma_client().get_or_create_collection(SCOPE, metadata={"hnsw:space": "cosine"})
    ids = [str(uuid.uuid4()) for _ in range(count)]
    texts = [f"{file_name} Abschnitt {index}" for index in range(count)]
    collection.add(
        ids=ids,
        documents=texts,
        embeddings=[_vector(text) for text in texts],
        metadatas=[{"file_name": stored, "page_label": str(index + 1)} for index in range(count)],
    )
    identity = {"aiq:embed_fingerprint": "fp", "aiq:embed_model": "model"}
    assert mirror.mirror_file(collection, SCOPE, stored, identity=identity) >= count
    env["text"].upsert_many(
        SCOPE, [{"chunk_id": cid, "body": text, "file_name": stored} for cid, text in zip(ids, texts, strict=True)]
    )
    register_summary(SCOPE, stored, f"Zusammenfassung {file_name}")
    return ids


def _chroma_ids(env: dict[str, Any], file_name: str | None = None) -> set[str]:
    collection = env["ingestor"]._get_chroma_client().get_or_create_collection(SCOPE)
    where = {"file_name": file_name} if file_name else None
    return set(collection.get(where=where, include=[])["ids"])


def _qdrant_ids(file_name: str | None = None) -> set[str]:
    store = store_module.get_store()
    filters = {"file_name": file_name} if file_name else None
    return {str(record.payload["chunk_id"]) for record in store.scroll(SCOPE, filters)}


def _summary_rows() -> set[str]:
    from aiq_agent.knowledge import get_available_documents

    return {document.file_name for document in get_available_documents(SCOPE)}


def _collection(env: dict[str, Any]):
    return env["ingestor"]._get_chroma_client().get_collection(SCOPE)


# ---------------------------------------------------------------- delete_file


def test_delete_file_under_qdrant_deletes_nothing_when_qdrant_fails_and_finishes_on_retry(env):
    ids = _seed(env, "plan.pdf")
    _seed(env, "other.pdf")
    env["outage"].down = True

    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is False

    # Not "gone from the record and still answering": nothing was deleted.
    assert _qdrant_ids("plan.pdf") == set(ids)
    assert _chroma_ids(env) >= set(ids)
    assert "plan.pdf" in _summary_rows()

    env["outage"].down = False
    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is True
    assert _qdrant_ids("plan.pdf") == set() and not (_chroma_ids(env) & set(ids))
    assert "plan.pdf" not in _summary_rows() and env["text"].count(SCOPE) == 3
    assert env["bumped"] == [SCOPE]
    assert len(_qdrant_ids("other.pdf")) == 3  # the neighbour untouched


def test_delete_file_under_qdrant_never_leaves_chroma_empty_while_qdrant_answers(env):
    ids = _seed(env, "plan.pdf")
    env["outage"].down = True
    env["ingestor"].delete_file("plan.pdf", SCOPE)
    deleted_from_record = not (_chroma_ids(env) & set(ids))
    assert not (deleted_from_record and _qdrant_ids("plan.pdf")), "deleted in Chroma, still retrievable from Qdrant"


def test_delete_file_under_dual_keeps_the_chroma_side_cleanup_when_the_mirror_fails(env, monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    ids = _seed(env, "plan.pdf")
    env["outage"].down = True

    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is True

    assert not (_chroma_ids(env) & set(ids))
    assert "plan.pdf" not in _summary_rows() and env["text"].count(SCOPE) == 0
    assert env["bumped"] == [SCOPE]
    assert _qdrant_ids("plan.pdf") == set(ids)  # the backfill's to repair; nothing reads it under dual


def test_a_retried_delete_takes_qdrants_points_under_every_stored_spelling(env, monkeypatch):
    """Chroma already empty (the mirror failed under ``dual``): the retry finds tmp- and %-spellings in Qdrant."""
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    tmp_ids = _seed(env, "Plan A.pdf", stored_as="tmpab12cd34_Plan%20A.pdf")
    plain_ids = _seed(env, "Plan A.pdf", 2)
    _seed(env, "Plan B.pdf", 2)
    env["outage"].down = True
    assert env["ingestor"].delete_file("Plan A.pdf", SCOPE) is True  # Chroma's exact match only
    assert env["ingestor"].delete_file("Plan A.pdf", SCOPE) is True  # Chroma's tmp spelling
    assert _qdrant_ids() >= set(tmp_ids) | set(plain_ids)

    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    env["outage"].down = False
    env["ingestor"].delete_file("Plan A.pdf", SCOPE)  # Chroma: no chunks at all

    remaining = _qdrant_ids()
    assert not remaining & (set(tmp_ids) | set(plain_ids))
    assert len(remaining) == 2  # Plan B.pdf stays


# ---------------------------------------------------------------- retire / quarantine / discard


@pytest.mark.parametrize("operation", ["retire", "quarantine"])
def test_retiring_a_version_under_qdrant_is_all_or_nothing(env, operation):
    old = _seed(env, "statik.pdf", stored_as="tmpab12cd34_statik.pdf")
    previous = _PreviousVersion(chunk_ids=old, stored_names=["tmpab12cd34_statik.pdf"])
    retire = getattr(
        env["ingestor"], "_retire_previous_version" if operation == "retire" else "_retire_held_predecessor"
    )
    env["outage"].down = True

    retire(_collection(env), SCOPE, "statik.pdf", previous)

    # Qdrant refused, so Chroma kept it too: never retired in the record yet answering.
    assert _qdrant_ids() == set(old) and _chroma_ids(env) == set(old)
    assert env["bumped"] == []

    env["outage"].down = False
    retire(_collection(env), SCOPE, "statik.pdf", previous)
    assert _qdrant_ids() == set() and _chroma_ids(env) == set()
    assert env["bumped"] == [SCOPE] and env["text"].count(SCOPE) == 0
    if operation == "retire":
        assert "tmpab12cd34_statik.pdf" not in _summary_rows()
    else:  # a quarantine drops no metadata row (ADR-0086)
        assert "tmpab12cd34_statik.pdf" in _summary_rows()


def test_retiring_under_dual_runs_the_whole_chroma_side_when_the_mirror_fails(env, monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    old = _seed(env, "statik.pdf", stored_as="tmpab12cd34_statik.pdf")
    env["outage"].down = True

    env["ingestor"]._retire_previous_version(
        _collection(env), SCOPE, "statik.pdf", _PreviousVersion(chunk_ids=old, stored_names=["tmpab12cd34_statik.pdf"])
    )

    assert _chroma_ids(env) == set()
    assert env["bumped"] == [SCOPE] and env["text"].count(SCOPE) == 0
    assert "tmpab12cd34_statik.pdf" not in _summary_rows()


def test_discarding_a_partial_attempt_under_qdrant_is_all_or_nothing(env):
    before = set(_seed(env, "statik.pdf"))
    partial = set(_seed(env, "statik.pdf", 2)) - before
    env["outage"].down = True

    env["ingestor"]._discard_partial_version(_collection(env), SCOPE, "statik.pdf", before)
    assert _qdrant_ids() == before | partial and _chroma_ids(env) == before | partial

    env["outage"].down = False
    env["ingestor"]._discard_partial_version(_collection(env), SCOPE, "statik.pdf", before)
    assert _qdrant_ids() == before and _chroma_ids(env) == before
    assert env["bumped"] == [SCOPE]


# ---------------------------------------------------------------- delete_collection


def test_delete_collection_under_qdrant_keeps_chroma_when_qdrant_fails(env):
    ids = _seed(env, "plan.pdf")
    env["outage"].down = True

    assert env["ingestor"].delete_collection(SCOPE) is False
    assert _qdrant_ids() == set(ids) and _chroma_ids(env) == set(ids)
    assert "plan.pdf" in _summary_rows() and env["text"].count(SCOPE) == 3

    env["outage"].down = False
    assert env["ingestor"].delete_collection(SCOPE) is True
    assert _qdrant_ids() == set()
    assert SCOPE not in [c.name for c in env["ingestor"]._get_chroma_client().list_collections()]
    assert _summary_rows() == set() and env["text"].count(SCOPE) == 0
    assert env["bumped"] == [SCOPE]


def test_delete_collection_under_dual_bumps_and_clears_when_the_mirror_fails(env, monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    _seed(env, "plan.pdf")
    env["outage"].down = True

    assert env["ingestor"].delete_collection(SCOPE) is True
    assert _summary_rows() == set() and env["text"].count(SCOPE) == 0
    assert env["bumped"] == [SCOPE]


def test_chroma_backend_deletes_without_touching_qdrant(env, monkeypatch):
    _seed(env, "plan.pdf")
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    env["outage"].calls = 0
    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is True
    assert env["ingestor"].delete_collection(SCOPE) is True
    assert env["outage"].calls == 0
