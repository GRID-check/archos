"""A passage read off a picture of the page carries its box to the viewer (issue #433).

The box travels as a field of the grounding record, and the model reads it as a
``Region:`` line in ``look``'s own frame (``[x, y, w, h]``, ADR-0128), so it can
look again at the place a hit cites. These tests hold both halves: the line is
what ``look(region=...)`` takes, and the box still reaches the wire, through
dedup and the session cache.
"""

from __future__ import annotations

import dataclasses

import pytest

from agent.citations.entries import SourceEntry
from agent.citations.extraction import extract_sources_from_tool_result
from agent.citations.registry import SourceRegistry
from agent.citations.session import _registry_from_cached_entries
from agent.citations.wire import read_source_to_wire
from agent.citations.wire import source_entry_to_wire
from agent.common.grounding_block import GroundingBlock
from agent.common.grounding_block import GroundingHit
from agent.common.grounding_block import SourceRegion
from agent.common.grounding_block import begin_grounding_capture
from agent.common.grounding_block import end_grounding_capture
from agent.common.grounding_block import render_grounding_block

FLOOR_PLAN = SourceRegion(box=(0.1, 0.2, 0.5, 0.6), label="Grundriss EG")
SECTION = SourceRegion(box=(0.55, 0.2, 0.9, 0.6), label=None)


def _hit(**overrides) -> GroundingHit:
    fields = {
        "citation_key": "plan.pdf, p.3",
        "file_name": "plan.pdf",
        "page": 3,
        "shelf": None,
        "collection": "proj_1",
        "doc_class": None,
        "display_title": "plan.pdf",
        "folder_path": None,
        "clause": None,
        "score": 0.7,
        "content_type": "drawing",
        "provenance": None,
        "stored_image_index": None,
        "status_note": None,
        "body": "[DRAWING from page 3] Grundriss EG mit Sitztreppe zum Innenhof.",
    }
    return GroundingHit(**{**fields, **overrides})


def _block(*hits: GroundingHit) -> GroundingBlock:
    return GroundingBlock(
        preamble=f"Found {len(hits)} relevant document(s):",
        degraded_banner="",
        hits=hits,
        lanes=(),
        tool="knowledge_search",
    )


@pytest.fixture
def capturing():
    token = begin_grounding_capture()
    yield
    end_grounding_capture(token)


def test_a_hit_with_a_region_says_where_it_sits_in_looks_own_numbers():
    rendered = render_grounding_block(_block(_hit(regions=(FLOOR_PLAN, SECTION))))

    assert "Region: [0.1, 0.2, 0.4, 0.4] „Grundriss EG“\n" in rendered
    # origin and size, not corners; an unlabelled box has no label
    assert "Region: [0.55, 0.2, 0.35, 0.4]\n" in rendered
    assert rendered.index("Region:") < rendered.index("Citation:")


def test_a_hit_without_a_region_renders_no_line():
    assert "Region:" not in render_grounding_block(_block(_hit()))


def test_at_most_three_regions_are_rendered():
    boxes = tuple(SourceRegion(box=(0.0, i / 10, 0.5, i / 10 + 0.05)) for i in range(5))

    assert render_grounding_block(_block(_hit(regions=boxes))).count("Region:") == 3


def test_a_label_with_a_line_break_stays_one_line():
    region = SourceRegion(box=(0.1, 0.1, 0.4, 0.4), label="Schnitt\nA-A")

    assert "Region: [0.1, 0.1, 0.3, 0.3] „Schnitt A-A“\n" in render_grounding_block(_block(_hit(regions=(region,))))


def test_a_replayed_block_with_a_region_line_still_parses_its_citation():
    rendered = render_grounding_block(_block(_hit(regions=(FLOOR_PLAN,))))

    [entry] = extract_sources_from_tool_result("knowledge_search", rendered)

    assert entry.citation_key == "plan.pdf, p.3"


def test_the_record_carries_the_region_into_the_registry(capturing):
    rendered = render_grounding_block(_block(_hit(regions=(FLOOR_PLAN,))))

    [entry] = extract_sources_from_tool_result("knowledge_search", rendered)

    assert entry.regions == [FLOOR_PLAN]


def test_two_depictions_on_one_page_are_both_marked(capturing):
    """Dedup folds the page's chunks into one source; it must not fold their boxes away."""
    rendered = render_grounding_block(
        _block(_hit(regions=(FLOOR_PLAN,)), _hit(regions=(SECTION,), body="Schnitt A-A durch die Sitztreppe."))
    )
    registry = SourceRegistry()
    for entry in extract_sources_from_tool_result("knowledge_search", rendered):
        registry.add(entry)

    [source] = registry._citation_keys
    assert source.regions == [FLOOR_PLAN, SECTION]


def test_the_wire_carries_the_boxes_and_omits_an_unknown_label():
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[FLOOR_PLAN, SECTION])

    assert source_entry_to_wire(entry)["regions"] == [
        {"box": [0.1, 0.2, 0.5, 0.6], "label": "Grundriss EG"},
        {"box": [0.55, 0.2, 0.9, 0.6]},
    ]


def test_running_text_carries_no_regions_key():
    entry = SourceEntry(citation_key="bescheid.pdf, p.2", source_type="knowledge_layer", chunk_text="Spruch.")

    assert "regions" not in source_entry_to_wire(entry)


def test_a_source_that_was_only_read_carries_no_regions():
    """The uncited channel names documents; a box is a claim about where the evidence is."""
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[FLOOR_PLAN])

    assert "regions" not in read_source_to_wire(entry)


def test_a_resumed_conversation_keeps_its_boxes():
    """The session registry is cached as ``asdict``; a replica move must not drop the boxes."""
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[FLOOR_PLAN])

    hydrated = _registry_from_cached_entries([dataclasses.asdict(entry)])

    assert hydrated._all[0].regions == [FLOOR_PLAN]


def test_a_malformed_cached_box_is_dropped_not_guessed():
    cached = {"citation_key": "plan.pdf, p.3", "regions": [{"box": [0.1, 0.2]}, {"box": [0.1, 0.2, 0.5, 0.6]}]}

    hydrated = _registry_from_cached_entries([cached])

    assert hydrated._all[0].regions == [SourceRegion(box=(0.1, 0.2, 0.5, 0.6))]


def test_a_non_finite_cached_box_is_dropped():
    cached = {"citation_key": "plan.pdf, p.3", "regions": [{"box": [float("nan"), 0.2, 0.5, 0.6]}]}

    hydrated = _registry_from_cached_entries([cached])

    assert hydrated._all[0].regions == []
