"""``[ingest-perf]``: one line per file, the stages it reached, in a fixed order.

Log-only and model-free. The unit tests drive the two helpers directly (the clock
monkeypatched, so no timing assertion is flaky); the integration test reuses the
offline ingest harness to prove two things at once: a clean file's line names its
stages, and a file the upload screen holds never reaches the table pass — the
saving Change A buys, read straight off the log.
"""

from __future__ import annotations

import logging

import pytest
from knowledge_layer.llamaindex import adapter

from .test_ingest_screen_before_tables import _TERMS
from .test_ingest_screen_before_tables import _ingest
from .test_ingest_screen_before_tables import _pdf
from .test_ingest_screen_before_tables import calls  # noqa: F401 - fixtures, shared with the harness
from .test_ingest_screen_before_tables import store  # noqa: F401
from .test_ingest_screen_before_tables import summary_db  # noqa: F401

_LOGGER = "knowledge_layer.llamaindex.adapter"


def _perf_lines(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records if "[ingest-perf]" in record.getMessage()]


def test_stage_accumulates_spans_under_one_name(monkeypatch):
    ticks = iter([10.0, 10.5, 20.0, 20.25])
    monkeypatch.setattr(adapter.time, "perf_counter", lambda: next(ticks))

    stages: dict[str, float] = {}
    with adapter._stage(stages, "screen"):
        pass
    with adapter._stage(stages, "screen"):
        pass

    assert stages == {"screen": pytest.approx(0.75)}


def test_the_log_lists_the_stages_in_the_fixed_order(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        adapter._log_ingest_perf("Plan.pdf", {"write": 2.0, "text": 1.0, "screen": 0.5})

    # A fixed order, so two files' lines compare; absent stages are simply skipped.
    assert _perf_lines(caplog) == ["[ingest-perf] Plan.pdf text=1.000 screen=0.500 write=2.000"]


def test_the_transcription_of_scans_is_a_stage_of_its_own(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        adapter._log_ingest_perf("Scan.pdf", {"renders": 1.0, "ocr": 42.0, "screen": 0.5})

    # Page transcription is a vision call per scanned page; its seconds were missing from the line.
    assert _perf_lines(caplog) == ["[ingest-perf] Scan.pdf screen=0.500 ocr=42.000 renders=1.000"]


def test_no_line_when_no_stage_was_reached(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        adapter._log_ingest_perf("Plan.pdf", {})

    assert _perf_lines(caplog) == []


def test_a_clean_file_logs_its_stages_and_a_held_one_stops_before_tables(tmp_path, calls, caplog):  # noqa: F811
    clean_dir = tmp_path / "clean"
    clean_dir.mkdir()
    held_dir = tmp_path / "held"
    held_dir.mkdir()

    with caplog.at_level(logging.INFO, logger=_LOGGER):
        _ingest(calls, _pdf(clean_dir, "Brandschutzkonzept", "Fluchtweglaenge 40 m"), "BSK.pdf", None)
    [clean] = _perf_lines(caplog)
    assert clean.startswith("[ingest-perf] BSK.pdf ")
    assert "text=" in clean and "screen=" in clean
    assert clean.index("text=") < clean.index("screen=") < clean.index("ocr=") < clean.index("embedding=")

    caplog.clear()
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        detail = _ingest(calls, _pdf(held_dir, "Gehaltsabrechnung Maerz 2026", "Brutto 4.200,00 EUR"), "A.pdf", _TERMS)
    [held] = _perf_lines(caplog)
    assert detail.screening == "quarantined"
    # The screen held it, so the table pass never ran: no `tables=` on the line.
    assert "text=" in held and "screen=" in held
    assert "tables=" not in held and "embedding=" not in held
