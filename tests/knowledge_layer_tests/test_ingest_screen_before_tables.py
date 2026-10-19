"""The upload screen runs before the table pass: a held file never pays for its tables.

The PDF pipeline is text extraction, then the table pass, then everything a
model reads. The screen used to run last, so a file it was going to hold paid
the whole table pass (measured on production: 125 s of a 133-page PDF) for
output nothing would index. Here the text layer is screened first, the tables
only after it passes, and the tables are screened themselves — still before any
model call — so a match that only a lost page's table carries still holds the
file.

Offline and model-free, so it runs without the Qdrant server the fuller
``test_upload_screening_ingestion`` needs: a hand-built PDF, a stub store,
recording call sites, and the same rules the shipped screen uses.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import processing
from knowledge_layer.llamaindex import screening
from knowledge_layer.llamaindex import transcription
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.knowledge.schema import FileStatus
from sources.knowledge_layer.tests.qdrant_testing import FakeEmbedder
from sources.knowledge_layer.tests.qdrant_testing import capture_indexed_documents

from .test_upload_screening_ingestion import _pdf
from .test_upload_screening_ingestion import _pdf_with_table_page
from .test_upload_screening_ingestion import _reasons
from .test_upload_screening_ingestion import _text_pass_loses_page

_TERMS = {"content_terms": ["Gehaltsabrechnung"], "detectors": []}
_PAYSLIP = ("Gehaltsabrechnung Maerz 2026", "Brutto 4.200,00 EUR", "Projekt Musterstrasse 5")


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def store(monkeypatch):
    """A Qdrant stub, so this module needs no server: scrolls nothing, writes nothing."""
    from knowledge_layer.qdrant import store as store_module
    from knowledge_layer.qdrant import writes as writes_module

    fake = MagicMock()
    fake.scroll.return_value = []
    monkeypatch.setattr(store_module, "get_store", lambda *args, **kwargs: fake)
    # ``writes`` bound ``get_store`` at import, so it needs the same stub.
    monkeypatch.setattr(writes_module, "get_store", lambda *args, **kwargs: fake)
    monkeypatch.setattr(writes_module, "write_chunks", lambda *args, **kwargs: None)
    return fake


@pytest.fixture
def calls(tmp_path, monkeypatch, summary_db, store):
    """The ingestor, and a recorder for the call sites that leave the pod (none do here)."""
    record: dict[str, list] = {"ocr": [], "vlm": [], "indexed": []}
    cred = ResolvedCredential(api_key="", base_url="", model="", source="env")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)

    def _route(path, text_pages, page_texts, **kwargs):
        record["ocr"].append(kwargs.get("triage", "measured-inside"))
        return transcription.PageRoutes()

    monkeypatch.setattr(transcription, "route_pdf_pages", _route)
    monkeypatch.setattr(processing, "enrich_vlm_batch", lambda **kwargs: record["vlm"].append(kwargs) or ([], []))
    monkeypatch.setattr(processing, "render_visual_pages_no_vlm", lambda *a, **k: [])

    ingestor = LlamaIndexIngestor({"extract_images": False, "extract_charts": False})
    ingestor._embed_model = FakeEmbedder()
    ingestor._initialized = True
    record["ingestor"] = ingestor
    record["indexed"] = capture_indexed_documents(monkeypatch)
    return record


def _ingest(calls: dict, path, name: str, screening: dict | None, **config):
    ingestor = calls["ingestor"]
    if screening is not None:
        config["screening"] = screening
    job_id = ingestor.submit_job([str(path)], "proj_1", config={"original_filenames": [name], **config})
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ingestor.get_job_status(job_id)
        if status.is_terminal:
            return status.file_details[0]
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _table_documents(calls: dict) -> list:
    return [
        document
        for documents in calls["indexed"]
        for document in documents
        if document.metadata.get("content_type") == "table"
    ]


class TestAHeldFileNeverExtractsTables:
    def test_a_term_in_the_text_layer_holds_it_before_the_table_pass(self, tmp_path, calls, monkeypatch):
        def _fail(*args, **kwargs):
            raise AssertionError("the table pass ran for a file the screen held")

        monkeypatch.setattr(adapter, "_extract_tables_from_pdf", _fail)

        detail = _ingest(calls, _pdf(tmp_path, *_PAYSLIP), "Abrechnung.pdf", _TERMS)

        assert detail.status == FileStatus.FAILED
        assert detail.screening == "quarantined"
        # The same reason, from the same locally extracted text, as before the split.
        assert _reasons(detail.error_message)["reasons"] == [
            {"kind": "term", "term": "Gehaltsabrechnung", "count": 1, "pages": [1]}
        ]
        assert calls["ocr"] == [] and calls["vlm"] == []

    def test_a_term_in_the_text_layer_and_a_table_never_reaches_the_table_pass(self, tmp_path, calls, monkeypatch):
        """A table the file also carries is read only after the text layer passes."""
        path = _pdf_with_table_page(tmp_path, monkeypatch, [["Posten", "Betrag"], ["Gehaltsabrechnung", "4200"]])
        seen: list[str] = []
        real = adapter._extract_tables_from_pdf

        def _record(*args, **kwargs):
            seen.append("tables")
            return real(*args, **kwargs)

        monkeypatch.setattr(adapter, "_extract_tables_from_pdf", _record)

        detail = _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=True)

        assert detail.status == FileStatus.FAILED
        assert detail.screening == "quarantined"
        assert seen == []


class TestTheTablesAreStillScreened:
    def test_a_term_only_in_a_lost_page_table_still_holds_the_file(self, tmp_path, calls, monkeypatch):
        # One page of five is within the failed-page tolerance, so the file
        # stands; only the table pass reads page 2, and only its table carries
        # the term. The text screen passes, the tables are read and screened,
        # and the file is held — the same finding as before the split.
        path = _pdf_with_table_page(tmp_path, monkeypatch, [["Posten", "Betrag"], ["Gehaltsabrechnung", "4200"]])
        _text_pass_loses_page(monkeypatch, 2)
        seen: list[str] = []
        real = adapter._extract_tables_from_pdf

        def _record(*args, **kwargs):
            seen.append("tables")
            return real(*args, **kwargs)

        monkeypatch.setattr(adapter, "_extract_tables_from_pdf", _record)

        detail = _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=True)

        assert detail.status == FileStatus.FAILED
        assert detail.screening == "quarantined"
        assert _reasons(detail.error_message)["reasons"] == [
            {"kind": "term", "term": "Gehaltsabrechnung", "count": 1, "pages": [2]}
        ]
        assert seen == ["tables"]

    def test_a_clean_file_with_a_table_is_ingested_and_its_table_indexed(self, tmp_path, calls, monkeypatch):
        """A passing file extracts the table exactly as before: same rows, same page, same Markdown."""
        rows = [["Posten", "Betrag"], ["Estrich", "4200"]]
        path = _pdf_with_table_page(tmp_path, monkeypatch, rows)

        detail = _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=True)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening == "clean"
        # The function's own output, read directly from the same file, is what
        # the job indexed — the extraction path is untouched by the reorder.
        taken = {}
        extracted = adapter._extract_tables_from_pdf(str(path), taken)
        assert len(extracted) == 1
        assert extracted[0]["page_number"] == 2
        assert extracted[0]["cells"] == rows
        assert extracted[0]["rows"] == 2 and extracted[0]["cols"] == 2

        tables = _table_documents(calls)
        assert len(tables) == 1
        assert tables[0].metadata["page_label"] == "2"
        assert tables[0].metadata["rows"] == 2 and tables[0].metadata["cols"] == 2
        assert "| Posten | Betrag |" in tables[0].text and "| Estrich | 4200 |" in tables[0].text


def test_the_screen_runs_before_the_table_pass(tmp_path, calls, monkeypatch):
    """The order itself: the text layer is screened, the tables read, the tables screened.

    Screening runs twice on purpose. The first pass covers the text layer and
    its companions and decides whether the table pass is worth its cost; the
    second screens the table Documents the first pass let through, still before
    any model call.
    """
    events: list[str] = []
    real_screen = screening.screen_pages
    real_tables = adapter._extract_tables_from_pdf

    def _screen(*args, **kwargs):
        events.append("screen")
        return real_screen(*args, **kwargs)

    def _tables(*args, **kwargs):
        events.append("tables")
        return real_tables(*args, **kwargs)

    monkeypatch.setattr(screening, "screen_pages", _screen)
    monkeypatch.setattr(adapter, "_extract_tables_from_pdf", _tables)
    path = _pdf_with_table_page(tmp_path, monkeypatch, [["Posten", "Betrag"], ["Estrich", "4200"]])

    _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=True)

    assert events == ["screen", "tables", "screen"]
