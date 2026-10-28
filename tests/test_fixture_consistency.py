"""The two eval fixture projects are two slices of ONE invented project, and their shared facts stay shared.

The office-file set reads the Plankopf of EP-01 and EP-02 as text (``tests/fixtures/files_eval/project.yaml``,
which extends the intake eval's); the visual set draws the same sheets (``tests/fixtures/visual/drawings.json``).
They once disagreed (Index B dated 14.03.2026 on the drawings and 03.02.2026 in the text; the Schnitt at 1:50
by one office and 1:100 by another), and a north-star row asking across both could not have a right answer.
This reads the Plankopf values, the Fassung dates, the scales, the author and the folder off both sides and
fails when they differ, so a change to one fixture that forgets the other is caught here and not in a paid run.

Planted differences stay: the Schnitt is drawn at another scale than the Grundrisse, and Index A is older than B.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import fixture_files  # noqa: E402
import north_star_eval  # noqa: E402
import render_fixture_drawings as drawings  # noqa: E402

_PLANKOPF = re.compile(
    r"Plannummer:\s*(?P<number>\S+)\s+Index:\s*(?P<index>\S+)\s+Datum:\s*(?P<date>\d{2}\.\d{2}\.\d{4})\s+"
    r"Maßstab:\s*(?P<scale>1:\d+)"
)
_AUTHOR = re.compile(r"Planverfasser:\s*(?P<author>.+)")
_CAPTION_AUTHOR = re.compile(r"Planverfasser\s+(?P<author>.+)$")
_TITLE_KEYS = {"Plannummer": "number", "Index": "index", "Datum": "date", "Maßstab": "scale"}


def _text_side() -> dict[str, dict]:
    """Per sheet the office-file project holds as text: its Plankopf values, author and folder."""
    found = {}
    for file in fixture_files.load_project().files:
        for page in file.pages:
            if match := _PLANKOPF.search(page):
                author = _AUTHOR.search(page)
                found[file.name] = {
                    **match.groupdict(),
                    "author": author.group("author").strip() if author else None,
                    "folder": file.folder,
                    "facts": file.revision_facts or {},
                }
                break
    return found


def _drawn_side() -> dict[str, dict]:
    """Per sheet the visual project draws: the values of its Plankopf fields on every page, the caption's author."""
    found = {}
    for drawing in drawings.load_spec()["drawings"]:
        values: dict[str, set[str]] = {key: set() for key in _TITLE_KEYS.values()}
        authors = set()
        for page in drawing["pages"]:
            for element in page["elements"]:
                if element["kind"] == "title_field":
                    values[_TITLE_KEYS[element["key"]]].add(element["value"])
            if caption := _CAPTION_AUTHOR.search(page["index_text"]):
                authors.add(caption.group("author").strip())
        found[drawing["file_name"]] = {**values, "authors": authors, "folder": drawing["folder"]}
    return found


TEXT = _text_side()
DRAWN = _drawn_side()
SHARED = sorted(set(TEXT) & set(DRAWN))


def _iso(date: str) -> str:
    return datetime.strptime(date, "%d.%m.%Y").date().isoformat()


class TestTheSlicesShareTheirFacts:
    def test_the_three_sheets_are_in_both_slices(self):
        assert SHARED == [
            "EP-01_Grundrisse_Index-A.pdf",
            "EP-01_Grundrisse_Index-B.pdf",
            "EP-02_Schnitt_A-A.pdf",
        ]

    @pytest.mark.parametrize("name", SHARED)
    @pytest.mark.parametrize("field", ["number", "index", "date", "scale"])
    def test_a_plankopf_field_is_one_value_on_every_page_and_in_the_text(self, name, field):
        assert DRAWN[name][field] == {TEXT[name][field]}, (
            f"{name}: the drawings' Plankopf {field} is {sorted(DRAWN[name][field])}, "
            f"the files text says {TEXT[name][field]!r}"
        )

    @pytest.mark.parametrize("name", SHARED)
    def test_the_stored_revision_facts_say_what_the_title_block_says(self, name):
        facts, text = TEXT[name]["facts"], TEXT[name]
        assert facts["revision"] == text["index"]
        assert facts["document_number"] == text["number"]
        assert facts["revision_date"] == _iso(text["date"])
        assert facts["scale"] == text["scale"]

    @pytest.mark.parametrize("name", SHARED)
    def test_a_sheet_sits_in_the_same_folder(self, name):
        assert DRAWN[name]["folder"] == TEXT[name]["folder"]

    @pytest.mark.parametrize("name", SHARED)
    def test_a_caption_that_names_the_author_names_the_text_slices_author(self, name):
        for author in DRAWN[name]["authors"]:
            assert author == TEXT[name]["author"], f"{name}: the caption says {author!r}"

    def test_the_schnitt_names_its_author_in_the_drawings_and_every_sheet_does_in_the_text(self):
        assert DRAWN["EP-02_Schnitt_A-A.pdf"]["authors"]
        assert all(TEXT[name]["author"] for name in SHARED)
        assert len({TEXT[name]["author"] for name in SHARED}) == 1


class TestThePlantedDifferencesStay:
    def test_the_schnitt_is_drawn_at_another_scale_than_the_grundrisse(self):
        assert TEXT["EP-02_Schnitt_A-A.pdf"]["scale"] != TEXT["EP-01_Grundrisse_Index-B.pdf"]["scale"]
        assert DRAWN["EP-02_Schnitt_A-A.pdf"]["scale"] != DRAWN["EP-01_Grundrisse_Index-B.pdf"]["scale"]

    def test_index_a_is_older_than_index_b(self):
        a, b = (TEXT[f"EP-01_Grundrisse_Index-{index}.pdf"]["date"] for index in "AB")
        assert datetime.strptime(a, "%d.%m.%Y") < datetime.strptime(b, "%d.%m.%Y")

    def test_the_plankopf_rows_ask_for_what_the_sheets_state(self):
        rows = {row["id"]: row for row in north_star_eval.load_questions()}
        schnitt = TEXT["EP-02_Schnitt_A-A.pdf"]
        wanted = {option for item in rows["ns-plankopf"]["expect"]["mentions"] for option in item}
        assert {schnitt["scale"], schnitt["date"]} <= wanted
        assert set(rows["ns-plankopf"]["expect"]["not_mentions"]) == {TEXT["EP-01_Grundrisse_Index-B.pdf"]["scale"]}
