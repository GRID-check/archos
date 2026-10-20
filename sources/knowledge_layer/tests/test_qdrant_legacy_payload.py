"""Points written before the English payload rename stay readable until the operator rewrite.

``docs/deployment/qdrant-payload-rename-runbook.md`` rewrites the German keys (``punkt_id``,
``project_facts.bundesland``, ``chunking: "punkt"``) in place. Until it has run on a collection, a read
must see both spellings: a hit's metadata under the English names, a filter and a boost matching either.
Delete this file with ``schema.LEGACY_FIELDS``.
"""

from __future__ import annotations

from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.boost import FactWeights
from knowledge_layer.qdrant.boost import boost_terms
from knowledge_layer.qdrant.boost import parse_boost
from knowledge_layer.qdrant.legacy_rewrite import PayloadRewrite
from knowledge_layer.qdrant.legacy_rewrite import rewrite_payload
from knowledge_layer.qdrant.payload import chunk_metadata
from knowledge_layer.qdrant.payload import project_payload
from qdrant_client import models


def _keys(condition: models.Filter) -> list[str]:
    found: list[str] = []
    for part in (condition.must or []) + (condition.should or []) + (condition.must_not or []):
        found.extend(_keys(part) if isinstance(part, models.Filter) else [part.key])
    return found


def test_a_legacy_hit_reads_under_the_english_names():
    metadata = chunk_metadata(
        {
            "text": "x",
            "punkt_id": "3.5.2",
            "punkt_title": "Fluchtwege",
            "punkt_path": "3 › 3.5",
            "punkt_parent_id": "3.5",
            "punkt_depth": 3,
            "chunking": "punkt",
            "file_name": "a.pdf",
        }
    )

    assert metadata == {
        "clause_id": "3.5.2",
        "clause_title": "Fluchtwege",
        "clause_path": "3 › 3.5",
        "clause_parent_id": "3.5",
        "clause_depth": 3,
        "chunking": "clause",
        "file_name": "a.pdf",
    }


def test_the_english_key_wins_when_a_point_carries_both():
    assert chunk_metadata({"punkt_id": "old", "clause_id": "new"}) == {"clause_id": "new"}


def test_a_new_point_is_not_touched():
    payload = {"clause_id": "1", "chunking": "clause", "page_label": "2"}

    assert chunk_metadata(dict(payload)) == payload


def test_every_legacy_field_stays_indexed_beside_its_english_one():
    for new, old in schema.LEGACY_FIELDS.items():
        assert new in schema.INDEXED_FIELDS
        assert old in schema.INDEXED_FIELDS


def test_the_project_payload_writes_only_the_english_keys():
    payload = project_payload({"federal_state": "vienna", "building_class": [4], "uses": ["housing"]}, "active")

    assert set(payload["project_facts"]) == set(schema.FACT_KEYS)
    assert payload["project_facts"]["federal_state"] == "vienna"


def test_a_boost_term_matches_the_german_key_with_the_german_token():
    boost = parse_boost(
        {
            "facts": {"federal_state": "vienna", "building_class": [4]},
            "weights": {"federal_state": 2, "building_class": 1},
        }
    )
    terms = dict(
        zip((weight for weight, _ in boost_terms(boost)), (cond for _, cond in boost_terms(boost)), strict=True)
    )

    assert boost.weights == FactWeights(federal_state=2, building_class=1)
    federal_state = terms[2]
    assert _keys(federal_state) == ["project_facts.federal_state", "project_facts.bundesland"]
    assert federal_state.should[1].match.any == ["wien"]
    assert _keys(terms[1]) == ["project_facts.building_class", "project_facts.gebaeudeklasse"]


# ----------------------------------------------------- the operator rewrite (scripts/qdrant_rename_payload_keys.py)

LEGACY_POINT = {
    "text": "x",
    "punkt_id": "3.5.2",
    "punkt_title": "Fluchtwege",
    "punkt_depth": 3,
    "richtlinie": "2",
    "chunking": "punkt",
    "project_status": "closed",
    "project_facts": {
        "bundesland": "wien",
        "gebaeudeklasse": [4],
        "bauweise": ["holzbau"],
        "nutzungen": ["wohnen"],
        "vorhabensart": ["neubau"],
    },
}


def test_a_legacy_point_is_rewritten_to_what_a_new_ingest_writes():
    rewrite = rewrite_payload(LEGACY_POINT)

    assert rewrite is not None
    assert rewrite.set == {
        "clause_id": "3.5.2",
        "clause_title": "Fluchtwege",
        "clause_depth": 3,
        "guideline": "2",
        "chunking": "clause",
        "project_facts": {
            "federal_state": "vienna",
            "building_class": [4],
            "construction_method": ["timber"],
            "uses": ["residential"],
            "work_type": ["new_build"],
        },
    }
    assert set(rewrite.delete) == {"punkt_id", "punkt_title", "punkt_depth", "richtlinie"}


def test_applying_the_rewrite_leaves_nothing_to_rewrite():
    rewrite = rewrite_payload(LEGACY_POINT)
    after = {key: value for key, value in LEGACY_POINT.items() if key not in rewrite.delete} | rewrite.set

    assert rewrite_payload(after) is None
    assert chunk_metadata(after)["clause_id"] == "3.5.2"


def test_a_point_written_after_the_rename_is_left_alone():
    point = {"clause_id": "1", "chunking": "clause", "project_facts": project_payload({"uses": ["housing"]}, "active")}

    assert rewrite_payload(point) is None


def test_the_english_key_wins_and_the_german_one_is_still_deleted():
    rewrite = rewrite_payload({"punkt_id": "old", "clause_id": "new"})

    assert rewrite == PayloadRewrite(set={}, delete=("punkt_id",))


def test_a_facts_object_without_a_federal_state_stays_without_one():
    rewrite = rewrite_payload({"project_facts": {"gebaeudeklasse": [3], "nutzungen": []}})

    assert rewrite.set == {"project_facts": {"building_class": [3], "uses": []}}
