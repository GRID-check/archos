"""The collection listing carries the title-block facts (``revision_facts``) beside topics and capture.

The BFF reads ``revision_facts`` off ``GET /v1/collections/{c}/documents`` (``FileInfo``): Plannummer,
Index and Datum read from the Plankopf during ingestion, present keys only. They ride the same merge
as the other per-document metadata: stored values fill an empty field and never overwrite one.
"""

import json

from agent.knowledge.schema import AvailableDocument
from agent.knowledge.schema import FileInfo
from agent.knowledge.schema import FileStatus
from backend.routes.documents import _merge_summaries

FACTS = {
    "document_number": "A-101",
    "revision": "C",
    "revision_date": "2026-08-14",
    "scale": "1:100",
    "title": "Grundriss EG",
    "page": 2,
}


def _file(name: str, **extra) -> FileInfo:
    return FileInfo(file_id=name, file_name=name, collection_name="proj_a", status=FileStatus.SUCCESS, **extra)


def test_the_facts_ride_the_listing_under_their_wire_name():
    files = [_file("Zeichnung 7.pdf"), _file("Bericht.pdf")]

    _merge_summaries(files, [AvailableDocument(file_name="Zeichnung 7.pdf", revision_facts=FACTS)])

    assert files[0].revision_facts == FACTS
    assert files[1].revision_facts is None
    assert json.loads(files[0].model_dump_json())["revision_facts"] == FACTS


def test_a_document_without_facts_leaves_the_field_null_in_the_payload():
    (file,) = [_file("Bericht.pdf")]
    _merge_summaries([file], [AvailableDocument(file_name="Bericht.pdf", summary="Ein Bericht.")])
    assert json.loads(file.model_dump_json())["revision_facts"] is None


def test_a_value_the_file_already_carries_is_not_overwritten():
    file = _file("Zeichnung 7.pdf", revision_facts={"revision": "A"})

    _merge_summaries([file], [AvailableDocument(file_name="Zeichnung 7.pdf", revision_facts=FACTS)])

    assert file.revision_facts == {"revision": "A"}


def test_an_open_suggestion_by_title_block_keeps_its_basis_on_the_wire():
    suggestion = {
        "of": "Zeichnung 7.pdf",
        "confidence": 0.95,
        "reason": "Gleiche Nummer im Plankopf (A-101), Index C statt B.",
        "basis": "title_block",
        "dismissed": False,
    }
    files = [_file("Zeichnung 7.pdf"), _file("Entwurf neu.pdf")]

    _merge_summaries(
        files,
        [
            AvailableDocument(file_name="Zeichnung 7.pdf"),
            AvailableDocument(file_name="Entwurf neu.pdf", revision_suggestion=suggestion),
        ],
    )

    assert files[1].revision_suggestion == {key: suggestion[key] for key in ("of", "confidence", "reason", "basis")}
