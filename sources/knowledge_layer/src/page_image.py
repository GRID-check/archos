"""One page of a stored document as JPEG bytes, for a caller that is not a chat turn.

``view_knowledge_image`` shows a page to the model inside a turn: it is bound to
the turn's scope and its per-turn image budget, and it answers in content
blocks. The Fassung comparison (``aiq_api.routes.fassung_compare``) needs the
same bytes outside a turn, so this is the same three steps without the tool
around them: ask the BFF where the document lives (``GET
/api/internal/document-file``), fetch the object from SeaweedFS, render the page
(a PDF) or re-encode the image (an uploaded picture) to the long edge the
ingest-time captioning used.

**Nothing is stored per page.** Ingestion keeps the rasters it cut out of a PDF
(``llamaindex/image_store``) and one thumbnail per document, not a render of
every page, so a page is rendered from the original on demand, exactly as
``view_knowledge_image`` does it. Those helpers are used as they are, so a
change to how a page is rendered lands in both places.

**Who may ask is not decided here.** The lookup carries no turn envelope, so the
BFF answers for an ordinary collection by name and never for a restricted
folder's (ADR-0088): such a page is simply unavailable. The caller is the
backend's own route, behind the BFF's access check.

Every failure is a :class:`PageImageUnavailable` with a reason code; nothing
else is raised.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from . import view_image as _view

logger = logging.getLogger(__name__)


class PageImageUnavailable(Exception):
    """The page could not be produced. ``reason`` is a code, never a path or a key."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class PageImage:
    """A page as JPEG bytes, with its pixel size."""

    jpeg: bytes
    width: int
    height: int


async def load_page_jpeg(
    collection: str,
    file_name: str,
    page: int,
    *,
    organization_id: str | None = None,
    max_dim: int | None = None,
    timeout: float = 30.0,
) -> PageImage:
    """Page ``page`` (1-based) of ``file_name`` in ``collection``.

    A standalone image has one page. Raises :class:`PageImageUnavailable` with
    ``not_stored`` (the BFF knows no such file), ``fetch_failed`` (the object
    store did not give the bytes), ``page_not_found`` (the page does not exist
    or the file is not a PDF or an image) or ``invalid_page``.
    """
    if page < 1:
        raise PageImageUnavailable("invalid_page")
    limit = max_dim or _view._default_max_dim()
    location = await _view._resolve_storage_location(collection, file_name, organization_id)
    if location is None:
        raise PageImageUnavailable("not_stored")
    try:
        data = await asyncio.wait_for(asyncio.to_thread(_view._fetch_seaweed_bytes, *location), timeout=timeout)
    except Exception:  # noqa: BLE001 - every failure is the same answer to the caller
        logger.warning("page_image: fetch failed for %s/%s", collection, file_name, exc_info=True)
        data = None
    if data is None:
        raise PageImageUnavailable("fetch_failed")

    standalone = _view._is_standalone_image(file_name)
    if standalone and page != 1:
        raise PageImageUnavailable("page_not_found")
    render = _view._normalize_image_to_jpeg if standalone else _view._render_page_from_bytes
    arguments = (data, limit) if standalone else (data, page, limit)
    try:
        jpeg, width, height = await asyncio.wait_for(asyncio.to_thread(render, *arguments), timeout=timeout)
    except Exception:  # noqa: BLE001 - a page past the end, a damaged file and a non-PDF alike
        logger.warning("page_image: render failed for %s/%s page %d", collection, file_name, page, exc_info=True)
        raise PageImageUnavailable("page_not_found") from None
    return PageImage(jpeg=jpeg, width=width, height=height)
