"""A place a look read is citable (ADR-0125, amendment of 2026-10-22): its class, its ceiling, and the hedges."""

from __future__ import annotations

import pytest

from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import LookPlace
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import is_hedged
from aiq_agent.common.claim_provenance import normative_uncited
from aiq_agent.common.claim_provenance import stamp_ceiling

READ = "Gelesen: Gangbreite 1,10 m (dimension, high)"


def _stamps(prose: str, **evidence):
    return classify_claims(prose, ClaimEvidence(**evidence), normative=answer_mentions_normative_claim)


def _one(prose: str, **evidence):
    [stamp] = _stamps(prose, **evidence)
    return stamp


class TestACitedPlaceIsObserved:
    def test_a_region_crop_and_the_exact_reading_reach_high(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", looks={2: LookPlace(READ, crop=True)})

        assert (stamp.provenance, stamp.claim_type, stamp.exact) == ("observed", "value", True)
        assert stamp_ceiling(stamp) == "high"

    def test_an_overview_is_medium_even_with_the_exact_reading(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", looks={2: LookPlace(READ, crop=False)})

        assert stamp.provenance == "observed" and stamp_ceiling(stamp) == "medium"

    def test_a_crop_without_the_exact_value_is_medium(self):
        stamp = _one("Der Gang ist 1,20 m breit [2].", looks={2: LookPlace(READ, crop=True)})

        assert stamp.provenance == "observed" and stamp_ceiling(stamp) == "medium"

    def test_a_place_never_grounds_a_claim_about_the_law(self):
        stamp = _one(
            "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [2].", looks={2: LookPlace(READ, crop=True)}
        )

        assert (stamp.provenance, stamp.claim_type) == ("observed", "normative")
        assert stamp_ceiling(stamp) == "low"

    def test_a_place_is_not_a_passage_so_it_does_not_count_as_cited(self):
        stamps = _stamps(
            "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [2].", looks={2: LookPlace(READ, crop=True)}
        )

        assert normative_uncited(stamps) == 1


CAPTION = "Schnitt A-A, Massstab 1:50, Gangbreite laut Legende 1,20 m."


class TestAMergedEntryIsClassedByWhereTheValueAppears:
    """A look on a page that also holds a retrieved caption merges into that entry (same file and page)."""

    @staticmethod
    def _merged(crop: bool = True) -> dict[int, LookPlace]:
        return {2: LookPlace(READ, crop=crop, place_only=False, passage=CAPTION)}

    def test_a_value_in_the_retrieved_passage_is_cited_as_today(self):
        stamp = _one("Die Legende nennt 1,20 m [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert stamp.provenance == "cited" and stamp_ceiling(stamp) == "high"

    def test_a_value_only_in_the_reading_is_observed_and_never_borrows_the_captions_authority(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert (stamp.provenance, stamp.exact) == ("observed", True)
        assert stamp_ceiling(stamp) == "high"  # a region crop and the exact reading, as for a place only

    def test_the_same_value_from_an_overview_is_medium(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged(crop=False))

        assert stamp.provenance == "observed" and stamp_ceiling(stamp) == "medium"

    def test_a_value_only_in_the_reading_stays_off_the_law(self):
        prose = "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [2]."
        stamp = _one(prose, cited_numbers=frozenset({2}), looks=self._merged())

        assert (stamp.provenance, stamp.claim_type) == ("observed", "normative")
        assert stamp_ceiling(stamp) == "low"

    def test_a_value_in_neither_is_an_unsupported_value(self):
        stamp = _one("Der Gang ist 1,35 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert (stamp.provenance, stamp.claim_type) == ("model_knowledge", "value")
        assert stamp_ceiling(stamp) == "low"

    def test_a_sentence_stating_no_value_is_cited_as_today(self):
        stamp = _one("Der Schnitt zeigt den Gang [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert stamp.provenance == "cited"

    def test_a_sentence_that_also_cites_a_plain_passage_keeps_its_pointer(self):
        stamp = _one("Der Gang ist 1,10 m breit [2][1].", cited_numbers=frozenset({1, 2}), looks=self._merged())

        assert stamp.provenance == "cited"


class TestTheWeakerOfTwoPointersWins:
    def test_a_looked_value_compared_with_a_cited_norm_takes_the_places_level(self):
        prose = "Der Gang misst 1,10 m [2] und unterschreitet die geforderten 1,20 m [1]."
        stamp = _one(prose, cited_numbers=frozenset({1}), looks={2: LookPlace("Gelesen: Gang 1,05 m", crop=True)})

        assert stamp.provenance == "cited" and stamp.cap == "medium"
        assert stamp_ceiling(stamp) == "medium"

    def test_the_cited_norm_alone_stays_high(self):
        stamp = _one("Gefordert sind 1,20 m [1].", cited_numbers=frozenset({1}))

        assert stamp_ceiling(stamp) == "high"

    def test_an_exact_crop_beside_a_norm_does_not_lower_the_norm(self):
        prose = "Der Gang misst 1,10 m [2] und die Richtlinie fordert 1,20 m [1]."
        stamp = _one(prose, cited_numbers=frozenset({1}), looks={2: LookPlace(READ, crop=True)})

        assert stamp_ceiling(stamp) == "high"

    def test_a_cited_sentence_repeating_a_reading_without_its_marker_is_held_to_medium(self):
        stamp = _one("Der Gang misst 1,10 m, verlangt sind 1,20 m [1].", cited_numbers=frozenset({1}), readings=(READ,))

        assert stamp.provenance == "cited" and stamp_ceiling(stamp) == "medium"


# The exemplar sentences of docs/architecture/north-star-answers.md.
ABSENCE = [
    "Für den Gang ja; der Abstand zum Treppenhaus ist in keinem Dokument nachgewiesen.",
    "Für den Gang ja; für den ganzen Weg ist es nicht nachgewiesen.",
    "Nachweisen kann ich es nicht: In den Unterlagen gibt es keinen Grundriss des 3. OG.",
    "Das Fluchtniveau, an dem die Einstufung hängt, steht in keinem Dokument des Projekts.",
    "Aus den Unterlagen lässt sich GK 4 weder bestätigen noch widerlegen.",
    "I cannot confirm the escape distance; no document states it.",
]
ESTIMATE = [
    "Nach meiner Einschätzung bleibt mit 28 m für den Weg in der Wohnung reichlich Spielraum.",
    "Überschlägig liegt es knapp darüber, das wären 11,25 m über dem Gehsteig.",
    "The distance is roughly estimated at 28 m.",
]


class TestHonestAbsenceAndEstimatesAreNotFalseClaims:
    @pytest.mark.parametrize("sentence", [*ABSENCE, *ESTIMATE])
    def test_the_matcher_reads_the_exemplar_sentences(self, sentence):
        assert is_hedged(sentence)

    @pytest.mark.parametrize(
        "sentence",
        [
            "Die Fluchtweglänge beträgt höchstens 40 m.",
            "Das Konzept gibt im 3. OG höchstens 12 m an [1].",
            "Der Nachweis ist erbracht.",
        ],
    )
    def test_a_plain_claim_is_not_hedged(self, sentence):
        assert not is_hedged(sentence)

    @pytest.mark.parametrize("sentence", [*ABSENCE, *ESTIMATE])
    def test_a_hedged_absence_caps_at_medium_and_a_hedged_verdict_counts_nothing(self, sentence):
        """A hedge is honest uncertainty, not a source (ADR-0139): a verdict it hedges is still an uncited claim."""
        stamps = _stamps(sentence)

        if stamps[0].is_verdict:
            assert claims_ceiling(stamps) == "low"
            assert normative_uncited(stamps) == 1
        else:
            assert claims_ceiling(stamps) == "medium"
            assert normative_uncited(stamps) == 0

    def test_a_hedged_verdict_counts_nothing(self):
        stamps = _stamps("Nach meiner Einschätzung ist die Anforderung an die Raumhöhe damit erfüllt.")

        assert stamps[0].is_verdict and stamps[0].hedged
        assert claims_ceiling(stamps) == "low"

    def test_the_same_sentence_without_the_hedge_is_still_low_and_uncited(self):
        stamps = _stamps("Der Abstand zum Treppenhaus beträgt 28 m.")

        assert claims_ceiling(stamps) == "low"

    def test_a_dropped_pointer_beside_a_verdict_stays_low(self):
        stamps = _stamps("Nach meiner Einschätzung gilt § 5 [Beleg nicht verifiziert].")

        assert stamps[0].dropped and stamps[0].is_verdict
        assert claims_ceiling(stamps) == "low"


class TestAReasonedValueThatACitedSentenceAlsoStates:
    def test_reasoning_with_a_value_of_the_cited_sentence_caps_at_medium(self):
        prose = "Das Konzept gibt im 3. OG höchstens 12 m an [1]. Daraus folgt, dass 12 m nicht der ganze Weg sind."

        stamps = _stamps(prose, cited_numbers=frozenset({1}))

        assert [stamp.provenance for stamp in stamps] == ["cited", "reasoning"]
        assert stamp_ceiling(stamps[1]) == "medium"

    def test_reasoning_with_a_value_no_cited_sentence_states_stays_low(self):
        prose = "Das Konzept gibt im 3. OG höchstens 12 m an [1]. Daraus folgt ein Weg von 28 m."

        stamps = _stamps(prose, cited_numbers=frozenset({1}))

        assert stamp_ceiling(stamps[1]) == "low"

    def test_a_value_of_an_observed_place_sentence_in_the_same_paragraph_counts_too(self):
        prose = "Der Gang ist 1,10 m breit [2]. Daraus folgt, dass 1,10 m knapp sind."

        stamps = _stamps(prose, looks={2: LookPlace(READ, crop=True)})

        # No passage in the paragraph, so the second sentence is the model's own knowledge, not reasoning.
        assert [stamp.provenance for stamp in stamps] == ["observed", "model_knowledge"]
