"""The answer check through ``finalize_answer`` and the state (ADR-0139): what it is handed, what it sets.

The check's model is the deterministic stub (``tests/aiq_agent/claim_judge_stub.py``):
these tests are about what the turn hands it (the question, the final answer,
every passage, record, measurement and reading, the quote check) and what the
pipeline does with its reply, never about how a model grades.
"""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.piloti import answer_check
from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_check import TurnCheck
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.registry import SourceRegistry
from aiq_agent.common.claim_judge import Evidence
from aiq_agent.common.claim_judge import Finding
from tests.aiq_agent.claim_judge_stub import failing_judge
from tests.aiq_agent.claim_judge_stub import stub_judge

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


async def _finalize(
    messages: list, registry: SourceRegistry | None = None, judge=None, context: tuple[str, ...] = (), **kwargs
):
    registry = registry if registry is not None else SourceRegistry()
    check = TurnCheck(judge or stub_judge(), context)
    final = await finalize_answer(
        messages, registry=registry, tools=[], repair=None, turn_sources=[], check=check, **kwargs
    )
    return final, assemble_result({"messages": messages}, final, turn_sources=[], turn_measurements=[])


async def _evidence(messages: list, registry: SourceRegistry | None = None, **kwargs) -> Evidence:
    calls: list[Evidence] = []
    await _finalize(messages, registry, judge=stub_judge(calls=calls), **kwargs)
    [evidence] = calls
    return evidence


def _oib_passage(text: str = "11.2.1 Die lichte Raumhöhe von Aufenthaltsräumen muss mindestens 2,50 m betragen."):
    return SourceEntry(
        citation_key="oib-rl_3.pdf, p.7", source_type="knowledge_layer", tool_name="knowledge_search", chunk_text=text
    )


async def test_the_level_is_the_checks_and_the_findings_ride_on_the_state():
    finding = Finding("Der Gang ist 1,50 m breit", "contradicted", "Der Schnitt nennt 1,10 m.", "[1] Schnitt A-A")
    prose = "Anna Berger hat 3 Freigaben."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, judge=stub_judge("low", [finding]))

    assert state.answer_confidence == "low" and state.answer_confidence_version == 2
    assert final.confidence_check == {"status": "judged", "level": "low", "findings": [finding.to_wire()]}
    assert state.confidence_check == final.confidence_check


async def test_the_check_reads_the_question_the_answer_and_this_turns_records():
    prose = "Anna Berger hat 3 Freigaben, davon 2 offen."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    evidence = await _evidence(messages, context=("PROJECT_CONTEXT v1\nconfirmed:\n- address: Lacknergasse 98",))

    assert evidence.question == "Was liegt bei Anna?" and evidence.answer == prose
    assert any(r.startswith("project-approvals-list (read):") and "Anna Berger" in r for r in evidence.records)
    assert any("Lacknergasse 98" in r for r in evidence.records)


async def test_last_turns_workspace_read_is_not_this_turns_evidence():
    prose = "Anna Berger hat 3 Freigaben."
    messages = [
        HumanMessage("Was liegt bei Anna?"),
        *_workspace_read(),
        AIMessage("Drei."),
        HumanMessage("Und jetzt?"),
        AIMessage(ANSWER_ENVELOPE.format(prose=prose)),
    ]

    evidence = await _evidence(messages)

    assert evidence.records == [] and evidence.question == "Und jetzt?"


async def test_a_passage_goes_in_whole_however_far_in_its_rule_stands():
    rule = "Punkt 9.4: Der Fluchtweg muss mindestens 1,20 m breit sein."
    registry = SourceRegistry()
    registry.add(_oib_passage("Allgemeines. " * 230 + rule))
    prose = "Der Fluchtweg muss 1,20 m breit sein [1].\n\n**Quellen:**\n- [1] oib-rl_3.pdf, p.7"
    messages = [HumanMessage("Wie breit?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    evidence = await _evidence(messages, registry)

    [passage] = evidence.passages
    assert passage.cited and passage.label == "[1] oib-rl_3.pdf, p.7"
    assert passage.text.index(rule) > 2800 and passage.text.endswith(rule)


async def test_the_quote_check_tells_the_check_which_quotation_held():
    registry = SourceRegistry()
    registry.add(_oib_passage())
    prose = (
        "Laut OIB gilt: „Die lichte Raumhöhe von Aufenthaltsräumen muss mindestens 2,50 m betragen“ [1]. "
        "Außerdem: „Jeder Raum braucht zwei Fenster nach Süden“ [1]."
        "\n\n**Quellen:**\n- [1] oib-rl_3.pdf, p.7"
    )
    messages = [HumanMessage("Raumhöhe?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    evidence = await _evidence(messages, registry)

    assert any("2,50 m betragen" in quote for quote in evidence.quotes_found)
    assert any("zwei Fenster" in quote for quote in evidence.quotes_not_found)
    assert not any("zwei Fenster" in quote for quote in evidence.quotes_found)


async def test_a_quote_no_passage_holds_caps_a_high_check_at_medium():
    registry = SourceRegistry()
    registry.add(_oib_passage())
    prose = (
        "Die Raumhöhe regelt Punkt 11.2.1: „Jeder Raum braucht zwei Fenster nach Süden“ [1]."
        "\n\n**Quellen:**\n- [1] oib-rl_3.pdf, p.7"
    )
    messages = [HumanMessage("Raumhöhe?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, registry, judge=stub_judge("high"))

    assert final.quotes_verified is False and final.confidence_check["level"] == "high"
    assert state.answer_confidence == "medium" and state.answer_confidence_capped_reason == "quote_unverified"


async def test_an_unavailable_check_surfaces_no_level_and_is_scored(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose="3."))]

    final, state = await _finalize(messages, judge=failing_judge())

    assert final.confidence_check == {"status": "unavailable"}
    assert state.answer_confidence is None and state.answer_confidence_version is None
    assert {score.name: score.value for score in written}["confidence-judge-unavailable"] == 1.0


async def test_no_judge_at_all_is_the_same_unavailable_turn():
    messages = [HumanMessage("Was liegt bei Anna?"), AIMessage(ANSWER_ENVELOPE.format(prose="Drei."))]

    final = await finalize_answer(messages, registry=SourceRegistry(), tools=[], repair=None, turn_sources=[])

    assert final.confidence_check == {"status": "unavailable"}


async def test_a_judged_level_and_the_dropped_labels_are_scored(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    prose = "Anna Berger hat 3 Freigaben. Laut OIB gilt das immer [4]."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    await _finalize(messages, judge=stub_judge("medium"))

    by_name = {score.name: score.value for score in written}
    assert by_name["confidence-judged-level"] == "medium"
    assert by_name["confidence-judge-unavailable"] == 0.0
    assert by_name["citations-dropped-labelled"] == 1.0


async def test_an_answer_that_grades_nothing_is_not_checked():
    calls: list = []
    messages = [HumanMessage("Hallo"), AIMessage("Guten Tag.")]

    final, state = await _finalize(messages, judge=stub_judge(calls=calls))

    assert calls == [] and final.confidence_check is None and state.answer_confidence is None


async def test_a_measurement_and_a_reading_reach_the_check_and_a_place_is_no_passage():
    registry = SourceRegistry()
    registry.add(_look_place_entry())
    messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

    evidence = await _evidence(messages, registry, measured_values=["2,70 m"])

    assert evidence.measurements == ["2,70 m"] and evidence.passages == []
    assert any("Gangbreite 1,10 m" in reading for reading in evidence.readings)


async def test_a_record_never_enters_the_source_registry():
    registry = SourceRegistry()
    prose = "Anna Berger hat 3 Freigaben."
    messages = [HumanMessage("Was liegt bei Anna?"), *_workspace_read(), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, registry)

    assert registry.all_sources() == []
    assert final.citation_grounded is False and state.verified_sources is None


async def test_a_locus_the_cited_passage_does_not_hold_is_labelled_in_the_answer():
    from aiq_agent.citations.entries import DROPPED_CITATION_MARKER
    from aiq_agent.citations.entries import SourceEntry

    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key="oib-rl_3.pdf, p.7",
            source_type="knowledge_layer",
            tool_name="knowledge_search",
            chunk_text="11.2.1 Die lichte Raumhöhe von Aufenthaltsräumen muss mindestens 2,50 m betragen.",
            clause="11.2.1",
        )
    )
    prose = (
        "Die Raumhöhe regelt Punkt 11.2.1 [1], die Belichtung Punkt 9.1 [1]."
        "\\n\\n**Quellen:**\\n- [1] oib-rl_3.pdf, p.7"
    )
    messages = [HumanMessage("Raumhöhe?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, _ = await _finalize(messages, registry)

    assert f"Punkt 11.2.1 [1], die Belichtung Punkt 9.1 {DROPPED_CITATION_MARKER}." in final.content


# --- a work turn (kind work, ADR-0123) under per-sentence provenance (ADR-0125) ---
#
# A work turn reports what it read and proposed in the office; it is not a legal
# answer. Its sentences are grounded by the records and proposals this turn left
# on the door, so it reaches the model's own level, and a sentence about the law
# inside it still needs a passage, exactly as in any other answer.

WORK_ENVELOPE = (
    '```answer_json\n{{"kind": "work", "confidence": {{"level": "high"}}, "answer": "{prose}", '
    '"work": {{"proposed": [{{"text": "Ordner Brandschutz anlegen"}}]}}}}\n```'
)
PROPOSED = (
    "Proposed — the person decides. Nothing was changed. "
    "Proposal 6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c: Create a folder in a project (name: Brandschutz)."
)


def _workspace_proposal(call_id: str = "w2") -> list:
    return [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": call_id,
                    "name": "workspace__call",
                    "args": {
                        "name": "project-folder-create",
                        "input": {"params": {"id": "p1"}, "body": {"name": "Brandschutz"}},
                    },
                }
            ],
        ),
        ToolMessage(content=PROPOSED, tool_call_id=call_id, name="workspace__call"),
    ]


# --- a reported proposal the turn did not file ---

FILED_ID = "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c"


async def test_a_reported_proposal_no_write_filed_is_dropped_and_scored(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    envelope = (
        '```answer_json\n{"kind": "work", "confidence": {"level": "high"}, '
        '"answer": "Den Ordner Brandschutz habe ich vorgeschlagen.", "work": {"proposed": ['
        f'{{"text": "Ordner Brandschutz anlegen", "ref": "{FILED_ID.upper()}"}},'
        '{"text": "Lea ins Projekt aufnehmen", "ref": "0b0b0b0b-0000-4000-8000-000000000000"},'
        '{"text": "Plan umbenennen"}], "next": [{"text": "Ordner freigeben", "who": "Anna"}]}}\n```'
    )
    messages = [HumanMessage("Leg einen Ordner Brandschutz an."), *_workspace_proposal(), AIMessage(envelope)]

    final, _ = await _finalize(messages)

    assert final.answer_meta["work"] == {
        "proposed": [{"text": "Ordner Brandschutz anlegen", "ref": FILED_ID.upper()}],
        "next": [{"text": "Ordner freigeben", "who": "Anna"}],
    }
    assert {score.name: score.value for score in written}["work-proposals-unfiled"] == 2.0


async def test_a_proposal_filed_last_turn_is_not_this_turns_report():
    envelope = (
        '```answer_json\n{"kind": "work", "confidence": {"level": "high"}, '
        '"answer": "Den Ordner habe ich vorgeschlagen.", "work": {"proposed": ['
        f'{{"text": "Ordner Brandschutz anlegen", "ref": "{FILED_ID}"}}]}}}}\n```'
    )
    messages = [
        HumanMessage("Leg einen Ordner an."),
        *_workspace_proposal(),
        AIMessage("Vorgeschlagen."),
        HumanMessage("Und jetzt?"),
        AIMessage(envelope),
    ]

    final, _ = await _finalize(messages)

    assert "work" not in (final.answer_meta or {})


def _hold_a_look(reading: str, name: str = "Grundriss_EG.pdf") -> None:
    from aiq_agent.tools.look.cards import note_look

    resolved = SimpleNamespace(file_name=name, collection="proj_1", target=None)
    note_look(resolved, 2, [0.1, 0.1, 0.3, 0.2], question="Türbreite?", reading=reading)


# --- a look at a project document registers a citable place (ADR-0125, amendment of 2026-10-22) ---


def _look_place_entry(region=(0.1, 0.2, 0.3, 0.4)):
    from aiq_agent.citations.extraction import extract_sources_from_tool_result
    from aiq_agent.tools.look.place import place_facts
    from aiq_agent.tools.look.place import render_place

    resolved = SimpleNamespace(file_name="Schnitt A-A.pdf", collection="proj_1", target=None)
    text = render_place(
        place_facts(resolved, 2, region, None), "Region of the page.", "Gelesen: Gangbreite 1,10 m (dimension, high)"
    )
    [entry] = extract_sources_from_tool_result("look", text)
    return entry


LOOK_PROSE = "Der Gang ist 1,10 m breit [1].\\n\\n**Quellen:**\\n- [1] Schnitt A-A.pdf, p.2"


async def test_a_place_is_a_citation_and_no_grounding_for_the_law():
    registry = SourceRegistry()
    registry.add(_look_place_entry())
    prose = (
        "Der Gang ist 1,10 m breit [1]. Der Fluchtweg muss nach § 5 der Bauordnung mindestens 1,20 m breit sein."
        "\\n\\n**Quellen:**\\n- [1] Schnitt A-A.pdf, p.2"
    )
    messages = [HumanMessage("Passt der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, registry)

    assert final.citation_grounded is False


async def test_the_look_scores_count_looks_and_say_whether_a_region_look_came_first(monkeypatch):
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry
    from aiq_agent.tools.look.cards import note_look

    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    registry = SourceRegistry()
    registry.add(_look_place_entry())
    token = set_card_registry(CardRegistry())
    try:
        resolved = SimpleNamespace(file_name="Schnitt A-A.pdf", collection="proj_1", target=None)
        note_look(resolved, 2, None, question="", reading="")
        note_look(resolved, 2, [0.1, 0.2, 0.3, 0.4], question="Breite?", reading="Gangbreite 1,10 m")
        messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

        await _finalize(messages, registry)
    finally:
        reset_card_registry(token)

    by_name = {score.name: score.value for score in written}
    assert by_name["look-count"] == 2.0 and by_name["looked-before-measurement"] == 1.0


async def test_an_overview_only_turn_that_states_a_drawing_value_scores_zero(monkeypatch):
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry
    from aiq_agent.tools.look.cards import note_look

    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    registry = SourceRegistry()
    registry.add(_look_place_entry(region=None))
    token = set_card_registry(CardRegistry())
    try:
        resolved = SimpleNamespace(file_name="Schnitt A-A.pdf", collection="proj_1", target=None)
        note_look(resolved, 2, None, question="Breite?", reading="Gangbreite 1,10 m")
        messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

        await _finalize(messages, registry)
    finally:
        reset_card_registry(token)

    by_name = {score.name: score.value for score in written}
    assert by_name["look-count"] == 1.0 and by_name["looked-before-measurement"] == 0.0


async def test_a_turn_with_no_drawing_value_writes_no_looked_before_measurement(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
    monkeypatch.setattr(answer_check, "emit_scores", lambda scores, **_: written.extend(scores))
    messages = [HumanMessage("Hallo"), AIMessage(ANSWER_ENVELOPE.format(prose="Guten Tag."))]

    await _finalize(messages)

    names = {score.name for score in written}
    assert "look-count" in names and "looked-before-measurement" not in names
