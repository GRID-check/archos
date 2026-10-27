"""Tests for agentic filters on knowledge retrieval.

``knowledge_retrieval.search`` accepts ``doc_class`` (validated against the
store vocabulary, store-authoritative), ``title_contains`` (case-insensitive
substring on file name OR display title), and ``file_name`` (indexed name).
Filtering happens post-merge so a reclassification without re-ingest is
honored; invalid input returns a clear message instead of raising.
"""

from __future__ import annotations

from types import SimpleNamespace

from knowledge_layer.register import _AGENT_FILTER_OVERFETCH
from knowledge_layer.register import _KNOWLEDGE_SEARCH_DESCRIPTION
from knowledge_layer.register import _apply_agent_filters
from knowledge_layer.register import _empty_search_message
from knowledge_layer.register import _file_name_matches

from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES


def _chunk(
    file_name: str = "doc.pdf",
    doc_class: str | None = None,
    chunk_id: str | None = None,
) -> SimpleNamespace:
    metadata = {"collection": "oib_knowledge"}
    if doc_class:
        metadata["doc_class"] = doc_class
    return SimpleNamespace(
        chunk_id=chunk_id or f"{file_name}-{doc_class or 'none'}",
        file_name=file_name,
        content="text",
        score=0.9,
        content_type=SimpleNamespace(value="text"),
        metadata=metadata,
    )


def test_overfetch_constant() -> None:
    assert _AGENT_FILTER_OVERFETCH == 3


def test_doc_class_filter_uses_store_value_when_available(monkeypatch) -> None:
    # Store says oib_guideline for this file even though chunk metadata disagrees.
    chunk = _chunk(file_name="oib-3.pdf", doc_class="other")
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_doc_classes",
        lambda *args, **kwargs: {"oib-3.pdf": "oib_guideline"},
    )
    # The resolved store value must win, so the oib_guideline filter keeps it.
    kept = _apply_agent_filters([chunk], doc_class="oib_guideline", title_contains=None)
    assert len(kept) == 1


def test_doc_class_filter_drops_non_matching() -> None:
    chunks = [_chunk(file_name="a.pdf", doc_class="oib_guideline"), _chunk(file_name="b.pdf", doc_class="law")]
    kept = _apply_agent_filters(chunks, doc_class="oib_guideline", title_contains=None)
    assert [c.file_name for c in kept] == ["a.pdf"]


def test_title_contains_matches_file_name_case_insensitive() -> None:
    chunks = [_chunk(file_name="OIB-3-Brandschutz.pdf"), _chunk(file_name="Wiener Bauordnung.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains="oib-3")
    assert [c.file_name for c in kept] == ["OIB-3-Brandschutz.pdf"]


def test_title_contains_matches_display_title(monkeypatch) -> None:
    # Display title (store) is preferred over the raw file name.
    chunks = [_chunk(file_name="norms_2023.pdf"), _chunk(file_name="other.pdf")]
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_display_titles",
        lambda *args, **kwargs: {"norms_2023.pdf": "OIB Richtlinie 3"},
    )
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains="richtlinie")
    assert [c.file_name for c in kept] == ["norms_2023.pdf"]


def test_no_filters_keeps_all() -> None:
    chunks = [_chunk(file_name="a.pdf"), _chunk(file_name="b.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None)
    assert len(kept) == 2


def test_doc_class_and_title_combined() -> None:
    chunks = [
        _chunk(file_name="a.pdf", doc_class="oib_guideline"),
        _chunk(file_name="b.pdf", doc_class="law"),
        _chunk(file_name="c.pdf", doc_class="oib_guideline"),
    ]
    kept = _apply_agent_filters(chunks, doc_class="oib_guideline", title_contains="c")
    assert [c.file_name for c in kept] == ["c.pdf"]


def test_document_classes_vocabulary_is_known() -> None:
    # Guards the vocabulary the tool validates against.
    assert "oib_guideline" in DOCUMENT_CLASSES
    assert "law" in DOCUMENT_CLASSES
    assert "other" in DOCUMENT_CLASSES


def test_file_name_matches_exact_and_contained() -> None:
    assert _file_name_matches("Brandschutzplan_EG.pdf", "Brandschutzplan_EG.pdf")
    assert _file_name_matches("Brandschutzplan_EG.pdf", "brandschutzplan_eg.pdf")
    assert _file_name_matches("Brandschutzplan_EG.pdf", "Brandschutzplan")
    assert not _file_name_matches("Schnitt.pdf", "Brandschutzplan")
    assert not _file_name_matches(None, "x.pdf")


def test_file_name_filter_keeps_only_the_named_file() -> None:
    chunks = [_chunk(file_name="Brandschutzplan_EG.pdf"), _chunk(file_name="Schnitt.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, file_name="Brandschutzplan")
    assert [c.file_name for c in kept] == ["Brandschutzplan_EG.pdf"]


def test_empty_search_message_steers_and_forbids_invented_citations() -> None:
    text = _empty_search_message("Fluchtwege", file_name="fehlend.pdf")
    assert "fehlend.pdf" in text
    assert "inventory" in text
    assert "do not invent" in text.lower()
    assert "surface_documents" in text


def test_knowledge_search_description_is_a_contract_for_the_evidence_tool() -> None:
    desc = _KNOWLEDGE_SEARCH_DESCRIPTION
    assert "evidence" in desc.lower()
    # The boundary with the nearest tool, stated once.
    assert "surface_documents" in desc
    assert "file_name=" in desc and "never invent" in desc
    assert "Citation" in desc
    # A contract, not a procedure: no when-to blocks and no sequencing.
    assert "WHEN TO CALL" not in desc and "WHEN NOT TO CALL" not in desc
    assert "ALWAYS" not in desc


def test_knowledge_search_takes_the_checkpoint_as_an_optional_argument() -> None:
    """The Herleitung checkpoint has a slot, and filling it is the model's option."""
    desc = _KNOWLEDGE_SEARCH_DESCRIPTION
    assert "`conclusion=`: Optional" in desc
    assert "No effect on the result" in desc


def test_the_description_says_what_a_piloti_document_may_be_cited_for() -> None:
    """The sentence that separates "the office decided this" from "the OIB requires this" for a
    document the office approved but Piloti wrote. Since ADR-0133 slice 6 it rides the hit's own
    `Herkunft:` line, so every tool that returns such a passage says it where it is read."""
    from aiq_agent.common.grounding_block import AGENT_DOCUMENT_NOTE

    assert "Piloti-Dokument" not in _KNOWLEDGE_SEARCH_DESCRIPTION
    assert "never a source for a normative value" in AGENT_DOCUMENT_NOTE
    assert "what the office decided" in AGENT_DOCUMENT_NOTE
