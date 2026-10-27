"""A citation written as a path resolves to the citation key it means (ADR-0133 slice 6).

The model reads paths (a hit's ``Path:``, a ``read_file`` header) and may cite one. Without the
mapping verification drops the citation and the answer loses its source without a word.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import _parse_citation_ref
from aiq_agent.common.citation_verification import citation_key_of_path
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.source_kinds import Shelf


def _registry(*keys: str, shelf: str = "project") -> SourceRegistry:
    registry = SourceRegistry()
    for key in keys:
        registry.add(SourceEntry(citation_key=key, source_type="knowledge", tool_name="read_file", shelf=shelf))
    return registry


class TestThePath:
    def test_the_leaf_s_candidates_and_the_mount_as_the_shelf(self):
        assert citation_key_of_path("/project/Gutachten/Brandschutzkonzept.pdf.md") == (
            ["Brandschutzkonzept.pdf", "Brandschutzkonzept.pdf.md"],
            Shelf.PROJECT,
        )
        assert citation_key_of_path("/law/oib/oib-rl_2.pdf.md")[1] is Shelf.BASE
        assert citation_key_of_path("/office/Notiz.md") == (["Notiz.md", "Notiz"], Shelf.OFFICE_SHELF)

    def test_no_path_no_mapping(self):
        assert citation_key_of_path("Brandschutzkonzept.pdf") is None
        assert citation_key_of_path("/drafts/aktenvermerk.md") is None
        assert citation_key_of_path("/project/Gutachten/") is None
        assert citation_key_of_path("/elsewhere/x.pdf") is None

    def test_the_page_is_kept(self):
        assert _parse_citation_ref("/project/A/Plan.pdf.md, p.3") == ("Plan.pdf", Shelf.PROJECT, 3)


class TestTheRegistry:
    @pytest.mark.parametrize(
        ("stored", "cited"),
        [
            ("Brandschutzkonzept.pdf, p.3", "/project/Gutachten/Brandschutzkonzept.pdf.md, p.3"),
            ("Notiz.v2.md, p.1", "/project/Notiz.v2.md, p.1"),  # a dotted Markdown file keeps its .md
            ("Plan, p.1", "/project/Plan.md, p.1"),  # a file with no extension, served as Plan.md
            ("Plan.pdf, p.1", "/office/Plan.pdf.md, p.1"),  # another shelf's mount fails open
        ],
    )
    def test_a_path_citation_matches_the_key_the_tool_returned(self, stored, cited):
        registry = _registry(stored)
        assert registry.has_citation_key(cited)
        assert registry.entry_for_citation_key(cited).citation_key == stored

    def test_another_file_does_not_match(self):
        assert not _registry("Brandschutzkonzept.pdf, p.3").has_citation_key("/project/Anderes.pdf.md, p.3")

    @pytest.mark.parametrize(
        ("stored", "line", "shown"),
        [
            # A comma in the file name is no end of the path; the page is.
            (
                "Bescheid, Stand 2024.pdf, p.3",
                "[1] /project/Behörde/Bescheid, Stand 2024.pdf.md, p.3",
                "[1] Bescheid, Stand 2024.pdf, p.3",
            ),
            # A German page reference survives the rewrite.
            ("Plan.pdf, p.3", "[1] /project/Einreichung/Plan.pdf.md S. 3", "[1] Plan.pdf S. 3"),
            # Text after the page is no part of the path.
            ("Plan.pdf, p.3", "[1] /project/A/Plan.pdf.md, p.3 – Abschnitt 2", "[1] Plan.pdf, p.3 – Abschnitt 2"),
            # A path inside parentheses keeps the closing one.
            ("Plan.pdf, p.3", "[1] Plan.pdf, p.3 (siehe /project/A/Plan.pdf.md)", "[1] Plan.pdf, p.3 (siehe Plan.pdf)"),
        ],
    )
    def test_the_rewrite_replaces_exactly_the_path(self, stored, line, shown):
        text = f"Der Fluchtweg ist 40 m lang [1].\n\n## Sources\n{line}\n"
        report = verify_citations(text, _registry(stored)).verified_report
        assert shown in report.splitlines()

    def test_the_answer_s_source_line_names_the_file_not_the_path(self):
        text = "Der Fluchtweg ist 40 m lang [1].\n\n## Sources\n[1] /project/Einreichung/Plan.pdf.md, p.3\n"
        result = verify_citations(text, _registry("Plan.pdf, p.3"))
        assert result.valid_citations[0]["citation_key"] == "Plan.pdf, p.3"
        assert "[1] Plan.pdf, p.3" in result.verified_report
        assert "/project/" not in result.verified_report
