"""The estate grep suites' corpus and backend: the files fixture's Brandschutzkonzept
cut by the real section chunker, a retriever over it, and the grounding capture.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from knowledge_layer.browse import FileRow
from knowledge_layer.estate import EstateBackend
from knowledge_layer.qdrant.retrieval import PatternTooCostly

from agent.common.grounding_block import begin_grounding_capture
from agent.common.grounding_block import end_grounding_capture
from agent.knowledge.schema import Chunk
from agent.knowledge.schema import ContentType
from agent.knowledge.scoping import ScopedCollection

# The repository, found by what it holds, so moving this package moves nothing here.
REPO_ROOT = next(path for path in Path(__file__).resolve().parents if (path / "scripts" / "turn_census").is_dir())
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import fixture_files  # noqa: E402

PROJECT = fixture_files.load_project()
REPORT = "Brandschutzkonzept_Hubergasse14.pdf"
COLLECTION = "proj_1"
OFFICE = "office_shelf_org"


def _chunks(name: str = REPORT) -> list[Chunk]:
    file = next(f for f in PROJECT.files if f.name == name)
    out = []
    for spec in fixture_files.chunk_specs(PROJECT, file):
        metadata = {**spec["metadata"], "chunk_ordinal": spec["ordinal"]}
        page = int(metadata["page_label"])
        out.append(
            Chunk(
                chunk_id=spec["chunk_id"],
                content=spec["text"],
                score=1.0,
                file_name=name,
                page_number=page,
                display_citation=f"{name}, p.{page}",
                content_type=ContentType.TEXT,
                metadata=metadata,
            )
        )
    return out


def _report_row() -> FileRow:
    file = next(f for f in PROJECT.files if f.name == REPORT)
    return FileRow(file_name=REPORT, shelf="project", collection=COLLECTION, folder=file.folder or "")


class Retriever:
    """``find_text`` as the store answers it: every chunk the pattern finds, per collection."""

    def __init__(self, by_collection: dict, fail: set[str] = frozenset(), deadline: set[str] = frozenset()):
        self.by_collection = by_collection
        self.fail = fail
        self.deadline = deadline
        self.asked: list[str] = []

    async def find_text(self, collection, pattern, *, filters=None, limit=500, user_regex=False, stem_phrases=None):
        self.asked.append(collection)
        if collection in self.fail:
            raise RuntimeError("store down")
        if collection in self.deadline:
            raise PatternTooCostly(pattern, scan=True)
        compiled = re.compile(pattern, re.IGNORECASE) if user_regex else re.compile(pattern)
        return [
            chunk.model_copy(deep=True)
            for chunk in self.by_collection.get(collection, [])
            if compiled.search(chunk.content)
        ][:limit]


def _backend(retriever: Retriever, rows=None, stored=None) -> EstateBackend:
    rows = (
        rows
        if rows is not None
        else [
            _report_row(),
            FileRow(file_name="Vorlage.docx", shelf="office_shelf", collection=OFFICE, folder="Vorlagen"),
        ]
    )

    async def listable():
        return list(rows)

    async def none():
        return []

    backend = EstateBackend(SimpleNamespace(), rows_loader=listable, restricted_loader=none, retriever=retriever)
    backend.entries = lambda: [ScopedCollection(COLLECTION, "project"), ScopedCollection(OFFICE, "office_shelf")]
    backend._restricted_search_loader = none

    async def reader(collection, file_name, *, wanted=None):
        return stored(collection, file_name) if stored else None

    backend._stored_reader = reader
    return backend


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    from knowledge_layer import browse

    monkeypatch.setattr(browse, "_collection_filter", lambda collection, **_kwargs: None)
    monkeypatch.setattr("knowledge_layer.search_scope.resolve_base_collection", lambda _config: "oib_knowledge")
    token = begin_grounding_capture()
    try:
        yield
    finally:
        end_grounding_capture(token)
