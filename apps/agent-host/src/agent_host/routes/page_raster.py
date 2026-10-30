"""One page of a PDF as a palette PNG, for a Skizze drawn over it (S6, ``docs/roadmap/sketches.md``).

``POST /v1/internal/page-raster?page=&dpi=`` takes the PDF's bytes as the body and answers the
page as a 16-colour palette PNG, its long side at most :data:`MAX_LONG_SIDE` pixels.
``POST /v1/internal/page-labels`` answers the page labels a PDF names (``"A-101"``,
``"iii"``), or ``null`` for a page without one, so a Skizze moved to a newer Fassung lands on the
page with the same label.

**The BFF decides everything else** (``apps/workspace/bff/documents/page-raster.ts``): who may
read the document, which Fassung, whether its bytes are held, and the cache. This route gets
bytes and gives bytes; it names no collection, no key and no person, so it can serve a
restricted folder's page exactly as an open one's, and never a page the BFF did not hand it.
Internal-token only, off the external allowlist.

**Why a palette PNG.** A drawing is mostly white with a few greys: at 150 dpi an A3 sheet is
531 KB as a 16-colour palette PNG, 1.03 MB as JPEG q80, and the PNG has no ringing around thin
lines (spike r3). WebP is out because the PDF step (@react-pdf) refuses it. Transparency is
flattened onto white first, because the page is paper.

Answers: ``200`` with ``image/png`` and the page facts in ``x-page-*`` headers, ``422`` when
the bytes are no PDF or the page does not exist (``detail`` names which), ``413`` past
:data:`MAX_PDF_BYTES` (checked on ``Content-Length`` before the body is read), ``503`` when
:data:`MAX_CONCURRENT_RENDERS` are already running and none finishes within
:data:`QUEUE_TIMEOUT_S`, ``504`` past :data:`RENDER_TIMEOUT_S`.

**Bounded work.** A page is drawn at most :data:`MAX_PIXELS` pixels, whatever its size, and at
most :data:`MAX_CONCURRENT_RENDERS` renders of this route run at once, on their own slots, so a
flood of misses never fills the default executor. A render past :data:`RENDER_TIMEOUT_S` is
answered 504 and keeps its slot until pdfium returns: pdfium cannot be interrupted in-process, so
a stuck page costs one slot, never the process. Rendering in a killable subprocess is the next
step (ADR-0150, consequences).
"""

from __future__ import annotations

import asyncio
import io
import logging
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from fastapi import Response
from knowledge_layer.llamaindex.pdfium_lock import detached_pil
from knowledge_layer.llamaindex.pdfium_lock import pdfium_lock

from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: The long side of a raster, in pixels: an A0 sheet at 150 dpi would be 7016 and is drawn smaller.
MAX_LONG_SIDE = 4096
#: The resolutions the BFF may ask for; the Skizze's ``customData.underlay.dpi`` is one of them.
DPIS = (100, 150, 200)
#: The colours of the palette.
PALETTE_COLOURS = 16
#: The PDF the BFF may send. A plan set of this size is rare; past it the page is not drawn.
MAX_PDF_BYTES = 256 * 1024 * 1024
#: Pages a label list names at most; a longer document answers the first ones, and its page count.
MAX_LABELS = 2000
#: Pixels a raster holds at most: 4096 x 2900, an A-series sheet on its long side.
MAX_PIXELS = 4096 * 2900
#: Renders of this route at once, process-wide.
MAX_CONCURRENT_RENDERS = 2
#: How long a request waits for a free slot.
QUEUE_TIMEOUT_S = 10.0
#: How long a render is waited for (the BFF gives up at 30 s).
RENDER_TIMEOUT_S = 25.0

_slots: asyncio.Semaphore | None = None


def _render_slots() -> asyncio.Semaphore:
    global _slots  # noqa: PLW0603 - one semaphore per process, made on the running loop
    if _slots is None:
        _slots = asyncio.Semaphore(MAX_CONCURRENT_RENDERS)
    return _slots


@dataclass(frozen=True)
class PageRaster:
    """A page as PNG bytes, with the facts the BFF stores beside it."""

    png: bytes
    width: int
    height: int
    page_count: int
    label: str | None
    width_pt: float
    height_pt: float


def _label(doc, index: int) -> str | None:  # noqa: ANN001 - a pypdfium2 PdfDocument
    try:
        label = doc.get_page_label(index)
    except Exception:  # noqa: BLE001 - a broken label tree is a page without a label
        return None
    if not isinstance(label, str):
        return None
    return label.strip() or None


def raster_scale(width_pt: float, height_pt: float, dpi: int) -> float:
    """The scale a page is drawn at: ``dpi``, no side past :data:`MAX_LONG_SIDE`, no more than :data:`MAX_PIXELS`."""
    long_side = max(width_pt, height_pt) or 1.0
    scale = min(dpi / 72.0, MAX_LONG_SIDE / long_side)
    area = max(width_pt, 1.0) * max(height_pt, 1.0) * scale * scale
    if area > MAX_PIXELS:
        scale *= (MAX_PIXELS / area) ** 0.5
    return scale


def _to_png(image) -> bytes:  # noqa: ANN001 - a PIL image
    from PIL import Image

    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        paper = Image.new("RGB", rgba.size, (255, 255, 255))
        paper.paste(rgba, mask=rgba.split()[-1])
        image = paper
    palette = image.convert("RGB").quantize(colors=PALETTE_COLOURS, method=Image.Quantize.FASTOCTREE)
    out = io.BytesIO()
    # `optimize` would save 6 % for seven times the time (771 ms against 107 on an A3 page).
    palette.save(out, format="PNG")
    return out.getvalue()


def render_page_raster(pdf: bytes, page: int, dpi: int) -> PageRaster:
    """Draw page ``page`` (1-based) at ``dpi``, the long side capped. Raises ``ValueError`` naming the fault."""
    import pypdfium2 as pdfium

    with pdfium_lock():
        try:
            doc = pdfium.PdfDocument(pdf)
        except Exception as error:  # noqa: BLE001 - every unreadable file is the same answer
            raise ValueError("not_a_pdf") from error
        try:
            count = len(doc)
            if page < 1 or page > count:
                raise ValueError("no_such_page")
            pdf_page = doc[page - 1]
            try:
                width_pt, height_pt = pdf_page.get_size()
                scale = raster_scale(width_pt, height_pt, dpi)
                image = detached_pil(pdf_page.render(scale=scale))
            finally:
                pdf_page.close()
            label = _label(doc, page - 1)
        finally:
            doc.close()
    png = _to_png(image)
    return PageRaster(png, image.width, image.height, count, label, round(width_pt, 2), round(height_pt, 2))


def read_page_labels(pdf: bytes) -> tuple[list[str | None], int]:
    """The first :data:`MAX_LABELS` pages' labels, ``None`` where a page has none, and the page count.

    Raises ``ValueError("not_a_pdf")``.
    """
    import pypdfium2 as pdfium

    with pdfium_lock():
        try:
            doc = pdfium.PdfDocument(pdf)
        except Exception as error:  # noqa: BLE001
            raise ValueError("not_a_pdf") from error
        try:
            count = len(doc)
            return [_label(doc, index) for index in range(min(count, MAX_LABELS))], count
        finally:
            doc.close()


async def _body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_PDF_BYTES):
        raise HTTPException(status_code=413, detail="too_large")
    body = await request.body()
    if len(body) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="too_large")
    return body


async def _bounded(fn, *args):  # noqa: ANN001, ANN002, ANN202 - a pdfium call and its arguments
    """Run ``fn`` on a thread in one of :data:`MAX_CONCURRENT_RENDERS` slots, waited for :data:`RENDER_TIMEOUT_S`.

    The slot is given back when the thread returns, not when the wait ends, so a render that outlives
    its request still counts against the bound.
    """
    slots = _render_slots()
    try:
        await asyncio.wait_for(slots.acquire(), QUEUE_TIMEOUT_S)
    except TimeoutError as error:
        raise HTTPException(status_code=503, detail="renderer_busy") from error
    task = asyncio.ensure_future(asyncio.to_thread(fn, *args))
    task.add_done_callback(lambda _: slots.release())
    try:
        return await asyncio.wait_for(asyncio.shield(task), RENDER_TIMEOUT_S)
    except TimeoutError as error:
        logger.warning(
            "page raster: a render ran past %.0f s and keeps its slot until pdfium returns", RENDER_TIMEOUT_S
        )
        raise HTTPException(status_code=504, detail="render_timeout") from error


def add_page_raster_routes(router: APIRouter) -> None:
    """Register the page raster and page label endpoints."""

    @router.post(
        "/v1/internal/page-raster",
        tags=["platform"],
        summary="Draw one page of a PDF as a palette PNG",
        response_class=Response,
    )
    async def page_raster(
        request: Request,
        page: int = Query(..., ge=1, le=9999),
        dpi: int = Query(150),
    ) -> Response:
        """The page as PNG, or 422 naming why not."""
        _require_internal_token(request)
        if dpi not in DPIS:
            raise HTTPException(status_code=422, detail="bad_dpi")
        body = await _body(request)
        try:
            raster = await _bounded(render_page_raster, body, page, dpi)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        headers = {
            "x-page-count": str(raster.page_count),
            "x-page-width-pt": str(raster.width_pt),
            "x-page-height-pt": str(raster.height_pt),
            "x-raster-width": str(raster.width),
            "x-raster-height": str(raster.height),
        }
        if raster.label:
            headers["x-page-label"] = quote(raster.label, safe="")
        return Response(content=raster.png, media_type="image/png", headers=headers)

    @router.post("/v1/internal/page-labels", tags=["platform"], summary="Read the page labels of a PDF")
    async def page_labels(request: Request) -> dict[str, object]:
        """``{"labels": [...], "pageCount": n}``, labels up to :data:`MAX_LABELS`; 422 for bytes that are no PDF."""
        _require_internal_token(request)
        body = await _body(request)
        try:
            labels, count = await _bounded(read_page_labels, body)
            return {"labels": labels, "pageCount": count}
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
