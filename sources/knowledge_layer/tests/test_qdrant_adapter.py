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
#: The real reader, before ``qdrant_env`` stubs it for the tests that need no metadata store.
FACTS_BY_FILE = mirror.facts_by_file


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
    chroma: list[str] = []
    mirror.ordered_delete("proj_a", lambda: chroma.append("chunks"), chunk_ids=[rows[0]["id"]])
    assert store.count("proj_a") == 2
    mirror.ordered_delete("proj_a", lambda: chroma.append("file"), file_name="a.pdf")
    assert store.count("proj_a") == 1
    mirror.ordered_delete("proj_a", lambda: chroma.append("scope"), whole_scope=True)
    assert store.count("proj_a") == 0
    assert chroma == ["chunks", "file", "scope"]


def test_dual_swallows_a_mirror_failure_and_qdrant_raises_before_chroma(qdrant_env, monkeypatch):
    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectionError("qdrant down")

    monkeypatch.setattr(store_module.QdrantStore, "delete_file", broken)
    chroma: list[str] = []
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "dual")
    assert mirror.ordered_delete("proj_a", lambda: chroma.append("dual") or "done", file_name="a.pdf") == "done"
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "qdrant")
    with pytest.raises(ConnectionError):
        mirror.ordered_delete("proj_a", lambda: chroma.append("qdrant"), file_name="a.pdf")
    assert chroma == ["dual"]


def test_chroma_backend_never_touches_qdrant(monkeypatch):
    monkeypatch.setenv("AIQ_VECTOR_BACKEND", "chroma")
    monkeypatch.setattr(store_module, "get_store", lambda *a, **k: pytest.fail("Qdrant touched under chroma"))
    assert mirror.ordered_delete("proj_a", lambda: "chroma", chunk_ids=["x"], file_name="a.pdf") == "chroma"
    assert mirror.ordered_delete("proj_a", lambda: "chroma", whole_scope=True) == "chroma"
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


# ---------------------------------------------------------------- numeric legal references, end to end


NUMBERED = [
    "Gemäß § 3 Abs. 2 sind Fluchtwege vorzusehen.",
    "Nach §3 gilt dies sinngemäß.",
    "Punkt 5.1.1 der OIB-Richtlinie 2 regelt Treppen.",
    "Die Brüstungshöhe beträgt 43 cm.",
    "Abs. 3 und Seite 3 nennen keinen Paragraphen.",
    "OIB-Richtlinie 3 ist eine andere.",
    "Punkt 5.1.10 und § 13 Abs. 2 sind andere Stellen.",
]


async def test_numeric_legal_references_reach_the_exact_term_channel(retriever):
    """extract_exact_terms -> term_frequencies -> the phrase prefetch, as ``knowledge_search`` runs it.

    On the ``multilingual`` tokenizer every count here was 0, so
    ``selective_terms`` dropped the terms and the channel the Chroma path's
    ``$contains`` served never ran.
    """
    from knowledge_layer.qdrant import retrieval as qdrant_retrieval

    _ingest(retriever, "proj_a", [_row(text, f"{index}.pdf") for index, text in enumerate(NUMBERED)])

    _, terms = retriever._qdrant_lexical_inputs("Was regelt § 3 zur Fluchttreppe?", "proj_a")
    assert terms == ["§ 3"]
    _, terms = retriever._qdrant_lexical_inputs('Was sagt die OIB-Richtlinie 2 in "5.1.1"? Und "43 cm"?', "proj_a")
    assert terms == ["OIB-Richtlinie 2", "5.1.1", "43 cm"]

    total, frequencies = qdrant_retrieval.term_frequencies("proj_a", ["§ 3", "5.1.1", "43 cm", "OIB-Richtlinie 2"])
    assert total == len(NUMBERED)
    assert frequencies == {"§ 3": 2, "5.1.1": 1, "43 cm": 1, "OIB-Richtlinie 2": 1}

    # The exact channel alone beside the dense one: the two chunks citing § 3
    # are in both, every other chunk in one, so they lead.
    hits = qdrant_retrieval.search(
        "proj_a",
        vector=_vector("Was regelt § 3?"),
        lexical_text="",
        top_k=len(NUMBERED),
        filters=None,
        exact_terms=["§ 3"],
        identity=retriever._identity(),
    )
    assert {hit.payload["file_name"] for hit in hits[:2]} == {"0.pdf", "1.pdf"}


# ---------------------------------------------------------------- find_text narrows on the server


FIND_CORPUS = [
    "Die Größe der Fläche ist anzugeben.",
    "Die Grösse der Flaeche ist anzugeben.",
    "DIE GROESSE DER FLAECHE IST ANZUGEBEN.",
    "Die Größe der Fläche, geschützt.",
    "Die Größe-der-Fläche als Begriff.",
    "Die Größe der Fläche, zerlegt.",
    "Die Größe der Flächen im Plural.",
    "Größe und Fläche, ohne der.",
    "Die Strasse und die Straße und die STRASSE.",
    "Der Weg, der Steg, das EG und die Regel.",
    "EG-Richtlinie und eg.",
    "Hauptfluchtstiegen sind breit.",
    "Die Fluchtstiege ist beleuchtet.",
    "Gemäß § 3 Abs. 2 und 3 sowie §3.",
    "Punkt 5.1.1 und 15.1.10 und 5.1.10.",
    "OIB-Richtlinie 2 und OIB Richtlinie 2 und OIB-Richtlinie 21.",
    "T30-2 Tür und T30-2-Tür.",
    "Abs.2 und 3 ohne Leerzeichen; Abs. 2 und 3 mit.",
] + [f"Füllkapitel {index} über Beton und Holz." for index in range(40)]

FIND_PHRASES = [
    ["Größe der Fläche"],
    ["Grösse der Flaeche"],
    ["Strasse"],
    ["Straße", "Weg"],
    ["EG"],
    ["weg", "EG"],
    ["Fluchtstiege"],
    ["§ 3"],
    ["5.1.1"],
    ["OIB-Richtlinie 2"],
    ["T30-2 Tür"],
    ["Abs. 2 und 3"],
    ["Beton und Holz"],
    ["der"],
]


async def test_find_text_with_the_token_prefilter_returns_exactly_what_the_full_scroll_does(retriever, monkeypatch):
    from knowledge_layer.browse import phrase_pattern
    from knowledge_layer.qdrant import retrieval as qdrant_retrieval
    from knowledge_layer.qdrant import store as store_module

    _ingest(retriever, "proj_a", [_row(text, f"{index:02d}.pdf") for index, text in enumerate(FIND_CORPUS)])
    scanned = {"n": 0}
    real_scroll = store_module.QdrantStore.scroll

    def counting(self, *args, **kwargs):
        for record in real_scroll(self, *args, **kwargs):
            scanned["n"] += 1
            yield record

    monkeypatch.setattr(store_module.QdrantStore, "scroll", counting)

    def run(pattern: str) -> tuple[list[str], int]:
        scanned["n"] = 0
        hits = qdrant_retrieval.find_text("proj_a", pattern, None, 100)
        return [hit.chunk_id for hit in hits], scanned["n"]

    narrowed_patterns = 0
    for phrases in FIND_PHRASES:
        pattern = phrase_pattern(phrases)
        narrowed, narrowed_scanned = run(pattern)
        with monkeypatch.context() as full_scroll:
            full_scroll.setattr(qdrant_retrieval, "_text_prefilter", lambda scope, pattern: [])
            full, full_scanned = run(pattern)
        assert narrowed == full, phrases
        assert full_scanned == len(FIND_CORPUS)
        if qdrant_retrieval.literal_tokens(pattern):
            narrowed_patterns += 1
            assert narrowed_scanned < full_scanned, phrases
    # Not vacuous: most of these patterns narrow on the server.
    assert narrowed_patterns >= 8
    # And the matches themselves are the ones a reader expects.
    found, _ = run(phrase_pattern(["Größe der Fläche"]))
    assert len(found) == 7  # every spelling, the plural included (a substring), not "ohne der"


def test_literal_tokens_only_names_words_every_match_holds_whole():
    from knowledge_layer.browse import phrase_pattern
    from knowledge_layer.qdrant.retrieval import literal_tokens

    assert literal_tokens(phrase_pattern(["Größe der Fläche"])) == [["der"]]
    assert literal_tokens(phrase_pattern(["OIB-Richtlinie 2"])) == [["richtlinie"]]
    assert literal_tokens(phrase_pattern(["weg", "EG"])) == [["weg"], ["eg"]]
    # A word longer than three characters matches inside longer words: no token.
    assert literal_tokens(phrase_pattern(["Fluchtstiege"])) is None
    # One alternative without a safe word leaves no safe condition at all.
    assert literal_tokens(phrase_pattern(["Straße", "Weg"])) is None
    assert literal_tokens("(?i)fo+") is None


# ---------------------------------------------------------------- facts: per file, batched, cleared


@pytest.fixture
def metadata_store(tmp_path, monkeypatch):
    """A real SQLite metadata store, with ``facts_by_file`` reading it (the module fixture stubs it out)."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    monkeypatch.setattr(mirror, "facts_by_file", FACTS_BY_FILE)
    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


def test_refreshing_one_file_reads_only_its_row(retriever, metadata_store, monkeypatch):
    from aiq_agent import knowledge
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_tags_by_person

    _ingest(retriever, "proj_a", [_row("eins", "a.pdf"), _row("zwei", "b.pdf")])
    register_summary("proj_a", "a.pdf", "A")
    register_summary("proj_a", "b.pdf", "B")
    monkeypatch.setattr(
        knowledge, "get_available_documents", lambda scope: pytest.fail("a one-file refresh read the whole scope")
    )

    assert set_document_tags_by_person("proj_a", "a.pdf", ["bescheid"]) is True

    assert store_module.get_store().count("proj_a", {"tags": "bescheid"}) == 1


def test_a_folder_rename_mirrors_in_one_batch_not_one_request_per_file(retriever, metadata_store, monkeypatch):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import rewrite_document_folder_paths
    from aiq_agent.knowledge import set_document_folder_path

    names = [f"{index}.pdf" for index in range(5)]
    _ingest(retriever, "proj_a", [_row(f"Text {name}", name) for name in names])
    for name in names:
        register_summary("proj_a", name, f"Summary {name}")
        set_document_folder_path("proj_a", name, "Brandschutz/Fluchtwege")
    client = store_module.get_store().client
    calls = {"set_payload": 0, "batch_update_points": 0, "scroll": 0}
    for method in calls:
        real = getattr(client, method)

        def counted(*args, _real=real, _method=method, **kwargs):
            calls[_method] += 1
            return _real(*args, **kwargs)

        monkeypatch.setattr(client, method, counted)

    assert rewrite_document_folder_paths("proj_a", "Brandschutz", "Feuer") == 5

    assert calls == {"set_payload": 0, "batch_update_points": 1, "scroll": 0}
    store = store_module.get_store()
    assert store.count("proj_a", {"folder_ancestors": "feuer/fluchtwege"}) == 5
    assert store.count("proj_a", {"folder_ancestors": "brandschutz"}) == 0


def test_clearing_a_dokumentart_puts_the_chunks_own_back(retriever, metadata_store):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_doc_class

    _ingest(retriever, "proj_a", [_row("Plan", "plan.pdf", doc_class="einreichplan"), _row("Brief", "brief.pdf")])
    register_summary("proj_a", "plan.pdf", "P")
    register_summary("proj_a", "brief.pdf", "B")
    store = store_module.get_store()
    set_document_doc_class("proj_a", "plan.pdf", "bescheid")
    set_document_doc_class("proj_a", "brief.pdf", "korrespondenz")
    assert store.count("proj_a", {"doc_class": "bescheid"}) == 1
    assert store.count("proj_a", {"doc_class": "korrespondenz"}) == 1

    set_document_doc_class("proj_a", "plan.pdf", None)
    set_document_doc_class("proj_a", "brief.pdf", None)

    # What register._hit_doc_class falls back to once the stored class is gone.
    assert store.count("proj_a", {"doc_class": "einreichplan"}) == 1
    assert store.count("proj_a", {"doc_class": "bescheid"}) == 0
    assert store.count("proj_a", {"doc_class": "korrespondenz"}) == 0


async def test_a_hit_carries_the_chunks_own_dokumentart_as_chroma_does(retriever, metadata_store):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_doc_class

    _ingest(retriever, "proj_a", [_row("Plan", "plan.pdf", doc_class="einreichplan")])
    register_summary("proj_a", "plan.pdf", "P")
    set_document_doc_class("proj_a", "plan.pdf", "bescheid")

    result = await retriever.retrieve("Plan", "proj_a", top_k=1)

    assert result.chunks[0].metadata.get("doc_class") == "einreichplan"


# ---------------------------------------------------------------- health


async def test_health_needs_chroma_too_under_qdrant(retriever, monkeypatch):
    """Chroma is still the write record and serves registry reads: a dead one is not healthy."""

    class DeadChroma:
        def heartbeat(self):
            raise ConnectionError("chroma down")

    class LiveChroma:
        def heartbeat(self):
            return 1

    retriever._chroma_client = DeadChroma()
    assert await retriever.health_check() is False
    retriever._chroma_client = LiveChroma()
    assert await retriever.health_check() is True
    monkeypatch.setattr(store_module.QdrantStore, "health", lambda self: False)
    assert await retriever.health_check() is False
