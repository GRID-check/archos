"""A work turn in Langfuse (ADR-0122): its kind, its report's size, and whether the report told the truth."""

from __future__ import annotations

from types import SimpleNamespace

from aiq_agent.observability.langfuse_scores import turn_outcome_scores
from aiq_agent.observability.turn_outcome import outcome_metadata
from aiq_agent.observability.turn_outcome import outcome_tags


def _card(card: dict) -> SimpleNamespace:
    return SimpleNamespace(card=card)


def _result(meta: dict | None, cards: list[dict]) -> SimpleNamespace:
    return SimpleNamespace(answer_meta=meta, cards=[_card(card) for card in cards], text="x", sources=[])


WORK = {
    "v": 1,
    "kind": "work",
    "work": {"proposed": [{"text": "a", "ref": "p1"}, {"text": "b"}], "next": [{"text": "c"}]},
}
PROPOSAL = {"type": "operation_proposal", "proposal_id": "p1"}


def test_a_work_turn_carries_its_kind_and_report_size_and_a_tag():
    metadata = outcome_metadata(outcome="answered", result=_result(WORK, [PROPOSAL, PROPOSAL]))
    assert metadata["answer_kind"] == "work"
    assert metadata["work_proposed"] == 2 and metadata["work_next"] == 1
    assert "work_done" not in metadata
    assert "kind:work" in outcome_tags(metadata)


def test_the_report_matches_when_it_lists_what_the_turn_filed():
    scores = {score.name: score for score in turn_outcome_scores(_result(WORK, [PROPOSAL, PROPOSAL]))}
    assert scores["work-report-matches"].value == 1.0


def test_a_report_claiming_a_proposal_the_turn_did_not_file_does_not_match():
    scores = {score.name: score for score in turn_outcome_scores(_result(WORK, [PROPOSAL, {"type": "x"}]))}
    assert scores["work-report-matches"].value == 0.0
    assert scores["work-report-matches"].comment == "reported 2, filed 1"


def test_no_work_score_and_no_kind_tag_on_any_other_answer():
    result = _result({"v": 1, "kind": "ruling"}, [PROPOSAL])
    assert all(score.name != "work-report-matches" for score in turn_outcome_scores(result))
    metadata = outcome_metadata(outcome="answered", result=result)
    assert metadata["answer_kind"] == "ruling"
    assert "kind:work" not in outcome_tags(metadata)
