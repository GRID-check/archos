"""Settling the streamed prose's citations before the cards arrive (ADR-0066)."""

from __future__ import annotations

from aiq_agent.agents.piloti.answer_pipeline import settle_streamed_citations
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import UNVERIFIED_QUOTE_MARKER
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    for page in (12, 13):
        registry.add(
            SourceEntry(
                citation_key=f"oib-rl_2_ausgabe_mai_2023.pdf, p.{page}",
                source_type="knowledge_layer",
                collection="oib_knowledge",
                tool_name="knowledge_search",
            )
        )
    return registry


SOURCES = (
    "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] erfunden.pdf, p.1\n"
    "- [3] oib-rl_2_ausgabe_mai_2023.pdf, p.13"
)


def test_an_unbacked_marker_is_labelled_and_the_rest_take_the_numbers_the_terminal_will_give():
    settled = settle_streamed_citations("Fluchtweg 40 m [1], erfunden [2], Treppe [3].", SOURCES, _registry())
    body, _, section = settled.content.partition("\n\n")
    # Labelled where it stood, not silently removed (ADR-0125): the claim's
    # pointer did not hold, and the reader is told so.
    assert body == f"Fluchtweg 40 m [1], erfunden {DROPPED_CITATION_MARKER}, Treppe [2]."
    # The source list rides along, renumbered, the unbacked line gone.
    assert "[1]" in section and "[2]" in section and "erfunden.pdf" not in section and "[3]" not in section
    assert [(s["number"], s["citation_key"]) for s in settled.sources] == [
        (1, "oib-rl_2_ausgabe_mai_2023.pdf, p.12"),
        (2, "oib-rl_2_ausgabe_mai_2023.pdf, p.13"),
    ]


def test_prose_without_a_sources_section_or_a_registry_settles_nothing():
    assert settle_streamed_citations("Ohne Quellen.", "", _registry()) is None
    assert settle_streamed_citations("Text [1].", SOURCES, SourceRegistry()) is None


def test_a_quote_no_passage_holds_is_marked_when_it_settles_not_seconds_later():
    # Settled without the quote check, a fabricated quotation read as a real
    # one until the terminal frame marked it, and the text changed under the
    # reader when it did.
    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.12",
            source_type="knowledge_layer",
            collection="oib_knowledge",
            tool_name="knowledge_search",
            chunk_text="Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen.",
        )
    )
    prose = (
        "Es gilt: „Treppen müssen mit einer automatischen Löschanlage ausgestattet sein“ [1]. "
        "Und: „Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen“ [1]."
    )

    settled = settle_streamed_citations(prose, "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12", registry)

    body = settled.content.partition("\n\n")[0]
    assert body.count(UNVERIFIED_QUOTE_MARKER) == 1
    assert f"ausgestattet sein“ {UNVERIFIED_QUOTE_MARKER}" in body


def test_a_mindmap_that_only_redraws_a_table_goes_when_the_prose_settles():
    # The terminal dropped it; with diagrams drawn mid-stream the reader
    # watched it appear, then vanish at the terminal frame.
    prose = (
        "| Abschnitt | Gegenstand |\n|---|---|\n| Garagen | Nutzfläche [1] |\n| Parkdecks | Bauart [1] |\n\n"
        '```mermaid\nmindmap\n  root(("OIB"))\n    "Garagen"\n      "Nutzfläche"\n'
        '    "Parkdecks"\n      "Bauart"\n```\n\n'
        "Danach."
    )

    settled = settle_streamed_citations(prose, "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12", _registry())

    assert "mindmap" not in settled.content
    assert "| Garagen |" in settled.content and "Danach." in settled.content


def _one_source() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", source_type="knowledge_layer", tool_name="knowledge_search"))
    return registry


def test_no_source_the_model_did_not_cite_is_attached():
    # The single-source fallback attached the registry's one source when the
    # only line named nothing retrieved; that source could be two turns old
    # (ADR-0125). The marker is labelled and no chip is invented.
    settled = settle_streamed_citations(
        "Treppen brauchen 2,10 m [1].", "## Quellen\n- [1] erfunden.pdf, p.9", _one_source()
    )

    assert settled.content == f"Treppen brauchen 2,10 m {DROPPED_CITATION_MARKER}."
    assert settled.sources == []


def test_the_settled_label_is_the_terminal_frame_byte_for_byte(monkeypatch):
    import asyncio

    from langchain_core.messages import AIMessage
    from langchain_core.messages import HumanMessage
    from langchain_core.messages import ToolMessage

    from aiq_agent.agents.piloti import answer_pipeline
    from aiq_agent.agents.piloti.answer_pipeline import finalize_answer

    monkeypatch.setattr(answer_pipeline, "get_source_id_for_tool", {"knowledge_search": "knowledge_layer"}.get)

    prose, sources = "Treppen brauchen 2,10 m [1].", "## Quellen\n- [1] erfunden.pdf, p.9"
    messages = [
        HumanMessage("Treppenhöhe?"),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "knowledge_search", "args": {}}]),
        ToolMessage(content="Text über Treppen.", tool_call_id="1", name="knowledge_search"),
        AIMessage(content=f"{prose}\n\n{sources}"),
    ]
    registry = _one_source()

    settled = settle_streamed_citations(prose, sources, registry)
    final = asyncio.run(finalize_answer(messages, registry=registry, tools=[], repair=None, turn_sources=[]))

    assert not final.citation_grounded and final.cited == ()
    assert settled.content == final.content.rstrip()
