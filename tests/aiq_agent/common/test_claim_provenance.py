"""Per-sentence provenance (ADR-0125): each class from the evidence that earns it, and the level (ADR-0139)."""

from __future__ import annotations

from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import UNVERIFIED_QUOTE_MARKER
from aiq_agent.common.claim_judge import Judgement
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import class_counts
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import normative_uncited
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import weakest_claim
from aiq_agent.common.claim_provenance import with_judgements
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
SUPPORTED_FACT = Judgement("supported", "fact")
SUPPORTED_VERDICT = Judgement("supported", "verdict")


def _stamps(prose: str, evidence: ClaimEvidence) -> list[ClaimStamp]:
    return classify_claims(prose, evidence, normative=answer_mentions_normative_claim)


def _classes(prose: str, evidence: ClaimEvidence) -> list[tuple[str, str]]:
    return [(stamp.provenance, stamp.claim_type) for stamp in _stamps(prose, evidence)]


class TestEachClassFromItsEvidence:
    def test_a_resolved_marker_is_cited_and_an_unresolved_label_is_a_flag_not_a_class(self):
        """ADR-0139: a pointer that did not hold is named on the chip; the class is what is left without it."""
        prose = f"Die Raumhöhe muss 2,50 m betragen [1]. Laut § 5 ist das zulässig {DROPPED_CITATION_MARKER}."
        stamps = _stamps(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE}))
        assert [(stamp.provenance, stamp.claim_type, stamp.dropped) for stamp in stamps] == [
            ("cited", "normative", False),
            ("reasoning", "normative", True),
        ]
        assert stamps[0].evidence == QUOTE and stamps[1].evidence == QUOTE
        assert support(with_judgements(stamps, [SUPPORTED_VERDICT, SUPPORTED_VERDICT])[1]) == 0.5

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

    def test_a_sentence_read_off_a_workspace_record_is_record_held_to_its_item(self):
        prose = "Anna Berger hat drei Freigaben, davon 2 offen. Der Lageplan ist freigegeben."
        stamps = _stamps(prose, ClaimEvidence(records=[APPROVALS]))
        assert [(stamp.provenance, stamp.claim_type) for stamp in stamps] == [
            ("record", "value"),
            ("record", "descriptive"),
        ]
        assert "lageplan" in stamps[1].evidence and "schnitt" not in stamps[1].evidence

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

    def test_a_sentence_reporting_a_proposal_is_action_held_to_the_proposal(self):
        prose = "Ich habe vorgeschlagen, Lea als Mitglied aufzunehmen; bitte bestätigen."
        [stamp] = _stamps(prose, ClaimEvidence(records=[PROPOSAL]))
        assert stamp.provenance == "action" and "lea@buero.at" in stamp.evidence

    def test_a_sentence_stating_a_measured_value_at_its_own_precision_is_measured(self):
        stamps = _stamps("Der Keller ist 2,70 m hoch.", ClaimEvidence(measured_values=["2.703 m"]))
        assert [(stamp.provenance, stamp.evidence) for stamp in stamps] == [("measured", "2.703 m")]

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

    def test_an_uncited_sentence_beside_a_cited_one_is_reasoning_held_to_the_paragraphs_passage(self):
        prose = "Die Raumhöhe muss 2,50 m betragen [1]. Das betrifft auch das Dachgeschoß.\n\nIch würde früh planen."
        stamps = _stamps(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE}))
        assert [(stamp.provenance, stamp.evidence) for stamp in stamps] == [
            ("cited", QUOTE),
            ("reasoning", QUOTE),
            ("model_knowledge", ""),
        ]

    def test_code_headings_and_table_headers_are_not_claims(self):
        prose = "## Ergebnis\n\n```\nmuss 3 m\n```\n\n| Raum | Höhe |\n|---|---|\n| Keller | 2,70 m |"
        assert [stamp.text for stamp in _stamps(prose, ClaimEvidence())] == ["Keller · 2,70 m"]

    def test_an_abbreviation_does_not_end_a_sentence(self):
        prose = "Gemäß § 5 Abs. 2 gilt das, vgl. Punkt 3.2 [1]. Zweiter Satz."
        stamps = classify_claims(prose, ClaimEvidence(cited_numbers=frozenset({1})), normative=lambda _: False)
        assert len(stamps) == 2


class TestTheLevel:
    """Rule 3 (ADR-0139): what the judge found, held to the deterministic rules."""

    def test_every_claim_supported_reads_high_and_one_not_addressed_medium(self):
        stamps = _stamps(
            "Die Raumhöhe muss 2,50 m betragen [1]. Die Frist beträgt 14 Tage [1].",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE}),
        )
        assert claims_ceiling(with_judgements(stamps, [SUPPORTED_VERDICT, SUPPORTED_FACT])) == "high"
        judged = with_judgements(stamps, [SUPPORTED_VERDICT, Judgement("not_addressed", "fact")])
        assert claims_ceiling(judged) == "medium"
        assert weakest_claim(judged).text.startswith("Die Frist")

    def test_a_contradicted_verdict_reads_low_whatever_else_is_supported(self):
        stamps = _stamps(
            "Die Raumhöhe muss 2,50 m betragen [1]. Wendeltreppen sind zulässig [1].",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE + " Unzulässig sind Wendeltreppen."}),
        )
        judged = with_judgements(stamps, [SUPPORTED_VERDICT, Judgement("contradicted", "verdict")])
        assert claims_ceiling(judged) == "low"
        assert weakest_claim(judged) is judged[1] and normative_uncited(judged) == 1

    def test_nothing_supported_reads_low(self):
        stamps = _stamps("Die Frist beträgt 14 Tage. Die Gebühr beträgt 300 Euro.", ClaimEvidence())
        assert claims_ceiling(with_judgements(stamps, [SUPPORTED_FACT, SUPPORTED_FACT])) == "low"

    def test_next_steps_and_assessments_bear_no_load(self):
        stamps = _stamps(
            "Die Raumhöhe muss 2,50 m betragen [1]. Ob das Dachgeschoß betroffen ist, muss geprüft werden. "
            "Vermutlich ist das ein Altbestand.",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE}),
        )
        judged = with_judgements(
            stamps,
            [SUPPORTED_VERDICT, Judgement("not_addressed", "next_step"), Judgement("not_addressed", "assessment")],
        )
        assert [stamp.load_bearing for stamp in judged] == [True, False, False]
        assert claims_ceiling(judged) == "high"

    def test_a_record_a_measurement_or_a_reading_never_grounds_a_verdict(self):
        """The anti-laundering rule: whatever the judge says, only a passage grounds the law."""
        for prose, evidence in (
            ("Die Einreichung muss nach § 5 mindestens 6 Dokumente enthalten.", ClaimEvidence(records=[LISTING])),
            ("Der Keller muss 2,70 m hoch sein.", ClaimEvidence(measured_values=["2.703 m"])),
            ("Die Öffnung muss 1,20 m breit sein.", ClaimEvidence(readings=("Gelesen: Öffnung 1,20 m",))),
        ):
            [stamp] = with_judgements(_stamps(prose, evidence), [SUPPORTED_VERDICT])
            assert stamp.provenance in ("record", "measured", "observed") and support(stamp) == 0.0
            assert claims_ceiling([stamp]) == "low"

    def test_without_the_judge_an_evidenced_answer_reads_medium_and_says_so(self):
        stamps = with_judgements(
            _stamps(
                "Die Raumhöhe muss 2,50 m betragen [1].",
                ClaimEvidence(cited_numbers=frozenset({1}), passages={1: QUOTE}),
            ),
            None,
        )
        assert stamps[0].judged == "unavailable" and stamps[0].to_wire()["judged"] == "unavailable"
        assert support(stamps[0]) == 0.5 and claims_ceiling(stamps) == "medium"

    def test_without_the_judge_an_answer_with_no_evidence_still_reads_low(self):
        stamps = with_judgements(_stamps("Die Frist beträgt 14 Tage.", ClaimEvidence()), None)
        assert stamps[0].judged is None and claims_ceiling(stamps) == "low"

    def test_an_answer_with_no_sentence_is_floored_not_left_unchecked(self):
        # Rule 1's intent (ADR-0125): nothing behind the answer, so the self-report cannot stand.
        assert claims_ceiling([]) == "low" and weakest_claim([]) is None
        stamps = _stamps("## Ergebnis\n\n[[card:1]]", ClaimEvidence())
        assert stamps == [] and claims_ceiling(stamps) == "low"


def test_class_counts():
    stamps = [
        ClaimStamp("a", "cited", "normative"),
        ClaimStamp("b", "model_knowledge", "normative"),
        ClaimStamp("c", "record", "descriptive"),
        ClaimStamp("d", "model_knowledge", "normative"),
    ]
    assert class_counts(stamps) == {"cited": 1, "record": 1, "model_knowledge": 2}


LISTING = listing_record(
    "Einreichung/  6 documents (all here; 2 older Fassungen)\n  Current: Einreichplan EG Index B (2026-09-30)\n"
)


class TestAListingGroundsWhatItStates:
    """ADR-0125, amendment of 2026-10-22: a list_files result is a record, never a citation."""

    def test_a_count_in_the_listing_is_a_record_and_reaches_high(self):
        stamps = _stamps("Einreichung: 6 Dokumente, aktuell Index B.", ClaimEvidence(records=[LISTING]))
        assert [(s.provenance, s.claim_type, s.operation) for s in stamps] == [("record", "value", "list_files")]
        assert claims_ceiling(with_judgements(stamps, [SUPPORTED_FACT])) == "high"

    def test_a_count_the_listing_lacks_has_no_evidence(self):
        [stamp] = _stamps("Im Ordner Wohnbau liegen 9 Dokumente.", ClaimEvidence(records=[LISTING]))
        assert stamp.provenance == "model_knowledge" and stamp.evidence == ""
        assert support(with_judgements([stamp], [SUPPORTED_FACT])[0]) == 0.0

    def test_a_listing_count_beside_a_stranger_number_counts_half_at_most(self):
        [stamp] = _stamps("Einreichung: 6 Dokumente und 31 Pläne.", ClaimEvidence(records=[LISTING]))
        assert stamp.provenance == "record" and stamp.unmatched == ("31",)
        assert support(with_judgements([stamp], [SUPPORTED_FACT])[0]) == 0.5
