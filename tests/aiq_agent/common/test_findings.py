"""The findings contract: bounded, fail-soft per row, pinned to the shared fixture."""

import json
from pathlib import Path

from aiq_agent.common.findings import FINDINGS_VERSION
from aiq_agent.common.findings import MAX_COMMENT_CHARS
from aiq_agent.common.findings import Findings
from aiq_agent.common.findings import sanitize_findings

FIXTURE = Path(__file__).parents[2] / "fixtures" / "findings" / "wire_payload.json"


class TestTheFixtureIsTheContract:
    def test_the_shared_fixture_validates_and_round_trips(self):
        raw = json.loads(FIXTURE.read_text())
        findings = Findings.model_validate(raw)
        assert findings.v == FINDINGS_VERSION
        assert findings.counts() == {"met": 1, "not_met": 0, "open": 1, "not_applicable": 1}
        assert sanitize_findings(raw) == findings.model_dump(exclude_none=True)


class TestSanitize:
    def test_a_row_the_contract_rejects_is_dropped_and_the_rest_stay(self):
        out = sanitize_findings(
            {
                "items": [
                    {"requirement": "A", "status": "met", "grounding": "sourced"},
                    {"requirement": "", "status": "met", "grounding": "sourced"},
                    {"requirement": "C", "status": "maybe", "grounding": "sourced"},
                    "not a row",
                ]
            }
        )
        assert out is not None
        assert [item["requirement"] for item in out["items"]] == ["A"]

    def test_the_german_spellings_stored_before_the_rename_read_as_the_english_ones(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "nicht_erfuellt", "grounding": "abgeleitet"}]}
        )
        assert out is not None
        assert out["items"][0]["status"] == "not_met"
        assert out["items"][0]["grounding"] == "derived"

    def test_free_text_is_cut_to_the_bound_rather_than_refused(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "open", "grounding": "open", "comment": "x" * 2000}]}
        )
        assert out is not None
        assert len(out["items"][0]["comment"]) == MAX_COMMENT_CHARS

    def test_citations_keep_only_positive_integers(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "open", "grounding": "open", "citations": [1, "2", 0, -3, 4]}]}
        )
        assert out is not None
        assert out["items"][0]["citations"] == [1, 4]

    def test_nothing_usable_is_none_not_an_empty_table(self):
        assert sanitize_findings({"items": []}) is None
        assert sanitize_findings({"items": [{"requirement": ""}]}) is None
        assert sanitize_findings("nope") is None

    def test_a_reference_without_a_document_is_dropped(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "open", "grounding": "open", "reference": {"section": "3.1"}}]}
        )
        assert out is not None
        assert "reference" not in out["items"][0]


class TestARowMayStateWithoutJudging:
    """A Bericht states its rows; only a Prüfbericht judges them (status null = stated, not failed)."""

    def test_a_null_status_survives_and_is_not_counted(self):
        out = sanitize_findings(
            {
                "items": [
                    {"requirement": "Fluchtweglänge", "status": None, "grounding": "sourced", "value": "38 m"},
                    {"requirement": "Türbreite", "status": "met", "grounding": "sourced"},
                ]
            }
        )
        assert out is not None
        assert [item.get("status") for item in out["items"]] == [None, "met"]
        findings = Findings.model_validate(out)
        assert findings.counts() == {"met": 1, "not_met": 0, "open": 0, "not_applicable": 0}

    def test_judged_is_whether_any_row_carries_a_status(self):
        stated = Findings.model_validate({"items": [{"requirement": "A", "grounding": "sourced"}]})
        judged = Findings.model_validate({"items": [{"requirement": "A", "status": "open", "grounding": "open"}]})
        assert stated.judged() is False
        assert judged.judged() is True
