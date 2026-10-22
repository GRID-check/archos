"""A look at a project or office document registers a citable place (ADR-0125, amendment of 2026-10-22).

The round trip: the tool's text is a grounding block; a live turn reads the
record filed under its hash, a replayed turn parses the text, and both register
the same place, which the wire draws as a place (``regions``) and never as law.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import is_look_place
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.tools.look.place import place_facts
from aiq_agent.tools.look.place import render_place
from aiq_agent.tools.look.reading import Reading
from aiq_agent.tools.look.reading import ReadingLine
from aiq_agent.tools.look.reading import card_reading
from aiq_agent.tools.look.reading import render_readings_parts
from aiq_agent.tools.look.register import _blocks_for

RESOLVED = SimpleNamespace(file_name="Schnitt A-A.pdf", collection="proj_1", target=None)
READING = Reading(
    lines=(
        ReadingLine("Gangbreite 1,10 m", "dimension", "high"),
        ReadingLine("EP-02", "label", "high"),
    ),
    summary="Schnitt mit Höhenkoten.",
)


@pytest.fixture
def capture():
    token = begin_grounding_capture()
    yield
    end_grounding_capture(token)


def _text(region=(0.1, 0.2, 0.3, 0.4)) -> str:
    facts = place_facts(RESOLVED, 2, region, None)
    head, rows = render_readings_parts(READING, blind=False)
    return render_place(facts, f"Region [x=0.1] of the page.\n\n{head}", rows)


class TestThePlace:
    def test_a_project_document_has_a_place_and_the_base_corpus_has_none(self):
        assert place_facts(RESOLVED, 2, None, None) is not None
        assert place_facts(SimpleNamespace(file_name="OIB-RL 2.pdf", collection="", target=None), 1, None, None) is None
        assert (
            place_facts(SimpleNamespace(file_name="x.pdf", collection="oib_knowledge", target=None), 1, None, None)
            is None
        )

    def test_an_embedded_image_has_no_region_because_its_box_is_not_the_pages(self):
        facts = place_facts(RESOLVED, 2, (0.1, 0.2, 0.3, 0.4), image_index=0)

        assert facts.box is None

    def test_the_region_is_written_in_looks_own_frame(self):
        assert "Region: [0.1, 0.2, 0.3, 0.4]" in _text()


class TestLiveAndReplayedRegisterTheSamePlace:
    def test_a_live_turn_reads_the_record(self, capture):
        text = _text()

        [live] = extract_sources_from_tool_result("look", text)

        assert is_look_place(live)
        assert live.chunk_text is None and "Gangbreite 1,10 m" in live.read
        assert live.citation_key == "Schnitt A-A.pdf, p.2"
        assert live.regions[0].box == pytest.approx((0.1, 0.2, 0.4, 0.6))

    def test_a_replayed_turn_parses_the_text_and_keeps_the_citation(self):
        text = _text()  # no capture open: the registry is rebuilt from the text alone

        [replayed] = extract_sources_from_tool_result("look", text)

        assert is_look_place(replayed)
        assert replayed.citation_key == "Schnitt A-A.pdf, p.2"
        assert replayed.collection == "proj_1"
        assert "Gangbreite 1,10 m" in replayed.read
        assert replayed.regions[0].box == pytest.approx((0.1, 0.2, 0.4, 0.6))

    def test_both_readers_agree(self, capture):
        text = _text()
        [live] = extract_sources_from_tool_result("look", text)

        from aiq_agent.common.grounding_block import begin_grounding_capture as begin
        from aiq_agent.common.grounding_block import end_grounding_capture as end

        token = begin()  # a fresh capture knows nothing of the text: the parser reads it
        try:
            [replayed] = extract_sources_from_tool_result("look", text)
        finally:
            end(token)

        for field in ("citation_key", "collection", "shelf", "read", "chunk_text", "regions", "doc_class"):
            assert getattr(live, field) == getattr(replayed, field), field

    def test_an_overview_has_no_region(self, capture):
        [entry] = extract_sources_from_tool_result("look", _text(region=None))

        assert entry.regions == [] and is_look_place(entry)


class TestTheWireDrawsAPlaceAndNeverLaw:
    def test_it_is_the_documents_own_kind_with_the_region_and_the_reading(self, capture):
        [entry] = extract_sources_from_tool_result("look", _text())

        wire = source_entry_to_wire(entry, number=3)

        assert wire["kind"] == "project" and wire["binding_status"] == "unknown"
        assert wire["file_name"] == "Schnitt A-A.pdf" and wire["page"] == 2
        assert wire["regions"] == [{"box": [0.1, 0.2, 0.4, 0.6]}]
        assert "Gangbreite 1,10 m" in wire["snippet"]

    def test_a_file_named_like_a_richtlinie_is_still_a_project_document(self, capture):
        resolved = SimpleNamespace(file_name="OIB-RL 2 Ausgabe 2023.pdf", collection="proj_1", target=None)
        facts = place_facts(resolved, 1, (0.1, 0.1, 0.2, 0.2), None)
        [entry] = extract_sources_from_tool_result(
            "look", render_place(facts, "Region.", "Gelesen: 40 m (dimension, high)")
        )

        assert source_entry_to_wire(entry)["kind"] == "project"

    def test_the_office_shelf_stays_office(self, capture):
        resolved = SimpleNamespace(file_name="Detail.pdf", collection="office_shelf_org1", target=None)
        facts = place_facts(resolved, 1, None, None)
        [entry] = extract_sources_from_tool_result("look", render_place(facts, "Page.", "Gelesen: M 1:5 (label, high)"))

        assert source_entry_to_wire(entry)["kind"] == "office"


class TestThePlaceInTheRegistry:
    def test_a_place_on_a_page_that_holds_a_retrieved_caption_merges_without_becoming_that_passage(self, capture):
        from aiq_agent.common.citation_verification import SourceEntry

        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                citation_key="Schnitt A-A.pdf, p.2",
                collection="proj_1",
                source_type="knowledge_layer",
                chunk_text="Schnitt A-A, Massstab 1:50",
            )
        )
        [place] = extract_sources_from_tool_result("look", _text())
        registry.add(place)

        [merged] = registry.all_sources()

        assert merged.chunk_text == "Schnitt A-A, Massstab 1:50"  # the reading never becomes the passage
        assert "Gangbreite 1,10 m" in merged.read and not is_look_place(merged)

    def test_the_reading_survives_the_session_cache(self, capture):
        import dataclasses

        from aiq_agent.common.citation_verification import _registry_from_cached_entries

        registry = SourceRegistry()
        [place] = extract_sources_from_tool_result("look", _text())
        registry.add(place)

        [restored] = _registry_from_cached_entries(
            [dataclasses.asdict(e) for e in registry.all_sources()]
        ).all_sources()

        assert is_look_place(restored) and restored.regions == place.regions


class TestWhatTheToolReturns:
    class _View:
        text = "Region of the page."
        jpeg = b"x"

        def blocks(self):
            return [{"type": "text", "text": self.text}]

        def with_text(self, text):
            view = type(self)()
            view.text = text
            return view

    async def test_with_a_place_the_text_block_is_the_block_and_the_card_keeps_the_value_line(
        self, monkeypatch, capture
    ):
        async def read(_jpeg, _question, region=False):
            return READING

        monkeypatch.setattr("aiq_agent.tools.look.reading.read_region", read)
        facts = place_facts(RESOLVED, 2, (0.1, 0.2, 0.3, 0.4), None)

        blocks, card, everything = await _blocks_for(self._View(), "Wie breit?", True, [0.1, 0.2, 0.3, 0.4], facts)

        [entry] = extract_sources_from_tool_result("look", blocks[0]["text"])
        assert is_look_place(entry)
        assert card == "Gangbreite 1,10 m; EP-02"  # the value lines, not the summary
        assert "Schnitt mit Höhenkoten." in everything

    async def test_without_a_place_the_text_is_as_before(self, monkeypatch):
        async def read(_jpeg, _question, region=False):
            return READING

        monkeypatch.setattr("aiq_agent.tools.look.reading.read_region", read)

        blocks, _, _ = await _blocks_for(self._View(), "Wie breit?", True, None, None)

        assert "--- Result" not in blocks[0]["text"] and "Gelesen: Gangbreite 1,10 m" in blocks[0]["text"]


class TestTheCardReading:
    def test_the_value_line_comes_before_the_summary(self):
        assert card_reading(READING) == "Gangbreite 1,10 m; EP-02"

    def test_a_reading_with_no_value_falls_back_to_the_summary_then_the_first_line(self):
        assert (
            card_reading(Reading(lines=(ReadingLine("Grundriss", "label", "high"),), summary="Ein Plan."))
            == "Ein Plan."
        )
        assert card_reading(Reading(lines=(ReadingLine("Grundriss", "label", "high"),))) == "Grundriss"
        assert card_reading(Reading(failure="x")) == ""
