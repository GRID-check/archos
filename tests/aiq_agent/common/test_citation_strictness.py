"""The strict half of ADR-0122: a dropped pointer is labelled, a locus must be in its passage, polarity holds.

Each test here fails on the code before the change: the verifier deleted an
unresolvable ``[N]`` silently, never compared a § beside a marker with the
passage, and scored „keine" quoted as „eine" as verbatim.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.citation_locus import Locus
from aiq_agent.common.citation_locus import locus_before
from aiq_agent.common.citation_locus import locus_in_entry
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import LOCUS_MISMATCH_REASON
from aiq_agent.common.citation_verification import QUOTE_MATCH_THRESHOLD
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import quote_coverage
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.quote_polarity import polarity_agrees

PASSAGE = (
    "3.5.2 Für Wohngebäude ist keine Genehmigung erforderlich, wenn die Fläche unzulässig groß ist. "
    "Bauteile müssen nicht brennbar sein. Die lichte Raumhöhe muss mindestens 2,50 m betragen."
)


def _registry(*entries: SourceEntry) -> SourceRegistry:
    registry = SourceRegistry()
    for entry in entries:
        registry.add(entry)
    return registry


def _oib(page: int = 12, *, clause: str | None = "3.5.2", text: str = PASSAGE) -> SourceEntry:
    return SourceEntry(
        citation_key=f"oib-rl_2.pdf, p.{page}",
        source_type="knowledge_layer",
        tool_name="knowledge_search",
        chunk_text=text,
        clause=clause,
    )


class TestPolarity:
    @pytest.mark.parametrize(
        "quote",
        [
            "Für Wohngebäude ist eine Genehmigung erforderlich",  # keine → eine
            "wenn die Fläche zulässig groß ist",  # unzulässig → zulässig
        ],
    )
    def test_an_edit_inside_a_word_that_flips_the_sentence_is_not_verbatim(self, quote):
        assert quote_coverage(quote, PASSAGE) < QUOTE_MATCH_THRESHOLD

    @pytest.mark.parametrize(
        "quote",
        [
            "Für Wohngebäude ist keine Genehmigung erforderlich",
            "wenn die Fläche unzulässig groß ist",
            "Die lichte Raumhöhe muß mindestens 2,50 m betragen",  # ß/ss noise stays verbatim
        ],
    )
    def test_the_verbatim_quote_still_passes(self, quote):
        assert quote_coverage(quote, PASSAGE) >= QUOTE_MATCH_THRESHOLD

    def test_the_tokens_are_a_multiset(self):
        assert polarity_agrees("nicht nur das", "nur nicht das")
        assert not polarity_agrees("nicht das", "nicht nicht das")
        assert not polarity_agrees("außer Garagen", "Garagen")
        assert polarity_agrees("Unterlagen und uns", "Unterlagen und uns")


class TestLocus:
    def test_the_closest_locus_in_the_markers_clause_is_read(self):
        text = "Nach § 3 gilt das. Die Höhe regelt § 5 Abs. 2 [1]"
        assert locus_before(text, text.index("[1]")) == Locus("paragraph", "5")
        text = "Siehe Pkt. 3.5.2 [1]"
        assert locus_before(text, text.index("[1]")) == Locus("punkt", "3.5.2")
        text = "Die Höhe beträgt 2,50 m [1]"
        assert locus_before(text, text.index("[1]")) is None

    def test_a_clause_agrees_on_a_dot_boundary(self):
        assert locus_in_entry(Locus("punkt", "3.5.2"), _oib(clause="3.5"))
        assert locus_in_entry(Locus("punkt", "3.5"), _oib(clause="3.5.2"))
        assert not locus_in_entry(Locus("punkt", "3.5.20"), _oib(clause="3.5.2", text="nichts"))

    def test_an_entry_with_nothing_to_check_against_passes(self):
        assert locus_in_entry(Locus("paragraph", "5"), SourceEntry(url="https://example.com/a")) is None


class TestVerifyCitationsLabels:
    SECTION = "\n\n## Quellen\n- [1] oib-rl_2.pdf, p.12\n- [2] erfunden.pdf, p.1"

    def test_an_unresolvable_marker_is_labelled_where_it_stood(self):
        result = verify_citations(
            "Die Höhe beträgt 2,50 m [1]. Das gilt immer [2]." + self.SECTION, _registry(_oib()), label_dropped=True
        )
        body = result.verified_report.partition("\n\n")[0]
        assert body == f"Die Höhe beträgt 2,50 m [1]. Das gilt immer {DROPPED_CITATION_MARKER}."

    def test_without_the_flag_it_is_removed_as_before(self):
        result = verify_citations("Das gilt immer [2]." + self.SECTION, _registry(_oib()))
        assert DROPPED_CITATION_MARKER not in result.verified_report

    def test_adjacent_dropped_markers_become_one_label(self):
        result = verify_citations("Das gilt [2][3]." + self.SECTION, _registry(_oib()), label_dropped=True)
        assert result.verified_report.count(DROPPED_CITATION_MARKER) == 1

    def test_an_empty_registry_labels_every_number_and_drops_the_invented_list(self):
        result = verify_citations("Das gilt [1]." + self.SECTION, SourceRegistry(), label_dropped=True)
        assert result.verified_report == f"Das gilt {DROPPED_CITATION_MARKER}."
        assert [entry["number"] for entry in result.removed_citations] == [1]

    def test_a_locus_the_cited_passage_does_not_hold_is_labelled(self):
        report = "Die Raumhöhe regelt Punkt 3.5.2 [1], die Fluchtwege Punkt 4.1 [1]." + self.SECTION
        result = verify_citations(report, _registry(_oib()), label_dropped=True, check_locus=True)
        body = result.verified_report.partition("\n\n")[0]
        assert body == f"Die Raumhöhe regelt Punkt 3.5.2 [1], die Fluchtwege Punkt 4.1 {DROPPED_CITATION_MARKER}."
        assert [entry["reason"] for entry in result.removed_citations if entry["number"] == 1] == [
            LOCUS_MISMATCH_REASON
        ]
        # The source line stays: [1] still resolves for the clause that holds.
        assert [citation["number"] for citation in result.valid_citations] == [1]

    def test_a_citation_whose_every_locus_misses_loses_its_line(self):
        report = "Das regelt § 12 [1]." + "\n\n## Quellen\n- [1] oib-rl_2.pdf, p.12"
        result = verify_citations(report, _registry(_oib()), label_dropped=True, check_locus=True)
        assert result.valid_citations == []
        assert "oib-rl_2.pdf" not in result.verified_report

    def test_without_the_flag_no_locus_is_checked(self):
        report = "Das regelt § 12 [1]." + "\n\n## Quellen\n- [1] oib-rl_2.pdf, p.12"
        result = verify_citations(report, _registry(_oib()), label_dropped=True)
        assert [citation["number"] for citation in result.valid_citations] == [1]
