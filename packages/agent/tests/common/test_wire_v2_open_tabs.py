"""A tab opened before the answer check still reads the turn it finishes (docs/design/chat-wire-v2.md, „Compatibility").

A tab outlives a deploy. Its bundle reads what the server sends leniently: an
unknown key is stripped, but a known field with a value its schema does not
allow drops the whole frame, and a dropped ``RUN_FINISHED`` asks the tab to
reload. ``v2.schema.before-answer-check.json`` is the generated schema's
``RunFinished`` and what it references, as they stood before ADR-0139; refresh
it only when a release has staged a break on purpose.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema

from agent.agents.piloti.markers import CONFIDENCE_RULE_VERSION

FIXTURES = Path(__file__).parents[4] / "tests" / "fixtures" / "wire_v2"


def _lenient(node: Any) -> Any:
    """The schema as the client reads it: unknown keys stripped rather than refused."""
    if isinstance(node, dict):
        return {key: _lenient(value) for key, value in node.items() if key != "additionalProperties"}
    if isinstance(node, list):
        return [_lenient(value) for value in node]
    return node


def _old_tab_reads(frame: dict[str, Any]) -> bool:
    schema = _lenient(json.loads((FIXTURES / "v2.schema.before-answer-check.json").read_text()))
    return jsonschema.Draft202012Validator(schema).is_valid(frame)


def _checked_finish(version: int, check: dict[str, Any]) -> dict[str, Any]:
    """The golden turn's RUN_FINISHED as a checked answer writes it."""
    lines = (FIXTURES / "golden_turn.jsonl").read_text().splitlines()
    frame = next(json.loads(line) for line in lines if '"RUN_FINISHED"' in line)
    result = frame["result"]
    result["confidence_check"] = check
    result["answer_confidence_version"] = version
    # The golden file leaves the clock out so it stays byte-stable; a live frame carries it.
    return {**frame, "ts": 1_793_100_000_000}


FINDING = {"statement": "Die Treppe ist 1,50 m breit", "problem": "contradicted", "reason": "1,10 m", "source": "[1]"}


def test_a_tab_from_before_the_check_reads_its_finished_turn():
    check = {"status": "judged", "level": "low", "findings": [FINDING]}
    assert _old_tab_reads(_checked_finish(CONFIDENCE_RULE_VERSION, check))


def test_an_unavailable_check_reads_too():
    frame = _checked_finish(CONFIDENCE_RULE_VERSION, {"status": "unavailable"})
    frame["result"].pop("answer_confidence", None)
    frame["result"].pop("answer_confidence_version", None)
    assert _old_tab_reads(frame)


def test_the_check_sees_the_break_a_new_version_number_would_be():
    """What review caught: ``answer_confidence_version: 3`` fails the old ``1 | 2``."""
    assert not _old_tab_reads(_checked_finish(3, {"status": "judged", "level": "high"}))
