"""The server's sketch fence check, held to the cases the browser's check runs too (ADR-0146)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.common.answer_dialect import validate_dialect
from agent.common.sketch_fence import REFUSED_SKETCH_FENCE_INFO
from agent.common.sketch_fence import SKETCH_REFUSALS
from agent.common.sketch_fence import check_sketch
from agent.common.sketch_fence import sketch_census
from agent.observability.answer_scores import sketch_scores

FIXTURES = Path(__file__).resolve().parents[4] / "apps/workspace/bff/diagrams/__fixtures__/sketch-fences.json"
CASES = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_each_case_gets_the_verdict_both_checks_agree_on(case):
    check = check_sketch(case["body"])
    assert check.refusal == case["refusal"]
    if case["refusal"] is None:
        assert check.elements == case["elements"]
        assert check.dimension_labels == case["dimension_labels"]


def test_every_refusal_has_a_case():
    assert {case["refusal"] for case in CASES} - {None} == set(SKETCH_REFUSALS)


def _answer(body: str, info: str = "excalidraw") -> str:
    return f"Eine erste Skizze:\n\n```{info}\n{body}\n```\n\nSie behauptet keine Maße."


def test_a_drawn_sketch_passes_the_dialect_byte_for_byte_and_counts_as_a_drawing():
    text = _answer(CASES[0]["body"])
    result = validate_dialect(text, "walkthrough")
    assert result.text == text
    assert [check.drawn for check in result.sketches] == [True]
    assert result.census["diagrams"] == 1


def test_a_refused_sketch_keeps_its_source_under_the_refused_tag():
    text = _answer("rectangle Wohnen -> Kochen", info="Excalidraw title")
    result = validate_dialect(text, None)
    assert result.text == text.replace("```Excalidraw title", f"```{REFUSED_SKETCH_FENCE_INFO} title")
    assert {"repair": "sketch_refused", "name": "malformed-json"} in result.repairs


def test_a_sketch_over_the_drawing_budget_is_logged_not_removed():
    text = _answer(CASES[0]["body"])
    result = validate_dialect(text, "direct")
    assert result.text == text
    assert {"repair": "diagrams_over_budget", "name": "excalidraw"} in result.repairs


def test_a_listing_that_mentions_excalidraw_is_not_a_sketch():
    result = validate_dialect('```json\n{"type": "excalidraw"}\n```', None)
    assert result.sketches == []


def test_the_trace_and_the_scores_name_each_sketch():
    checks = [check_sketch(CASES[0]["body"]), check_sketch(CASES[2]["body"]), check_sketch("nope")]
    census = sketch_census(checks)
    assert census["drawn"] == 2
    assert census["refused"] == {"malformed-json": 1}
    assert census["dimension_labels"] == 2
    scores = sketch_scores(checks)
    assert [(score.value, score.item, score.comment) for score in scores] == [
        ("drawn", "0", None),
        ("drawn", "1", None),
        ("refused", "2", "malformed-json"),
    ]


def test_a_body_escaped_twice_is_drawn_and_counted():
    [case] = [case for case in CASES if case["name"] == "a body escaped twice is read once unescaped"]
    check = check_sketch(case["body"])
    assert check.drawn and check.unescaped
    assert sketch_census([check])["unescaped"] == 1
    assert not check_sketch(CASES[0]["body"]).unescaped
