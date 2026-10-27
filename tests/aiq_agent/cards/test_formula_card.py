"""The formula card's contract (ADR-0143), and the fixture both sides compute from.

The arithmetic lives in the browser (`frontends/ui/src/features/grid-cards/lib/
formulas.ts`) and is tested there against `shared/cards/formula-cases.json`.
This side holds what the model may put on the wire: every case's card is a
valid card, the checkable quantities are one list on both sides, a limit cannot
arrive without its Punkt, and a stated result never survives validation.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from aiq_agent.cards.catalog import CARD_EXAMPLES
from aiq_agent.cards.models import FORMULA_TARGETS
from aiq_agent.cards.models import formula_inputs
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.observability.langfuse_scores import formula_provenance_score

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "shared/cards/formula-cases.json").read_text("utf-8"))
OIB4 = {"document": "OIB-Richtlinie 4", "section": "Pkt. 3.2.1", "edition": "Ausgabe Mai 2023"}


def _stair(**limit) -> dict:
    return {
        "type": "formula",
        "title": "Schrittmaßregel",
        "formula": {"name": "stair_step_rule", "riser": {"value": 17}, "going": {"value": 29}},
        "limits": [{"target": "step_measure", "comparator": "between", "value": 59, "upper": 65, "reference": OIB4}]
        if not limit
        else [limit],
    }


class TestTheSharedFixture:
    @pytest.mark.parametrize("case", [c for c in FIXTURE["cases"] if "card" in c], ids=lambda c: c["id"])
    def test_every_case_is_a_card_the_model_could_emit(self, case):
        grid_card_adapter.validate_python(case["card"])

    def test_every_derived_case_names_a_base_and_inputs_the_base_has(self):
        cards = {case["id"]: case["card"] for case in FIXTURE["cases"] if "card" in case}
        for case in FIXTURE["cases"]:
            if "card" in case:
                continue
            base = cards[case["base"]]
            assert case["overrides"], case["id"]
            assert len(formula_inputs(base)) > 0

    def test_the_checkable_quantities_are_one_list(self):
        assert {name: sorted(targets) for name, targets in FORMULA_TARGETS.items()} == {
            name: sorted(targets) for name, targets in FIXTURE["targets"].items()
        }

    def test_the_cases_cover_every_formula(self):
        named = {case["card"]["formula"]["name"] for case in FIXTURE["cases"] if "card" in case}
        assert named == set(FORMULA_TARGETS)


class TestTheContract:
    def test_a_stated_result_does_not_survive_validation(self):
        card = _stair()
        card["result"] = 63
        card["formula"]["riser"]["result"] = 34
        dumped = grid_card_adapter.validate_python(card).model_dump()
        assert "result" not in dumped
        assert "result" not in dumped["formula"]["riser"]

    def test_a_unit_on_the_wire_is_not_the_card_s(self):
        card = _stair()
        card["formula"]["riser"]["unit"] = "m"
        assert "unit" not in grid_card_adapter.validate_python(card).model_dump()["formula"]["riser"]

    def test_a_limit_needs_its_clause(self):
        with pytest.raises(ValidationError, match="Punkt"):
            grid_card_adapter.validate_python(
                _stair(target="riser", comparator="<=", value=18, reference={"document": "OIB-Richtlinie 4"})
            )

    def test_a_limit_needs_a_reference_at_all(self):
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(_stair(target="riser", comparator="<=", value=18))

    def test_a_limit_names_a_quantity_of_its_own_formula(self):
        with pytest.raises(ValidationError, match="targets one of"):
            grid_card_adapter.validate_python(_stair(target="u_value", comparator="<=", value=0.35, reference=OIB4))

    def test_a_range_limit_needs_an_upper_bound_above_the_lower(self):
        with pytest.raises(ValidationError, match="upper"):
            grid_card_adapter.validate_python(
                _stair(target="step_measure", comparator="between", value=65, upper=59, reference=OIB4)
            )

    def test_a_source_value_inside_its_own_range(self):
        card = _stair()
        card["formula"]["riser"] = {"value": 30, "min": 10, "max": 25}
        with pytest.raises(ValidationError, match="above `max`"):
            grid_card_adapter.validate_python(card)

    def test_an_unknown_input_is_allowed_and_stays_unknown(self):
        card = _stair()
        card["formula"]["going"] = {"value": None}
        validated = grid_card_adapter.validate_python(card).model_dump()
        assert validated["formula"]["going"]["value"] is None

    def test_an_unknown_rule_is_refused(self):
        card = _stair()
        card["formula"]["name"] = "clear_room_height"
        with pytest.raises(ValidationError):
            grid_card_adapter.validate_python(card)

    def test_the_worked_example_is_a_valid_card_and_states_no_result(self):
        card = grid_card_adapter.validate_python(CARD_EXAMPLES["formula"]).model_dump()
        assert "result" not in json.dumps(card)
        assert all(limit["reference"]["section"] for limit in card["limits"])


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

    def test_a_norm_reference_counts_as_a_source_and_an_unknown_input_is_not_held_against_it(self):
        card = {
            "type": "formula",
            "formula": {
                "name": "u_value",
                "heat_flow": "horizontal",
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
