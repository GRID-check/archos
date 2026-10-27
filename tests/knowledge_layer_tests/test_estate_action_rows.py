"""The Herleitung rows of ``ls``, ``glob``, ``grep`` and ``read_file`` on the estate (ADR-0132 × ADR-0133).

One row per call, emitted by the estate backend itself from its own typed values.
What is pinned, per outcome:

* a row names a place (``mount``) and the folder inside it, never a path; a name
  pattern is the row's ``query``;
* counts are what the folder holds, not what the listing had room for;
* a literal search that could not search everything carries ``incomplete``, and
  one that found nothing in what it did search is ``empty``, never a failure;
* a folder or document that is not there is ``empty`` with the name asked for,
  and a restricted one answers with exactly the same row (ADR-0088);
* a read names the pages it served; a folder card is the folder's listing;
* the rows of reads and of a ``content`` grep share their ``call_id`` with the
  ``sources`` step of the passages they returned.
"""

from __future__ import annotations

import pytest
from knowledge_layer import estate_grep
from knowledge_layer import estate_listing

from aiq_agent.common import grounding_block
from aiq_agent.common import turn_status
from tests.knowledge_layer_tests import test_estate_grep as grep_suite
from tests.knowledge_layer_tests import test_estate_listing as listing_suite
from tests.knowledge_layer_tests import test_estate_read as read_suite

# The three suites' own autouse fixtures: the grep's retriever seam, no files in flight, the grounding capture.
_setup = grep_suite._setup
_no_in_flight = listing_suite._no_in_flight
_capture = read_suite._capture

FIRE_CONCEPT = "/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md"


@pytest.fixture
def steps(monkeypatch):
    out: list = []

    def record(step, started=False):
        out.append(step)

    monkeypatch.setattr(turn_status, "emit_step", record)
    monkeypatch.setattr(grounding_block, "emit_step", record)
    return out


def _row(steps) -> dict:
    """The one settled row of the call, as the wire carries it (no id, no time)."""
    rows = [s for s in steps if s.kind == "action" and s.status != "running"]
    assert len(rows) == 1, rows
    return rows[0].model_dump(exclude_none=True, exclude={"id", "call_id", "elapsed_ms", "scope", "kind", "round"})


def _linked(steps) -> int:
    row = next(s for s in steps if s.kind == "action" and s.status != "running")
    return sum(1 for s in steps if s.kind == "sources" and s.call_id == row.call_id)


def _grep_backend(**retriever):
    return grep_suite._backend(grep_suite.Retriever({grep_suite.COLLECTION: grep_suite._chunks()}, **retriever))


class TestList:
    async def test_a_folder_is_its_place_and_folder_with_what_it_holds(self, steps) -> None:
        await listing_suite._backend().ls("/project/Einreichung/")
        assert _row(steps) == {
            "verb": "list",
            "status": "ok",
            "mount": "project",
            "target": "Einreichung",
            "counts": {"files": 3, "folders": 1},
        }

    async def test_the_places_themselves_count_every_document(self, steps) -> None:
        await listing_suite._backend().ls("/")
        assert _row(steps) == {"verb": "list", "status": "ok", "mount": "estate", "counts": {"files": 6, "folders": 3}}

    async def test_a_place_root_has_no_folder(self, steps) -> None:
        await listing_suite._backend().ls("/law/oib/")
        assert _row(steps)["mount"] == "law" and "target" not in _row(steps)

    async def test_the_count_is_the_folders_not_the_listings_room(self, steps, monkeypatch) -> None:
        monkeypatch.setattr(estate_listing, "MAX_LS_FILES", 1)
        rows = [
            *listing_suite.ROWS,
            listing_suite.FileRow(
                file_name="EP-03.pdf", shelf="project", collection="proj_a", folder="Einreichung/Pläne"
            ),
        ]
        await listing_suite._backend(rows).ls("/project/Einreichung/Pläne/")
        assert _row(steps)["counts"] == {"files": 3, "folders": 0}

    async def test_a_missing_folder_is_not_found_and_a_restricted_one_reads_the_same(self, steps) -> None:
        await listing_suite._backend().ls("/project/Personal/")
        restricted = _row(steps)
        steps.clear()
        await listing_suite._backend().ls("/project/Persona/")
        missing = _row(steps)
        assert restricted == {
            "verb": "list",
            "status": "empty",
            "missing": True,
            "mount": "project",
            "target": "Personal",
        }
        assert {**missing, "target": "Personal"} == restricted

    async def test_a_name_pattern_is_the_query_beside_its_place(self, steps) -> None:
        await listing_suite._backend().glob("*.pdf", "/project/")
        assert _row(steps) == {
            "verb": "list",
            "status": "ok",
            "query": "*.pdf",
            "mount": "project",
            "counts": {"files": 3},
        }

    async def test_a_name_pattern_no_file_matches_is_empty_and_a_restricted_name_too(self, steps) -> None:
        await listing_suite._backend().glob("Vertrag*")
        assert _row(steps) == {
            "verb": "list",
            "status": "empty",
            "query": "Vertrag*",
            "mount": "estate",
            "counts": {"files": 0},
        }

    async def test_an_empty_project_is_there_and_empty_never_not_found(self, steps) -> None:
        """A new project, without a file yet: it was found, it holds nothing, and „Offen“ owes nothing."""
        office_only = [row for row in listing_suite.ROWS if row.shelf != "project"]
        await listing_suite._backend(office_only).ls("/project/")
        assert _row(steps) == {"verb": "list", "status": "ok", "mount": "project", "counts": {"files": 0, "folders": 0}}

    async def test_a_chat_without_uploads_is_there_and_empty(self, steps) -> None:
        await listing_suite._backend().ls("/chat/")
        assert _row(steps) == {"verb": "list", "status": "ok", "mount": "chat", "counts": {"files": 0, "folders": 0}}

    async def test_a_folder_counts_everything_it_holds_as_its_tree_and_card_do(self, steps) -> None:
        """One folder, one count: what `ls`, `ls(depth=2)` and its README.md say it holds (ADR-0132)."""
        await listing_suite._backend().ls("/project/Einreichung/")
        flat = _row(steps)["counts"]["files"]
        steps.clear()
        await listing_suite._backend().ls("/project/Einreichung/", depth=2)
        tree = _row(steps)["counts"]["files"]
        steps.clear()
        await listing_suite._backend().read_file("/project/Einreichung/README.md")
        card = _row(steps)["counts"]["files"]
        assert flat == tree == card == 3

    async def test_a_folder_counts_its_own_subfolders_at_any_depth(self, steps) -> None:
        """Depth 2 draws a card for every folder below; the row still counts the folder's own subfolders."""
        rows = [
            *listing_suite.ROWS,
            listing_suite.FileRow(
                file_name="Detail.pdf", shelf="project", collection="proj_a", folder="Einreichung/Pläne/Details"
            ),
        ]
        counts = []
        for depth in (1, 2, 3):
            steps.clear()
            await listing_suite._backend(rows).ls("/project/Einreichung/", depth=depth)
            counts.append(_row(steps)["counts"]["folders"])
        steps.clear()
        await listing_suite._backend(rows).read_file("/project/Einreichung/README.md")
        assert counts == [1, 1, 1] == [_row(steps)["counts"]["folders"]] * 3

    async def test_the_places_count_what_a_grep_everywhere_searches(self, steps) -> None:
        """„3 Ablagen, N Dateien“ and „kein Treffer in N Dateien“ are one N when nothing failed."""
        await grep_suite._backend(grep_suite.Retriever({grep_suite.COLLECTION: grep_suite._chunks()})).ls("/")
        places = _row(steps)["counts"]["files"]
        steps.clear()
        await _grep_backend().grep("Sprinklerzentrale")
        assert _row(steps)["counts"]["searched"] == places

    async def test_a_path_that_names_no_place_is_a_failed_listing_of_no_named_folder(self, steps) -> None:
        """`/drafts/../project/` never reaches the row as „drafts › .. › project“."""
        await listing_suite._backend().ls("/drafts/../project/")
        assert _row(steps) == {"verb": "list", "status": "error"}

    async def test_a_listing_returns_no_card(self, steps) -> None:
        await listing_suite._backend().ls("/project/")
        assert _linked(steps) == 0


class TestGrep:
    async def test_a_literal_search_names_its_place_mode_and_denominator(self, steps) -> None:
        await _grep_backend().grep("Fluchtweg", path="/project/")
        assert _row(steps) == {
            "verb": "search",
            "status": "ok",
            "query": "Fluchtweg",
            "mode": "exact",
            "mount": "project",
            "counts": {"hits": 3, "documents": 1, "searched": 1},
        }

    async def test_without_a_path_it_searched_every_place(self, steps) -> None:
        await _grep_backend().grep("Sprinklerzentrale")
        row = _row(steps)
        assert (row["status"], row["mount"], row["counts"]["searched"]) == ("empty", "estate", 2)
        assert "incomplete" not in row and "target" not in row

    async def test_a_place_that_did_not_answer_makes_hits_a_floor(self, steps) -> None:
        await _grep_backend(fail={grep_suite.OFFICE}).grep("Fluchtweg")
        row = _row(steps)
        assert (row["status"], row["incomplete"], row["counts"]["searched"]) == ("ok", True, 1)

    async def test_no_hit_in_what_could_be_searched_is_empty_and_incomplete_never_a_failure(self, steps) -> None:
        await _grep_backend(fail={grep_suite.OFFICE}).grep("Sprinklerzentrale")
        row = _row(steps)
        assert (row["status"], row["incomplete"]) == ("empty", True)

    async def test_a_capped_scan_is_incomplete(self, steps, monkeypatch) -> None:
        monkeypatch.setattr(estate_grep, "MAX_MATCH_CHUNKS", 1)
        await _grep_backend().grep("Fluchtweg")
        assert _row(steps)["incomplete"] is True

    async def test_nothing_searched_at_all_is_a_failure(self, steps) -> None:
        await grep_suite._backend(grep_suite.Retriever({}, fail={grep_suite.COLLECTION, grep_suite.OFFICE})).grep(
            "Fluchtweg"
        )
        assert _row(steps)["status"] == "error"

    async def test_content_links_its_row_to_the_passages_it_returned(self, steps) -> None:
        await _grep_backend().grep("Fluchtweg", path="/project/", output_mode="content")
        assert _linked(steps) == 1

    async def test_a_path_that_names_no_place_names_no_folder(self, steps) -> None:
        await _grep_backend().grep("Fluchtweg", path="/nirgends/")
        assert _row(steps) == {"verb": "search", "status": "error", "query": "Fluchtweg", "mode": "exact"}


class TestRead:
    async def test_a_read_names_its_document_and_the_pages_it_served(self, steps) -> None:
        await read_suite._backend().read_file(FIRE_CONCEPT, pages="2-3")
        assert _row(steps) == {
            "verb": "read",
            "status": "ok",
            "target": "Brandschutzkonzept.pdf",
            "pages": "2-3",
            "shelf": "project",
            "counts": {"hits": 2, "documents": 1},
        }
        assert _linked(steps) == 1

    async def test_while_it_runs_a_read_names_what_was_asked_for(self, steps) -> None:
        await read_suite._backend().read_file(FIRE_CONCEPT, pages="2")
        running = next(s for s in steps if s.kind == "action" and s.status == "running")
        assert running.target == "Brandschutzkonzept.pdf"

    async def test_a_read_without_pages_says_the_page_it_opened(self, steps) -> None:
        await read_suite._backend().read_file(FIRE_CONCEPT)
        assert _row(steps)["pages"] == "1"

    async def test_a_refused_pages_value_is_never_printed(self, steps) -> None:
        await read_suite._backend().read_file(FIRE_CONCEPT, pages="x")
        row = _row(steps)
        assert row["status"] == "error" and "pages" not in row

    async def test_a_miss_is_not_found_by_the_name_asked_for(self, steps) -> None:
        await read_suite._backend().read_file("/project/Personal/Gehalt.pdf.md")
        assert _row(steps) == {"verb": "read", "status": "empty", "missing": True, "target": "Gehalt.pdf"}

    async def test_a_guessed_restricted_path_reads_exactly_like_a_miss(self, steps) -> None:
        """Nothing on the row confirms the file: no shelf, no count, the asked name only (ADR-0088)."""
        await read_suite._backend(restricted=()).read_file("/project/Personal/Vertrag.pdf.md")
        guessed = _row(steps)
        steps.clear()
        await read_suite._backend(restricted=()).read_file("/project/Personal/Vertrxg.pdf.md")
        absent = _row(steps)
        assert guessed == {"verb": "read", "status": "empty", "missing": True, "target": "Vertrag.pdf"}
        assert {**absent, "target": "Vertrag.pdf"} == guessed

    @pytest.mark.parametrize(
        ("path", "place"),
        [
            ("/project/Gutachten/README.md", {"mount": "project", "target": "Gutachten"}),
            # A place's root card: the row names the place, never „README“ as if it were a folder.
            ("/project/README.md", {"mount": "project"}),
        ],
    )
    async def test_a_folder_card_is_the_folders_listing(self, steps, path, place) -> None:
        await read_suite._backend().read_file(path)
        row = _row(steps)
        assert row["verb"] == "list"
        assert {key: row[key] for key in ("mount", "target") if key in row} == place
        assert row["counts"]["files"] >= 1
