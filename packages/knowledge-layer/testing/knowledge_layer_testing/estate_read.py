"""The estate read suites' rows, pages and backend, with the grounding capture."""

from __future__ import annotations

from contextvars import ContextVar
from types import SimpleNamespace

import pytest
from knowledge_layer import stored_pages
from knowledge_layer.browse import FileRow
from knowledge_layer.estate import EstateBackend

from agent.common.grounding_block import begin_grounding_capture
from agent.common.grounding_block import end_grounding_capture

RESTRICTED = "proj_a_r0123456789ab"

BSK = FileRow(
    file_name="Brandschutzkonzept.pdf",
    shelf="project",
    collection="proj_a",
    folder="Gutachten/Brandschutz",
    display_title="Brandschutzkonzept Hubergasse 14",
    doc_class="fire_safety_concept",
    page_count=3,
)
NOTE = FileRow(file_name="Notiz.txt", shelf="project", collection="proj_a", folder="")
SECRET = FileRow(file_name="Vertrag.pdf", shelf="project", collection=RESTRICTED, folder="Personal")

PAGES = {
    1: "1. Allgemeines\nDas Gebäude hat vier Geschoße.",
    2: "2. Bauliche Maßnahmen\n2.1 Rettungsweg\nDer Fluchtweg führt über das Stiegenhaus ins Freie.",
    3: "3. Anlagen\nKeine Sprinkleranlage.",
}

#: Which tenant the current "turn" is: the rows loader reads it, as the real one reads the turn's scope.
TURN: ContextVar[str] = ContextVar("turn", default="org_a")
ROWS = {"org_a": [BSK, NOTE], "org_b": [FileRow(file_name="Fremd.pdf", shelf="project", collection="proj_b")]}


def _page_reader(text_by_file: dict[str, dict[int, str]], origin: str = "stored"):
    async def read(collection: str, file_name: str, *, wanted=None):
        pages = text_by_file.get(file_name)
        if pages is None:
            return None
        items = [
            stored_pages.Page(number=n, text=t, source="text_layer" if origin == "stored" else "chunks")
            for n, t in sorted(pages.items())
            if wanted is None or n in wanted
        ]
        return stored_pages.PageText(pages=items, origin=origin, page_count=max(pages))

    return read


def _backend(page_reader=None, restricted=()) -> EstateBackend:
    async def rows():
        return list(ROWS[TURN.get()])

    async def restricted_rows():
        return list(restricted)

    return EstateBackend(
        SimpleNamespace(),
        rows_loader=rows,
        restricted_loader=restricted_rows,
        page_reader=page_reader or _page_reader({"Brandschutzkonzept.pdf": PAGES, "Notiz.txt": {1: "a\nb\nc"}}),
    )


@pytest.fixture(autouse=True)
def _capture():
    token = begin_grounding_capture()
    try:
        yield
    finally:
        end_grounding_capture(token)
