"""Range operators in the filter grammar, and the tenancy boundary a ranged read keeps.

No server needed: the filters are compiled and inspected, and ``reads.fetch_from`` runs against a
stand-in store that applies the scope condition the way Qdrant does.
"""

from __future__ import annotations

from typing import Any

import pytest
from knowledge_layer.qdrant import reads
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import scope as scope_module
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.qdrant.scope import translate
from qdrant_client import models


def _conditions(flt: models.Filter) -> list[models.FieldCondition]:
    found: list[models.FieldCondition] = []
    for part in (flt.must or []) + (flt.should or []) + (flt.must_not or []):
        found.extend(_conditions(part) if isinstance(part, models.Filter) else [part])
    return found


class TestRangeOperators:
    @pytest.mark.parametrize(("op", "bound"), [("$gt", "gt"), ("$gte", "gte"), ("$lt", "lt"), ("$lte", "lte")])
    def test_an_integer_field_compiles_to_a_range(self, op, bound):
        (condition,) = _conditions(translate({"reading_order": {op: 4}}))

        assert condition.key == "reading_order"
        assert condition.range == models.Range(**{bound: 4})

    def test_a_numeric_string_is_coerced_like_an_equality_value(self):
        (condition,) = _conditions(translate({"reading_order": {"$gte": "4"}}))

        assert condition.range == models.Range(gte=4)

    def test_a_closed_interval_is_two_conditions(self):
        flt = translate({"$and": [{"reading_order": {"$gte": 4}}, {"reading_order": {"$lte": 6}}]})

        assert [condition.range for condition in _conditions(flt)] == [models.Range(gte=4), models.Range(lte=6)]

    def test_a_range_on_a_keyword_field_raises(self):
        with pytest.raises(ValueError, match="needs an integer or datetime field"):
            translate({"file_name": {"$gte": "a"}})

    def test_a_range_on_a_boolean_field_raises(self):
        with pytest.raises(ValueError, match="needs an integer or datetime field"):
            translate({"superseded": {"$lt": 1}})

    def test_a_range_needs_a_number(self):
        with pytest.raises(ValueError, match="needs a number"):
            translate({"reading_order": {"$gte": "vier"}})

    def test_a_datetime_field_compiles_to_a_datetime_range(self, monkeypatch):
        monkeypatch.setattr(schema, "DATETIME_FIELDS", ("indexed_on",))
        monkeypatch.setattr(scope_module, "DATETIME_FIELDS", ("indexed_on",))
        monkeypatch.setattr(scope_module, "INDEXED_FIELDS", scope_module.INDEXED_FIELDS | {"indexed_on"})

        (condition,) = _conditions(translate({"indexed_on": {"$gte": "2026-01-01T00:00:00Z"}}))

        assert condition.range == models.DatetimeRange(gte="2026-01-01T00:00:00Z")

    def test_two_operators_in_one_condition_stay_refused(self):
        with pytest.raises(ValueError, match="Unsupported metadata filter condition"):
            translate({"reading_order": {"$gte": 1, "$lte": 3}})


class TestTenancy:
    def test_a_ranged_filter_still_carries_the_scope(self):
        flt = scope_filter(["proj_a"], {"reading_order": {"$gte": 4}})

        scope_condition = flt.must[0]
        assert scope_condition.key == schema.SCOPE_FIELD
        assert scope_condition.match == models.MatchAny(any=["proj_a"])
        assert flt.must[1].must[0].range == models.Range(gte=4)

    def test_a_range_cannot_stand_in_for_the_scope(self):
        with pytest.raises(ValueError, match="at least one non-empty scope"):
            scope_filter([], {"reading_order": {"$gte": 0}})
        with pytest.raises(ValueError, match="needs an integer or datetime field"):
            translate({"scope": {"$gte": 0}})


class _Record:
    def __init__(self, scope: str, payload: dict[str, Any]):
        self.id = payload["chunk_id"]
        self.payload = {**payload, "scope": scope}


class _Store:
    """Stands in for the Qdrant store: ``scroll`` applies the scope and the one bound ``fetch_from`` adds."""

    def __init__(self, records: list[_Record]):
        self.records = records
        self.calls: list[tuple[str, Any]] = []

    def exists(self, scope: str) -> bool:
        return True

    def has_index(self, scope: str, field: str) -> bool:
        return True

    def count(self, scope: str, filters: Any, *extra: Any) -> int:
        return sum(
            1 for record in self.records if record.payload["scope"] == scope and "reading_order" not in record.payload
        )

    def scroll(self, scope: str, filters: Any = None, *extra: Any, limit: int | None = None, **_):
        self.calls.append((scope, filters))
        lower = 0
        for node in (filters or {}).get("$and", []):
            lower = max(lower, node.get("reading_order", {}).get("$gte", 0)) if isinstance(node, dict) else lower
        for record in self.records:
            if record.payload["scope"] == scope and record.payload["reading_order"] >= lower:
                yield record


def _payload(chunk_id: str, page: int, ordinal: int | None, text: str = "t") -> dict[str, Any]:
    payload: dict[str, Any] = {
        "chunk_id": chunk_id,
        "text": text,
        "page_label": str(page),
        "reading_order": page,
        "file_name": "a.pdf",
    }
    if ordinal is not None:
        payload["chunk_ordinal"] = ordinal
    return payload


def _at(page: int, ordinal: int, chunk_id: str) -> tuple:
    """The ``document_position`` of a numbered chunk with no section structure."""
    return (page, 0, 0, 0, 0, ordinal, chunk_id)


def test_fetch_from_continues_after_the_start_in_document_order(monkeypatch):
    records = [
        _Record("proj_a", _payload("p3b", 3, 5)),
        _Record("proj_a", _payload("p1", 1, 0)),
        _Record("proj_a", _payload("p3a", 3, 4)),
        _Record("proj_a", _payload("p2", 2, 2)),
        _Record("proj_a", _payload("p3n", 3, None)),
    ]
    store = _Store(records)
    monkeypatch.setattr(reads, "get_store", lambda: store)

    hits = reads.fetch_from("proj_a", {"file_name": "a.pdf"}, _at(3, 4, "p3a"), 10)

    assert [hit.chunk_id for hit in hits] == ["p3b", "p3n"]
    assert [hit.chunk_id for hit in reads.fetch_from("proj_a", None, _at(1, 0, "p1"), 2)] == ["p2", "p3a"]
    assert reads.fetch_from("proj_a", None, _at(9, 0, "z"), 5) == []


def test_fetch_from_reads_only_the_scope_it_is_asked_for(monkeypatch):
    """The start position narrows within a scope; it cannot reach the same file name in another one."""
    records = [
        _Record("proj_a", _payload("mine", 4, 0, "mine")),
        _Record("proj_b", _payload("theirs", 4, 1, "theirs")),
    ]
    store = _Store(records)
    monkeypatch.setattr(reads, "get_store", lambda: store)

    hits = reads.fetch_from("proj_a", {"file_name": "a.pdf"}, _at(1, 0, ""), 10)

    assert [hit.text for hit in hits] == ["mine"]
    assert {scope for scope, _filters in store.calls} == {"proj_a"}


def _place(payload: dict[str, Any], **structure: int) -> dict[str, Any]:
    return {**payload, **structure}


def test_fetch_from_compares_the_key_it_sorts_by_so_a_table_part_out_of_ordinal_order_is_kept(monkeypatch):
    """Page 5 sorts [text 4, text 5, table part 3]: a cursor after text 4 must still reach table part 3."""
    records = [
        _Record("proj_a", _payload("t4", 5, 4)),
        _Record("proj_a", _payload("t5", 5, 5)),
        _Record("proj_a", _place(_payload("table", 5, 3), table_part=2)),
    ]
    monkeypatch.setattr(reads, "get_store", lambda: _Store(records))
    ordered = reads.in_document_order([reads._hit(record) for record in records])
    assert [hit.chunk_id for hit in ordered] == ["t4", "t5", "table"]

    hits = reads.fetch_from("proj_a", None, reads._document_key(ordered[0]), 10)

    assert [hit.chunk_id for hit in hits] == ["t5", "table"]


def test_fetch_from_does_not_end_a_read_at_an_unnumbered_chunk_of_an_earlier_section(monkeypatch):
    """Unnumbered (section 1), numbered 7 (section 2), unnumbered (section 3): a cut after the first loses neither."""
    records = [
        _Record("proj_a", _place(_payload("u1", 5, None), section_order=1)),
        _Record("proj_a", _place(_payload("n7", 5, 7), section_order=2)),
        _Record("proj_a", _place(_payload("u3", 5, None), section_order=3)),
    ]
    monkeypatch.setattr(reads, "get_store", lambda: _Store(records))
    first = reads._hit(records[0])

    hits = reads.fetch_from("proj_a", None, reads._document_key(first), 10)

    assert [hit.chunk_id for hit in hits] == ["n7", "u3"]
