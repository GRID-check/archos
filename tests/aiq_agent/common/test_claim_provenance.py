"""Per-sentence provenance (ADR-0122): each class from the evidence that earns it, and the ceilings."""

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
from aiq_agent.common.claim_provenance import weakest_claim
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

    def test_a_sentence_stating_a_measured_value_at_its_own_precision_is_measured(self):
        assert _classes("Der Keller ist 2,70 m hoch.", ClaimEvidence(measured_values=["2.703 m"])) == [
            ("measured", "value")
        ]

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
            ("reasoning", "descriptive", "medium"),
            ("reasoning", "normative", "low"),
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

    def test_an_answer_with_no_sentence_has_no_ceiling(self):
        assert claims_ceiling([]) is None and weakest_claim([]) is None


def test_counts_and_the_normative_tally():
    stamps = [
        ClaimStamp("a", "cited", "normative"),
        ClaimStamp("b", "model_knowledge", "normative"),
        ClaimStamp("c", "record", "descriptive"),
    ]
    assert class_counts(stamps) == {"cited": 1, "record": 1, "model_knowledge": 1}
    assert normative_uncited(stamps) == 1
