"""Per-sentence provenance (ADR-0125): each class from the evidence that earns it, and the ceilings."""

from __future__ import annotations

import pytest

from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import UNVERIFIED_QUOTE_MARKER
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import ceiling
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import class_counts
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import mark_load_bearing
from aiq_agent.common.claim_provenance import normative_uncited
from aiq_agent.common.claim_provenance import stamp_ceiling
from aiq_agent.common.claim_provenance import weakest_claim
from aiq_agent.common.workspace_records import listing_record
from aiq_agent.common.workspace_records import record_from_result

APPROVALS = record_from_result(
    "project-approvals-list",
    {},
    '{"items": ['
    '{"assignee": "Anna Berger", "status": "pending", "document": "Einreichplan EG"},'
    '{"assignee": "Anna Berger", "status": "pending", "document": "Schnitt A-A"},'
    '{"assignee": "Anna Berger", "status": "approved", "document": "Lageplan"}]}',
)
PROPOSAL = record_from_result(
    "project-member-add",
    {"name": "project-member-add", "input": {"body": {"email": "lea@buero.at", "role": "member"}}},
    "Proposed — the person decides. Nothing was changed.",
)
QUOTE = "Aufenthaltsräume müssen eine lichte Raumhöhe von mindestens 2,50 m aufweisen."


def _classes(prose: str, evidence: ClaimEvidence) -> list[tuple[str, str]]:
    return [
        (stamp.provenance, stamp.claim_type)
        for stamp in classify_claims(prose, evidence, normative=answer_mentions_normative_claim)
    ]


class TestEachClassFromItsEvidence:
    def test_a_resolved_marker_is_cited_and_an_unresolved_label_is_cited_dropped(self):
        prose = f"Die Raumhöhe muss 2,50 m betragen [1]. Laut § 5 ist das zulässig {DROPPED_CITATION_MARKER}."
        assert _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}))) == [
            ("cited", "normative"),
            ("cited_dropped", "normative"),
        ]

    def test_a_quote_line_the_server_stamped_verbatim_is_quoted(self):
        prose = f"> „{QUOTE}“ [1]"
        stamps = [{"text": QUOTE, "status": "verbatim"}]
        assert _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), quote_stamps=stamps)) == [
            ("quoted", "normative")
        ]

    def test_a_quote_line_no_passage_holds_is_only_cited(self):
        prose = f"> „{QUOTE}“ [1]"
        stamps = [{"text": QUOTE, "status": "not_found"}]
        assert _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), quote_stamps=stamps))[0][0] == "cited"

    def test_an_inline_quote_flagged_unverified_is_not_quoted(self):
        prose = f"Es heißt „{QUOTE}“ {UNVERIFIED_QUOTE_MARKER} [1]."
        assert _classes(prose, ClaimEvidence(cited_numbers=frozenset({1})))[0][0] == "cited"

    def test_a_sentence_read_off_a_workspace_record_is_record(self):
        prose = "Anna Berger hat drei Freigaben, davon 2 offen. Der Lageplan ist freigegeben."
        assert _classes(prose, ClaimEvidence(records=[APPROVALS])) == [("record", "value"), ("record", "descriptive")]

    def test_one_shared_word_is_not_a_record(self):
        prose = "Ich würde den Schnitt zuerst prüfen."
        assert _classes(prose, ClaimEvidence(records=[APPROVALS])) == [("model_knowledge", "descriptive")]

    def test_two_shared_words_in_different_rows_are_a_coincidence(self):
        tasks = record_from_result(
            "project-tasks-list",
            {},
            '{"items": [{"title": "Planung Tiefgarage", "status": "open"},'
            '{"title": "Fassade Nord", "status": "done"}]}',
        )
        prose = "Die Planung der Fassade sollte früh beginnen."
        assert _classes(prose, ClaimEvidence(records=[tasks]))[0][0] == "model_knowledge"
        # The same two words in one row are a sentence read off that row.
        prose = "Die Planung der Tiefgarage ist offen."
        assert _classes(prose, ClaimEvidence(records=[tasks]))[0][0] == "record"

    def test_piloti_s_own_earlier_answer_is_no_record(self):
        # An earlier answer read back through the workspace is model knowledge, not a server fact.
        history = record_from_result(
            "conversation-message-list",
            {},
            '[{"id": "m1", "role": "user", "content": "Zähl bitte nach."},'
            '{"id": "m2", "role": "assistant", "content": "Die Tiefgarage hat 42 Stellplätze im Untergeschoß."}]',
        )
        prose = "Die Tiefgarage hat 42 Stellplätze im Untergeschoß."
        assert _classes(prose, ClaimEvidence(records=[history])) == [("model_knowledge", "value")]
        # Capped, it cannot be split by author, so it is no record at all.
        capped = '[{"role": "assistant", "content": "Die Tiefgarage hat 42 Stellpl'
        assert record_from_result("conversation-message-list", {}, capped) is None

    def test_a_sentence_reporting_a_proposal_is_action(self):
        prose = "Ich habe vorgeschlagen, Lea als Mitglied aufzunehmen; bitte bestätigen."
        assert _classes(prose, ClaimEvidence(records=[PROPOSAL]))[0][0] == "action"

    def test_the_proposed_operation_is_not_read_as_a_prescription(self):
        # „aufzunehmen" is the zu-infinitive the normative detector reads as
        # „ist einzuhalten"; in an action report it names the operation.
        prose = "Ich habe vorgeschlagen, Lea als Mitglied aufzunehmen; bitte bestätigen."
        assert _classes(prose, ClaimEvidence(records=[PROPOSAL])) == [("action", "descriptive")]
        prose = "Ich habe vorgeschlagen, die Brüstung anzuheben, weil die OIB-RL 4 das verlangt."
        assert _classes(prose, ClaimEvidence(records=[PROPOSAL])) == [("action", "normative")]

    def test_the_name_a_proposal_was_filed_with_is_not_read_as_building_law(self):
        # A work turn (ADR-0123) names what it proposed: „den Ordner Brandschutz". The name is the
        # proposal's own data; the detector reads „Brandschutz" as law, so it is left out first.
        folder = record_from_result(
            "project-folder-create",
            {"name": "project-folder-create", "input": {"body": {"name": "Brandschutz"}}},
            "Proposed — the person decides. Nothing was changed.",
        )
        prose = "Den Ordner Brandschutz habe ich vorgeschlagen."
        assert _classes(prose, ClaimEvidence(records=[folder])) == [("action", "descriptive")]
        prose = "Den Ordner Brandschutz habe ich vorgeschlagen; das Konzept muss nach § 5 vorliegen."
        assert _classes(prose, ClaimEvidence(records=[folder]))[0] == ("action", "normative")

    @pytest.mark.parametrize(
        ("prose", "name"),
        [
            # „;" ends the action clause: the rule after it is read whole, „herzustellen" included.
            ("Vorgeschlagen: Ordner Stellplatz; pro Wohnung ist ein Stellplatz herzustellen.", "Stellplatz"),
            # The reason after „, weil" is a claim of its own.
            ("Ordner Stellplatz vorgeschlagen, weil pro Wohnung ein Stellplatz herzustellen ist.", "Stellplatz"),
            ("Ordner Brandschutz vorgeschlagen, da die Brandschutzplanung erforderlich ist.", "Brandschutz"),
            # „zulässigen" is no zu-infinitive, inside the action clause or out of it.
            ("Ich habe vorgeschlagen, die zulässigen Abstände einzutragen.", "Abstand"),
            ("Ich schlage vor, die zulässigen Höhen zu prüfen.", "Höhe"),
            # A name is removed as a whole word: „Bau" leaves „Bauordnung", „OIB" leaves „OIB-RL".
            ("Ich habe den Ordner Bau für die Bauordnung vorgeschlagen.", "Bau"),
            ("Ich habe den Ordner OIB für die OIB-RL 2 vorgeschlagen.", "OIB"),
        ],
    )
    def test_only_the_action_clause_loses_the_operation_and_its_names(self, prose, name):
        folder = record_from_result(
            "project-folder-create",
            {"name": "project-folder-create", "input": {"body": {"name": name}}},
            "Proposed — the person decides. Nothing was changed.",
        )
        assert _classes(prose, ClaimEvidence(records=[folder])) == [("action", "normative")]

    def test_a_colon_after_the_report_announces_what_was_proposed(self):
        folder = record_from_result(
            "project-folder-create",
            {"name": "project-folder-create", "input": {"body": {"name": "Brandschutz"}}},
            "Proposed — the person decides. Nothing was changed.",
        )
        assert _classes("Vorgeschlagen: Ordner Brandschutz.", ClaimEvidence(records=[folder])) == [
            ("action", "descriptive")
        ]

    def test_a_prescriptive_proposal_input_is_no_name_and_stays_in(self):
        note = record_from_result(
            "project-memory-create",
            {"name": "project-memory-create", "input": {"body": {"content": "Fluchtweg muss breit sein"}}},
            "Proposed — the person decides. Nothing was changed.",
        )
        prose = "Ich habe vorgeschlagen zu notieren: Fluchtweg muss breit sein."
        assert _classes(prose, ClaimEvidence(records=[note]))[-1][1] == "normative"

    def test_a_sentence_stating_a_measured_value_at_its_own_precision_is_measured(self):
        assert _classes("Der Keller ist 2,70 m hoch.", ClaimEvidence(measured_values=["2.703 m"])) == [
            ("measured", "value")
        ]

    def test_a_sentence_repeating_a_value_a_look_read_is_observed(self):
        evidence = ClaimEvidence(readings=("Gelesen: Tür 1,00 m, Brüstung 0,90 m",))
        assert _classes("Die Tür ist 1,00 m breit.", evidence) == [("observed", "value")]
        # At the precision the sentence writes it, like a measurement.
        assert _classes("Die Tür ist 1 m breit.", evidence) == [("observed", "value")]
        assert _classes("Die Tür ist 1,20 m breit.", evidence) == [("model_knowledge", "value")]

    def test_a_whole_number_a_reading_rounds_to_is_not_observed(self):
        # A reading is rounded text: „3" is not „2,70 m" read at a coarser precision.
        evidence = ClaimEvidence(readings=("Raumhöhe 2,70 m",))
        assert _classes("Das Gebäude hat 3 Geschosse. Die Frist beträgt 3 Wochen.", evidence) == [
            ("model_knowledge", "value"),
            ("model_knowledge", "value"),
        ]
        assert _classes("Die Raumhöhe beträgt 2,7 m.", evidence) == [("observed", "value")]
        assert _classes("Die Raumhöhe beträgt 2,70.", evidence) == [("observed", "value")]
        # A sheet number is not a count of storeys.
        assert _classes("Das Gebäude hat 3 Geschosse.", ClaimEvidence(readings=("Blatt 3, M 1:100",)))[0][0] == (
            "model_knowledge"
        )

    def test_a_code_a_look_read_is_observed_and_no_reading_means_no_class(self):
        evidence = ClaimEvidence(readings=("Wandaufbau EI30, Tür D1",))
        assert _classes("Die Wand ist EI30.", evidence)[0][0] == "observed"
        assert _classes("Die Wand ist EI30.", ClaimEvidence())[0][0] == "model_knowledge"

    def test_a_measurement_or_a_record_outranks_a_reading(self):
        evidence = ClaimEvidence(measured_values=["2.703 m"], readings=("Höhe 2,70 m",))
        assert _classes("Der Keller ist 2,70 m hoch.", evidence)[0][0] == "measured"

    def test_a_reading_never_grounds_a_normative_sentence(self):
        evidence = ClaimEvidence(readings=("Gelesen: Öffnung 1,20 m",))
        stamps = classify_claims(
            "Die Öffnung ist 1,20 m breit. Sie muss mindestens 1,20 m breit sein.",
            evidence,
            normative=answer_mentions_normative_claim,
        )
        assert [(stamp.provenance, stamp.claim_type) for stamp in stamps] == [
            ("observed", "value"),
            ("observed", "normative"),
        ]
        assert claims_ceiling(stamps) == "low"
        assert claims_ceiling(stamps[:1]) == "medium"

    def test_an_uncited_sentence_beside_a_cited_one_is_reasoning_and_alone_is_model_knowledge(self):
        prose = "Die Raumhöhe muss 2,50 m betragen [1]. Das betrifft auch das Dachgeschoß.\n\nIch würde früh planen."
        assert _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}))) == [
            ("cited", "normative"),
            ("reasoning", "descriptive"),
            ("model_knowledge", "descriptive"),
        ]

    def test_code_headings_and_table_headers_are_not_claims(self):
        prose = "## Ergebnis\n\n```\nmuss 3 m\n```\n\n| Raum | Höhe |\n|---|---|\n| Keller | 2,70 m |"
        stamps = classify_claims(prose, ClaimEvidence(), normative=answer_mentions_normative_claim)
        assert [stamp.text for stamp in stamps] == ["Keller · 2,70 m"]

    def test_an_abbreviation_does_not_end_a_sentence(self):
        prose = "Gemäß § 5 Abs. 2 gilt das, vgl. Punkt 3.2 [1]. Zweiter Satz."
        stamps = classify_claims(prose, ClaimEvidence(cited_numbers=frozenset({1})), normative=lambda _: False)
        assert len(stamps) == 2


class TestARecordSentenceIsChecked:
    def test_a_number_no_record_holds_is_named(self):
        stamps = classify_claims(
            "Anna Berger hat 7 offene Freigaben.",
            ClaimEvidence(records=[APPROVALS]),
            normative=answer_mentions_normative_claim,
        )
        assert stamps[0].provenance == "record" and stamps[0].unmatched == ("7",)
        assert claims_ceiling(stamps) == "medium"

    def test_a_count_the_record_implies_is_held(self):
        stamps = classify_claims(
            "Anna Berger hat 3 Freigaben.", ClaimEvidence(records=[APPROVALS]), normative=lambda _: False
        )
        assert stamps[0].unmatched == ()


class TestTheCeilings:
    @pytest.mark.parametrize(
        ("provenance", "ctype", "level"),
        [
            ("quoted", "normative", "high"),
            ("cited", "value", "high"),
            ("record", "value", "high"),
            ("action", "descriptive", "high"),
            ("measured", "value", "high"),
            # A record, an action or a measurement never grounds the law.
            ("record", "normative", "low"),
            ("action", "normative", "low"),
            ("measured", "normative", "low"),
            # A reading is a model's perception: capped at medium, never the law.
            ("observed", "descriptive", "medium"),
            ("observed", "value", "medium"),
            ("observed", "normative", "low"),
            ("reasoning", "descriptive", "medium"),
            ("reasoning", "normative", "low"),
            # Low while no cited or observed sentence of the answer states the value; with one, medium
            # (test_claim_provenance_looks.py). An estimate or a reported absence is medium too (`hedged`).
            ("reasoning", "value", "low"),
            ("model_knowledge", "descriptive", "medium"),
            ("model_knowledge", "value", "low"),
            ("model_knowledge", "normative", "low"),
            ("cited_dropped", "descriptive", "low"),
        ],
    )
    def test_each_class_and_type(self, provenance, ctype, level):
        assert ceiling(provenance, ctype) == level

    def test_the_answer_is_held_to_its_weakest_load_bearing_sentence(self):
        stamps = mark_load_bearing(
            [
                ClaimStamp("Die Höhe muss 2,50 m sein [1].", "cited", "normative"),
                ClaimStamp("Das gilt für das ganze Haus.", "model_knowledge", "descriptive"),
                ClaimStamp("Die Frist beträgt 14 Tage.", "model_knowledge", "value"),
            ]
        )
        assert [stamp.load_bearing for stamp in stamps] == [True, False, True]
        assert claims_ceiling(stamps) == "low"
        assert (weakest_claim(stamps).provenance, weakest_claim(stamps).claim_type) == ("model_knowledge", "value")

    def test_a_purely_descriptive_answer_bears_on_every_sentence(self):
        stamps = mark_load_bearing(
            [
                ClaimStamp("Anna leitet das Projekt.", "record", "descriptive"),
                ClaimStamp("Sie ist diese Woche im Büro.", "model_knowledge", "descriptive"),
            ]
        )
        assert all(stamp.load_bearing for stamp in stamps)
        assert claims_ceiling(stamps) == "medium"

    def test_an_answer_with_no_sentence_is_floored_not_left_unchecked(self):
        # Rule 1's intent (ADR-0125): nothing behind the answer, so the self-report cannot stand.
        assert claims_ceiling([]) == "low" and weakest_claim([]) is None
        stamps = classify_claims(
            "## Ergebnis\n\n[[card:1]]", ClaimEvidence(), normative=answer_mentions_normative_claim
        )
        assert stamps == [] and claims_ceiling(stamps) == "low"


def test_counts_and_the_normative_tally():
    stamps = [
        ClaimStamp("a", "cited", "normative"),
        ClaimStamp("b", "model_knowledge", "normative"),
        ClaimStamp("c", "record", "descriptive"),
    ]
    assert class_counts(stamps) == {"cited": 1, "record": 1, "model_knowledge": 1}
    assert normative_uncited(stamps) == 1


class TestAListingGroundsWhatItStates:
    """ADR-0125, amendment of 2026-10-22: a list_files result is a record, never a citation."""

    LISTING = listing_record(
        "Einreichung/  6 documents (all here; 2 older Fassungen)\n  Current: Einreichplan EG Index B (2026-09-30)\n"
    )

    def test_a_count_in_the_listing_is_a_record_and_reaches_high(self):
        stamps = classify_claims(
            "Einreichung: 6 Dokumente, aktuell Index B.",
            ClaimEvidence(records=[self.LISTING]),
            normative=answer_mentions_normative_claim,
        )
        assert [(s.provenance, s.claim_type, s.operation) for s in stamps] == [("record", "value", "list_files")]
        assert stamp_ceiling(stamps[0]) == "high"

    def test_a_count_the_listing_lacks_stays_capped(self):
        prose = "Im Ordner Wohnbau liegen 9 Dokumente."
        (stamp,) = classify_claims(
            prose, ClaimEvidence(records=[self.LISTING]), normative=answer_mentions_normative_claim
        )
        assert stamp.provenance == "model_knowledge" and stamp_ceiling(stamp) == "low"

    def test_a_listing_count_beside_a_stranger_number_is_medium(self):
        (stamp,) = classify_claims(
            "Einreichung: 6 Dokumente und 31 Pläne.",
            ClaimEvidence(records=[self.LISTING]),
            normative=answer_mentions_normative_claim,
        )
        assert stamp.provenance == "record" and stamp_ceiling(stamp) == "medium"

    def test_a_listing_never_grounds_the_law(self):
        (stamp,) = classify_claims(
            "Die Einreichung muss nach § 5 mindestens 6 Dokumente enthalten.",
            ClaimEvidence(records=[self.LISTING]),
            normative=answer_mentions_normative_claim,
        )
        assert stamp_ceiling(stamp) == "low"
