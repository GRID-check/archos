"""``knowledge_search(match="exact", stemmed=true)``: inflected forms through a German-stemmed index (ADR-0127).

The literal exact search finds „Fluchtwegbreite“ inside „Fluchtwegbreiten“ (a
substring) but not the reverse, and never „Türen“ for „Tür“ the other way. A
second copy of the chunk text (``text_stem``) carries a Snowball German index;
the stemmed search adds every chunk it matches to the literal result. Default
off, so the exact search stays literal. Real Qdrant 1.19, real adapter, real tool.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import MagicMock

import pytest
from knowledge_layer.browse import inflection_stem
from knowledge_layer.browse import stemmed_pattern
from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
from knowledge_layer.qdrant import retrieval
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import chunk_metadata
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.tests.qdrant_testing import record
from sources.knowledge_layer.tests.qdrant_testing import vector
from sources.knowledge_layer.tests.qdrant_testing import write

PROJECT = "proj_stem"
BASE = "oib_knowledge"
TEXTS = {
    "Plural.pdf": "Die Fluchtwegbreiten betragen im Erdgeschoss 1,20 m.",
    "Singular.pdf": "Die Fluchtwegbreite beträgt 1,20 m.",
    "Compound.pdf": "Die Fluchtwegbreitenangabe fehlt.",
    "Tueren.pdf": "Die Türen T30 schließen selbsttätig.",
    "Other.pdf": "Brandabschnitte sind zu bilden.",
}


class TestTheCountingPattern:
    @pytest.mark.parametrize(
        ("phrase", "stem"),
        [
            ("Fluchtwegbreiten", "Fluchtwegbreit"),
            ("Fluchtwegbreite", "Fluchtwegbreit"),
            ("Brandabschnitte", "Brandabschnitt"),
            ("Türen", "Türe"),
            ("EI 90", "EI 90"),
            ("OIB-Richtlinie", "OIB-Richtlinie"),
            ("Fluchtwege ins Freie", "Fluchtweg ins Frei"),
        ],
    )
    def test_the_stem_drops_one_ending_from_a_long_plain_word(self, phrase, stem):
        assert inflection_stem(phrase) == stem

    def test_the_pattern_finds_both_numbers(self):
        import re

        pattern = re.compile(stemmed_pattern(["Fluchtwegbreiten"]))

        assert pattern.search(TEXTS["Singular.pdf"]) and pattern.search(TEXTS["Plural.pdf"])


def test_the_stemmed_copy_is_written_and_never_read_back_as_metadata():
    payload = build_payload(PROJECT, ChunkRecord("c1", "Die Türen", [0.1], {"file_name": "a.pdf"}))

    assert payload[schema.TEXT_STEM_FIELD] == "Die Türen"
    assert schema.TEXT_STEM_FIELD not in chunk_metadata(payload)
    with pytest.raises(ValueError, match="not an indexed payload field"):
        from knowledge_layer.qdrant.scope import translate

        translate({schema.TEXT_STEM_FIELD: "x"})


# ---------------------------------------------------------------- real Qdrant


@pytest.fixture
def placed(qdrant_store):
    write(PROJECT, [record(text, name) for name, text in TEXTS.items()])
    return qdrant_store


def _files(hits) -> set[str]:
    return {hit.payload["file_name"] for hit in hits}


class TestOnQdrant:
    def test_the_index_is_the_stemmed_one(self, placed):
        params = placed.client.get_collection(placed.alias(PROJECT)).payload_schema[schema.TEXT_STEM_FIELD].params

        assert params.stemmer.language == "german"

    def test_the_plural_finds_the_singular_and_the_singular_the_plural(self, placed):
        for asked in ("Fluchtwegbreiten", "Fluchtwegbreite"):
            pattern = stemmed_pattern([asked])
            found = retrieval.find_text(PROJECT, pattern, None, 50, stem_phrases=[asked])

            assert _files(found) >= {"Plural.pdf", "Singular.pdf"}, asked
            assert "Other.pdf" not in _files(found)

    def test_the_literal_search_is_what_it_was(self, placed):
        from knowledge_layer.browse import phrase_pattern

        literal = retrieval.find_text(PROJECT, phrase_pattern(["Fluchtwegbreiten"]), None, 50)

        # A substring: the plural and the compound, never the singular.
        assert _files(literal) == {"Plural.pdf", "Compound.pdf"}

    def test_the_stemmed_result_is_the_literal_one_and_more(self, placed):
        pattern = stemmed_pattern(["Fluchtwegbreiten"])

        found = retrieval.find_text(PROJECT, pattern, None, 50, stem_phrases=["Fluchtwegbreiten"])

        assert _files(found) == {"Plural.pdf", "Singular.pdf", "Compound.pdf"}

    def test_an_umlaut_plural_and_a_phrase(self, placed):
        assert _files(retrieval.find_text(PROJECT, stemmed_pattern(["Tür"]), None, 50, stem_phrases=["Tür"])) == {
            "Tueren.pdf"
        }
        phrase = ["Fluchtwegbreite betragen"]
        assert "Plural.pdf" in _files(
            retrieval.find_text(PROJECT, stemmed_pattern(phrase), None, 50, stem_phrases=phrase)
        )

    def test_a_point_written_before_the_field_is_still_found_literally(self, placed):
        alias = placed.alias(PROJECT)
        old = record("Die Fluchtwegbreiten im Altbestand.", "Alt.pdf")
        write(PROJECT, [old])
        placed.client.delete_payload(
            alias,
            keys=[schema.TEXT_STEM_FIELD],
            points=scope_filter([PROJECT], {"file_name": "Alt.pdf"}),
            wait=True,
        )

        found = retrieval.find_text(
            PROJECT, stemmed_pattern(["Fluchtwegbreiten"]), None, 50, stem_phrases=["Fluchtwegbreiten"]
        )

        assert "Alt.pdf" in _files(found)


# ---------------------------------------------------------------- through the tool


@pytest.fixture
def tool(qdrant_store, monkeypatch):
    instance = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    instance._initialized = True
    monkeypatch.setattr(instance, "_embed_query_cached", lambda query: vector(query))
    write(PROJECT, [record(text, name, chunk_id=str(uuid.uuid4())) for name, text in TEXTS.items()])
    docs = [AvailableDocument(file_name=name, collection=PROJECT, shelf="project") for name in TEXTS]
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", lambda collection: {})
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: instance)
    set_turn_documents(docs)

    async def run(**kwargs: Any) -> str:
        config = KnowledgeRetrievalConfig(collection_name=BASE, include_session_collection=False, top_k=5)
        async with knowledge_retrieval(config, MagicMock()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    yield run
    set_turn_documents(None)


def _table(out: str) -> str:
    return out.split("## Matches for", 1)[1]


class TestThroughTheTool:
    async def test_stemmed_finds_the_singular_and_says_what_a_match_meant(self, tool):
        out = await tool(query="Fluchtwegbreiten", match="exact", stemmed=True)

        assert "Inflected forms included" in out
        assert "- Singular.pdf (Projektwissen): 1×" in _table(out)
        assert "- Plural.pdf (Projektwissen): 1×" in _table(out)

    async def test_by_default_the_exact_search_stays_literal(self, tool):
        out = await tool(query="Fluchtwegbreiten", match="exact")

        assert "Inflected forms included" not in out
        assert "Singular.pdf" not in _table(out)

    async def test_stemmed_belongs_to_the_exact_mode(self, tool):
        assert (await tool(query="Fluchtwegbreiten", stemmed=True)).startswith("`stemmed` finds inflected forms")
        assert (await tool(query="Tür.*", match="regex", stemmed=True)).startswith("`stemmed` finds inflected forms")
