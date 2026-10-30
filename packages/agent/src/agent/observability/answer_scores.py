"""The answer-text passes as scores: the dialect pass, its sketches, the quote repair.

Split out of ``langfuse_scores`` (which declares every score in
``SCORE_DEFINITIONS`` and posts them) so that module stops growing
(``docs/contributing/code-conventions.md#size-limits``). The builders are pure:
a pass's outcome in, scores out, emitted by ``langfuse_scores.emit_scores``.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .langfuse_scores import RuntimeScore


def dialect_scores(repairs: list[dict[str, str]], sketches: Iterable[Any] = ()) -> list[RuntimeScore]:
    """The dialect pass's repairs on one answer, zero included (a clean answer is a measurement), and its sketches."""
    kinds = sorted({repair.get("repair", "") for repair in repairs if repair.get("repair")})
    return [
        RuntimeScore("dialect-repairs", float(len(repairs)), comment=", ".join(kinds) or None),
        *sketch_scores(sketches),
    ]


def sketch_scores(checks: Iterable[Any]) -> list[RuntimeScore]:
    """One ``sketch-drawn`` per sketch fence (``sketch_fence.SketchCheck``); nothing for an answer without one."""
    return [
        RuntimeScore(
            "sketch-drawn",
            "drawn" if check.drawn else "refused",
            comment=check.refusal,
            item=str(index),
            metadata={"elements": check.elements, "dimension_labels": check.dimension_labels, "links": check.links},
        )
        for index, check in enumerate(checks)
    ]


def quote_patch_scores(patched: int) -> list[RuntimeScore]:
    """How many quotes the repair pass corrected on one answer."""
    return [RuntimeScore("quotes-patched", float(max(0, patched)))]
