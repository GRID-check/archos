"""BM25 tuned to our chunks: measured from the stored vectors, written by a ``_vN`` rebuild (ADR-0127, S12).

Qdrant's ``qdrant/bm25`` normalises term weights by chunk length against
``avg_len`` (default 256 of ITS tokens). A collection records the length
normalisation its lexical vectors were written with (``schema.BM25_LENGTH_KEY``);
none recorded means Qdrant's defaults, which is every collection the rebuild
did not make. The rebuild measures the source's chunk lengths from the weights
it stored, writes the target with the measured ``avg_len`` and recomputes every
lexical vector; writes and queries then read the length from the collection the
alias points at. Real Qdrant, like ``test_qdrant_rebuild.py``.
"""

from __future__ import annotations

import os
import random
import uuid

import pytest
from knowledge_layer.qdrant import folders
from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.search import hybrid_search
from knowledge_layer.qdrant.store import QdrantStore

DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "fp-bm25", "aiq:embed_model": "model-bm25"}
SCOPE = "proj_bm25"
#: Words the German analysis keeps (no stopwords), so a text of N of them is N BM25 tokens long.
WORDS = ["Fluchtweg", "Treppenhaus", "Brandabschnitt", "Geschoss", "Rauchabzug", "Bauteil", "Decke", "Wand"]


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


@pytest.fixture
def store(monkeypatch):
    from qdrant_client import QdrantClient

    client = QdrantClient(url=_server_url(), cloud_inference=True, timeout=30, check_compatibility=False)
    suffix = uuid.uuid4().hex[:8]
    alias = f"bm25_office_{suffix}"
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, alias)
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"bm25_corpus_{suffix}")
    yield QdrantStore(client, IDENTITY)
    for name in (alias + schema.FIRST_VERSION, alias + "_v2", alias + "_v3"):
        if client.collection_exists(name):
            client.delete_collection(name)


def _text(words: int, seed: int) -> str:
    rng = random.Random(seed)
    return " ".join(f"{rng.choice(WORDS)}{rng.randrange(10_000)}" for _ in range(words))


def _records(lengths: list[int]) -> list[ChunkRecord]:
    rng = random.Random(7)
    return [
        ChunkRecord(
            chunk_id=str(uuid.uuid4()),
            text=_text(words, index),
            embedding=[rng.uniform(-1, 1) for _ in range(DIM)],
            metadata={"file_name": f"f{index}.pdf", "page_label": "1"},
        )
        for index, words in enumerate(lengths)
    ]


def _weights(store: QdrantStore, collection: str, chunk_id: str) -> list[float]:
    [point] = store.client.retrieve(collection, [chunk_id], with_vectors=[schema.LEXICAL])
    return list(point.vector[schema.LEXICAL].values)


class TestTheArithmetic:
    def test_a_weight_gives_the_length_back(self):
        length = {"k": 1.2, "b": 0.75, "avg_len": 256.0}
        for dl in (12.0, 256.0, 900.0):
            weight = 2.2 / (1 + 1.2 * (0.25 + 0.75 * dl / 256))

            assert rebuild.length_from_weight(weight, length) == pytest.approx(dl)

    def test_no_length_in_the_weight_is_no_answer(self):
        assert rebuild.length_from_weight(0.5, {"k": 1.2, "b": 0.0, "avg_len": 256.0}) is None
        assert rebuild.length_from_weight(0.0, {"k": 1.2, "b": 0.75, "avg_len": 256.0}) is None

    def test_the_tuned_length_moves_only_beyond_the_tolerance_and_takes_overrides(self):
        def stats(mean):
            return rebuild.LengthStats("c", 10, mean, mean, mean)

        assert rebuild.tuned_length(stats(270), {}) == schema.BM25_DEFAULT_LENGTH
        assert rebuild.tuned_length(stats(80.4), {})["avg_len"] == 80.0
        assert rebuild.tuned_length(None, {"avg_len": 90.0}) == {"k": 1.2, "b": 0.75, "avg_len": 90.0}
        assert rebuild.tuned_length(stats(80), {}, k=1.5, b=0.6, avg_len=100) == {"k": 1.5, "b": 0.6, "avg_len": 100.0}

    def test_the_metadata_is_read_defensively(self):
        assert schema.bm25_length_of(None) == {}
        assert schema.bm25_length_of({schema.BM25_LENGTH_KEY: "256"}) == {}
        assert schema.bm25_length_of({schema.BM25_LENGTH_KEY: {"avg_len": -1}}) == {}
        assert schema.bm25_length_of({schema.BM25_LENGTH_KEY: {"avg_len": 80, "x": 1}}) == {"avg_len": 80.0}


class TestOnQdrant:
    def test_a_new_collection_records_nothing_and_writes_with_the_defaults(self, store):
        store.upsert(SCOPE, _records([40]))
        alias = schema.ALIASES[schema.Physical.OFFICE]

        metadata = store.client.get_collection(alias).config.metadata
        assert schema.BM25_LENGTH_KEY not in metadata
        assert store.bm25_length(SCOPE) == {}
        stats = rebuild.measure_lengths(store.client, alias)
        assert stats.mean == pytest.approx(40, abs=0.5)

    def test_the_rebuild_measures_records_and_recomputes(self, store):
        records = _records([60, 80, 100, 120])
        store.upsert(SCOPE, records)
        alias = schema.ALIASES[schema.Physical.OFFICE]
        before = _weights(store, alias + schema.FIRST_VERSION, records[0].chunk_id)

        report = rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")

        assert report.complete and report.relexed
        assert report.bm25_length == {"k": 1.2, "b": 0.75, "avg_len": 90.0}
        target = store.client.get_collection(alias + "_v2").config.metadata
        assert target[schema.BM25_LENGTH_KEY] == {"k": 1.2, "b": 0.75, "avg_len": 90.0}
        assert target["aiq:embed_fingerprint"] == IDENTITY["aiq:embed_fingerprint"]
        after = _weights(store, alias + "_v2", records[0].chunk_id)
        # A 60-token chunk was short against 256 and is near the mean against 90: its weights fall.
        assert min(after) < min(before)
        assert rebuild.length_from_weight(min(after), report.bm25_length) == pytest.approx(60, abs=0.5)

    def test_after_the_switch_writes_and_searches_use_the_new_length(self, store):
        records = _records([60, 80, 100, 120])
        records[1].text = "Sprinkleranlage " + records[1].text
        store.upsert(SCOPE, records)
        alias = schema.ALIASES[schema.Physical.OFFICE]
        rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")
        rebuild.switch_alias(store.client, schema.Physical.OFFICE, alias + "_v2")
        fresh = QdrantStore(store.client, IDENTITY)

        [late] = _records([60])
        fresh.upsert(SCOPE, [late])
        hits = hybrid_search(fresh, [SCOPE], vector=records[1].embedding, lexical_text="Sprinkleranlage", limit=2)

        assert fresh.bm25_length(SCOPE) == {"k": 1.2, "b": 0.75, "avg_len": 90.0}
        assert rebuild.length_from_weight(min(_weights(fresh, alias, late.chunk_id)), fresh.bm25_length(SCOPE)) == (
            pytest.approx(60, abs=0.5)
        )
        assert hits[0].chunk_id == records[1].chunk_id

    def test_a_length_within_the_tolerance_is_copied_as_stored(self, store):
        records = _records([250, 260])
        store.upsert(SCOPE, records)
        alias = schema.ALIASES[schema.Physical.OFFICE]

        report = rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")

        assert not report.relexed and report.bm25_length == schema.BM25_DEFAULT_LENGTH
        assert schema.BM25_LENGTH_KEY not in store.client.get_collection(alias + "_v2").config.metadata
        assert _weights(store, alias + "_v2", records[0].chunk_id) == _weights(
            store, alias + schema.FIRST_VERSION, records[0].chunk_id
        )

    def test_keep_and_explicit_values(self, store):
        store.upsert(SCOPE, _records([40, 50]))
        alias = schema.ALIASES[schema.Physical.OFFICE]

        kept = rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2", retune_bm25=False)
        given = rebuild.copy_collection(
            store.client, schema.Physical.OFFICE, alias + "_v3", bm25_length={"avg_len": 300, "k": 1.5}
        )

        assert not kept.relexed and kept.bm25_length == schema.BM25_DEFAULT_LENGTH
        assert given.relexed and given.bm25_length == {"k": 1.5, "b": 0.75, "avg_len": 300.0}

    def test_a_rebuild_carries_the_folder_card_points(self, store):
        store.upsert(SCOPE, _records([60, 80]))
        folders.upsert_folder_card(
            store, SCOPE, {"folder_path": "Gutachten", "abstract": "Gutachten.", "key_facts": []}, [0.1] * DIM
        )
        alias = schema.ALIASES[schema.Physical.OFFICE]

        report = rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")
        rebuild.switch_alias(store.client, schema.Physical.OFFICE, alias + "_v2")

        assert report.complete and report.relexed
        assert [card["folder_path"] for card in folders.folder_cards(store, [SCOPE])] == ["Gutachten"]

    def test_the_stats_script_reads_and_writes_nothing(self, store, monkeypatch, capsys):
        import importlib.util
        import pathlib

        store.upsert(SCOPE, _records([60, 80]))
        monkeypatch.setenv("AIQ_QDRANT_URL", _server_url())
        monkeypatch.delenv("AIQ_QDRANT_API_KEY", raising=False)
        path = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "qdrant_chunk_length_stats.py"
        spec = importlib.util.spec_from_file_location("qdrant_chunk_length_stats", path)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)

        assert script.main(["office"]) == 0
        assert "2 chunks, mean 70" in capsys.readouterr().out
        assert (
            schema.BM25_LENGTH_KEY
            not in store.client.get_collection(schema.ALIASES[schema.Physical.OFFICE]).config.metadata
        )


def test_the_ttl_is_what_a_running_process_trusts():
    assert store_module.BM25_LENGTH_TTL_SECONDS <= 600
