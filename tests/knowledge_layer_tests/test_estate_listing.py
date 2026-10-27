"""``ls``, ``glob`` and the folder card ``README.md`` on the estate (ADR-0133 slice 3).

What is pinned: the root lists the places the person may see; a folder lists its subfolders with
counts and one row per file with the leaf ``read_file`` takes; a restricted folder's document is
never named or counted, so ``ls`` of its folder and ``glob`` for its name answer exactly as for a
folder or a name that does not exist; folder names match folded; ``README.md`` is the folder's card
unless a real document has the name; every listing is an index (no ``Citation:`` line).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sources.knowledge_layer.src.browse import FileRow
from sources.knowledge_layer.src.estate import EstateBackend
from sources.knowledge_layer.src.estate import glob_files
from sources.knowledge_layer.src.estate_listing import render_glob

ROWS = [
    FileRow(
        file_name="EP-01_Grundrisse.pdf",
        shelf="project",
        collection="proj_a",
        folder="Einreichung/Pläne",
        doc_class="submission_plan",
        page_count=4,
        revision_facts={"revision": "B"},
    ),
    FileRow(file_name="EP-02_Schnitte.pdf", shelf="project", collection="proj_a", folder="Einreichung/Pläne"),
    FileRow(
        file_name="Baubeschreibung.docx",
        shelf="project",
        collection="proj_a",
        folder="Einreichung",
        superseded_by="Baubeschreibung_v2.docx",
    ),
    FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_a", folder="Gutachten/Brandschutz"),
    FileRow(file_name="Vorlage.docx", shelf="office_shelf", collection="office_shelf_org", folder="Vorlagen"),
    FileRow(file_name="oib-rl_2_ausgabe_mai_2023.pdf", shelf="base", collection="oib_knowledge"),
]
#: A restricted folder's documents never reach the listable rows (``browse._turn_rows`` filters them),
#: so the backend under test gets exactly those; the restricted ones exist only as readable rows.
SECRET = FileRow(file_name="Vertrag.pdf", shelf="project", collection="proj_a_r0123456789ab", folder="Personal")


def _backend(rows=ROWS) -> EstateBackend:
    async def listable():
        return list(rows)

    async def restricted():
        return [SECRET]

    async def no_pages(*_args, **_kwargs):
        return None

    backend = EstateBackend(SimpleNamespace(), rows_loader=listable, restricted_loader=restricted, page_reader=no_pages)

    async def no_abstracts(files, mount):
        return {}

    backend._abstracts = no_abstracts  # type: ignore[method-assign]
    return backend


@pytest.fixture(autouse=True)
def _no_in_flight(monkeypatch):
    from sources.knowledge_layer.src import estate

    async def none(_files):
        return []

    monkeypatch.setattr(estate, "_in_flight", none)


class TestLs:
    async def test_the_root_lists_the_places_with_their_counts(self) -> None:
        result = await _backend().ls("/", drafts=True)
        lines = result.text.split("\n")
        assert lines[1].startswith("/project/") and "4 documents" in lines[1]
        assert any(line.startswith("/office/") for line in lines)
        assert any(line.startswith("/law/oib/") for line in lines)
        assert any(line.startswith("/drafts/") for line in lines)
        assert not any(line.startswith("/chat/") for line in lines), "a place with nothing readable is not listed"

    async def test_a_folder_lists_its_subfolders_and_its_files(self) -> None:
        result = await _backend().ls("/project/Einreichung/")
        assert result.status == "ok"
        assert "Pläne/" in result.text and "2 documents" in result.text
        assert "Baubeschreibung.docx.md" in result.text and "ersetzt durch Baubeschreibung_v2.docx" in result.text
        assert "README.md" in result.text
        assert "Citation:" not in result.text

    async def test_a_file_row_carries_pages_dokumentart_and_plankopf(self) -> None:
        result = await _backend().ls("/project/Einreichung/Plaene")
        row = next(line for line in result.text.split("\n") if line.startswith("EP-01"))
        assert "4 pp" in row and "submission_plan" in row and "Plankopf" in row

    async def test_a_restricted_folder_reads_like_one_that_does_not_exist(self) -> None:
        restricted = await _backend().ls("/project/Personal/")
        absent = await _backend().ls("/project/Persona/")
        assert restricted.status == absent.status == "error"
        assert restricted.text.replace("Personal", "X") == absent.text.replace("Persona", "X")
        listing = await _backend().ls("/project/")
        assert "Personal" not in listing.text and "Vertrag" not in listing.text

    async def test_depth_draws_the_tree_as_folder_cards(self) -> None:
        result = await _backend().ls("/project/", depth=3)
        assert "folder cards" in result.text and "Einreichung/Pläne/" in result.text

    async def test_the_law_is_flat(self) -> None:
        result = await _backend().ls("/law/oib/")
        assert "oib-rl_2_ausgabe_mai_2023.pdf.md" in result.text

    async def test_a_path_that_is_not_canonical_is_refused(self) -> None:
        result = await _backend().ls("/project/../office/")
        assert result.status == "error"


class TestGlob:
    async def test_a_name_pattern_at_any_depth_folded(self) -> None:
        result = await _backend().glob("*brandschutz*")
        assert "/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md" in result.text
        assert "1 file match" in result.text

    async def test_the_pdf_extension_finds_the_served_text(self) -> None:
        files = await _backend().listable_files()
        assert {file.row.file_name for file in glob_files(files, "*.pdf", "/project/")} == {
            "EP-01_Grundrisse.pdf",
            "EP-02_Schnitte.pdf",
            "Brandschutzkonzept.pdf",
        }

    async def test_a_relative_and_an_absolute_path_pattern(self) -> None:
        files = await _backend().listable_files()
        assert [f.row.file_name for f in glob_files(files, "Einreichung/**/EP-0?_*", "/project/")] == [
            "EP-01_Grundrisse.pdf",
            "EP-02_Schnitte.pdf",
        ]
        assert [f.row.file_name for f in glob_files(files, "/office/**/*.{docx,xlsx}")] == ["Vorlage.docx"]
        assert [f.row.file_name for f in glob_files(files, "Plaene/*", "/project/Einreichung/")] == [
            "EP-01_Grundrisse.pdf",
            "EP-02_Schnitte.pdf",
        ]

    async def test_a_restricted_name_is_no_match(self) -> None:
        found = await _backend().glob("Vertrag*")
        nothing = await _backend().glob("Vertrxg*")
        assert found.text.replace("Vertrag", "X") == nothing.text.replace("Vertrxg", "X")

    def test_a_miss_says_it_is_about_names(self) -> None:
        assert "A name says nothing of the content" in render_glob([], "x*", None).text


class TestTheFolderCard:
    async def test_readme_is_the_folders_card_and_no_source(self) -> None:
        result = await _backend().read_file("/project/Einreichung/README.md")
        assert result.status == "ok" and result.hits == ()
        assert "folder card" in result.text and "3 documents" in result.text
        assert "Citation:" not in result.text

    async def test_a_real_readme_keeps_its_name(self) -> None:
        real = FileRow(file_name="README.md", shelf="project", collection="proj_a", folder="Einreichung")

        async def pages(collection, file_name, *, wanted=None):
            from sources.knowledge_layer.src import stored_pages

            return stored_pages.PageText(
                pages=[stored_pages.Page(number=1, text="Lies mich")], origin="chunks", page_count=1
            )

        backend = _backend([*ROWS, real])
        backend._page_reader = pages
        result = await backend.read_file("/project/Einreichung/README.md")
        assert "Citation: README.md" in result.text
        listing = await backend.ls("/project/Einreichung/")
        assert "the folder card" not in listing.text

    async def test_no_card_for_a_restricted_folder(self) -> None:
        result = await _backend().read_file("/project/Personal/README.md")
        assert result.status == "error" and result.text.startswith('No file "/project/Personal/README.md".')
