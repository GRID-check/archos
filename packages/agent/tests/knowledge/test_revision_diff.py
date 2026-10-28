"""The cheap layers of the Fassung compare, held to planted changes (ADR-0104).

Each fixture is two Fassungen of one document as their chunks are stored, with
one change planted in the newer. The compare must find the planted change and
nothing else: a report that lists unchanged pages, or a reworded model summary,
as changes sends the reader hunting for differences that are not there.
"""

from __future__ import annotations

import json

from aiq_agent.knowledge.revision_diff import RevisionChunk
from aiq_agent.knowledge.revision_diff import changed_pages
from aiq_agent.knowledge.revision_diff import chunk_from_store
from aiq_agent.knowledge.revision_diff import diff_revisions
from aiq_agent.knowledge.revision_diff import diff_title_blocks
from aiq_agent.knowledge.revision_diff import render_diff

PAGE_1 = "Brandschutzkonzept Wohnbau Nord\nGebäudeklasse 4\nFluchtweglänge 38 m bis zum Stiegenhaus"
PAGE_2 = "Tragwerk\nDecken REI 90\nWände REI 90"
PAGE_3 = "Haustechnik\nLüftung über Dach"


def _text(page: str, text: str) -> RevisionChunk:
    return RevisionChunk(page=page, content_type="text", text=text)


def _drawing(page: str, quantities: list[dict], annotations: list[str], summary: str = "") -> RevisionChunk:
    segment = {"summary": summary, "quantities": quantities, "annotations": annotations}
    return RevisionChunk(page=page, content_type="drawing", text=summary, structured={"segment": segment})


class TestPrintedText:
    def test_identical_revisions_have_no_change(self) -> None:
        chunks = [_text("1", PAGE_1), _text("2", PAGE_2)]
        diff = diff_revisions(chunks, chunks)
        assert diff.pages == ()
        assert diff.unchanged_pages == 2

    def test_a_moved_value_is_reported_with_what_it_is_about(self) -> None:
        older = [_text("1", PAGE_1), _text("2", PAGE_2)]
        newer = [_text("1", PAGE_1.replace("38 m", "42 m")), _text("2", PAGE_2)]

        diff = diff_revisions(older, newer)

        assert len(diff.pages) == 1
        change = diff.pages[0]
        assert change.kind == "changed" and change.newer_page == "1"
        assert [(v.subject, v.older, v.newer) for v in change.values] == [("Fluchtweglänge", "38 m", "42 m")]
        # A value that moved is not also reported as a removed and an added line.
        assert change.removed_lines == () and change.added_lines == ()
        assert diff.unchanged_pages == 1

    def test_a_new_line_is_added_not_a_change_of_its_neighbour(self) -> None:
        older = [_text("2", PAGE_2)]
        newer = [_text("2", PAGE_2 + "\nStützen R 90")]
        change = diff_revisions(older, newer).pages[0]
        assert change.added_lines == ("Stützen R 90",)
        assert change.removed_lines == ()

    def test_an_inserted_page_shifts_nothing_after_it(self) -> None:
        """Page n against page n would report every page after the insertion as changed."""
        older = [_text("1", PAGE_1), _text("2", PAGE_2), _text("3", PAGE_3)]
        newer = [_text("1", PAGE_1), _text("2", "Neues Blatt\nAußenanlagen"), _text("3", PAGE_2), _text("4", PAGE_3)]

        diff = diff_revisions(older, newer)

        assert [(c.kind, c.older_page, c.newer_page) for c in diff.pages] == [("added", None, "2")]
        assert diff.unchanged_pages == 3

    def test_a_removed_page_is_reported_as_removed(self) -> None:
        older = [_text("1", PAGE_1), _text("2", PAGE_2)]
        newer = [_text("1", PAGE_1)]
        assert [(c.kind, c.older_page) for c in diff_revisions(older, newer).pages] == [("removed", "2")]

    def test_overlapping_chunks_of_one_page_do_not_read_as_a_change(self) -> None:
        """Chunks overlap; a line read twice in a row is one line on both sides."""
        older = [_text("1", PAGE_1)]
        lines = PAGE_1.splitlines()
        newer = [_text("1", "\n".join(lines[:2])), _text("1", "\n".join(lines[1:]))]
        assert diff_revisions(older, newer).pages == ()


class TestDrawingReading:
    def test_a_changed_quantity_is_reported_and_a_reworded_summary_is_not(self) -> None:
        room = {"object": "Wohnraum", "property": "Fläche", "value": "24,5", "unit": "m²"}
        older = [_drawing("1", [room], ["2,50", "3,20"], summary="Grundriss Erdgeschoss mit Wohnraum.")]
        newer = [
            _drawing(
                "1",
                [{**room, "value": "26,1"}],
                ["2,50", "3,40"],
                summary="Der Grundriss zeigt das Erdgeschoss, darin einen Wohnraum.",
            )
        ]

        change = diff_revisions(older, newer).pages[0]

        assert [(v.subject, v.older, v.newer) for v in change.drawing_values] == [
            ("wohnraum fläche", "24,5 m²", "26,1 m²")
        ]
        assert change.annotations_added == ("3,40",)
        assert change.annotations_removed == ("3,20",)
        # The summary is prose a model wrote; it is not compared.
        assert change.added_lines == () and change.removed_lines == ()

    def test_the_same_reading_is_no_change(self) -> None:
        room = {"object": "Wohnraum", "property": "Fläche", "value": "24,5", "unit": "m²"}
        older = [_drawing("1", [room], ["2,50"], summary="Grundriss.")]
        newer = [_drawing("1", [room], ["2,50"], summary="Ein Grundriss des Erdgeschosses.")]
        assert diff_revisions(older, newer).pages == ()


class TestTitleBlock:
    def test_index_and_date_moved(self) -> None:
        changes = diff_title_blocks(
            {"document_number": "A-101", "revision": "B", "revision_date": "2026-07-02"},
            {"document_number": "A-101", "revision": "C", "revision_date": "2026-08-14"},
        )
        assert [(c.label, c.older, c.newer) for c in changes] == [
            ("Index", "B", "C"),
            ("Stand", "2026-07-02", "2026-08-14"),
        ]

    def test_none_on_either_side_compares_what_is_printed(self) -> None:
        assert diff_title_blocks(None, None) == ()
        assert [c.field for c in diff_title_blocks(None, {"revision": "A"})] == ["revision"]


class TestFromTheStore:
    def test_a_text_chunk_and_a_drawing_chunk_are_read(self) -> None:
        text = chunk_from_store("[TEXT from page 3]\nDecken REI 90", {"page_label": "3", "content_type": "text"})
        assert text == RevisionChunk(page="3", content_type="text", text="[TEXT from page 3]\nDecken REI 90")
        drawing_data = json.dumps({"segment": {"quantities": [], "annotations": ["1:100"]}})
        drawing = chunk_from_store("…", {"page_label": "1", "content_type": "drawing", "drawing_data": drawing_data})
        assert drawing is not None and drawing.structured == {"segment": {"quantities": [], "annotations": ["1:100"]}}

    def test_a_caption_without_structure_is_not_compared(self) -> None:
        assert chunk_from_store("Ein Foto der Fassade.", {"page_label": "1", "content_type": "image"}) is None

    def test_the_page_marker_is_not_a_line(self) -> None:
        older = [chunk_from_store("[TEXT from page 1]\nA", {"page_label": "1", "content_type": "text"})]
        newer = [chunk_from_store("[TEXT from page 1]\nA", {"page_label": "1", "content_type": "text"})]
        assert diff_revisions([c for c in older if c], [c for c in newer if c]).pages == ()


class TestRendering:
    def test_the_report_leads_with_the_title_block_and_says_what_it_did_not_compare(self) -> None:
        older = [_text("1", PAGE_1)]
        newer = [_text("1", PAGE_1.replace("38 m", "42 m"))]
        diff = diff_revisions(older, newer, older_facts={"revision": "B"}, newer_facts={"revision": "C"})

        text = render_diff(diff, "Konzept_B.pdf", "Konzept_C.pdf")

        assert "„Konzept_B.pdf“ (older) → „Konzept_C.pdf“ (newer)" in text
        assert "Plankopf (title block): Index B → C." in text
        assert "Page 1: Values: Fluchtweglänge 38 m → 42 m." in text
        assert "not the drawings themselves" in text

    def test_nothing_to_compare_never_reads_as_the_same(self) -> None:
        empty = diff_revisions([], [])
        assert "it does not follow that they are the same" in render_diff(empty, "a.pdf", "b.pdf")

    def test_the_report_is_bounded(self) -> None:
        older = [_text(str(n), f"Blatt {n}\nWert 1 m") for n in range(1, 41)]
        newer = [_text(str(n), f"Blatt {n}\nWert 2 m") for n in range(1, 41)]
        text = render_diff(diff_revisions(older, newer), "a.pdf", "b.pdf")
        assert "… and 30 more changed pages." in text
        assert len(text) < 4000


class TestChangedPages:
    """What a notice spends its look on (ADR-0130): the newer Fassung's changed pages, by number."""

    def test_only_changed_and_new_pages_of_the_newer_revision(self) -> None:
        older = [_text("1", PAGE_1), _text("2", PAGE_2), _text("3", PAGE_3)]
        newer = [_text("1", PAGE_1), _text("2", PAGE_2.replace("REI 90", "REI 60")), _text("3", PAGE_3)]
        newer.append(_text("4", "Anhang\nNeue Tabelle"))

        assert changed_pages(diff_revisions(older, newer)) == (2, 4)

    def test_a_removed_page_and_an_unnumbered_label_are_left_out(self) -> None:
        older = [_text("1", PAGE_1), _text("2", PAGE_2), _text("3", PAGE_3)]
        newer = [_text("1", PAGE_1), _text("iv", "Vorwort\nneu")]

        assert changed_pages(diff_revisions(older, newer)) == ()

    def test_nothing_changed_is_no_page(self) -> None:
        pages = [_text("1", PAGE_1), _text("2", PAGE_2)]

        assert changed_pages(diff_revisions(pages, pages)) == ()
