"""Where a question was asked, on its trace: ``turn_surface`` and the ``surface:review-canvas`` tag."""

from __future__ import annotations

import pytest

from aiq_agent.observability.langfuse_trace_attributes import begin_trace_contributions
from aiq_agent.observability.langfuse_trace_attributes import end_trace_contributions
from aiq_agent.observability.langfuse_trace_attributes import record_turn_surface
from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions


@pytest.mark.parametrize(
    ("surface", "tags"),
    [
        ("chat", []),
        ("review_canvas", ["surface:review-canvas"]),
        ("annotation_thread", ["surface:review-canvas"]),
    ],
)
def test_the_surface_is_metadata_and_every_canvas_turn_is_tagged(surface, tags):
    token = begin_trace_contributions()
    try:
        record_turn_surface(surface)
        recorded = snapshot_contributions()
    finally:
        end_trace_contributions(token)

    assert recorded == {"metadata": {"turn_surface": surface}, "tags": tags}
