"""What the ingest read of a document, copied onto every chunk as filterable payload."""

from __future__ import annotations

from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import LIST_FIELDS
from knowledge_layer.qdrant.payload import document_facts
from knowledge_layer.qdrant.payload import fact_value
from knowledge_layer.qdrant.payload import reading_facts

from aiq_agent.knowledge.schema import AvailableDocument


def _document(**reading) -> AvailableDocument:
    return AvailableDocument(file_name="BSK.pdf", **reading)


def test_the_reading_becomes_indexed_payload_on_the_document_facts():
    document = _document(
        dossier={
            "document_type": "fire_safety_concept",
            "parties": [{"role": "author", "name": "Brandschutz  Huber GmbH"}],
            "facts": [
                {"key": "building_class", "value": "GK 4", "unit": None},
                {"key": "room_height", "value": "2,60", "unit": "m"},
            ],
        },
        doc_references=[{"kind": "norm", "key": "trvb 124 f", "label": "TRVB 124 F", "pages": [2]}],
        coverage={"pages": 12, "not_read": 2},
    )

    facts = document_facts(document)

    assert facts["document_type"] == "fire_safety_concept"
    assert facts["references"] == ["norm:trvb 124 f"]
    assert facts["dossier_facts"] == ["building_class=4", "room_height=2.60 m"]
    assert facts["parties"] == ["brandschutz huber gmbh"]
    assert facts["pages_not_read"] == 2


def test_a_document_without_a_reading_states_every_field_empty_so_a_stale_copy_stops_matching():
    assert reading_facts(_document()) == {
        "document_type": None,
        "references": [],
        "dossier_facts": [],
        "parties": [],
        "pages_not_read": 0,
    }


def test_two_spellings_of_one_building_class_are_one_value():
    assert (
        fact_value("building_class", "Gebäudeklasse IV") == fact_value("building_class", "GK 4") == "building_class=4"
    )


def test_every_field_a_filter_names_has_an_index_and_the_lists_are_lists():
    for field in ("document_type", "references", "dossier_facts", "parties"):
        assert field in schema.KEYWORD_FIELDS
    assert "pages_not_read" in schema.INTEGER_FIELDS
    assert {"references", "dossier_facts", "parties"} <= LIST_FIELDS
