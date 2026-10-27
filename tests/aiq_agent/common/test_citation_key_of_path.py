"""A citation written as a path resolves to the citation key it means (ADR-0133 slice 6).

The model reads paths (a hit's ``Path:``, a ``read_file`` header) and may cite one. Without the
mapping verification drops the citation and the answer loses its source without a word.
"""

from __future__ import annotations

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import _parse_citation_ref
from aiq_agent.common.citation_verification import citation_key_of_path
from aiq_agent.common.source_kinds import Shelf


def _entry(key: str, shelf: str) -> SourceEntry:
    return SourceEntry(citation_key=key, source_type="knowledge", tool_name="read_file", shelf=shelf)


class TestThePath:
    def test_the_leaf_without_the_served_md_and_the_mount_as_the_shelf(self):
        assert citation_key_of_path("/project/Gutachten/Brandschutzkonzept.pdf.md") == (
            "Brandschutzkonzept.pdf",
            Shelf.PROJECT,
        )
        assert citation_key_of_path("/law/oib/oib-rl_2_ausgabe_mai_2023.pdf.md") == (
            "oib-rl_2_ausgabe_mai_2023.pdf",
            Shelf.BASE,
        )
        assert citation_key_of_path("/office/Notiz.md") == ("Notiz.md", Shelf.OFFICE_SHELF)

    def test_no_path_no_mapping(self):
        assert citation_key_of_path("Brandschutzkonzept.pdf") is None
        assert citation_key_of_path("/drafts/aktenvermerk.md") is None
        assert citation_key_of_path("/project/Gutachten/") is None
        assert citation_key_of_path("/elsewhere/x.pdf") is None

    def test_the_page_is_kept(self):
        assert _parse_citation_ref("/project/A/Plan.pdf.md, p.3") == ("Plan.pdf", Shelf.PROJECT, 3)


class TestTheRegistry:
    def test_a_path_citation_matches_the_key_the_tool_returned(self):
        registry = SourceRegistry()
        registry.add(_entry("Brandschutzkonzept.pdf, p.3", "project"))
        assert registry.has_citation_key("/project/Gutachten/Brandschutzkonzept.pdf.md, p.3")
        assert registry.entry_for_citation_key("/project/Gutachten/Brandschutzkonzept.pdf.md, p.3") is not None
        assert not registry.has_citation_key("/project/Gutachten/Anderes.pdf.md, p.3")

    def test_the_mount_states_the_shelf_like_a_qualifier_and_fails_open(self):
        """An office path names the office shelf; a key retrieved from another shelf still matches (fail-open)."""
        assert _parse_citation_ref("/office/Plan.pdf.md, p.1")[1] is Shelf.OFFICE_SHELF
        registry = SourceRegistry()
        registry.add(_entry("Plan.pdf, p.1", "project"))
        assert registry.has_citation_key("/office/Plan.pdf.md, p.1")
