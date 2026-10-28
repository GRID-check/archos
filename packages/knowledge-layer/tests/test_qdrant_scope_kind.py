"""Folder card points never reach a chunk read; the folder channel finds them (ADR-0127, S11c).

A folder card is a point ``kind = folder`` in its folder's own scope, beside the
chunks. Every read in the knowledge layer builds its filter in
``scope.scope_filter``, which leaves those points out unless the read asks for
them. These tests put a folder point next to real chunks on a real Qdrant and
drive every read path there is (ranked, grouped, similar, scroll, ordered
scroll, grep, facets, counts, the chunk id listings, the structural fetch),
then the two that may see it: the folder search and the folder scroll.
"""

from __future__ import annotations

import pytest
from knowledge_layer.qdrant import folders
from knowledge_layer.qdrant import reads
from knowledge_layer.qdrant import retrieval
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.scope import kind_filter
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.qdrant.search import grouped_search
from knowledge_layer.qdrant.search import hybrid_search
from knowledge_layer.qdrant.similar import PassageSource
from knowledge_layer.qdrant.similar import find_similar
from knowledge_layer_testing.qdrant import record
from knowledge_layer_testing.qdrant import vector
from knowledge_layer_testing.qdrant import write
from qdrant_client import models

PROJECT = "proj_kind"
RESTRICTED = "proj_kind_r_9"
CARD_TEXT = "Brandschutz Fluchtwege Gutachten"

CARD = {
    "folder_path": "Gutachten/Brandschutz",
    "abstract": "Brandschutzgutachten und Fluchtwegnachweise des Projekts.",
    "key_facts": [{"statement": "Fluchtwegbreite 1,20 m nachgewiesen.", "documents": ["BS.pdf"]}],
    "status": "fresh",
    "abstract_hash": "abc",
}


@pytest.fixture
def placed(qdrant_store):
    """Two chunks and one folder card point in the project; a card in a restricted scope too."""
    write(
        PROJECT,
        [
            record(CARD_TEXT, "BS.pdf", folder_path="Gutachten/Brandschutz", reading_order=1, chunk_ordinal=0),
            record("Statik Bewehrung Decke", "Statik.pdf", folder_path="Gutachten", reading_order=1, chunk_ordinal=0),
        ],
    )
    # The card's vector is the chunk text's, so a chunk search for that text ranks it first if it can.
    folders.upsert_folder_card(qdrant_store, PROJECT, CARD, vector(CARD_TEXT))
    write(RESTRICTED, [record("Geheim", "Vertrag.pdf", reading_order=1, chunk_ordinal=0)])
    folders.upsert_folder_card(qdrant_store, RESTRICTED, {**CARD, "folder_path": "Verträge"}, vector(CARD_TEXT))
    return qdrant_store


def _no_folder(payloads) -> None:
    payloads = [dict(payload or {}) for payload in payloads]
    assert payloads, "the read returned nothing at all, so it proves nothing"
    assert all(payload.get(schema.KIND_FIELD) != schema.FOLDER_KIND for payload in payloads)


class TestNoChunkReadSeesAFolder:
    def test_the_ranked_search(self, placed):
        hits = hybrid_search(placed, [PROJECT], vector=vector(CARD_TEXT), lexical_text=CARD_TEXT, limit=10)

        _no_folder(hit.payload for hit in hits)
        assert len(hits) == 2

    def test_the_grouped_search(self, placed):
        groups = grouped_search(
            placed,
            [PROJECT, RESTRICTED],
            vector=vector(CARD_TEXT),
            lexical_text=CARD_TEXT,
            group_by="scope",
            groups=5,
            group_size=5,
        )

        _no_folder(hit.payload for _scope, hits in groups for hit in hits)

    def test_similar_passages(self, placed):
        result = find_similar(
            placed,
            [PROJECT],
            source=PassageSource(scope=PROJECT, file_name="Statik.pdf", text="Statik Bewehrung Decke"),
            embed=vector,
            documents=5,
            per_document=3,
        )

        assert [document.file_name for document in result.documents] == ["BS.pdf"]

    def test_scroll_and_ordered_scroll(self, placed):
        _no_folder(point.payload for point in placed.scroll(PROJECT))
        _no_folder(point.payload for point in placed.scroll_ordered(PROJECT, None, schema.READING_ORDER_FIELD, 10))

    def test_the_structural_fetch(self, placed):
        _no_folder(hit.payload for hit in reads.fetch(PROJECT, None, 10))

    def test_grep(self, placed):
        # The card's abstract says "Brandschutzgutachten"; a grep reads chunk text only.
        hits = retrieval.find_text(PROJECT, r"(?i)brandschutz", None, 50)

        _no_folder(hit.payload for hit in hits)

    def test_counts_and_facets(self, placed):
        assert placed.count(PROJECT) == 2
        assert placed.file_counts(PROJECT) == {"BS.pdf": 1, "Statik.pdf": 1}
        assert placed.facet_counts(PROJECT, "folder_path") == {"Gutachten/Brandschutz": 1, "Gutachten": 1}
        assert placed.scope_counts(schema.Physical.OFFICE) == {PROJECT: 2, RESTRICTED: 1}

    def test_the_chunk_id_listings(self, placed):
        ids = set(placed.chunk_ids(PROJECT))

        assert len(ids) == 2
        assert set(placed.sample_chunk_ids(PROJECT, 10)) == ids

    def test_term_frequencies(self, placed):
        total, counts = retrieval.term_frequencies(PROJECT, ["Brandschutz"])

        assert total == 2


class TestTheFolderReads:
    def test_the_folder_search_lands_on_the_card(self, placed):
        [hit] = folders.search_folders(placed, [PROJECT], vector(CARD_TEXT))

        assert hit.folder_path == "Gutachten/Brandschutz"
        assert hit.abstract == CARD["abstract"]
        assert hit.scope == PROJECT and hit.score == pytest.approx(1.0, abs=1e-2)

    def test_a_restricted_folders_card_is_invisible_without_its_scope(self, placed):
        assert [hit.folder_path for hit in folders.search_folders(placed, [PROJECT], vector(CARD_TEXT))] == [
            "Gutachten/Brandschutz"
        ]
        both = folders.search_folders(placed, [PROJECT, RESTRICTED], vector(CARD_TEXT))
        assert {hit.folder_path for hit in both} == {"Gutachten/Brandschutz", "Verträge"}

    def test_within_a_folder_only_the_folders_beneath_it(self, placed):
        assert folders.search_folders(placed, [PROJECT], vector(CARD_TEXT), folder="Gutachten")[0].folder_path == (
            "Gutachten/Brandschutz"
        )
        assert folders.search_folders(placed, [PROJECT], vector(CARD_TEXT), folder="Gutachten/Brandschutz") == []
        assert folders.search_folders(placed, [PROJECT], vector(CARD_TEXT), folder="Pläne") == []

    def test_the_corpus_has_no_folder_channel(self, placed):
        assert folders.search_folders(placed, ["oib_knowledge"], vector(CARD_TEXT)) == []

    def test_the_folder_scroll_and_a_kind_read(self, placed):
        [card] = folders.folder_cards(placed, [PROJECT])

        assert card["folder_ancestors"] == ["gutachten", "gutachten/brandschutz"]
        assert card["key_facts"] == CARD["key_facts"]
        assert placed.client.count(placed.alias(PROJECT), count_filter=kind_filter("folder"), exact=True).count == 2
        folder_read = scope_filter([PROJECT], None, kind="folder")
        assert placed.client.count(placed.alias(PROJECT), count_filter=folder_read, exact=True).count == 1


class TestTheCardsLifecycle:
    def test_a_rewrite_replaces_the_point(self, placed):
        folders.upsert_folder_card(
            placed, PROJECT, {**CARD, "folder_path": "gutachten/brandschutz/", "abstract": "Neu."}, vector("x")
        )

        [card] = folders.folder_cards(placed, [PROJECT])
        assert card["abstract"] == "Neu."

    def test_a_status_change_keeps_the_vector(self, placed):
        folders.set_folder_card_status(placed, PROJECT, "Gutachten/Brandschutz", "stale")

        [hit] = folders.search_folders(placed, [PROJECT], vector(CARD_TEXT))
        assert hit.status == "stale" and hit.score == pytest.approx(1.0, abs=1e-2)

    def test_a_deleted_card_leaves_the_chunks(self, placed):
        folders.delete_folder_card(placed, PROJECT, "Gutachten/Brandschutz")

        assert folders.folder_cards(placed, [PROJECT]) == []
        assert placed.count(PROJECT) == 2
        folders.delete_folder_card(placed, PROJECT, "Gutachten/Brandschutz")

    def test_deleting_a_file_leaves_the_card_and_deleting_the_scope_takes_it(self, placed):
        placed.delete_file(PROJECT, "BS.pdf")
        assert len(folders.folder_cards(placed, [PROJECT])) == 1

        placed.delete_scope(PROJECT)
        assert folders.folder_cards(placed, [PROJECT]) == []
        assert len(folders.folder_cards(placed, [RESTRICTED])) == 1

    def test_the_corpus_takes_no_card(self, placed):
        with pytest.raises(ValueError, match="office scope"):
            folders.upsert_folder_card(placed, "oib_knowledge", CARD, vector(CARD_TEXT))

    def test_a_file_payload_write_never_touches_a_card(self, placed):
        placed.set_file_payloads(PROJECT, {"BS.pdf": {"tags": ["brandschutz"]}})
        placed.set_scope_payload(PROJECT, {"project_status": "active"})

        [card] = folders.folder_cards(placed, [PROJECT])
        assert "tags" not in card and "project_status" not in card
        assert (
            placed.count(PROJECT, None, models.FieldCondition(key="tags", match=models.MatchValue(value="brandschutz")))
            == 1
        )


class _Embedder:
    """The production embedder's two methods the callers use, with the test vectors."""

    def embed_query(self, text: str) -> list[float]:
        return vector(text)

    def embedding_identity(self) -> dict[str, str]:
        from knowledge_layer_testing.qdrant import IDENTITY

        return dict(IDENTITY)


class TestThroughTheCallers:
    def test_the_builder_writes_the_point_the_search_channel_finds(self, qdrant_store, monkeypatch):
        from knowledge_layer import folder_channel

        from agent.knowledge import factory
        from agent.knowledge.folder_cards import worker

        write(PROJECT, [record("Statik Bewehrung Decke", "Statik.pdf", folder_path="Gutachten")])
        monkeypatch.setattr(factory, "get_active_retriever", _Embedder)
        card = {**CARD, "organization_id": "org_1", "collection": PROJECT}

        worker._publish_point(PROJECT, card)
        text = folders.embedding_text(card["folder_path"], card["abstract"], card["key_facts"])
        lines = folder_channel._routes(_Embedder(), [PROJECT], text, None, "Fluchtweg")

        assert lines.splitlines()[1] == f"Folder: Gutachten/Brandschutz — {CARD['abstract']}"
        assert qdrant_store.count(PROJECT) == 1

        worker._restamp_point(PROJECT, "Gutachten/Brandschutz", "failed")
        assert folders.folder_cards(qdrant_store, [PROJECT])[0]["status"] == "failed"
        worker._drop_point(PROJECT, "Gutachten/Brandschutz")
        assert folders.folder_cards(qdrant_store, [PROJECT]) == []
