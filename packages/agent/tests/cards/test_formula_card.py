"""The formula card's contract (ADR-0143), and the fixture both sides compute from.

The arithmetic and the bounds live in the browser (`apps/workspace/ui/features/
cards/lib/formulas.ts`) and are tested there against `formula-cases.json`.
This side holds what the model may put on the wire: every case's card is a
valid card, the model names a case but never a number (no limit, no result, no
figure in the title, a label or the note), and a stated result is counted.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent.agents.piloti import answer_pipeline
from agent.cards.catalog import CARD_EXAMPLES
from agent.cards.envelope import ENVELOPE_SHAPE_TYPES
from agent.cards.formula_card import formula_inputs
from agent.cards.formula_card import stated_result_fields
from agent.cards.models import answer_card_adapter
from agent.observability.langfuse_scores import card_validity_score
from agent.observability.langfuse_scores import formula_provenance_score

FIXTURE_PATH = Path(__file__).resolve().parents[4] / "apps/workspace/ui/features/cards/lib/formula-cases.json"
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
        answer_card_adapter.validate_python(case["card"])

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
        dumped = answer_card_adapter.validate_python(card).model_dump()
        assert "result" not in dumped and "limits" not in dumped
        assert "result" not in dumped["formula"]["riser"]

    def test_a_unit_on_the_wire_is_not_the_card_s(self):
        card = _stair()
        card["formula"]["riser"]["unit"] = "m"
        assert "unit" not in answer_card_adapter.validate_python(card).model_dump()["formula"]["riser"]

    @pytest.mark.parametrize(
        "title", ["U-Wert Außenwand – 20 cm Dämmung", "Fluchtweg 36,5 m", "Belichtung 12 %", "U = 0,17"]
    )
    def test_a_title_with_a_figure_is_refused(self, title):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize("title", ["U-Wert Außenwand AW 01", "Fluchtweg Büro 2.14", "Stiege 2. OG", "Haus A"])
    def test_an_identifier_in_a_title_is_not_a_figure(self, title):
        answer_card_adapter.validate_python(_stair(title=title))

    def test_a_layer_label_or_a_leg_label_with_a_figure_is_refused(self):
        wall = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        wall["formula"]["layers"][1]["label"] = "EPS-F 20 cm"
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(wall)
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
            answer_card_adapter.validate_python(route)

    def test_a_note_that_states_a_result_is_refused(self):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(note="Das Schrittmaß = 63 und damit erfüllt."))
        answer_card_adapter.validate_python(_stair(note="Gilt für jede Stufe des Laufs."))

    def test_the_stair_type_is_required_and_closed(self):
        card = _stair()
        del card["formula"]["stair_type"]
        with pytest.raises(ValidationError):
            answer_card_adapter.validate_python(card)
        card["formula"]["stair_type"] = "spiral"
        with pytest.raises(ValidationError):
            answer_card_adapter.validate_python(card)

    def test_a_u_value_names_its_component_and_no_heat_flow(self):
        card = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        card["formula"]["heat_flow"] = "downward"
        dumped = answer_card_adapter.validate_python(card).model_dump()
        assert "heat_flow" not in dumped["formula"]
        del card["formula"]["component"]
        with pytest.raises(ValidationError):
            answer_card_adapter.validate_python(card)

    def test_a_source_value_inside_its_own_range(self):
        card = _stair()
        card["formula"]["riser"] = {"value": 30, "min": 10, "max": 25}
        with pytest.raises(ValidationError, match="above `max`"):
            answer_card_adapter.validate_python(card)

    def test_an_unknown_input_is_allowed_and_stays_unknown(self):
        card = _stair()
        card["formula"]["going"] = {"value": None}
        assert answer_card_adapter.validate_python(card).model_dump()["formula"]["going"]["value"] is None

    def test_an_unknown_rule_is_refused(self):
        card = _stair()
        card["formula"]["name"] = "clear_room_height"
        with pytest.raises(ValidationError):
            answer_card_adapter.validate_python(card)

    def test_the_worked_example_is_a_valid_card_with_no_number_of_its_own(self):
        card = answer_card_adapter.validate_python(CARD_EXAMPLES["formula"]).model_dump()
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
            answer_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize(
        "title", ["Stiege Top 7", "Fluchtweg Büro 2.14", "Stiege 2. OG", "U-Wert Außenwand AW 01", "Gst.-Nr. 123/4"]
    )
    def test_an_identifier_still_passes(self, title):
        answer_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize(
        "note", ["nicht erfüllt", "Die Stufenhöhe ist zulässig.", "Auftritt ≥ 27 erreicht.", "max. 18 laut Plan"]
    )
    def test_a_note_with_a_verdict_or_a_comparison_is_refused(self, note):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(note=note))

    def test_a_note_may_cite_a_clause(self):
        answer_card_adapter.validate_python(_stair(note="Gilt sinngemäß auch für Außentreppen, Pkt. 3.2.7."))

    @pytest.mark.parametrize("source", ["Schnitt A-A, 17 cm", "Plan: erfüllt", "laut Statik ≥ 20"])
    def test_a_source_says_where_never_what(self, source):
        card = _stair()
        card["formula"]["riser"]["source"] = source
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(card)

    @pytest.mark.parametrize("source", ["Einreichplan, Schnitt A-A", "Grundriss 2. OG", "Plan 04-123, Index B"])
    def test_a_source_may_name_a_plan_and_its_number(self, source):
        card = _stair()
        card["formula"]["riser"]["source"] = source
        answer_card_adapter.validate_python(card)


class TestTheMeasureOfAUValue:
    def test_new_build_renovation_or_unknown(self):
        card = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        for measure in ("new_build", "renovation"):
            card["formula"]["measure"] = measure
            assert answer_card_adapter.validate_python(card).model_dump()["formula"]["measure"] == measure
        del card["formula"]["measure"]
        assert answer_card_adapter.validate_python(card).model_dump()["formula"]["measure"] is None
        card["formula"]["measure"] = "partial_renovation"
        with pytest.raises(ValidationError):
            answer_card_adapter.validate_python(card)

    def test_the_fixture_has_a_case_for_each(self):
        measures = {
            case["card"]["formula"].get("measure")
            for case in FIXTURE["cases"]
            if "card" in case and case["card"]["formula"]["name"] == "u_value"
        }
        assert measures == {"new_build", "renovation", "major_renovation", None}


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


class TestTheGuardIsFailClosed:
    """Every string the third review found accepted is a refusal case here; a digit needs an allow-list entry."""

    NOTES = [
        "U-Wert 0,17",
        "Schrittmaß 63",
        "U ≈ 0,17",
        "U ~ 0,17",
        "U ⩽ 0,35",
        "U unter 0,35",
        "U kleiner als 0,35",
        "62 ± 3",
        "20 Zentimeter",
        "1,5 Meter Auskragung",
        "12 Prozent",
        "erfuellt",
        "passt",
        "ok",
        "Ergebnis knapp unter dem Grenzwert",
    ]
    TITLES = [
        "EPS 200",
        "XPS 30",
        "EPS 0",
        "UG 18",
        "BA 1600",
        "Achse 12.5",
        "Nr. 40",
        "Stiege A – passt",
        "Stiege A genügt",
        "Stiege A in Ordnung",
        "Stiege A ✓",
        "Haus A, OK",
        "nicht erfuellt",
        "U-Wert deutlich unter Grenzwert",
    ]
    SOURCES = ["Schnitt A-A (17)", "Plan 17 Zentimeter"]

    @pytest.mark.parametrize("note", NOTES)
    def test_a_note(self, note):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(note=note))

    @pytest.mark.parametrize("title", TITLES)
    def test_a_title(self, title):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize("label", ["EPS 200", "Dämmung passt", "Mineralwolle 16"])
    def test_a_layer_label(self, label):
        wall = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        wall["formula"]["layers"][1]["label"] = label
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(wall)

    @pytest.mark.parametrize("source", SOURCES)
    def test_a_source(self, source):
        card = _stair()
        card["formula"]["going"]["source"] = source
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(card)

    @pytest.mark.parametrize(
        "text",
        [
            "Gilt sinngemäß auch für Außentreppen, Pkt. 3.2.7.",
            "Siehe OIB-Richtlinie 4, Tabelle 3, Zeile 2.",
            "Rechenweg nach ÖNORM B 8110-7.",
            "gemessen ab OK FFB",
        ],
    )
    def test_a_citation_and_a_floor_edge_still_pass_in_a_note(self, text):
        answer_card_adapter.validate_python(_stair(note=text))

    @pytest.mark.parametrize("source", ["Plan 04-123, Index B", "Grundriss 2. OG", "Raumbuch Top 3"])
    def test_a_plan_number_still_passes_in_a_source(self, source):
        card = _stair()
        card["formula"]["going"]["source"] = source
        answer_card_adapter.validate_python(card)

    @pytest.mark.parametrize("title", ["U-Wert Außenwand AW 20", "Wohnzimmer Top 63", "Fluchtweg Büro 2.14"])
    def test_an_identifier_passes_whatever_its_number(self, title):
        # The judgement, documented at `_IDENTIFIER`: a component code („AW 20"), a
        # numbered dwelling („Top 63") and a room number are names, and no rule on
        # the text alone can tell one from a figure written as one. They pass.
        answer_card_adapter.validate_python(_stair(title=title))

    def test_every_fixture_card_and_example_survives_the_guard(self):
        for case in FIXTURE["cases"]:
            if "card" in case:
                answer_card_adapter.validate_python(case["card"])
        answer_card_adapter.validate_python(CARD_EXAMPLES["formula"])


class TestAMajorRenovation:
    def test_is_a_measure_of_its_own(self):
        card = json.loads(json.dumps(CARD_EXAMPLES["formula"]))
        card["formula"]["measure"] = "major_renovation"
        assert answer_card_adapter.validate_python(card).model_dump()["formula"]["measure"] == "major_renovation"

    def test_the_schema_tells_the_model_it_is_not_judged_by_the_table(self):
        from agent.cards.formula_card import UValueFormula

        description = UValueFormula.model_fields["measure"].description or ""
        assert "major_renovation" in description and "Pkt. 4.3" in description


class TestTheGuardAllowsProvenanceAndRefusesByClass:
    """Fourth review: real provenance passes; a name is an alphabet, so a sign is refused as a class."""

    @pytest.mark.parametrize(
        "source",
        [
            "Einreichplan EP-01 Index B",
            "Bestandsplan 1972",
            "Produktdatenblatt Rev. 3",
            "Gemäß Statik Pos. 63",
            "Siehe Seite 17",
            "Variante 2",
            "Stand 03/2024",
            "Fassung vom 12.03.2024",
        ],
    )
    def test_a_document_reference_passes_in_a_source_and_a_note(self, source):
        card = _stair(note=source)
        card["formula"]["going"]["source"] = source
        answer_card_adapter.validate_python(card)

    @pytest.mark.parametrize(
        "text",
        [
            "konform",
            "regelkonform",
            "i. O.",
            "bestanden",
            "nachgewiesen",
            "entspricht der Anforderung",
            "hält die Anforderung ein",
            "verfehlt",
            "unzureichend",
            "pass",
            "fail",
            "compliant",
            "kleiner als gefordert",
            "größer als erlaubt",
            "besser als der Grenzwert",
            "schlechter als die Anforderung",
            "weniger als gefordert",
            "mehr als erlaubt",
            "U ≤ Grenzwert",
            "Stiege ☑",
            "👍",
            "🟢",
            "Dicke 20 cm²",
            "U-Wert ⁰,¹⁷",
        ],
    )
    def test_a_verdict_a_sign_or_a_symbol_is_refused_in_a_note(self, text):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(note=text))

    @pytest.mark.parametrize(
        "title",
        [
            "Stiege ☑",
            "Haus A 👍",
            "Wand 🟢",
            "U ≤ 0,35",
            "U ≥ Soll",
            "Wand ²",
            "Stiege A konform",
            "Stiege A i. O.",
            "Stiege A bestanden",
            "Wand nachgewiesen",
            "Wand verfehlt",
            "Wand compliant",
            "Stiege A!",
            "Stiege A: geprüft",
        ],
    )
    def test_a_name_outside_its_alphabet_is_refused(self, title):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(title=title))

    @pytest.mark.parametrize(
        "title",
        ["U-Wert Außenwand AW 01 – Variante 2", "Wohnungseingangstüre → Gang", "Decke über Durchfahrt"],
    )
    def test_a_name_inside_its_alphabet_passes(self, title):
        answer_card_adapter.validate_python(_stair(title=title))


class TestADocumentReferenceIsNeverADecimal:
    """Fifth review: a plan word is named, a plan code is a code or an integer, a position has no leading 0."""

    @pytest.mark.parametrize(
        "text", ["U im Durchschnitt 0.17", "laut Lageplan 0.35", "Detailschnitt 0.17", "Pos. 0.17", "Seite 0.17"]
    )
    def test_a_decimal_after_a_document_word_is_refused(self, text):
        card = _stair(note=text)
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(card)
        card = _stair()
        card["formula"]["going"]["source"] = text
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(card)

    @pytest.mark.parametrize(
        "source",
        ["Bestand 1960er", "Lageplan A-101", "Detailschnitt 12", "Gemäß Statik Pos. 4.2", "Grundriss EG-03"],
    )
    def test_a_code_an_integer_and_a_decade_pass(self, source):
        card = _stair()
        card["formula"]["going"]["source"] = source
        answer_card_adapter.validate_python(card)

    def test_abschnitt_stays_a_citation_word(self):
        answer_card_adapter.validate_python(_stair(note="Siehe Abschnitt 4.2."))


class TestMoreVerdicts:
    @pytest.mark.parametrize(
        "text",
        [
            "knapp",
            "kritisch",
            "grenzwertig",
            "mangelhaft",
            "Mangel",
            "NOK",
            "iO",
            "i.O",
            "zu steil",
            "zu flach",
            "zu lang",
            "zu kurz",
            "zu schmal",
            "zu hoch",
            "zu niedrig",
            "Stiege A – grün",
            "Stiege A → rot",
            "Wand - gelb",
        ],
    )
    def test_is_refused_in_a_note_and_a_title(self, text):
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(note=text))
        with pytest.raises(ValidationError, match="carries"):
            answer_card_adapter.validate_python(_stair(title=f"Stiege A {text}"))
