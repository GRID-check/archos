"""References (Verweise) read at ingest: norms, laws, plans and named documents, with no model."""

from __future__ import annotations

import pytest
from knowledge_layer.references import MAX_REFERENCES
from knowledge_layer.references import drop_own_type
from knowledge_layer.references import extract_references
from knowledge_layer.references import norm_key
from knowledge_layer.references import plan_key


def _refs(text: str, page: int | None = 1, **kwargs) -> list[tuple[str, str, str]]:
    return [(r["kind"], r["key"], r["label"]) for r in extract_references([(text, page)], **kwargs)]


class TestNorms:
    @pytest.mark.parametrize(
        ("text", "key", "label"),
        [
            ("nach ÖNORM B 1600 barrierefrei", "önorm b 1600", "ÖNORM B 1600"),
            ("gem. ÖNORM EN 1992-1-1", "önorm en 1992-1-1", "ÖNORM EN 1992-1-1"),
            ("Tauwasser nach DIN EN ISO 13788", "din en iso 13788", "DIN EN ISO 13788"),
            ("Schallschutz DIN 4109-1", "din 4109-1", "DIN 4109-1"),
            ("OIB-Richtlinie 2.1 Punkt 3.2", "oib-rl 2.1", "OIB-Richtlinie 2.1"),
            ("lt. OIB-RL 2", "oib-rl 2", "OIB-RL 2"),
            ("TRVB 124 F ist einzuhalten", "trvb 124 f", "TRVB 124 F"),
            ("VDI 6022 Blatt 1", "vdi 6022 blatt 1", "VDI 6022 Blatt 1"),
            ("Bemessung nach EN 1990", "en 1990", "EN 1990"),
        ],
    )
    def test_a_standard_is_one_record_under_its_designation(self, text, key, label):
        assert _refs(text) == [("norm", key, label)]

    def test_a_longer_designation_is_not_also_read_as_its_parts(self):
        assert [key for _, key, _ in _refs("DIN EN ISO 13788 und EN 1990")] == ["din en iso 13788", "en 1990"]

    def test_onorm_typed_without_the_umlaut_is_the_same_standard(self):
        assert norm_key("ONORM B 1600") == norm_key("ÖNORM  B 1600") == "önorm b 1600"


class TestLaws:
    def test_a_paragraph_with_its_law_is_a_reference(self):
        assert _refs("Gemäß § 33 BayBO ist") == [("law", "§ 33 baybo", "§ 33 BayBO")]

    def test_subdivisions_are_read_past_to_the_law(self):
        assert _refs("nach § 62 Abs. 2 BO für Wien") == [("law", "§ 62 bo für wien", "§ 62 BO für Wien")]

    def test_a_bare_paragraph_names_no_law_and_is_left_to_the_payload(self):
        assert _refs("§ 5 ist zu beachten") == []


class TestPlans:
    @pytest.mark.parametrize(
        ("text", "key"),
        [
            ("Siehe Plan EP-05", "ep-05"),
            ("Plan-Nr. EP_03 Index C", "ep-03"),
            ("Detail 3/A-501", "3/a-501"),
            ("vgl. A-102", "a-102"),
            ("Blatt-Nr. GR 04", "gr-04"),
        ],
    )
    def test_a_plan_number_after_a_designator_or_a_pointing_word(self, text, key):
        assert [(kind, k) for kind, k, _ in _refs(text)] == [("plan", key)]

    def test_a_scale_is_not_a_plan(self):
        assert _refs("Plan M 1:100") == []

    def test_a_word_without_a_number_is_not_a_plan(self):
        assert _refs("Plan Erdgeschoss") == []

    def test_plan_keys_agree_however_the_number_is_spaced(self):
        assert plan_key("EP 05") == plan_key("ep_05") == plan_key("EP-05") == "ep-05"
        assert plan_key("3 / A-501") == "3/a-501"


class TestDocuments:
    @pytest.mark.parametrize(
        ("text", "key"),
        [
            ("Ausführung gem. Brandschutzkonzept", "fire_safety_concept"),
            ("Die Bemessung lt. Statik (Beilage 4)", "structural_analysis"),
            ("siehe beiliegenden Lageplan", "site_plan"),
            ("die Auflagen im Baubescheid", "permit"),
            ("laut Energieausweis", "energy_certificate"),
            ("nach dem Bodengutachten", "soil_report"),
            ("wie in der Baubeschreibung", "building_description"),
        ],
    )
    def test_a_named_document_after_a_pointing_word(self, text, key):
        assert [(kind, k) for kind, k, _ in _refs(text)] == [("document", key)]

    def test_a_heading_that_names_a_kind_is_not_a_reference(self):
        assert _refs("Statik: Holzbau") == []

    def test_a_document_pointing_at_its_own_kind_is_dropped(self):
        text = "im vorliegenden Brandschutzkonzept, lt. Statik"
        assert [k for _, k, _ in _refs(text, own_document_type="fire_safety_concept")] == ["structural_analysis"]
        records = extract_references([(text, 1)])
        assert [r["key"] for r in drop_own_type(records, "fire_safety_concept")] == ["structural_analysis"]


class TestMerging:
    def test_one_reference_on_several_pages_is_one_record_with_its_pages(self):
        records = extract_references([("ÖNORM B 1600", 7), ("ONORM B 1600", 3), ("ÖNORM B 1600", 7)])
        assert records == [{"kind": "norm", "key": "önorm b 1600", "label": "ÖNORM B 1600", "pages": [3, 7]}]

    def test_records_keep_the_order_they_first_appear_in(self):
        records = extract_references([("siehe Plan EP-05, ÖNORM B 1600", 1), ("§ 33 BayBO", 2)])
        assert [r["kind"] for r in records] == ["plan", "norm", "law"]

    def test_the_list_is_bounded(self):
        text = " ".join(f"DIN {1000 + n}" for n in range(MAX_REFERENCES + 20))
        assert len(extract_references([(text, 1)])) == MAX_REFERENCES

    def test_a_passage_without_a_page_still_counts(self):
        assert extract_references([("ÖNORM B 1600", None)])[0]["pages"] == []


class TestKeysForWhatSomeoneNames:
    @pytest.mark.parametrize(
        ("text", "keys"),
        [
            ("ÖNORM B 1600", [("norm", "önorm b 1600")]),
            ("§ 33 BayBO", [("law", "§ 33 baybo")]),
            ("EP-05", [("plan", "ep-05")]),
            ("Plan: EP-05", [("plan", "ep-05")]),
            ("Plan Nr. EP-05", [("plan", "ep-05")]),
            ("siehe EP-05", [("plan", "ep-05")]),
            ("Detail 3/A-501", [("plan", "3/a-501")]),
            ("Brandschutzkonzept", [("document", "fire_safety_concept")]),
            ("Hubergasse", []),
            ("", []),
        ],
    )
    def test_a_name_reads_into_the_keys_a_document_carries(self, text, keys):
        from knowledge_layer.references import reference_keys_for

        assert reference_keys_for(text) == keys
