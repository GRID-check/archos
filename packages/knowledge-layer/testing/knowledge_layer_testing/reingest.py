"""The re-ingest suites' harness: a temp metadata store, a live ingestor on a real
Qdrant, a seeded previous version and a wait for a job to finish.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

from knowledge_layer_testing.qdrant import FakeEmbedder
from knowledge_layer_testing.qdrant import record
from knowledge_layer_testing.qdrant import write


@pytest.fixture()
def stores(tmp_path):
    """A temp SQLite metadata store for the whole job."""
    from agent.knowledge import configure_summary_db
    from agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture()
def live_ingestor(qdrant_store):
    llm = MagicMock()
    llm.invoke.return_value = MagicMock(content="Eine Statik.")
    ing = LlamaIndexIngestor({"generate_summary": False, "summary_llm": llm})
    ing._embed_model = FakeEmbedder()
    ing._initialized = True
    return ing


def _seed_previous_version(ing, stores, collection_name: str, file_name: str) -> None:
    """The version already live: two chunks and a row a person edited."""
    from agent.knowledge import register_summary
    from agent.knowledge import set_document_display_title
    from agent.knowledge import set_document_doc_class
    from agent.knowledge import set_document_folder_path

    write(
        collection_name,
        [
            record("Alte Fassung Seite eins", file_name, chunk_id="old-1", page_label="1"),
            record("Alte Fassung Seite zwei", file_name, chunk_id="old-2", page_label="2"),
        ],
    )
    register_summary(collection_name, file_name, "Die alte Statik.")
    set_document_doc_class(collection_name, file_name, "tragwerk")
    set_document_display_title(collection_name, file_name, "Statik Bauteil B")
    set_document_folder_path(collection_name, file_name, "/Einreichung")


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")
