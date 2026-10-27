"""A place a look read is citable (ADR-0125, amendment of 2026-10-22): its class and what it can count."""

from __future__ import annotations

from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.common.claim_judge import Judgement
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import LookPlace
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import normative_uncited
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import with_judgements

READ = "Gelesen: Gangbreite 1,10 m (dimension, high)"


def _stamps(prose: str, *, kind: str = "fact", **evidence):
    stamps = classify_claims(prose, ClaimEvidence(**evidence), normative=answer_mentions_normative_claim)
    return with_judgements(stamps, [Judgement("supported", kind)] * len(stamps))


def _one(prose: str, **evidence):
    [stamp] = _stamps(prose, **evidence)
    return stamp


class TestACitedPlaceIsObserved:
    def test_a_region_crop_and_the_exact_reading_count_whole(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", looks={2: LookPlace(READ, crop=True)})

        assert (stamp.provenance, stamp.claim_type, stamp.exact) == ("observed", "value", True)
        assert READ in stamp.evidence and support(stamp) == 1.0

    def test_an_overview_counts_half_even_with_the_exact_reading(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", looks={2: LookPlace(READ, crop=False)})

        assert stamp.provenance == "observed" and support(stamp) == 0.5

    def test_a_crop_without_the_exact_value_counts_half(self):
        stamp = _one("Der Gang ist 1,20 m breit [2].", looks={2: LookPlace(READ, crop=True)})

        assert stamp.provenance == "observed" and support(stamp) == 0.5

    def test_a_place_never_grounds_a_claim_about_the_law(self):
        stamps = _stamps(
            "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [2].",
            kind="verdict",
            looks={2: LookPlace(READ, crop=True)},
        )

        assert stamps[0].provenance == "observed" and support(stamps[0]) == 0.0
        assert normative_uncited(stamps) == 1


CAPTION = "Schnitt A-A, Massstab 1:50, Gangbreite laut Legende 1,20 m."


class TestAMergedEntryIsClassedByWhereTheValueAppears:
    """A look on a page that also holds a retrieved caption merges into that entry (same file and page)."""

    @staticmethod
    def _merged(crop: bool = True) -> dict[int, LookPlace]:
        return {2: LookPlace(READ, crop=crop, place_only=False, passage=CAPTION)}

    def test_a_value_in_the_retrieved_passage_is_cited(self):
        stamp = _one(
            "Die Legende nennt 1,20 m [2].", cited_numbers=frozenset({2}), passages={2: CAPTION}, looks=self._merged()
        )

        assert stamp.provenance == "cited" and CAPTION in stamp.evidence and support(stamp) == 1.0

    def test_a_value_only_in_the_reading_is_observed_and_never_borrows_the_captions_authority(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert (stamp.provenance, stamp.exact) == ("observed", True)
        assert support(stamp) == 1.0  # a region crop and the exact reading, as for a place only

    def test_the_same_value_from_an_overview_counts_half(self):
        stamp = _one("Der Gang ist 1,10 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged(crop=False))

        assert stamp.provenance == "observed" and support(stamp) == 0.5

    def test_a_value_only_in_the_reading_stays_off_the_law(self):
        prose = "Der Fluchtweg muss nach § 5 mindestens 1,10 m breit sein [2]."
        [stamp] = _stamps(prose, kind="verdict", cited_numbers=frozenset({2}), looks=self._merged())

        assert stamp.provenance == "observed" and support(stamp) == 0.0

    def test_a_value_in_neither_has_no_evidence(self):
        stamp = _one("Der Gang ist 1,35 m breit [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert (stamp.provenance, stamp.claim_type) == ("model_knowledge", "value")
        assert support(stamp) == 0.0

    def test_a_sentence_stating_no_value_is_cited(self):
        stamp = _one("Der Schnitt zeigt den Gang [2].", cited_numbers=frozenset({2}), looks=self._merged())

        assert stamp.provenance == "cited"

    def test_a_sentence_that_also_cites_a_plain_passage_keeps_its_pointer(self):
        stamp = _one("Der Gang ist 1,10 m breit [2][1].", cited_numbers=frozenset({1, 2}), looks=self._merged())

        assert stamp.provenance == "cited"


class TestTheWeakerOfTwoPointersWins:
    def test_a_looked_value_compared_with_a_cited_norm_takes_the_places_level(self):
        prose = "Der Gang misst 1,10 m [2] und unterschreitet die geforderten 1,20 m [1]."
        stamp = _one(
            prose,
            cited_numbers=frozenset({1}),
            passages={1: "Gänge: 1,20 m"},
            looks={2: LookPlace("Gelesen: Gang 1,05 m", crop=True)},
        )

        assert stamp.provenance == "cited" and stamp.cap == "medium"
        assert support(stamp) == 0.5

    def test_the_cited_norm_alone_counts_whole(self):
        stamp = _one("Gefordert sind 1,20 m [1].", cited_numbers=frozenset({1}), passages={1: "Gänge: 1,20 m"})

        assert support(stamp) == 1.0

    def test_an_exact_crop_beside_a_norm_does_not_lower_the_norm(self):
        prose = "Der Gang misst 1,10 m [2] und die Richtlinie fordert 1,20 m [1]."
        stamp = _one(
            prose, cited_numbers=frozenset({1}), passages={1: "Gänge: 1,20 m"}, looks={2: LookPlace(READ, crop=True)}
        )

        assert support(stamp) == 1.0

    def test_a_cited_sentence_repeating_a_reading_without_its_marker_counts_half(self):
        stamp = _one(
            "Der Gang misst 1,10 m, verlangt sind 1,20 m [1].",
            cited_numbers=frozenset({1}),
            passages={1: "Gänge: 1,20 m"},
            readings=(READ,),
        )

        assert stamp.provenance == "cited" and support(stamp) == 0.5
