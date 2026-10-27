"""The formula card's contract (ADR-0143), and the fixture both sides compute from.

The arithmetic and the bounds live in the browser (`frontends/ui/src/features/
grid-cards/lib/formulas.ts`) and are tested there against `formula-cases.json`.
This side holds what the model may put on the wire: every case's card is a
valid card, the model names a case but never a number (no limit, no result, no
figure in the title, a label or the note), and a stated result is counted.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.cards.catalog import CARD_EXAMPLES
from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
from aiq_agent.cards.models import formula_inputs
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import stated_result_fields
from aiq_agent.observability.langfuse_scores import card_validity_score
from aiq_agent.observability.langfuse_scores import formula_provenance_score

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "frontends/ui/src/features/grid-cards/lib/formula-cases.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text("utf-8"))


def _stair(**changes) -> dict:
    card = {
        "type": "formula",
        "title": "Stiege Haus A",
        "formula": {"name": "stair_step_rule", "stair_type": "main", "riser": {"value": 17}, "going": {"value": 29}},
    }
    card.update(changes)
    return card


class TestTheSharedFixture:
    @pytest.mark.parametrize("case", [c for c in FIXTURE["cases"] if "card" in c], ids=lambda c: c["id"])
    def test_every_case_is_a_card_the_model_could_emit(self, case):
        grid_card_adapter.validate_python(case["card"])

    def test_every_derived_case_names_a_base_and_changes_an_input_it_has(self):
        cards = {case["id"]: case["card"] for case in FIXTURE["cases"] if "card" in case}
        for case in FIXTURE["cases"]:
            if "card" in case:
                continue
            assert case["overrides"], case["id"]
            assert formula_inputs(cards[case["base"]]), case["id"]

    def test_the_cases_cover_every_rule_and_every_case_of_it(self):
        formulas = [case["card"]["formula"] for case in FIXTURE["cases"] if "card" in case]
        assert {f["name"] for f in formulas} == {"u_value", "stair_step_rule", "escape_route_length", "daylight_ratio"}
        assert {f["stair_type"] for f in formulas if f["name"] == "stair_step_rule"} == {
            "main",
            "dwelling",
            "secondary",
        }
        assert {f["component"] for f in formulas if f["name"] == "u_value"} == {
            "external_wall",
            "roof_or_ceiling_to_outside_air",
            "floor_over_outside_air",
        }
        assert {f["start"] for f in formulas if f["name"] == "escape_route_length"} == {"room", "dwelling_entrance"}


class TestTheModelNamesACaseNeverANumber:
    def test_a_stated_result_and_a_limit_do_not_survive_validation(self):
        card = _stair(result=63, limits=[{"target": "riser", "comparator": "<=", "value": 18}])
        card["formula"]["riser"]["result"] = 34
        dumped = grid_card_adapter.validate_python(card).model_dump()
        assert "result" not in dumped and "limits" not in dumped
        assert "result" not in dumped["formula"]["riser"]

    def test_a_unit_on_the_wire_is_not_the_card_s(self):
        card = _stair()
        card["formula"]["riser"]["unit"] = "m"
        assert "unit" not in grid_card_adapter.validate_python(card).model_dump()["formula"]["riser"]

    @pytest.mark.parametrize(
        "title", ["U-Wert Außenwand – 20 cm Dämmung", "Fluchtweg 36,5 m", "Belichtung 12 %", "U = 0,17"]
    )
    def test_a_title_with_a_figure_is_refused(self, title):
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize("title", ["U-Wert Außenwand AW 01", "Fluchtweg Büro 2.14", "Stiege 2. OG", "Haus A"])
    def test_an_identifier_in_a_title_is_not_a_figure(self, title):
        grid_card_adapter.validate_python(_stair(title=title))

    def test_a_layer_label_or_a_leg_label_with_a_figure_is_refused(self):
        wall = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        wall["formula"]["layers"][1]["label"] = "EPS-F 20 cm"
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(wall)
        route = {
            "type": "formula",
            "title": "Fluchtweg Top 1",
            "formula": {
                "name": "escape_route_length",
                "start": "room",
                "segments": [{"label": "Gang 18 m", "length": {"value": 18}}],
            },
        }
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(route)

    def test_a_note_that_states_a_result_is_refused(self):
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(_stair(note="Das Schrittmaß = 63 und damit erfüllt."))
        grid_card_adapter.validate_python(_stair(note="Gilt für jede Stufe des Laufs."))

    def test_the_stair_type_is_required_and_closed(self):
        card = _stair()
        del card["formula"]["stair_type"]
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)
        card["formula"]["stair_type"] = "spiral"
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)

    def test_a_u_value_names_its_component_and_no_heat_flow(self):
        card = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        card["formula"]["heat_flow"] = "downward"
        dumped = grid_card_adapter.validate_python(card).model_dump()
        assert "heat_flow" not in dumped["formula"]
        del card["formula"]["component"]
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)

    def test_a_source_value_inside_its_own_range(self):
        card = _stair()
        card["formula"]["riser"] = {"value": 30, "min": 10, "max": 25}
        with pytest.raises(ValidationError, match="above `max`"):
            grid_card_adapter.validate_python(card)

    def test_an_unknown_input_is_allowed_and_stays_unknown(self):
        card = _stair()
        card["formula"]["going"] = {"value": None}
        assert grid_card_adapter.validate_python(card).model_dump()["formula"]["going"]["value"] is None

    def test_an_unknown_rule_is_refused(self):
        card = _stair()
        card["formula"]["name"] = "clear_room_height"
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)

    def test_the_worked_example_is_a_valid_card_with_no_number_of_its_own(self):
        card = grid_card_adapter.validate_python(CARD_EXAMPLES["formula"]).model_dump()
        text = json.dumps(card)
        assert "result" not in text and "limits" not in text
        assert card["title"] == "U-Wert Außenwand AW 01"

    def test_the_envelope_teaches_the_formula_shape_up_front(self):
        assert "formula" in ENVELOPE_SHAPE_TYPES


class TestAStatedResultIsCounted:
    def test_counts_every_field_that_states_what_the_card_computes(self):
        card = _stair(result=63, limits=[{"value": 18}])
        card["formula"]["riser"]["result"] = 34
        assert stated_result_fields(card) == 3
        calculation = {"type": "calculation", "steps": [{"label": "x", "result": 4}]}
        assert stated_result_fields(calculation) == 1
        assert stated_result_fields(_stair()) == 0
        assert stated_result_fields({"type": "stair_diagram", "result": 1}) == 0

    def test_the_score_says_how_many_were_stripped(self):
        score = card_validity_score(outcome="stripped", card_type="formula", index=2, fields=3)
        assert score.value == "stripped"
        assert score.metadata == {"card_type": "formula", "fields": 3}

    async def test_the_envelope_records_a_stripped_result(self, monkeypatch):
        written: list = []
        monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, writer: written.extend(scores))
        validated = await answer_pipeline._checked_envelope_card(_stair(result=63), 0, "", None)
        assert validated is not None and "result" not in validated
        assert [(score.name, score.value, score.metadata.get("fields")) for score in written] == [
            ("card-validity", "stripped", 1)
        ]

    async def test_a_clean_card_records_nothing(self, monkeypatch):
        written: list = []
        monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, writer: written.extend(scores))
        assert await answer_pipeline._checked_envelope_card(_stair(), 0, "", None) is not None
        assert written == []


class TestProvenanceScore:
    def test_counts_the_given_inputs_that_say_where_they_are_written(self):
        card = {
            "type": "formula",
            "formula": {
                "name": "stair_step_rule",
                "riser": {"value": 17, "source": "Schnitt A-A"},
                "going": {"value": 29},
            },
        }
        score = formula_provenance_score(card, index=2)
        assert score is not None
        assert score.name == "formula-input-provenance"
        assert score.value == 0.5
        assert score.item == "2"
        assert score.metadata == {"formula": "stair_step_rule", "inputs": 2, "given": 2, "sourced": 1, "unknown": 0}

    def test_reads_all_four_daylight_inputs(self):
        card = next(c["card"] for c in FIXTURE["cases"] if c["id"] == "daylight-above-12-percent")
        score = formula_provenance_score(card, index=1)
        assert score is not None
        assert score.metadata["inputs"] == 4
        assert score.value == 1.0

    def test_a_norm_reference_counts_as_a_source_and_an_unknown_input_is_not_held_against_it(self):
        card = {
            "type": "formula",
            "formula": {
                "name": "u_value",
                "component": "external_wall",
                "layers": [
                    {
                        "label": "EPS",
                        "thickness": {"value": None},
                        "conductivity": {"value": 0.035, "reference": {"document": "ÖNORM B 8110-7"}},
                    }
                ],
            },
        }
        score = formula_provenance_score(card, index=1)
        assert score is not None
        assert score.value == 1.0
        assert score.metadata["unknown"] == 1

    def test_no_score_for_another_card(self):
        assert formula_provenance_score({"type": "calculation"}, index=1) is None


class TestTheFigureGuardHoldsWhereItLeaked:
    """The five texts the review found passing, and the ones that must keep passing."""

    @pytest.mark.parametrize(
        "title", ["U-Wert 0.17 W/m²K", "U ≤ 0,35", "U-Wert 0,17 erfüllt", "Schrittmaß 63", "Stiege mit 18 Stufen"]
    )
    def test_a_title_with_any_number_but_an_identifier_is_refused(self, title):
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize(
        "title", ["Stiege Top 7", "Fluchtweg Büro 2.14", "Stiege 2. OG", "U-Wert Außenwand AW 01", "Gst.-Nr. 123/4"]
    )
    def test_an_identifier_still_passes(self, title):
        grid_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize(
        "note", ["nicht erfüllt", "Die Stufenhöhe ist zulässig.", "Auftritt ≥ 27 erreicht.", "max. 18 laut Plan"]
    )
    def test_a_note_with_a_verdict_or_a_comparison_is_refused(self, note):
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(_stair(note=note))

    def test_a_note_may_cite_a_clause(self):
        grid_card_adapter.validate_python(_stair(note="Gilt sinngemäß auch für Außentreppen, Pkt. 3.2.7."))

    @pytest.mark.parametrize("source", ["Schnitt A-A, 17 cm", "Plan: erfüllt", "laut Statik ≥ 20"])
    def test_a_source_says_where_never_what(self, source):
        card = _stair()
        card["formula"]["riser"]["source"] = source
        with pytest.raises(ValidationError, match="carries"):
            grid_card_adapter.validate_python(card)

    @pytest.mark.parametrize("source", ["Einreichplan, Schnitt A-A", "Grundriss 2. OG", "Plan 04-123, Index B"])
    def test_a_source_may_name_a_plan_and_its_number(self, source):
        card = _stair()
        card["formula"]["riser"]["source"] = source
        grid_card_adapter.validate_python(card)


class TestTheMeasureOfAUValue:
    def test_new_build_renovation_or_unknown(self):
        card = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        for measure in ("new_build", "renovation"):
            card["formula"]["measure"] = measure
            assert grid_card_adapter.validate_python(card).model_dump()["formula"]["measure"] == measure
        del card["formula"]["measure"]
        assert grid_card_adapter.validate_python(card).model_dump()["formula"]["measure"] is None
        card["formula"]["measure"] = "major_renovation"
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)

    def test_the_fixture_has_a_case_for_each(self):
        measures = {
            case["card"]["formula"].get("measure")
            for case in FIXTURE["cases"]
            if "card" in case and case["card"]["formula"]["name"] == "u_value"
        }
        assert measures == {"new_build", "renovation", None}


class TestAStatedResultInsideASurface:
    def test_counts_a_formula_leaf_s_stated_fields(self):
        surface = {
            "type": "surface",
            "components": [
                {"id": "root", "component": "Tabs", "tabs": [{"title": "A", "child": "a"}]},
                {"id": "a", "component": "formula", "title": "Stiege", "result": 63, "limits": [{"value": 18}]},
                {"id": "b", "component": "stair_diagram", "result": 1},
            ],
        }
        assert stated_result_fields(surface) == 2
