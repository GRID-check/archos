"""The ``canvas_activity`` card: what Piloti did on a document, as the BFF confirmed it.

Its shape is checked here; how the canvas tools fill and extend it is checked in
``packages/agent/tests/tools/canvas``. Built the way ``tools/canvas/cards.py`` builds it.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from aiq_agent.cards.canvas_activity_card import MAX_CANVAS_ACTIVITY_ITEMS
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.canvas.cards import record_canvas_activity

DOCUMENT = {"id": "11111111-0000-4000-8000-000000000001", "name": "Grundriss_EG.pdf"}
OTHER = {"id": "22222222-0000-4000-8000-000000000002", "name": "Grundriss_OG.pdf"}
PROPOSED = {
    "action": "proposed",
    "annotation_id": "44444444-0000-4000-8000-000000000004",
    "number": 5,
    "page": 1,
    "shape": "region",
    "x": 0.12,
    "y": 0.3,
    "w": 0.2,
    "h": 0.1,
    "kind": "defect",
    "body": "Treppenlaufbreite 1,10 m statt 1,20 m.",
}
POINT = {**PROPOSED, "shape": "point", "w": None, "h": None, "number": 6}
REPLIED = {
    "action": "replied",
    "annotation_id": "33333333-0000-4000-8000-000000000003",
    "number": 4,
    "excerpt": "Ist im Index C korrigiert.",
}

CREATED = {**PROPOSED, "action": "created", "number": 7}
CHANGED = {
    "action": "changed",
    "annotation_id": "33333333-0000-4000-8000-000000000003",
    "number": 4,
    "status": "resolved",
    "changes": [
        {"field": "status", "before": "open", "after": "resolved"},
        {"field": "assignee", "after": "user_anna", "after_label": "Anna Berger"},
    ],
    "note": "Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.",
}
DELETED = {"action": "deleted", "number": 9, "body": "Doppelt gesetzt."}


def _card(*items: dict) -> dict:
    return {"type": "canvas_activity", "document": DOCUMENT, "items": list(items)}


@pytest.fixture
def registry():
    cards = CardRegistry()
    token = set_card_registry(cards)
    yield cards
    reset_card_registry(token)


class TestTheShape:
    def test_a_proposal_a_point_and_a_reply_validate(self) -> None:
        card = grid_card_adapter.validate_python(_card(PROPOSED, POINT, REPLIED)).model_dump(exclude_none=True)

        assert [item["action"] for item in card["items"]] == ["proposed", "proposed", "replied"]
        assert "w" not in card["items"][1]

    def test_what_the_person_asked_for_validates_and_an_empty_field_stays_absent(self) -> None:
        card = grid_card_adapter.validate_python(_card(CREATED, CHANGED, DELETED)).model_dump(exclude_none=True)

        assert [item["action"] for item in card["items"]] == ["created", "changed", "deleted"]
        # An assignee nobody had before is absent, not null: the card is dumped without Nones.
        assigned = {"field": "assignee", "after": "user_anna", "after_label": "Anna Berger"}
        assert card["items"][1]["changes"][1] == assigned

    def test_it_is_a_system_card_the_model_cannot_author_and_an_interactive_one(self) -> None:
        assert "canvas_activity" in SYSTEM_CARD_TYPES
        assert "canvas_activity" in INTERACTIVE_CARD_TYPES

    @pytest.mark.parametrize(
        ("change", "where"),
        [
            ({"document": {**DOCUMENT, "id": "not-a-uuid"}}, "document"),
            ({"document": {**DOCUMENT, "name": ""}}, "document"),
            ({"items": []}, "items"),
            ({"items": [{**PROPOSED, "x": 1.5}]}, "x"),
            ({"items": [{**PROPOSED, "page": 0}]}, "page"),
            ({"items": [{**PROPOSED, "kind": "remark"}]}, "kind"),
            ({"items": [{**PROPOSED, "action": "erased"}]}, "action"),
            ({"items": [{**CHANGED, "changes": []}]}, "changes"),
            ({"items": [{**CHANGED, "changes": [{"field": "position"}]}]}, "field"),
            ({"items": [{**CHANGED, "status": "archived"}]}, "status"),
            ({"items": [{**CHANGED, "note": ""}]}, "note"),
            ({"items": [{**DELETED, "body": ""}]}, "body"),
            ({"items": [{**REPLIED, "excerpt": ""}]}, "excerpt"),
            ({"items": [PROPOSED] * (MAX_CANVAS_ACTIVITY_ITEMS + 1)}, "items"),
        ],
    )
    def test_what_the_card_refuses(self, change, where) -> None:
        with pytest.raises(ValidationError, match=where):
            grid_card_adapter.validate_python({**_card(PROPOSED), **change})


class TestOneCardPerDocumentPerTurn:
    def test_a_second_write_on_the_same_document_extends_its_card(self, registry) -> None:
        record_canvas_activity(DOCUMENT, [PROPOSED])
        record_canvas_activity(DOCUMENT, [REPLIED])

        [card] = registry.snapshot()
        assert [item["action"] for item in card["items"]] == ["proposed", "replied"]

    def test_another_document_gets_its_own_card(self, registry) -> None:
        record_canvas_activity(DOCUMENT, [PROPOSED])
        record_canvas_activity(OTHER, [REPLIED])

        assert [card["document"]["name"] for card in registry.snapshot()] == ["Grundriss_EG.pdf", "Grundriss_OG.pdf"]

    def test_the_extended_card_keeps_its_place_in_the_array(self, registry) -> None:
        record_canvas_activity(DOCUMENT, [PROPOSED])
        registry.add({"type": "task_created", "task_id": "t", "title": "x"})
        record_canvas_activity(DOCUMENT, [REPLIED])

        assert registry.snapshot()[0]["type"] == "canvas_activity"
        assert len(registry.snapshot()[0]["items"]) == 2

    def test_a_full_card_opens_the_next_and_drops_nothing(self, registry) -> None:
        landed = record_canvas_activity(DOCUMENT, [PROPOSED] * (MAX_CANVAS_ACTIVITY_ITEMS + 3))

        assert landed == MAX_CANVAS_ACTIVITY_ITEMS + 3
        assert [len(card["items"]) for card in registry.snapshot()] == [MAX_CANVAS_ACTIVITY_ITEMS, 3]

    def test_an_entry_that_does_not_validate_is_dropped_and_said(self, registry) -> None:
        assert record_canvas_activity(DOCUMENT, [{**PROPOSED, "page": 0}]) == 0
        assert registry.snapshot() == []

    def test_no_card_channel_lands_nothing(self) -> None:
        assert record_canvas_activity(DOCUMENT, [PROPOSED]) == 0
