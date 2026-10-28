"""The revision suites' end-to-end harness: a summary model that answers by prompt
kind, a temp metadata store and a live ingestor on a real Qdrant.
"""

from __future__ import annotations

import threading
import time
import uuid

import pytest
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from langchain_core.messages import AIMessage


class _Model:
    """A summary model that answers by the kind of prompt it is given, and remembers them."""

    def __init__(self, judge='{"of": null, "confidence": 0.0, "reason": ""}', change="- Stiege nach Norden verschoben"):
        self.judge = judge
        self.change = change
        self.prompts: list[str] = []
        self.fail_on: str | None = None
        self._lock = threading.Lock()

    def invoke(self, prompt):
        with self._lock:
            self.prompts.append(prompt)
        if self.fail_on and self.fail_on in prompt:
            raise RuntimeError("model down")
        if "NEWER FASSUNG" in prompt:
            return AIMessage(content=self.judge)
        if "replaced one Fassung" in prompt:
            return AIMessage(content=self.change)
        if "EINEM Satz" in prompt:
            return AIMessage(content="Neue Statik mit anderer Bewehrung.")
        return AIMessage(content="[]")

    def asked(self, marker: str) -> list[str]:
        return [prompt for prompt in self.prompts if marker in prompt]


@pytest.fixture()
def stores(tmp_path):
    from agent.knowledge import configure_summary_db
    from agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture()
def model():
    return _Model()


@pytest.fixture()
def live_ingestor(tmp_path, monkeypatch, model, qdrant_store):
    from agent.knowledge import document_classification
    from knowledge_layer_testing.qdrant import FakeEmbedder

    ing = LlamaIndexIngestor({"generate_summary": True, "summary_llm": model})
    ing._embed_model = FakeEmbedder()
    ing._initialized = True
    monkeypatch.setattr(document_classification, "classify_document_tags", lambda *_a, **_k: ["Grundriss"])
    return ing


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _ingest(ing, tmp_path, collection, file_name, text="Neue Fassung der Statik mit anderer Bewehrung.", **extra):
    upload = tmp_path / f"tmp_{uuid.uuid4().hex[:8]}.txt"
    upload.write_text(text, encoding="utf-8")
    job_id = ing.submit_job(
        [str(upload)],
        collection,
        config={
            "original_filenames": [file_name],
            "extract_tables": False,
            "extract_images": False,
            "extract_charts": False,
            **extra,
        },
    )
    status = _wait_terminal(ing, job_id)
    assert status.file_details[0].status.value == "success"


def _documents(collection):
    from agent.knowledge import get_available_documents

    return {doc.file_name: doc for doc in get_available_documents(collection)}


def _seed_previous_version(ing, stores, collection_name, file_name):
    from agent.knowledge import register_summary
    from knowledge_layer_testing.qdrant import record
    from knowledge_layer_testing.qdrant import write

    write(collection_name, [record("Alte Fassung Seite eins", file_name, chunk_id="old-1")])
    register_summary(collection_name, file_name, "Die alte Statik.")
