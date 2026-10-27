"""The paths Piloti reads the office's documents by (ADR-0133, agent-filesystem.md §1)."""

from __future__ import annotations

import pytest

from aiq_agent.common.estate_paths import PathRefused
from aiq_agent.common.estate_paths import action_place
from aiq_agent.common.estate_paths import asked_document
from aiq_agent.common.estate_paths import call_mount
from aiq_agent.common.estate_paths import estate_path
from aiq_agent.common.estate_paths import file_name_candidates
from aiq_agent.common.estate_paths import is_draft_path
from aiq_agent.common.estate_paths import leaf_for
from aiq_agent.common.estate_paths import mount_of_path
from aiq_agent.common.estate_paths import parse_estate_path
from aiq_agent.common.estate_paths import reaches_drafts_only


class TestTheLeaf:
    def test_a_pdf_is_served_as_its_text(self) -> None:
        """A `.pdf` path that returns text becomes a base64 file block in the stock tool (prototype p2)."""
        assert leaf_for("Brandschutzkonzept.pdf") == "Brandschutzkonzept.pdf.md"

    def test_a_text_file_keeps_its_name(self) -> None:
        assert leaf_for("Notiz.txt") == "Notiz.txt"
        assert leaf_for("Liste.CSV") == "Liste.CSV"

    def test_an_agent_filed_document_shows_no_piloti_directory(self) -> None:
        assert leaf_for("piloti/Aktenvermerk.pdf") == "Aktenvermerk.pdf.md"

    def test_the_name_is_nfc(self) -> None:
        decomposed = "Pläne.pdf"
        assert leaf_for(decomposed) == "Pläne.pdf.md"


class TestThePath:
    def test_each_shelf_has_its_mount(self) -> None:
        assert estate_path("project", "Gutachten/Brandschutz", "B.pdf") == "/project/Gutachten/Brandschutz/B.pdf.md"
        assert estate_path("office_shelf", "", "V.docx") == "/office/V.docx.md"
        assert estate_path("archiv", None, "V.docx") == "/office/V.docx.md"
        assert estate_path("session", None, "Foto.jpg") == "/chat/Foto.jpg.md"

    def test_the_law_is_flat(self) -> None:
        assert estate_path("base", "irgendwas", "oib-rl_2.pdf") == "/law/oib/oib-rl_2.pdf.md"

    def test_an_unknown_shelf_has_no_path(self) -> None:
        assert estate_path(None, "", "x.pdf") is None
        assert estate_path("web", "", "x.pdf") is None

    def test_a_path_never_names_a_collection(self) -> None:
        path = estate_path("project", "Personal", "Vertrag.pdf")
        assert path is not None and "proj_" not in path and "_r" not in path.split("/")[-1]


class TestParsing:
    def test_a_document_path(self) -> None:
        parsed = parse_estate_path("/project/Einreichung/Pläne/EP-01.pdf.md")
        assert (parsed.mount, parsed.folder, parsed.leaf) == ("project", "Einreichung/Pläne", "EP-01.pdf.md")

    def test_a_mount_root_is_a_directory(self) -> None:
        assert parse_estate_path("/project").leaf is None
        assert parse_estate_path("/law/oib/").mount == "law"
        assert parse_estate_path("/").mount is None

    def test_the_law_corpus_path(self) -> None:
        parsed = parse_estate_path("/law/oib/oib-rl_2.pdf.md")
        assert (parsed.mount, parsed.folders, parsed.leaf) == ("law", (), "oib-rl_2.pdf.md")

    @pytest.mark.parametrize(
        "path",
        ["project/x.pdf.md", "/project/../office/x.pdf.md", "/project/Pl%C3%A4ne/x.pdf.md", "/project\\x.pdf"],
    )
    def test_a_path_that_is_not_canonical_is_refused_before_any_lookup(self, path: str) -> None:
        with pytest.raises(PathRefused):
            parse_estate_path(path)

    def test_a_leaf_names_its_file_name_first(self) -> None:
        assert file_name_candidates("Plan.pdf.md") == ["Plan.pdf", "Plan.pdf.md"]
        assert file_name_candidates("Plan.pdf") == ["Plan.pdf"]
        assert file_name_candidates("Notiz.md") == ["Notiz.md", "Notiz"]  # a file with no extension is served so
        assert file_name_candidates("Notiz.v2.md") == ["Notiz.v2", "Notiz.v2.md"]


class TestMounts:
    def test_drafts_in_both_spellings(self) -> None:
        assert is_draft_path("/drafts/a.md") and is_draft_path("/entwuerfe/a.md") and is_draft_path("drafts/a.md")
        assert mount_of_path("/drafts") == "drafts"
        assert not is_draft_path("/project/drafts/a.md")

    def test_a_call_reaches_its_mount(self) -> None:
        assert call_mount("read_file", {"file_path": "/project/x.pdf.md"}) == "project"
        assert call_mount("read_file", {"file_path": "/drafts/x.md"}) == "drafts"
        assert call_mount("grep", {"pattern": "x"}) == "estate"
        assert call_mount("ls", {"path": "/"}) == "estate"
        assert call_mount("write_file", {"file_path": "/project/x.md"}) == "drafts"
        assert call_mount("knowledge_search", {"query": "x"}) is None

    def test_only_a_drafts_call_stays_in_the_drafts(self) -> None:
        assert reaches_drafts_only("ls", {"path": "/drafts/"})
        assert not reaches_drafts_only("ls", {"path": "/project/"})
        assert not reaches_drafts_only("read_file", None)


class TestTheRowsPlace:
    """A Herleitung row names a place and the folder inside it, never a path (ADR-0132, ADR-0133)."""

    @pytest.mark.parametrize(
        ("path", "place"),
        [
            (None, {"mount": "estate"}),
            ("", {"mount": "estate"}),
            ("/", {"mount": "estate"}),
            ("/project/", {"mount": "project"}),
            ("/project/03 Einreichung/Pläne/", {"mount": "project", "target": "03 Einreichung/Pläne"}),
            ("/project/03 Einreichung", {"mount": "project", "target": "03 Einreichung"}),
            ("/office/Vorlagen/", {"mount": "office", "target": "Vorlagen"}),
            ("/chat/", {"mount": "chat"}),
            ("/law/oib/", {"mount": "law"}),
            ("/law/", {"mount": "law"}),
        ],
    )
    def test_a_path_is_its_place_and_folder(self, path, place) -> None:
        assert action_place(path) == place

    @pytest.mark.parametrize("path", ["/nirgends/", "../project/", "project/x", "/drafts/", "/drafts/../project/"])
    def test_a_path_that_names_no_place_gives_the_row_nothing_to_print(self, path) -> None:
        """The row then reads „… einen Ordner“, never „drafts › .. › project“."""
        assert action_place(path) == {}

    def test_the_document_a_read_asked_for_is_its_leaf_without_the_text_suffix(self) -> None:
        assert asked_document("/project/Personal/Vertrag.pdf.md") == "Vertrag.pdf"
        assert asked_document("/project/Notiz.txt") == "Notiz.txt"
        assert asked_document("/project/Plan.pdf") == "Plan.pdf"
        assert asked_document("/project/Gutachten/") == ""
        assert asked_document("") == ""
