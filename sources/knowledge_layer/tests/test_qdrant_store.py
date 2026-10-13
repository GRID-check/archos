"""The Qdrant store against a real Qdrant server (ADR-0104, ADR-0105).

What is under test is the server's behaviour as this package drives it: German
BM25, server-side fusion, strict mode, phrase matching, grouping. A mock would
only test the mock, so these run against ``AIQ_QDRANT_TEST_URL``: the CI
backend job starts ``qdrant/qdrant:v1.19.2`` as a service container. Locally,
without the variable, the module skips; on CI it fails instead, so the suite
cannot quietly stop running.
"""

from __future__ import annotations

import math
import os
import random
import uuid

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import point_id
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.qdrant.scope import translate
from knowledge_layer.qdrant.search import facet_counts
from knowledge_layer.qdrant.search import grouped_search
from knowledge_layer.qdrant.search import hybrid_search
from knowledge_layer.qdrant.search import phrase
from knowledge_layer.qdrant.store import QdrantStore

DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"}


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


@pytest.fixture
def store(monkeypatch):
    """A store on fresh, uniquely named collections, deleted afterwards."""
    from qdrant_client import QdrantClient

    client = QdrantClient(url=_server_url(), cloud_inference=True, timeout=30, check_compatibility=False)
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"test_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"test_office_{suffix}")
    yield QdrantStore(client, IDENTITY)
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _record(text: str, file_name: str, **metadata) -> ChunkRecord:
    return ChunkRecord(
        chunk_id=str(uuid.uuid4()),
        text=text,
        embedding=_vector(text),
        metadata={"file_name": file_name, "page_label": "1", **metadata},
    )


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


# ---------------------------------------------------------------- pure units


def test_filter_translation_keeps_missing_keys_on_negations():
    flt = translate({"chunking": {"$ne": "page"}})
    assert flt.must_not and not flt.must


def test_filter_translation_coerces_types_to_the_index():
    flt = translate({"punkt_depth": {"$in": ["1", 2]}, "page_label": 3})
    conditions = [part.must[0] for part in flt.must]
    assert conditions[0].match.any == [1, 2]
    assert conditions[1].match.value == "3"


def test_filter_on_unindexed_field_raises():
    with pytest.raises(ValueError, match="not an indexed payload field"):
        translate({"drawing_data": "x"})


def test_unknown_operator_raises():
    with pytest.raises(ValueError):
        translate({"file_name": {"$regex": "x"}})


def test_scope_filter_requires_a_scope():
    with pytest.raises(ValueError):
        scope_filter([])
    with pytest.raises(ValueError):
        scope_filter(["proj_a", ""])


def test_payload_drops_llama_internals_and_keeps_the_text():
    record = ChunkRecord("abc", "Text", [0.1], {"_node_content": "{}", "doc_id": "x", "file_name": "a.pdf"})
    payload = build_payload("proj_a", record, {"office_id": "org_1", "tags": "brandschutz"})
    assert "_node_content" not in payload and "doc_id" not in payload
    assert payload["text"] == "Text" and payload["scope"] == "proj_a" and payload["chunk_id"] == "abc"
    assert payload["tags"] == ["brandschutz"]


def test_point_id_keeps_uuids_and_maps_others_stably():
    chunk_id = str(uuid.uuid4())
    assert point_id(chunk_id) == chunk_id
    assert point_id("not-a-uuid") == point_id("not-a-uuid") != "not-a-uuid"


# ---------------------------------------------------------------- server


def test_german_bm25_finds_inflected_forms(store):
    store.upsert("proj_a", [_record("Die Fluchtwege sind rauchfrei auszuführen.", "bk.pdf")])
    store.upsert("proj_a", [_record("Die Statik berücksichtigt den Holzbau.", "statik.pdf")])
    hits = hybrid_search(store, ["proj_a"], vector=_vector("unrelated"), lexical_text="Fluchtweg", limit=1)
    assert hits[0].payload["file_name"] == "bk.pdf"


def test_search_never_crosses_scopes(store):
    store.upsert("proj_a", [_record("Fluchtweg in Projekt A", "a.pdf")])
    store.upsert("proj_b", [_record("Fluchtweg in Projekt B", "b.pdf")])
    hits = hybrid_search(store, ["proj_a"], vector=_vector("Fluchtweg"), lexical_text="Fluchtweg", limit=10)
    assert {hit.payload["scope"] for hit in hits} == {"proj_a"}


def test_corpus_and_office_scopes_land_in_different_collections(store):
    store.upsert("oib_knowledge", [_record("OIB-Richtlinie 2", "rl2.pdf")])
    store.upsert("archiv_org1", [_record("Büroablage", "ablage.pdf")])
    corpus = store.client.count(schema.ALIASES[schema.Physical.CORPUS]).count
    office = store.client.count(schema.ALIASES[schema.Physical.OFFICE]).count
    assert (corpus, office) == (1, 1)


def test_exact_term_channel_lifts_the_chunk_with_the_phrase(store):
    store.upsert(
        "proj_a",
        [
            _record("Gemäß § 3 Abs. 2 sind Fluchtwege zu kennzeichnen.", "bescheid.pdf"),
            _record("Fluchtwege und Rettungswege im Allgemeinen.", "allgemein.pdf"),
        ],
    )
    assert store.count("proj_a", None, phrase("§ 3 Abs. 2")) == 1
    hits = hybrid_search(store, ["proj_a"], vector=_vector("x"), lexical_text="", exact_terms=["§ 3 Abs. 2"], limit=2)
    assert hits[0].payload["file_name"] == "bescheid.pdf"


def test_hit_cosine_is_the_true_dense_similarity(store):
    record = _record("Brandabschnitt", "a.pdf")
    store.upsert("proj_a", [record])
    query = _vector("query")
    [hit] = hybrid_search(store, ["proj_a"], vector=query, lexical_text="", limit=1)
    assert hit.cosine == pytest.approx(_cosine(query, record.embedding), abs=1e-3)


def test_ne_keeps_points_without_the_field(store):
    store.upsert(
        "oib_knowledge",
        [
            _record("alt", "a.pdf"),
            _record("seite", "a.pdf", chunking="page"),
            _record("punkt", "a.pdf", chunking="punkt"),
        ],
    )
    assert store.count("oib_knowledge", {"chunking": {"$ne": "page"}}) == 2


def test_int_and_string_spellings_meet(store):
    store.upsert("oib_knowledge", [_record("Punkt", "rl.pdf", punkt_depth=1, page_label=4)])
    assert store.count("oib_knowledge", {"punkt_depth": {"$in": ["1"]}}) == 1
    assert store.count("oib_knowledge", {"page_label": {"$in": [4]}}) == 1


def test_deletes_address_scope_file_and_chunk(store):
    a1, a2 = _record("eins", "a.pdf"), _record("zwei", "a.pdf")
    store.upsert("proj_a", [a1, a2, _record("drei", "b.pdf")])
    store.upsert("proj_b", [_record("eins", "a.pdf")])
    store.delete_chunks("proj_a", [a1.chunk_id])
    assert store.count("proj_a") == 2
    store.delete_file("proj_a", "a.pdf")
    assert store.count("proj_a") == 1 and store.count("proj_b") == 1
    store.delete_scope("proj_a")
    assert store.count("proj_a") == 0 and store.count("proj_b") == 1


def test_set_file_payload_mirrors_a_persons_fact(store):
    store.upsert("proj_a", [_record("eins", "a.pdf"), _record("zwei", "b.pdf")])
    store.set_file_payload("proj_a", "a.pdf", {"superseded": True, "tags": ["bescheid"]})
    assert store.count("proj_a", {"superseded": True}) == 1
    assert store.count("proj_a", {"tags": "bescheid"}) == 1


def test_grouped_search_ranks_projects_in_one_call(store):
    store.upsert("proj_a", [_record("Fluchttreppe Holzbau", "a1.pdf"), _record("Fluchttreppe Stahl", "a2.pdf")])
    store.upsert("proj_b", [_record("Fluchttreppe Sicherheitstreppenhaus", "b1.pdf")])
    store.upsert("proj_c", [_record("Fassade", "c1.pdf")])
    groups = grouped_search(
        store,
        ["proj_a", "proj_b", "proj_c"],
        vector=_vector("Fluchttreppe"),
        lexical_text="Fluchttreppe",
        group_by="scope",
        groups=3,
        group_size=2,
    )
    by_scope = dict(groups)
    assert set(by_scope) >= {"proj_a", "proj_b"}
    assert len(by_scope["proj_a"]) == 2


def test_facets_count_per_value(store):
    store.upsert("proj_a", [_record("x", "a.pdf"), _record("y", "a.pdf"), _record("z", "b.pdf")])
    assert dict(facet_counts(store, ["proj_a"], "file_name")) == {"a.pdf": 2, "b.pdf": 1}


def test_strict_mode_refuses_an_unindexed_filter_at_the_server(store):
    from qdrant_client import models

    store.upsert("proj_a", [_record("x", "a.pdf", drawing_type="Grundriss")])
    with pytest.raises(Exception, match="(?i)index"):
        store.client.count(
            store.alias("proj_a"),
            count_filter=models.Filter(
                must=[models.FieldCondition(key="drawing_type", match=models.MatchValue(value="Grundriss"))]
            ),
        )


def test_a_foreign_embedder_is_refused(store):
    store.upsert("proj_a", [_record("x", "a.pdf")])
    other = QdrantStore(store.client, {"aiq:embed_fingerprint": "other", "aiq:embed_model": "other-model"})
    with pytest.raises(RuntimeError, match="embedding mismatch"):
        other.check_identity("proj_a")
    with pytest.raises(RuntimeError, match="embedding mismatch"):
        other.upsert("proj_a", [_record("y", "a.pdf")])


def test_isolation_property_random_scope_sets(store):
    """No hit ever comes from a scope outside the requested set (ADR-0105 Confirmation)."""
    scopes = [f"proj_{name}" for name in "abcdef"] + ["archiv_org1", "s_conv1"]
    words = ["Fluchtweg", "Brandschutz", "Stiege", "Holzbau", "Auflage", "Bescheid"]
    rng = random.Random(7)
    for scope in scopes:
        store.upsert(
            scope, [_record(f"{rng.choice(words)} {rng.choice(words)} {scope}", f"{scope}.pdf") for _ in range(5)]
        )
    returned = 0
    for case in range(200):
        requested = rng.sample(scopes, rng.randint(1, len(scopes)))
        hits = hybrid_search(
            store, requested, vector=_vector(str(case)), lexical_text=rng.choice(words), limit=20, candidates=40
        )
        assert {hit.payload["scope"] for hit in hits} <= set(requested), case
        # Every requested scope holds 5 chunks and the dense channel admits
        # them all: an empty answer would make the property vacuous.
        assert len(hits) == min(20, 5 * len(requested)), case
        returned += len(hits)
    assert returned > 0


def test_no_scope_is_an_empty_answer_not_an_index_error(monkeypatch):
    """A caller with nothing to search gets nothing back, before any store call."""
    from knowledge_layer.qdrant import retrieval

    monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: pytest.fail("store touched for no scope"))
    assert retrieval.search_grouped([], vector=[0.1], lexical_text="x", groups=3, group_size=2, identity={}) == []
    assert grouped_search(object(), [], vector=[0.1], lexical_text="x", group_by="scope", groups=3, group_size=2) == []
    assert hybrid_search(object(), [], vector=[0.1], lexical_text="x", limit=3) == []
