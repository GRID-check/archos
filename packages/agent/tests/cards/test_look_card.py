"""The ``look`` card (ADR-0128): an address of where Piloti looked, never pixels.

Its shape is checked here; how ``look``, ``highlight`` and ``point`` fill it and
which looks the answer keeps is checked in ``packages/agent/tests/tools/look/test_visibility.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent.cards.catalog import INTERACTIVE_CARD_TYPES
from agent.cards.catalog import SYSTEM_CARD_TYPES
from agent.cards.look_card import MAX_LOOK_ITEMS
from agent.cards.models import answer_card_adapter
from agent.cards.models import validate_cards
from agent.cards.surface_card import SURFACE_EXCLUDED_LEAVES

DOCUMENT = {"id": "11111111-0000-4000-8000-000000000001", "name": "Grundriss_EG.pdf"}
REGION = {"page": 2, "scope": "region", "region": [0.6, 0.0, 0.4, 0.3], "where": "oben rechts"}
SCHEMAS = Path(__file__).resolve().parents[4] / "contracts" / "cards" / "schemas.json"


def _card(*items: dict, document: dict | None = None) -> dict:
    return {"type": "look", "document": document or DOCUMENT, "items": list(items)}


def _valid(card: dict) -> dict:
    return answer_card_adapter.validate_python(card).model_dump(exclude_none=True)


class TestShape:
    def test_a_region_look_validates_with_its_defaults(self) -> None:
        card = _valid(_card(REGION))

        assert card["document"]["shelf"] == "stored"
        assert card["items"][0] | {} == {**REGION, "origin": "look", "frame": "page"}

    def test_a_base_corpus_document_needs_no_id(self) -> None:
        card = _valid(_card({"page": 1, "scope": "overview"}, document={"name": "OIB-RL2.pdf", "shelf": "base"}))

        assert "id" not in card["document"]

    def test_a_reference_carries_its_label_and_a_point_its_point(self) -> None:
        card = _valid(
            _card(
                {**REGION, "origin": "reference", "label": "Hier: Fluchtweg 1,10 m"},
                {"origin": "reference", "page": 1, "scope": "point", "point": [0.3, 0.6]},
            )
        )

        assert [item["scope"] for item in card["items"]] == ["region", "point"]

    @pytest.mark.parametrize(
        "item",
        [
            {"page": 1, "scope": "region"},  # a region item without its region
            {"page": 1, "scope": "point"},  # a point item without its point
            {"page": 1, "scope": "overview", "frame": "image"},  # an image frame without its image
            {**REGION, "region": [0.8, 0.0, 0.4, 0.3]},  # past the right edge
            {**REGION, "region": [0.1, 0.1, 0.0, 0.3]},  # no area
            {**REGION, "region": [-0.1, 0.1, 0.2, 0.3]},  # not a share
            {**REGION, "page": 0},
            {**REGION, "revision_id": "rev 1"},
        ],
    )
    def test_a_place_that_is_not_one_is_refused(self, item: dict) -> None:
        with pytest.raises(ValidationError):
            _valid(_card(item))

    def test_a_card_holds_at_most_its_cap(self) -> None:
        _valid(_card(*[REGION] * MAX_LOOK_ITEMS))
        with pytest.raises(ValidationError):
            _valid(_card(*[REGION] * (MAX_LOOK_ITEMS + 1)))


class TestNoPixels:
    @pytest.mark.parametrize("field", ["question", "reading", "label", "where"])
    def test_a_data_url_in_any_text_is_refused(self, field: str) -> None:
        with pytest.raises(ValidationError, match="data:"):
            _valid(_card({**REGION, field: "data:image/jpeg;base64,/9j/4AAQ"}))

    def test_a_data_url_as_the_document_name_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            _valid(_card(REGION, document={"name": " DATA:image/png;base64,iVBOR"}))

    def test_the_generated_schema_refuses_it_too(self) -> None:
        schema = json.loads(SCHEMAS.read_text(encoding="utf-8"))
        item = next(definition for name, definition in schema["$defs"].items() if name == "LookItem")
        pattern = item["properties"]["reading"]["anyOf"][0]["pattern"]

        assert pattern.startswith("^(?!")

    def test_a_card_has_no_field_that_could_hold_bytes(self) -> None:
        fields = set(answer_card_adapter.json_schema()["$defs"]["LookItem"]["properties"])

        assert not fields & {"image", "jpeg", "url", "data", "bytes", "thumbnail"}


class TestSystemCard:
    def test_only_the_tools_emit_it(self) -> None:
        assert "look" in SYSTEM_CARD_TYPES
        assert "look" not in INTERACTIVE_CARD_TYPES
        assert "look" in SURFACE_EXCLUDED_LEAVES

    def test_a_model_written_look_card_is_dropped(self) -> None:
        assert validate_cards([_card(REGION)]) == []
