"""The Qdrant parity harness end to end, on its sample corpus, against a real Qdrant.

``task be:eval:qdrant-parity`` decides the flag flip (design doc §10); this keeps
the instrument itself from rotting. It runs the whole measurement: Chroma filled
through LlamaIndex, Qdrant filled by the migration's backfill, the production
retriever reading both, every gate computed and rendered. The sample corpus is a
dozen synthetic chunks with hashed vectors, so the numbers are wiring; what is
asserted is that the two stores hold the same thing and that the exact mode and
the phrase channel behave as the report claims.

Same server contract as ``test_qdrant_store.py``: ``AIQ_QDRANT_TEST_URL``, skipped
locally without it, failed on CI.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
BENCHMARK = REPO / "frontends" / "benchmarks" / "oib_retrieval"
sys.path.insert(0, str(BENCHMARK / "src"))

from oib_retrieval_eval.qdrant_parity import runner  # noqa: E402
from oib_retrieval_eval.qdrant_parity import sample  # noqa: E402

HARD_CASES = BENCHMARK / "fixtures" / "qdrant_lexical_hard_cases.json"


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


@pytest.fixture(scope="module")
def report(tmp_path_factory):
    from aiq_agent.knowledge.chunk_text_store import reset_chunk_text_store

    url = _server_url()
    try:
        yield runner.run(
            sample.inputs(HARD_CASES),
            qdrant_url=url,
            rounds=1,
            work_dir=tmp_path_factory.mktemp("parity"),
            use_postgres=False,
            variant_names="all",
        )
    finally:
        reset_chunk_text_store()


def test_both_stores_hold_every_chunk(report):
    assert report["corpus"]["chroma_count"] == report["corpus"]["qdrant_count"] == len(sample.TEXTS)


def test_exact_mode_is_identical_on_both_stores_for_every_phrase(report):
    differing = [row["phrase"] for row in report["exact"] if not row["identical"]]
    assert differing == []


def test_the_phrase_index_keeps_numbers_and_codes(report):
    """The tokenizer regression: a multilingual tokenizer dropped digits, so „REI 90“
    matched REI 60 and „5.1.1“ / „§ 8“ matched nothing."""
    rows = {row["phrase"]: row for row in report["exact"]}
    for phrase in ("REI 90", "5.1.1", "§ 8", "EI2 30-C"):
        assert rows[phrase]["phrase_index_misses"] == 0, phrase
        assert rows[phrase]["phrase_index_extra"] == 0, phrase


def test_every_gate_has_a_verdict_and_the_unmeasurable_ones_say_so(report):
    gates = {verdict["gate"]: verdict["status"] for verdict in report["verdicts"]}
    assert {"G1b lexical", "G2 latency", "G1 answer quality"} <= set(gates)
    assert gates["G1 answer quality"] == "not measured"
    assert gates["G6 dimension"] == "not measured", "64-d sample vectors cannot speak for 3072-d"


def test_the_report_renders(report):
    markdown = runner.render_markdown(report)
    assert "| G2 latency |" in markdown and "qdrant_bm25" in markdown


def test_the_ranking_sweep_measures_every_variant_against_the_baseline(report):
    from oib_retrieval_eval.qdrant_parity import decompound
    from oib_retrieval_eval.qdrant_parity import variants

    sweep = report["variants"]
    catalogue = variants.catalogue()
    ordinary = [name for name, setting in catalogue.items() if not isinstance(setting, decompound.Variant)]
    split = [name for name in catalogue if name not in ordinary] if decompound.available() else []
    assert list(sweep) == [*ordinary, variants.REPEAT, *split]
    assert "diff" not in sweep[variants.BASELINE]
    assert all("diff" in result for name, result in sweep.items() if name != variants.BASELINE)
    assert "## Ranking sweep" in runner.render_markdown(report)


def test_every_variant_serves_the_true_cosine_as_the_score(report):
    """``Chunk.score`` is printed in the grounding block and compared against
    thresholds: whatever the fusion and the quantized read, it stays the exact cosine."""
    errors = {name: result["cosine_error"]["max"] for name, result in report["variants"].items()}
    assert all(error < 1e-4 for error in errors.values()), errors
