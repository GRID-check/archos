"""The estate listing suites' rows and backend, with no file in flight."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from knowledge_layer.browse import FileRow
from knowledge_layer.estate import EstateBackend

ROWS = [
    FileRow(
        file_name="EP-01_Grundrisse.pdf",
        shelf="project",
        collection="proj_a",
        folder="Einreichung/Pläne",
        doc_class="submission_plan",
        page_count=4,
        revision_facts={"revision": "B"},
    ),
    FileRow(file_name="EP-02_Schnitte.pdf", shelf="project", collection="proj_a", folder="Einreichung/Pläne"),
    FileRow(
        file_name="Baubeschreibung.docx",
        shelf="project",
        collection="proj_a",
        folder="Einreichung",
        superseded_by="Baubeschreibung_v2.docx",
    ),
    FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_a", folder="Gutachten/Brandschutz"),
    FileRow(file_name="Vorlage.docx", shelf="office_shelf", collection="office_shelf_org", folder="Vorlagen"),
    FileRow(file_name="oib-rl_2_ausgabe_mai_2023.pdf", shelf="base", collection="oib_knowledge"),
]
#: A restricted folder's documents never reach the listable rows (``browse._turn_rows`` filters them),
#: so the backend under test gets exactly those; the restricted ones exist only as readable rows.
SECRET = FileRow(file_name="Vertrag.pdf", shelf="project", collection="proj_a_r0123456789ab", folder="Personal")


def _backend(rows=ROWS) -> EstateBackend:
    async def listable():
        return list(rows)

    async def restricted():
        return [SECRET]

    async def no_pages(*_args, **_kwargs):
        return None

    backend = EstateBackend(SimpleNamespace(), rows_loader=listable, restricted_loader=restricted, page_reader=no_pages)

    async def no_abstracts(files, mount):
        return {}

    backend._abstracts = no_abstracts  # type: ignore[method-assign]
    return backend


@pytest.fixture(autouse=True)
def _no_in_flight(monkeypatch):
    from knowledge_layer import estate

    async def none(_files):
        return []

    monkeypatch.setattr(estate, "_in_flight", none)
