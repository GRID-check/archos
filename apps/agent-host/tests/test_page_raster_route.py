"""The page raster route draws a real PDF page as a palette PNG, capped, and refuses what is no page.

A PDF is made with pypdfium2 itself (two A3 landscape pages, one filled rectangle), so the
render, the quantisation and the wire shape are the real ones.
"""

from __future__ import annotations

import io

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from PIL import Image

from agent_host.routes.internal_auth import _TOKEN_HEADERS
from agent_host.routes.page_raster import MAX_LONG_SIDE
from agent_host.routes.page_raster import PALETTE_COLOURS
from agent_host.routes.page_raster import add_page_raster_routes

TOKEN = "page-raster-test-token"
A3 = (1190.55, 841.89)
A0 = (3370.39, 2383.94)


def _pdf(size: tuple[float, float], pages: int = 2) -> bytes:
    import pypdfium2 as pdfium
    from pypdfium2 import raw

    doc = pdfium.PdfDocument.new()
    for _ in range(pages):
        page = doc.new_page(*size)
        rect = raw.FPDFPageObj_CreateNewRect(100, 100, 300, 200)
        raw.FPDFPageObj_SetFillColor(rect, 40, 40, 40, 255)
        raw.FPDFPath_SetDrawMode(rect, raw.FPDF_FILLMODE_ALTERNATE, False)
        raw.FPDFPage_InsertObject(page, rect)
        raw.FPDFPage_GenerateContent(page)
        page.close()
    out = io.BytesIO()
    doc.save(out)
    doc.close()
    return out.getvalue()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> AsyncClient:
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("APP_ENV", "test")
    router = APIRouter()
    add_page_raster_routes(router)
    app = FastAPI()
    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _headers() -> dict[str, str]:
    return {_TOKEN_HEADERS[0]: TOKEN, "content-type": "application/pdf"}


async def test_a3_page_at_150_dpi_is_a_small_palette_png(client: AsyncClient) -> None:
    response = await client.post("/v1/internal/page-raster?page=2&dpi=150", content=_pdf(A3), headers=_headers())
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-page-count"] == "2"
    image = Image.open(io.BytesIO(response.content))
    assert image.mode == "P"
    assert len(image.getcolors()) <= PALETTE_COLOURS
    assert abs(image.width - 2480) <= 1 and abs(image.height - 1754) <= 1
    assert response.headers["x-raster-width"] == str(image.width)
    assert float(response.headers["x-page-width-pt"]) == pytest.approx(A3[0], abs=0.01)


async def test_a_large_sheet_is_capped_on_its_long_side(client: AsyncClient) -> None:
    response = await client.post("/v1/internal/page-raster?page=1&dpi=200", content=_pdf(A0, 1), headers=_headers())
    assert response.status_code == 200
    image = Image.open(io.BytesIO(response.content))
    assert max(image.size) == MAX_LONG_SIDE


@pytest.mark.parametrize(
    ("query", "body", "detail"),
    [
        ("page=3&dpi=150", None, "no_such_page"),
        ("page=1&dpi=150", b"%PDF-no", "not_a_pdf"),
        ("page=1&dpi=300", None, "bad_dpi"),
    ],
)
async def test_what_is_no_page_is_named(client: AsyncClient, query: str, body: bytes | None, detail: str) -> None:
    response = await client.post(f"/v1/internal/page-raster?{query}", content=body or _pdf(A3), headers=_headers())
    assert response.status_code == 422
    assert response.json()["detail"] == detail


async def test_labels_list_one_entry_per_page(client: AsyncClient) -> None:
    response = await client.post("/v1/internal/page-labels", content=_pdf(A3, 3), headers=_headers())
    assert response.status_code == 200
    assert response.json() == {"labels": [None, None, None]}


async def test_without_the_internal_token_nothing_is_drawn(client: AsyncClient) -> None:
    response = await client.post(
        "/v1/internal/page-raster?page=1&dpi=150", content=_pdf(A3), headers={"content-type": "application/pdf"}
    )
    assert response.status_code == 403
