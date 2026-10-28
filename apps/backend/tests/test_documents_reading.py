"""The collection listing carries what the ingest read: the dossier, the references, the coverage.

The BFF reads all three off ``GET /v1/collections/{c}/documents`` (``FileInfo``) and derives the
project's findings from them (``docs/architecture/document-dossier.md``). They ride the same merge
as the other per-document metadata: a stored value fills an empty field and never overwrites one.
"""

import json

from agent.knowledge.schema import AvailableDocument
from agent.knowledge.schema import FileInfo
from agent.knowledge.schema import FileStatus
from backend.routes.documents import _merge_summaries

DOSSIER = {"version": 1, "document_type": "fire_safety_concept", "summary": "Brandschutzkonzept.", "facts": []}
REFERENCES = [{"kind": "plan", "key": "ep-05", "label": "EP-05", "pages": [3]}]
COVERAGE = {"pages": 12, "text": 10, "transcribed": 0, "drawings": 2, "drawings_read": 2, "not_read": 0, "reasons": {}}


def _file(name: str, **extra) -> FileInfo:
    return FileInfo(file_id=name, file_name=name, collection_name="proj_a", status=FileStatus.SUCCESS, **extra)


def test_the_reading_rides_the_listing_under_its_wire_names():
    files = [_file("BSK.pdf"), _file("Foto.jpg")]
    stored = AvailableDocument(file_name="BSK.pdf", dossier=DOSSIER, doc_references=REFERENCES, coverage=COVERAGE)

    _merge_summaries(files, [stored])

    wire = json.loads(files[0].model_dump_json())
    assert (wire["dossier"], wire["doc_references"], wire["coverage"]) == (DOSSIER, REFERENCES, COVERAGE)
    assert json.loads(files[1].model_dump_json())["dossier"] is None


def test_a_value_the_file_already_carries_is_not_overwritten():
    file = _file("BSK.pdf", coverage={"pages": 1})
    _merge_summaries([file], [AvailableDocument(file_name="BSK.pdf", coverage=COVERAGE)])
    assert file.coverage == {"pages": 1}


async def test_a_listing_read_without_the_metadata_store_says_so(monkeypatch):
    """The files still list; the header tells a projector not to take the empty readings as read."""
    from unittest.mock import MagicMock

    from fastapi import APIRouter
    from fastapi import FastAPI
    from httpx import ASGITransport
    from httpx import AsyncClient

    from agent.knowledge.factory import clear_active_ingestor
    from agent.knowledge.factory import set_active_ingestor
    from backend.routes import documents as routes

    async def present(*args, **kwargs):
        return None

    async def store_down(collection):
        raise RuntimeError("summary store unreachable")

    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.list_files.return_value = [_file("BSK.pdf")]
    monkeypatch.setattr(routes, "require_collection", present)
    monkeypatch.setattr(routes, "get_available_documents_async", store_down)
    set_active_ingestor(ingestor)
    try:
        app = FastAPI()
        router = APIRouter()
        routes.add_document_routes(router)
        app.include_router(router)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/v1/collections/proj_a/documents")
    finally:
        clear_active_ingestor()

    assert response.status_code == 200
    assert [row["file_name"] for row in response.json()] == ["BSK.pdf"]
    assert response.headers[routes.READING_UNAVAILABLE_HEADER] == "1"
