"""The collection listing carries what the ingest read: the dossier, the references, the coverage.

The BFF reads all three off ``GET /v1/collections/{c}/documents`` (``FileInfo``) and derives the
project's findings from them (``docs/architecture/document-dossier.md``). They ride the same merge
as the other per-document metadata: a stored value fills an empty field and never overwrites one.
"""

import json

from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_api.routes.documents import _merge_summaries

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
