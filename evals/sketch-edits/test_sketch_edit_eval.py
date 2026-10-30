"""The sketch-edit eval's harness, held without a model: the checker passes every gold answer and catches
every negative, and the recorded blind answers (2026-10-29) score what docs/roadmap/sketches.md reports
under the shipped operation rules. A change to the ops in `apps/workspace/bff/diagrams/sketch-edit.ts`
that the mirror in `sketch_edit_lib.py` does not follow shows here first. The model run itself is
`run_sketch_edit_eval.py run`, when an endpoint is configured.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_sketch_edit_eval as harness  # noqa: E402


def test_gold_passes_and_negatives_are_caught() -> None:
    assert harness.selftest() == 0


def test_the_blind_answers_score_as_recorded() -> None:
    passes = harness.summarise(HERE / "answers", legacy=True)
    assert passes == {"sonnet/outline": (13, 13), "sonnet/outline+png": (12, 13), "haiku/outline": (9, 13)}
