"""The metadata header a chunk is embedded with stays within its budget (``adapter._fit_rendered_metadata``).

``SentenceSplitter`` prepends the rendered metadata to every chunk and raises
``Metadata length (1497) is longer than chunk size (1024)`` when the header alone is
too long. That fails the whole file: 35 ingest jobs of one project's structural
drawings ended with 0 chunks (2026-10), because a legend read as a heading filled
``punkt_id``, ``punkt_title`` and ``punkt_path``. Heading detection is fixed at the
cause (``test_section_chunking``); this is the boundary that keeps the next long key,
from wherever it comes, from failing a file.
"""

from __future__ import annotations

import pytest
from knowledge_layer.llamaindex.adapter import _apply_metadata_exclusions
from knowledge_layer.llamaindex.adapter import _fit_rendered_metadata
from knowledge_layer.llamaindex.adapter import _rendered_metadata_tokens
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
            "punkt_id": f"3.OG - Neubau + Bestand M 1 : 100 › {LEGEND}",
            "punkt_title": LEGEND,
            "punkt_path": f"3.OG - Neubau + Bestand M 1 : 100 › {LEGEND}",
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

    assert set(dropped) == {"punkt_id", "punkt_title", "punkt_path"}
    assert _rendered_metadata_tokens(document) <= 512
    assert nodes
    header = document.get_metadata_str(mode=MetadataMode.EMBED)
    assert FILE in header and "Statik" in header
    # Still stored, for display and for read_passage's address.
    assert document.metadata["punkt_title"] == LEGEND


def test_a_normal_header_is_left_alone():
    document = Document(
        text="Die Wände sind in REI 90 auszuführen.",
        metadata={"file_name": "brandschutz.pdf", "page_label": "3", "punkt_id": "3.2", "punkt_title": "Wände"},
    )
    _apply_metadata_exclusions(document)

    assert _fit_rendered_metadata(document, 512) == []
    assert "Wände" in document.get_metadata_str(mode=MetadataMode.EMBED)
