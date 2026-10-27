"""Collection metadata keys moved from ``aiq:`` to ``grid:`` (ADR-0145 row 10d), for one release both.

A collection made before the rename holds its embedder's identity, its BM25
length and the import marker only under ``aiq:``. Reading it as foreign would
refuse every write and query, so the old key is read where the new one is
missing; every write carries both, so a process of the previous release still
finds its own; and the copy to ``grid:`` runs on its own, the first time a
process makes sure of the collection.
"""

from __future__ import annotations

from types import SimpleNamespace

from knowledge_layer.qdrant import schema

IDENTITY = {"grid:embed_fingerprint": "fp", "grid:embed_model": "model"}
LEGACY = {"aiq:embed_fingerprint": "fp", "aiq:embed_model": "model", "aiq:bm25_length": {"k": 1.5}}


class FakeClient:
    """The two calls the adoption makes, with Qdrant's merge of the metadata."""

    def __init__(self, metadata):
        self.metadata = dict(metadata)
        self.updates = []

    def get_collection(self, name):
        return SimpleNamespace(config=SimpleNamespace(metadata=dict(self.metadata)))

    def update_collection(self, name, metadata):
        self.updates.append(metadata)
        self.metadata.update(metadata)


def test_a_collection_made_before_the_rename_is_not_foreign():
    assert schema.identity_mismatch(LEGACY, IDENTITY) is None
    assert schema.bm25_length_of(LEGACY) == {"k": 1.5}


def test_a_new_collection_records_both_prefixes_and_no_copied_length():
    metadata = schema._metadata(LEGACY, None)

    assert metadata == {**IDENTITY, "aiq:embed_fingerprint": "fp", "aiq:embed_model": "model"}


def test_the_copy_to_grid_runs_once_and_keeps_the_legacy_keys():
    client = FakeClient(LEGACY)

    assert schema.adopt_legacy_metadata(client, "office") == {**IDENTITY, "grid:bm25_length": {"k": 1.5}}
    assert schema.adopt_legacy_metadata(client, "office") == {}
    assert len(client.updates) == 1
    assert client.metadata["aiq:embed_fingerprint"] == "fp"


def test_a_new_key_wins_over_its_legacy_one():
    assert schema.current_metadata({"aiq:embed_model": "old", "grid:embed_model": "new"})["grid:embed_model"] == "new"
