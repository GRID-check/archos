"""Captioned tables are indexed as tables, not as text read across their columns.

OIB-Richtlinie 2's Tabelle 3 reached the agent as „an der obersten an der
obersten an der obersten Stelle …" and cost the September 2026 census three
research rounds. These pin the pure half: fragments joined across pages, the
header repeated in every chunk, a two-row header merged so each column still
names what it holds, and the per-page path keeping a table rather than losing it.
"""

from __future__ import annotations

from types import SimpleNamespace

from knowledge_layer.llamaindex.captioned_tables import PageTable
from knowledge_layer.llamaindex.captioned_tables import join_fragments
from knowledge_layer.llamaindex.captioned_tables import markdown_chunks
from knowledge_layer.llamaindex.captioned_tables import page_text_with_tables
from knowledge_layer.llamaindex.punkt_chunking import punkt_documents

HEADER = ["Gegenstand", "GK 3", "GK 4", "GK 5"]
ROWS = [
    ["1.1 in oberirdischen Geschoßen", "REI 60", "REI 60", "REI 90 und A2"],
    ["2 Decke über dem Treppenhaus", "REI 60", "REI 60", "REI 90 und A2"],
]


def _table(rows=None, **kw) -> PageTable:
    return PageTable("3", "Anforderungen an Treppenhäuser", [HEADER, *(rows or ROWS)], kw.pop("page", 30), **kw)


def test_a_table_reads_as_rows_under_its_columns():
    [chunk] = markdown_chunks(join_fragments([_table()])[0])
    assert chunk.splitlines()[0] == "| Gegenstand | GK 3 | GK 4 | GK 5 |"
    assert "| 1.1 in oberirdischen Geschoßen | REI 60 | REI 60 | REI 90 und A2 |" in chunk


def test_every_chunk_of_a_long_table_carries_the_header():
    rows = [[f"{n} Bauteil mit einer längeren Bezeichnung", "REI 60", "REI 60", "REI 90"] for n in range(60)]
    chunks = markdown_chunks(join_fragments([_table(rows)])[0], max_chars=800)
    assert len(chunks) > 2
    assert all(chunk.startswith("| Gegenstand | GK 3 | GK 4 | GK 5 |") for chunk in chunks)
    assert all(len(chunk) <= 800 for chunk in chunks)


def test_a_continuation_joins_its_table_and_drops_the_repeated_header():
    first = _table()
    second = PageTable("3", first.title, [HEADER, ["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"]], 31, True)
    [table] = join_fragments([first, second])
    assert (table.page_start, table.page_end) == (30, 31)
    assert [row[0] for row in table.rows] == ["Gegenstand", *[row[0] for row in ROWS], "4.1 in Treppenhäusern"]


def test_a_two_row_header_names_every_column():
    rows = [
        ["Gebäudeklassen", "GK 4", "GK 5", ""],
        ["", "", "≤ 6 Geschoße", "> 6 Geschoße"],
        ["1.5 Gebäudetrennfugenmaterial", "A2", "A2", "A2"],
    ]
    table = join_fragments([PageTable("1a", "Brandverhalten", rows, 24)])[0]
    head = markdown_chunks(table)[0].splitlines()[0]
    assert head == "| Gebäudeklassen | GK 4 | GK 5 ≤ 6 Geschoße | GK 5 > 6 Geschoße |"


def test_the_per_page_path_keeps_the_table():
    text = page_text_with_tables("Fließtext der Seite.", [_table()])
    assert text.startswith("Fließtext der Seite.")
    assert "Tabelle 3: Anforderungen an Treppenhäuser" in text
    assert "| 2 Decke über dem Treppenhaus | REI 60 | REI 60 | REI 90 und A2 |" in text


def test_a_richtlinie_indexes_its_table_as_an_addressable_passage():
    body = "\n".join(f"{n} Punkt Nummer {n}\nText zu Punkt {n}, lang genug um zu zählen." for n in range(1, 8))
    pages = [
        {"page_number": 1, "text": "OIB-Richtlinie 9 Ausgabe Mai 2023\n" + body},
        {"page_number": 2, "text": "Tabelle 3: Anforderungen", "tables": [_table(page=2)]},
    ]
    documents = punkt_documents(pages, "oib-rl_9_ausgabe_mai_2023.pdf", 1)
    [table] = [d for d in documents if d.metadata.get("chunking") == "table"]
    assert table.metadata["punkt_id"] == "Tabelle 3"
    assert table.metadata["content_type"] == "table"
    assert "punkt_depth" not in table.metadata
    assert "Tabelle 3: Anforderungen an Treppenhäuser" in table.text


def test_the_row_group_order_is_not_embedded_or_shown_to_the_model():
    """``table_part`` orders row groups for ``read_passage``; it is no retrieval signal."""
    from llama_index.core.schema import MetadataMode

    body = "\n".join(f"{n} Punkt Nummer {n}\nText zu Punkt {n}, lang genug um zu zählen." for n in range(1, 8))
    pages = [
        {"page_number": 1, "text": "OIB-Richtlinie 9 Ausgabe Mai 2023\n" + body},
        {"page_number": 2, "text": "Tabelle 3: Anforderungen", "tables": [_table(page=2)]},
    ]
    documents = punkt_documents(pages, "oib-rl_9_ausgabe_mai_2023.pdf", 1)
    [table] = [d for d in documents if d.metadata.get("chunking") == "table"]
    assert table.metadata["table_part"] == 1
    for mode in (MetadataMode.EMBED, MetadataMode.LLM):
        assert "table_part" not in table.get_content(metadata_mode=mode)


def test_a_caption_without_a_title_is_the_table_number_alone():
    body = "\n".join(f"{n} Punkt Nummer {n}\nText zu Punkt {n}, lang genug um zu zählen." for n in range(1, 8))
    untitled = PageTable("3", "", [HEADER, *ROWS], 2)
    pages = [
        {"page_number": 1, "text": "OIB-Richtlinie 9 Ausgabe Mai 2023\n" + body},
        {"page_number": 2, "text": "Tabelle 3:", "tables": [untitled]},
    ]
    [table] = [
        d for d in punkt_documents(pages, "oib-rl_9_ausgabe_mai_2023.pdf", 1) if d.metadata["chunking"] == "table"
    ]
    assert table.metadata["punkt_path"] == "Tabelle 3"
    assert "\nTabelle 3\n" in table.text
    assert page_text_with_tables("", [untitled]).startswith("Tabelle 3\n")


class _FakeTable:
    def __init__(self, rows, top, left=0):
        self._rows = rows
        self.bbox = (left, top, left + 500, top + 100)

    def extract(self):
        return self._rows


class _FakeRegion:
    def __init__(self, text):
        self._text = text

    def extract_text(self):
        return self._text


class _FakePage:
    """A pdfplumber page: its tables, and the caption text standing above them (if any).

    ``within_bbox`` refuses a region outside the page's box, as pdfplumber does. The
    fake once accepted any region, so a crop built from ``(0, 0)`` passed here and
    failed on every page whose box does not start at the origin.
    """

    def __init__(self, tables=(), caption="", bbox=(0, 0, 600, 842)):
        self._tables = list(tables)
        self._caption = caption
        self.bbox = bbox
        self.width = bbox[2] - bbox[0]

    def find_tables(self):
        return self._tables

    def within_bbox(self, bbox):
        x0, top, x1, bottom = self.bbox
        if bbox[0] < x0 or bbox[1] < top or bbox[2] > x1 or bbox[3] > bottom:
            raise ValueError(f"Bounding box {bbox} is not fully within parent page bounding box {self.bbox}")
        return _FakeRegion(self._caption)

    def filter(self, predicate):
        return self

    def extract_text(self):
        return "Fließtext."


def test_a_captionless_box_pages_later_does_not_continue_an_old_table(monkeypatch):
    """Tabelle 3 on p.3, nothing on p.4, a caption-less ruled box at the top of
    p.9: the box used to be appended to Tabelle 3 because the last table was
    remembered across every page after it."""
    import pdfplumber
    from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf

    box = _FakeTable([["Formular", "Feld"], ["Name", "—"]], top=60)
    pages = [
        _FakePage(),
        _FakePage(),
        _FakePage([_FakeTable([HEADER, *ROWS], top=300)], caption="Tabelle 3: Anforderungen an Treppenhäuser"),
        _FakePage(),
        *[_FakePage() for _ in range(4)],
        _FakePage([box]),
    ]
    pdf = SimpleNamespace(pages=pages)

    class _Open:
        def __enter__(self):
            return pdf

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pdfplumber, "open", lambda path: _Open())

    extracted = _extract_text_from_pdf("x.pdf")

    tables = [(page["page_number"], table.table_id) for page in extracted for table in page["tables"]]
    assert tables == [(3, "3")]


def test_the_table_pass_skips_what_the_captioned_pass_took(monkeypatch):
    """AIQ_EXTRACT_TABLES read every pdfplumber table again: Tabelle 3 stood in
    the index twice, as „Tabelle 3" and as „[TABLE from page 1]"."""
    import pdfplumber
    from knowledge_layer.llamaindex.adapter import _extract_tables_from_pdf
    from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf

    box = _FakeTable([["Formular", "Feld"], ["Name", "—"]], top=400)
    pdf = SimpleNamespace(
        pages=[
            _FakePage([_FakeTable([HEADER, *ROWS], top=300)], caption="Tabelle 3: Anforderungen an Treppenhäuser"),
            _FakePage(),
            _FakePage([box]),
        ]
    )

    class _Open:
        def __enter__(self):
            return pdf

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pdfplumber, "open", lambda path: _Open())

    text_pages = _extract_text_from_pdf("x.pdf")
    taken = {page["page_number"]: page["table_boxes"] for page in text_pages}
    tables = _extract_tables_from_pdf("x.pdf", taken)

    assert [(table["page_number"], table["table_text"].splitlines()[0]) for table in tables] == [
        (3, "| Formular | Feld |")
    ]


def test_a_page_whose_box_is_not_at_the_origin_still_reads_its_tables():
    """A CAD export's sheet, box (-1162, 1275, 1162, 3826): the caption region was built
    from x 0 and page.width, pdfplumber refused it, and every table on the page went
    unread (2026-10, ``WR_25003_P1240_0.pdf``)."""
    from knowledge_layer.llamaindex.captioned_tables import extract_page_tables

    box = (-1162.2, 1275.54, 1162.2, 3826.62)
    captioned = _FakeTable([HEADER, *ROWS], top=1700, left=-1000)
    page = _FakePage([captioned], caption="Tabelle 3: Anforderungen an Treppenhäuser", bbox=box)

    [(fragment, _bbox)] = extract_page_tables(page, 1, None)

    assert fragment.table_id == "3"


def test_a_continuation_is_measured_from_the_top_of_its_page_box():
    from knowledge_layer.llamaindex.captioned_tables import extract_page_tables

    box = (-1162.2, 1275.54, 1162.2, 3826.62)
    near_top = _FakeTable([["4.1 in Treppenhäusern", "R 60"], ["4.2", "R 30"]], top=1275.54 + 60, left=-1000)

    [(fragment, _bbox)] = extract_page_tables(_FakePage([near_top], bbox=box), 4, _table(page=3))

    assert fragment.continuation


def test_only_the_next_page_can_continue_a_table():
    from knowledge_layer.llamaindex.captioned_tables import extract_page_tables

    previous = _table(page=3)
    page = _FakePage(
        [_FakeTable([["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"], ["4.2", "R 30", "R 30", "R 60"]], 60)]
    )

    assert extract_page_tables(page, 9, previous) == []
    [(fragment, _bbox)] = extract_page_tables(page, 4, previous)
    assert fragment.continuation and fragment.table_id == "3"


def test_a_continuation_on_its_own_page_keeps_its_first_row_as_data():
    """The per-page path renders a continuation without its table; its first
    row is a requirement, not the column labels."""
    first_row = ["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"]
    fragment = PageTable("3", "Anforderungen", [first_row, ["4.2 Wände", "R 30", "R 30", "R 60"]], 31, True)

    text = page_text_with_tables("", [fragment])

    lines = text.splitlines()
    assert lines[0] == "|  |  |  |  |"
    assert "| 4.1 in Treppenhäusern | R 60 | R 60 | R 90 |" in lines[2:]


def test_a_captioned_table_is_cited_by_its_page_not_as_table_1():
    """Every captioned table carried no ``table_index`` and was cited
    „<file>, p.N, Table 1", whichever table it was, under a key no other hit
    on that page renders."""
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from llama_index.core.schema import NodeWithScore
    from llama_index.core.schema import TextNode

    node = TextNode(
        text="| a | b |",
        metadata={"file_name": "oib-rl_2.pdf", "page_label": "30", "content_type": "table", "punkt_id": "Tabelle 3"},
    )
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})

    chunk = retriever.normalize(NodeWithScore(node=node, score=0.5))

    assert chunk.display_citation == "oib-rl_2.pdf, p.30"


def test_a_table_page_counts_its_table_as_text_for_the_visual_page_check():
    """A page that is mostly a captioned table kept only its caption-free prose
    in ``text``, fell under the visual-page threshold and was VLM-captioned as a
    drawing (oib-rl_2 pages 29, 31, 33, 34), competing with the table's chunks."""
    from knowledge_layer.llamaindex.adapter import VISUAL_PAGE_MIN_TEXT_CHARS
    from knowledge_layer.llamaindex.adapter import page_texts_for_visual_heuristic

    page = {"page_number": 30, "text": "Seite 30", "tables": [_table()]}

    texts = page_texts_for_visual_heuristic([page])

    assert len(page["text"]) < VISUAL_PAGE_MIN_TEXT_CHARS <= len(texts[30])
    assert "REI 90 und A2" in texts[30]
