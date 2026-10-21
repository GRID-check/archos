"""The joins of ADR-0122: every answer stamped, records grounding through their own channel, scores written.

The parts are tested in ``tests/aiq_agent/common``; these go through
``finalize_answer`` and the state, where a part nobody calls would show.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.common.citation_verification import SourceRegistry

APPROVALS = (
    '{"items": [{"assignee": "Anna Berger", "status": "pending", "document": "Einreichplan EG"},'
    '{"assignee": "Anna Berger", "status": "pending", "document": "Schnitt A-A"},'
    '{"assignee": "Anna Berger", "status": "approved", "document": "Lageplan"}]}'
)
ANSWER_ENVELOPE = '```answer_json\n{{"kind": "direct", "confidence": {{"level": "high"}}, "answer": "{prose}"}}\n```'


def _workspace_read(call_id: str = "w1") -> list:
    return [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": call_id,
                    "name": "workspace__call",
                    "args": {"name": "project-approvals-list", "input": {"params": {"projectId": "p1"}}},
                }
            ],
        ),
        ToolMessage(content=APPROVALS, tool_call_id=call_id, name="workspace__call"),
    ]


async def _finalize(messages: list, registry: SourceRegistry | None = None):
    registry = registry if registry is not None else SourceRegistry()
    final = await finalize_answer(messages, registry=registry, tools=[], repair=None, turn_sources=[])
    return final, assemble_result({"messages": messages}, final, turn_sources=[], turn_measurements=[])


async def test_a_workspace_answer_is_record_grounded_and_reaches_the_models_level():
    prose = "Anna Berger hat 3 Freigaben, davon 2 offen."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages)

    assert [(stamp["provenance"], stamp["operation"]) for stamp in final.claim_stamps] == [
        ("record", "project-approvals-list")
    ]
    assert state.answer_confidence == "high" and state.answer_confidence_version == 2
    assert state.answer_confidence_capped_reason is None


async def test_a_record_never_grounds_a_claim_about_the_law():
    prose = "Anna Berger hat 3 Freigaben. Der Einreichplan EG muss nach § 5 bewilligt werden."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    _, state = await _finalize(messages)

    assert state.answer_confidence == "low"
    assert state.answer_confidence_capped_reason == "normative_claim_uncited"


async def test_a_record_never_enters_the_source_registry():
    registry = SourceRegistry()
    prose = "Anna Berger hat 3 Freigaben."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, registry)

    assert registry.all_sources() == []
    assert final.citation_grounded is False and state.verified_sources is None


async def test_last_turns_workspace_read_grounds_nothing_this_turn():
    prose = "Anna Berger hat 3 Freigaben."
    messages = [
        HumanMessage("Was liegt bei Anna?"),
        *_workspace_read(),
        AIMessage("Drei."),
        HumanMessage("Und jetzt?"),
        AIMessage(ANSWER_ENVELOPE.format(prose=prose)),
    ]

    final, _ = await _finalize(messages)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["model_knowledge"]


async def test_the_three_scores_are_written(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    prose = "Anna Berger hat 3 Freigaben. Laut OIB gilt das immer [4]."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    await _finalize(messages)

    by_name = {(score.name, score.item): score.value for score in written}
    assert by_name[("claims-by-class", "record")] == "record"
    assert by_name[("claims-by-class", "cited_dropped")] == "cited_dropped"
    assert by_name[("claims-normative-uncited", None)] == 1.0
    assert by_name[("citations-dropped-labelled", None)] == 1.0
