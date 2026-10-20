"""The metadata header a chunk is embedded with stays within its budget (``adapter._fit_rendered_metadata``).

``SentenceSplitter`` prepends the rendered metadata to every chunk and raises
``Metadata length (1497) is longer than chunk size (1024)`` when the header alone is
too long. That fails the whole file: 35 ingest jobs of one project's structural
drawings ended with 0 chunks (2026-10), because a legend read as a heading filled
``clause_id``, ``clause_title`` and ``clause_path``. Heading detection is fixed at the
cause (``test_section_chunking``); this is the boundary that keeps the next long key,
from wherever it comes, from failing a file.
"""

from __future__ import annotations

import logging

import pytest
from knowledge_layer.llamaindex.adapter import _apply_metadata_exclusions
from knowledge_layer.llamaindex.adapter import _fit_rendered_metadata
from knowledge_layer.llamaindex.adapter import _rendered_metadata_tokens
from knowledge_layer.llamaindex.adapter import _stamp_chunk_metadata
from llama_index.core import Document
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import MetadataMode

FILE = "06_Statische Unterlagen/BPL 1 mit Amtshaus/WR_25003_P1240_0.pdf"
LEGEND = " ".join(["STB-Fertigteil FDUK FUNDAMENT UNTERKANTE RDOK ROHDECKE OBERKANTE"] * 60)


def _drawing_chunk() -> Document:
    document = Document(
        text="3.OG - Neubau + Bestand M 1 : 100\n\nDecke über 3.OG, Stahlbeton 25 cm.",
        metadata={
            "file_name": FILE,
            "file_size": 586896,
            "page_label": "1",
            "content_type": "text",
            "doc_class": "Statik",
            "clause_id": f"3.OG - Neubau + Bestand M 1 : 100 › {LEGEND}",
            "clause_title": LEGEND,
            "clause_path": f"3.OG - Neubau + Bestand M 1 : 100 › {LEGEND}",
        },
    )
    _apply_metadata_exclusions(document)
    return document


def test_the_splitter_fails_the_file_without_the_guard():
    with pytest.raises(ValueError, match="Metadata length"):
        SentenceSplitter(chunk_size=1024, chunk_overlap=128).get_nodes_from_documents([_drawing_chunk()])


def test_long_free_text_keys_leave_the_header_and_the_file_chunks():
    document = _drawing_chunk()

    dropped = _fit_rendered_metadata(document, 512)
    nodes = SentenceSplitter(chunk_size=1024, chunk_overlap=128).get_nodes_from_documents([document])

    assert set(dropped) == {"clause_id", "clause_title", "clause_path"}
    assert _rendered_metadata_tokens(document) <= 512
    assert nodes
    header = document.get_metadata_str(mode=MetadataMode.EMBED)
    assert FILE in header and "Statik" in header
    # Still stored, for display and for read_passage's address.
    assert document.metadata["clause_title"] == LEGEND


def test_a_normal_header_is_left_alone():
    document = Document(
        text="Die Wände sind in REI 90 auszuführen.",
        metadata={"file_name": "brandschutz.pdf", "page_label": "3", "clause_id": "3.2", "clause_title": "Wände"},
    )
    _apply_metadata_exclusions(document)

    assert _fit_rendered_metadata(document, 512) == []
    assert "Wände" in document.get_metadata_str(mode=MetadataMode.EMBED)


def test_a_budget_that_is_not_positive_is_refused_outright():
    with pytest.raises(ValueError, match="must be positive"):
        _fit_rendered_metadata(_drawing_chunk(), 0)


def _stamp(documents: list[Document], chunk_size: int) -> None:
    _stamp_chunk_metadata(documents, doc_class="Statik", provenance={}, chunk_size=chunk_size, file_name=FILE)


def test_the_header_is_budgeted_against_the_chunk_size_the_job_splits_with():
    # Fits half of the 1024 default, not half of the 256 this job splits with.
    title = " ".join(["Bewehrungsplan Decke über Erdgeschoss"] * 20)
    document = Document(text="Stahlbeton 25 cm.", metadata={"file_name": "s.pdf", "clause_title": title})
    assert 128 < _rendered_metadata_tokens(document) <= 512

    _stamp([document], chunk_size=256)

    assert _rendered_metadata_tokens(document) <= 128
    assert document.metadata["doc_class"] == "Statik"
    assert SentenceSplitter(chunk_size=256, chunk_overlap=32).get_nodes_from_documents([document])


def test_a_header_that_cannot_shrink_is_reported_once_per_file(caplog):
    pages = [
        Document(text="Seite.", metadata={"file_name": f"{LEGEND}.pdf", "page_label": str(page)}) for page in range(3)
    ]

    with caplog.at_level(logging.WARNING, logger="knowledge_layer.llamaindex.adapter"):
        _stamp(pages, chunk_size=1024)

    over = [record for record in caplog.records if "over its 512-token budget" in record.getMessage()]
    assert len(over) == 1
    assert "file_name" in over[0].getMessage()
