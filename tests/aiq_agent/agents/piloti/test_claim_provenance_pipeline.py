"""The joins of ADR-0125: every answer stamped, records grounding through their own channel, scores written.

The parts are tested in ``tests/aiq_agent/common``; these go through
``finalize_answer`` and the state, where a part nobody calls would show.
"""

from __future__ import annotations

from types import SimpleNamespace

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


async def test_a_locus_the_cited_passage_does_not_hold_is_labelled_in_the_answer():
    from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
    from aiq_agent.common.citation_verification import SourceEntry

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


async def test_a_work_turn_is_grounded_by_what_it_read_and_proposed():
    prose = (
        "Anna Berger hat 3 Freigaben, davon 2 offen. Den Ordner Brandschutz habe ich vorgeschlagen; er wartet auf Sie."
    )
    messages = [
        HumanMessage("Was liegt bei Anna, und leg einen Ordner Brandschutz an."),
        *_workspace_read(),
        *_workspace_proposal(),
        AIMessage(WORK_ENVELOPE.format(prose=prose)),
    ]

    final, state = await _finalize(messages)

    assert [(stamp["provenance"], stamp["operation"]) for stamp in final.claim_stamps] == [
        ("record", "project-approvals-list"),
        ("action", "project-folder-create"),
    ]
    assert state.answer_confidence == "high" and state.answer_confidence_version == 2


async def test_a_work_turn_still_floors_on_a_legal_sentence_without_a_passage():
    prose = "Den Ordner Brandschutz habe ich vorgeschlagen. Das Brandschutzkonzept muss nach § 5 vorgelegt werden."
    messages = [
        HumanMessage("Leg einen Ordner Brandschutz an."),
        *_workspace_proposal(),
        AIMessage(WORK_ENVELOPE.format(prose=prose)),
    ]

    _, state = await _finalize(messages)

    assert state.answer_confidence == "low"
    assert state.answer_confidence_capped_reason == "normative_claim_uncited"


# --- a reported proposal the turn did not file ---

FILED_ID = "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c"


async def test_a_reported_proposal_no_write_filed_is_dropped_and_scored(monkeypatch):
    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
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


async def test_an_answer_with_no_sentence_is_floored_not_left_at_its_self_report():
    messages = [HumanMessage("Zeig mir das."), AIMessage(ANSWER_ENVELOPE.format(prose="## Ergebnis"))]

    final, state = await _finalize(messages)

    assert final.claim_stamps == () and final.claims_ceiling == "low"
    assert state.answer_confidence == "low" and state.answer_confidence_capped_reason == "ungrounded"


def _hold_a_look(reading: str, name: str = "Grundriss_EG.pdf") -> None:
    from aiq_agent.tools.look.cards import note_look

    resolved = SimpleNamespace(file_name=name, collection="proj_1", target=None)
    note_look(resolved, 2, [0.1, 0.1, 0.3, 0.2], question="Türbreite?", reading=reading)


async def test_a_value_taken_from_a_look_is_observed_and_held_at_medium():
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    token = set_card_registry(CardRegistry())
    try:
        _hold_a_look("Gelesen: Tür 1,00 m breit")
        prose = "Die Tür im EG ist 1,00 m breit."
        messages = [HumanMessage("Wie breit ist die Tür?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

        final, state = await _finalize(messages)
    finally:
        reset_card_registry(token)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["observed"]
    assert state.answer_confidence == "medium"


async def test_a_reading_beside_a_legal_statement_does_not_ground_it():
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    token = set_card_registry(CardRegistry())
    try:
        _hold_a_look("Gelesen: Fluchtweg 1,20 m")
        prose = "Der Fluchtweg ist 1,20 m breit. Das genügt nach § 5 der Bauordnung."
        messages = [HumanMessage("Passt der Fluchtweg?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

        final, state = await _finalize(messages)
    finally:
        reset_card_registry(token)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["observed", "model_knowledge"]
    assert state.answer_confidence == "low"


async def test_a_value_with_no_look_behind_it_is_not_observed():
    prose = "Die Tür im EG ist 1,00 m breit."
    messages = [HumanMessage("Wie breit ist die Tür?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, _ = await _finalize(messages)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["model_knowledge"]


# --- a look at a project document registers a citable place (ADR-0125, amendment of 2026-10-22) ---


def _look_place_entry(region=(0.1, 0.2, 0.3, 0.4)):
    from aiq_agent.common.citation_verification import extract_sources_from_tool_result
    from aiq_agent.tools.look.place import place_facts
    from aiq_agent.tools.look.place import render_place

    resolved = SimpleNamespace(file_name="Schnitt A-A.pdf", collection="proj_1", target=None)
    text = render_place(
        place_facts(resolved, 2, region, None), "Region of the page.", "Gelesen: Gangbreite 1,10 m (dimension, high)"
    )
    [entry] = extract_sources_from_tool_result("look", text)
    return entry


LOOK_PROSE = "Der Gang ist 1,10 m breit [1].\\n\\n**Quellen:**\\n- [1] Schnitt A-A.pdf, p.2"


async def test_a_value_citing_a_region_look_is_observed_and_reaches_high():
    registry = SourceRegistry()
    registry.add(_look_place_entry())
    messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

    final, state = await _finalize(messages, registry)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["observed"]
    assert state.answer_confidence == "high"
    assert [source.entry.citation_key for source in final.cited] == ["Schnitt A-A.pdf, p.2"]


async def test_the_same_citation_of_an_overview_is_medium():
    registry = SourceRegistry()
    registry.add(_look_place_entry(region=None))
    messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

    final, state = await _finalize(messages, registry)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["observed"]
    assert state.answer_confidence == "medium"


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
    assert final.normative_claim_uncited is True
    assert state.answer_confidence == "low"


async def test_a_place_cited_for_a_legal_sentence_is_refused_the_law():
    registry = SourceRegistry()
    registry.add(_look_place_entry())
    prose = (
        "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [1].\\n\\n**Quellen:**\\n- [1] Schnitt A-A.pdf, p.2"
    )
    messages = [HumanMessage("Passt der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages, registry)

    assert [(stamp["provenance"], stamp["claim_type"]) for stamp in final.claim_stamps] == [("observed", "normative")]
    assert state.answer_confidence == "low"


async def test_the_look_scores_count_looks_and_say_whether_a_region_look_came_first(monkeypatch):
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry
    from aiq_agent.tools.look.cards import note_look

    written: list = []
    monkeypatch.setattr(answer_pipeline, "emit_scores", lambda scores, **_: written.extend(scores))
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
    messages = [HumanMessage("Hallo"), AIMessage(ANSWER_ENVELOPE.format(prose="Guten Tag."))]

    await _finalize(messages)

    names = {score.name for score in written}
    assert "look-count" in names and "looked-before-measurement" not in names


async def test_honest_absence_in_an_answer_is_medium_and_not_an_uncited_legal_claim():
    prose = "Für den Gang ja; der Abstand zum Treppenhaus ist in keinem Dokument nachgewiesen."
    messages = [HumanMessage("Reicht der Fluchtweg?"), AIMessage(ANSWER_ENVELOPE.format(prose=prose))]

    final, state = await _finalize(messages)

    assert final.claims_ceiling == "medium"
    assert state.answer_confidence == "medium"


async def test_a_look_on_a_page_with_a_retrieved_caption_does_not_borrow_the_captions_authority():
    from aiq_agent.common.citation_verification import SourceEntry

    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key="Schnitt A-A.pdf, p.2",
            collection="proj_1",
            source_type="knowledge_layer",
            tool_name="knowledge_search",
            chunk_text="Schnitt A-A, Massstab 1:50, Legende.",
        )
    )
    registry.add(_look_place_entry(region=None))  # an overview: medium, where a caption would have said high
    messages = [HumanMessage("Wie breit ist der Gang?"), AIMessage(ANSWER_ENVELOPE.format(prose=LOOK_PROSE))]

    final, state = await _finalize(messages, registry)

    assert [stamp["provenance"] for stamp in final.claim_stamps] == ["observed"]
    assert state.answer_confidence == "medium"


async def test_a_listing_backed_count_is_record_grounded_and_not_registered_as_a_source():
    listing = "Einreichung/  6 documents (all here)\n  Current: Einreichplan EG Index B (2026-09-30)\n"
    messages = [
        HumanMessage("Was liegt in der Einreichung?"),
        AIMessage(content="", tool_calls=[{"id": "l1", "name": "list_files", "args": {"view": "tree"}}]),
        ToolMessage(content=listing, tool_call_id="l1", name="list_files"),
        AIMessage(ANSWER_ENVELOPE.format(prose="Einreichung: 6 Dokumente, aktuell Index B.")),
    ]
    registry = SourceRegistry()

    final, state = await _finalize(messages, registry)

    assert [(s["provenance"], s["operation"]) for s in final.claim_stamps] == [("record", "list_files")]
    assert state.answer_confidence == "high"
