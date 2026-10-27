"""An ingest stores what it read: the dossier from the whole document, its references, its coverage.

Offline: the screening harness's hand-built PDF and stub store, and a fake summary model
that answers the dossier's strict call and the one-sentence summary. The tags and topics
are stubbed, so nothing leaves the process.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from aiq_agent.knowledge import document_classification

from .test_ingest_screen_before_tables import _ingest
from .test_ingest_screen_before_tables import _pdf
from .test_ingest_screen_before_tables import calls  # noqa: F401 - fixtures, shared with the harness
from .test_ingest_screen_before_tables import store  # noqa: F401
from .test_ingest_screen_before_tables import summary_db  # noqa: F401

_LINES = (
    "Baubeschreibung Wohnhausanlage Hubergasse 14",
    "Die Ausfuehrung erfolgt gem. Brandschutzkonzept und nach OENORM B 1600.",
    "Siehe Plan EP-05. Gebaeudeklasse 4, vier oberirdische Geschosse.",
)

_DOSSIER = {
    "document_type": "building_description",
    "title": "Baubeschreibung",
    "summary": "Baubeschreibung einer Wohnhausanlage in der Hubergasse 14 mit vier Geschossen.",
    "parties": [],
    "dates": [],
    "place": {"address": "Hubergasse 14", "municipality": None, "state": None},
    "facts": [{"key": "building_class", "value": "4", "unit": None, "page": 1, "quote": "Gebaeudeklasse 4"}],
}


class _SummaryModel:
    """The ingest's summary model: the dossier's strict call when bound, else the one-sentence summary."""

    model_name = "fake/summary"

    def __init__(self, dossier: Any):
        self.dossier = dossier
        self.digests: list[str] = []

    def bind(self, **kwargs: Any) -> Any:
        model = self

        class _Bound:
            def invoke(self, messages):
                model.digests.append(messages[-1].content)
                if isinstance(model.dossier, Exception):
                    raise model.dossier
                return SimpleNamespace(content=json.dumps(model.dossier), usage_metadata={})

        return _Bound()

    def invoke(self, prompt):
        return SimpleNamespace(content="Ein Satz aus der ersten und letzten Seite.")


@pytest.fixture
def reading(calls, monkeypatch):  # noqa: F811
    monkeypatch.setattr(document_classification, "classify_document_tags", lambda *a, **k: ["Sonstiges"])
    monkeypatch.setattr(document_classification, "suggest_topics", lambda *a, **k: [])

    def _run(tmp_path, dossier: Any = _DOSSIER):
        ingestor = calls["ingestor"]
        ingestor.generate_summary_enabled = True
        ingestor.summary_llm = model = _SummaryModel(dossier)
        detail = _ingest(calls, _pdf(tmp_path, *_LINES), "Baubeschreibung.pdf", None)
        from aiq_agent.knowledge import get_available_documents

        return detail, get_available_documents("proj_1")[0], model

    return _run


def test_the_dossier_is_written_from_the_digest_and_its_summary_is_the_documents(tmp_path, reading):
    detail, document, model = reading(tmp_path)

    assert detail.status.value == "success"
    (digest,) = model.digests
    assert "[Seite 1 · text]" in digest and "Brandschutzkonzept" in digest
    assert document.dossier["document_type"] == "building_description"
    assert document.dossier["facts"][0]["key"] == "building_class"
    assert document.summary == _DOSSIER["summary"]


def test_the_references_are_read_from_the_text_without_a_model(tmp_path, reading):
    _, document, _ = reading(tmp_path)

    found = {(r["kind"], r["key"]) for r in document.doc_references}
    assert {("document", "fire_safety_concept"), ("norm", "önorm b 1600"), ("plan", "ep-05")} <= found
    assert all(r["pages"] == [1] for r in document.doc_references)


def test_the_coverage_says_every_page_was_read(tmp_path, reading):
    _, document, _ = reading(tmp_path)

    assert document.coverage["pages"] == 1
    assert document.coverage["not_read"] == 0


def test_a_failed_dossier_keeps_the_old_summary_and_the_references(tmp_path, reading):
    detail, document, _ = reading(tmp_path, dossier=RuntimeError("provider down"))

    assert detail.status.value == "success"
    assert document.dossier is None
    assert document.summary == "Ein Satz aus der ersten und letzten Seite."
    assert any(r["kind"] == "norm" for r in document.doc_references)


def test_the_predecessor_is_the_re_uploaded_name_else_the_linked_version():
    from types import SimpleNamespace

    from knowledge_layer.llamaindex.adapter import _predecessor_dossier

    rows = [
        SimpleNamespace(file_name="EP-05_Index-B.pdf", dossier={"facts": []}),
        SimpleNamespace(file_name="EP-05.pdf", dossier={"facts": [{"key": "units", "value": "12"}]}),
        SimpleNamespace(file_name="Foto.jpg", dossier=None),
    ]
    assert _predecessor_dossier(rows, ["EP-05.pdf"], None)[0] == "EP-05.pdf"
    assert _predecessor_dossier(rows, [], "EP-05_Index-B.pdf")[0] == "EP-05_Index-B.pdf"
    assert _predecessor_dossier(rows, [], "Foto.jpg") is None
    assert _predecessor_dossier(rows, [], None) is None
