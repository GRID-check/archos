"""The work report: ``kind: "work"`` and its ``work`` field (ADR-0123).

An operations turn is not forced into the legal answer's shape any more: it
reports what it did, what waits for the person as a proposal, what is blocked
and what comes next. The gate keeps the report on work turns only, bounds each
list and drops a line that is a paragraph, and the gated payload is the one the
frontend's sanitizer passes through verbatim (`work_payload.json`).
"""

from __future__ import annotations

import json
import pathlib

from aiq_agent.common.answer_envelope import WORK_ITEMS_MAX
from aiq_agent.common.answer_envelope import WORK_TEXT_MAX_CHARS
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import extract_answer_envelope
from aiq_agent.common.answer_envelope import gate_answer_meta
from aiq_agent.common.answer_envelope import render_envelope_response_format
from aiq_agent.common.answer_envelope import render_envelope_schema

FIXTURE = json.loads(
    pathlib.Path(__file__).resolve().parents[3].joinpath("tests/fixtures/answer_meta/work_payload.json").read_text()
)


def _gate(envelope: dict) -> dict | None:
    return gate_answer_meta(AnswerMeta.model_validate({"answer": "x", **envelope}), prose_chars=200)


def test_the_gated_work_report_matches_the_shared_fixture() -> None:
    assert _gate({"kind": "work", "topic": FIXTURE["topic"], "work": FIXTURE["work"]}) == FIXTURE


def test_a_work_report_survives_only_on_a_work_turn() -> None:
    work = {"proposed": [{"text": "Ordner anlegen", "ref": "p1"}]}
    assert "work" not in (_gate({"kind": "walkthrough", "work": work}) or {})
    assert "work" not in (_gate({"work": work}) or {})
    assert _gate({"kind": "work", "work": work}) == {"v": 1, "kind": "work", "work": work}


def test_each_list_is_bounded_and_a_paragraph_is_not_a_line() -> None:
    lines = [{"text": f"Schritt {n}"} for n in range(WORK_ITEMS_MAX + 3)]
    paragraph = {"text": "x" * (WORK_TEXT_MAX_CHARS + 1)}
    long_ref = {"text": "Mitglied aufnehmen", "ref": "r" * 200, "who": "Lena Berger"}
    payload = _gate({"kind": "work", "work": {"next": [paragraph, *lines], "proposed": [long_ref], "done": []}})
    assert payload is not None
    assert len(payload["work"]["next"]) == WORK_ITEMS_MAX
    assert payload["work"]["next"][0] == {"text": "Schritt 0"}
    assert payload["work"]["proposed"] == [{"text": "Mitglied aufnehmen", "who": "Lena Berger"}]
    assert "done" not in payload["work"]


def test_a_work_turn_never_keeps_a_verdict() -> None:
    payload = _gate({"kind": "work", "verdict": {"value": "REI 60", "subject": "x"}})
    assert payload == {"v": 1, "kind": "work"}


def test_the_model_is_taught_the_report_and_the_provider_enforces_it() -> None:
    schema = render_envelope_schema()
    assert '"handoff" | "work"' in schema
    assert "work: { done: [" in schema and "only for kind=work" in schema
    enforced = render_envelope_response_format()["json_schema"]["schema"]
    assert enforced["properties"]["kind"]["anyOf"][0]["enum"][-1] == "work"
    work = enforced["properties"]["work"]["anyOf"][0]
    assert list(work["properties"]) == ["done", "proposed", "blocked", "next"]


def test_a_fenced_work_reply_is_extracted_whole() -> None:
    reply = (
        "```answer_json\n" + json.dumps({"kind": "work", "answer": "Vorgeschlagen.", "work": FIXTURE["work"]}) + "\n```"
    )
    prose, meta = extract_answer_envelope(reply)
    assert prose == "Vorgeschlagen."
    assert meta is not None and meta.kind == "work"
    assert meta.work is not None and meta.work.proposed is not None
    assert meta.work.proposed[0].ref == FIXTURE["work"]["proposed"][0]["ref"]
