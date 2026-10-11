"""``page_image.load_page_jpeg``: a stored document's page as JPEG bytes, outside a chat turn.

The Fassung comparison reads two pages this way. Real PDF bytes are rendered by PDFium; the
BFF lookup and the object store are doubles, since what is pinned is the order of the steps
and that every failure is a ``PageImageUnavailable`` with a reason, never another exception.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from sources.knowledge_layer.src import page_image
from sources.knowledge_layer.src import view_image

from .pdf_fixtures import build_pdf

COLLECTION = "proj_a"
LOCATION = ("proj_a/doc/Grundriss.pdf", "bucket-a")


@pytest.fixture
def store(monkeypatch):
    """The BFF lookup and the object store, with a record of what they were asked."""
    state = {
        "location": LOCATION,
        "bytes": build_pdf([[("R", 12, "Seite eins")], [("R", 12, "Seite zwei")]]),
        "asked": [],
    }

    async def locate(collection, file_name, organization_id=None, image_index=None):
        state["asked"].append((collection, file_name, organization_id, image_index))
        return state["location"]

    def fetch(storage_key, storage_bucket=None):
        state["asked"].append((storage_key, storage_bucket))
        return state["bytes"]

    monkeypatch.setattr(view_image, "_resolve_storage_location", locate)
    monkeypatch.setattr(view_image, "_fetch_seaweed_bytes", fetch)
    return state


async def _reason(**kwargs) -> str:
    with pytest.raises(page_image.PageImageUnavailable) as raised:
        await page_image.load_page_jpeg(**{"collection": COLLECTION, "file_name": "Grundriss.pdf", "page": 1, **kwargs})
    return raised.value.reason


async def test_a_pdf_page_is_rendered_from_the_stored_original(store):
    image = await page_image.load_page_jpeg(COLLECTION, "Grundriss.pdf", 2, organization_id="org-1", max_dim=400)

    assert image.jpeg.startswith(b"\xff\xd8")
    assert max(image.width, image.height) == 400
    assert Image.open(io.BytesIO(image.jpeg)).size == (image.width, image.height)
    assert store["asked"] == [(COLLECTION, "Grundriss.pdf", "org-1", None), LOCATION]


async def test_an_uploaded_image_is_its_own_single_page(store):
    buf = io.BytesIO()
    Image.new("RGB", (3000, 1000), "white").save(buf, format="PNG")
    store["bytes"] = buf.getvalue()

    image = await page_image.load_page_jpeg(COLLECTION, "Foto.png", 1, max_dim=1500)

    assert (image.width, image.height) == (1500, 500)
    assert await _reason(file_name="Foto.png", page=2) == "page_not_found"


async def test_a_page_past_the_end_is_not_found(store):
    assert await _reason(page=3) == "page_not_found"


async def test_a_page_below_one_is_invalid_and_nothing_is_looked_up(store):
    assert await _reason(page=0) == "invalid_page"
    assert store["asked"] == []


async def test_a_file_the_bff_does_not_know_is_not_stored(store):
    store["location"] = None

    assert await _reason() == "not_stored"


async def test_bytes_the_object_store_does_not_give_are_a_failed_fetch(store):
    store["bytes"] = None

    assert await _reason() == "fetch_failed"


async def test_bytes_that_are_no_pdf_are_not_found_as_a_page(store):
    store["bytes"] = b"this is not a pdf"

    assert await _reason() == "page_not_found"
