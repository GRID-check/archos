"""The PDF text and table passes hold one page, against the real pdfplumber and PDFium.

Two 26-29 MB plan collections OOM-killed a 12 GiB ingest worker (2026-10-19)
before ``_extract_text_from_pdf`` returned. pdfplumber caches every parsed
object on its ``Page`` until the page is closed, the pages hang off the open
``PDF``, and nothing closed them: a CAD sheet of 20 000 paths stayed resident
at about 77 MiB until the last page was read. These tests pin the two bounds
that fixed it, on a generated set of drawing sheets
(``pdf_fixtures.build_drawing_sheets_pdf``):

- every pdfplumber page is closed before the next one is read, in both passes;
- a page denser than ``PDF_PAGE_MAX_OBJECTS`` never reaches pdfplumber at all,
  and keeps its text, read by PDFium.

They count cached pages through the library's own attribute
(``Page._objects``, what ``Page.close`` deletes) rather than measure RSS, so
they hold on any machine. Model-free and network-free.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer_testing import pdf_fixtures

_SHEETS = 4
#: Enough paths that pdfplumber's cache is real, few enough to stay fast.
_PATHS = 400


@pytest.fixture
def sheets(tmp_path: Path) -> str:
    path = tmp_path / "plaene.pdf"
    path.write_bytes(pdf_fixtures.build_drawing_sheets_pdf(_SHEETS, _PATHS))
    return str(path)


def _cached(pages: list) -> list[int]:
    return [index for index, page in enumerate(pages, start=1) if hasattr(page, "_objects")]


def test_the_text_pass_closes_each_page_before_reading_the_next(sheets, monkeypatch):
    seen: list = []
    cached_when_read: list[list[int]] = []
    read = adapter._read_pdf_page

    def _spy(page, page_num, previous, pdf_path):
        cached_when_read.append(_cached(seen))
        seen.append(page)
        return read(page, page_num, previous, pdf_path)

    monkeypatch.setattr(adapter, "_read_pdf_page", _spy)

    pages = adapter._extract_text_from_pdf(sheets)

    assert [page["page_number"] for page in pages] == list(range(1, _SHEETS + 1))
    assert cached_when_read == [[]] * _SHEETS
    assert _cached(seen) == []


def test_the_table_pass_closes_each_page_and_skips_the_dense_ones(sheets, monkeypatch):
    seen: list = []
    cached_when_read: list[list[int]] = []
    read = adapter._page_tables

    def _spy(page, page_num, skip):
        cached_when_read.append(_cached(seen))
        seen.append(page)
        return read(page, page_num, skip)

    monkeypatch.setattr(adapter, "_page_tables", _spy)

    adapter._extract_tables_from_pdf(sheets, {}, skip_pages=[2])

    assert [page.page_number for page in seen] == [1, 3, 4]
    assert cached_when_read == [[]] * 3
    assert _cached(seen) == []


def test_a_page_over_the_object_ceiling_is_read_by_pdfium_and_keeps_its_text(sheets, monkeypatch):
    monkeypatch.setattr(adapter, "PDF_PAGE_MAX_OBJECTS", _PATHS // 2)
    layout_reads: list[int] = []
    read = adapter._read_pdf_page
    monkeypatch.setattr(
        adapter,
        "_read_pdf_page",
        lambda page, page_num, *rest: layout_reads.append(page_num) or read(page, page_num, *rest),
    )

    pages = adapter._extract_text_from_pdf(sheets)

    assert layout_reads == []
    assert pages.dense_pages == list(range(1, _SHEETS + 1))
    assert [page["text"] for page in pages] == [f"Plan {n} Grundriss EG M 1:100" for n in range(1, _SHEETS + 1)]
    assert all(page["tables"] == [] and page["line_styles"] == [] for page in pages)
    assert [page["image_count"] for page in pages] == [0] * _SHEETS


def test_a_ceiling_of_zero_reads_every_page_with_layout(sheets, monkeypatch):
    monkeypatch.setattr(adapter, "PDF_PAGE_MAX_OBJECTS", 0)

    pages = adapter._extract_text_from_pdf(sheets)

    assert pages.dense_pages == []
    assert len(pages) == _SHEETS


def test_a_pdf_pdfium_cannot_count_is_left_to_the_layout_pass(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "PDF_PAGE_MAX_OBJECTS", 1)
    broken = tmp_path / "kaputt.pdf"
    broken.write_bytes(b"not a pdf")

    assert adapter._dense_page_texts(str(broken), 1) == {}


def test_releasing_memory_after_a_file_never_raises():
    adapter._release_memory("plaene.pdf")
