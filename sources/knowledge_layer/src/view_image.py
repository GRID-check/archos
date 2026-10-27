"""The renderer behind ``look``: a page, a region of it, or an image, as content blocks.

Agents retrieve caption-only chunks for image/drawing pages: the caption
describes the image but the model never sees it. :func:`view_image` returns the
source visual as a multimodal content block (``image_url`` with a data URL), so
vision-capable models can inspect drawings, sections, elevations and charts
directly at answer time. The tool the model calls is ``look``
(``aiq_agent.tools.look``, ADR-0128), which resolves WHICH file and collection
and hands them here; this module is no NAT function of its own any more.

Three source shapes are covered, without re-ingest:

- **PDF pages** — the requested page is rendered from the original PDF on
  demand (max-dim capped). Base-corpus PDFs are read from this replica's cache
  of the corpus, filled from the object store on demand
  (``corpus_store.ensure_local``); project/Archiv PDFs are fetched from
  SeaweedFS and rendered from bytes.
- **Standalone images** (PNG/JPG project/Archiv uploads) — the stored bytes
  are fetched from SeaweedFS and returned directly (re-encoded to JPEG).
- **Stored embedded rasters** — an image the ingest pipeline cut out of a
  PDF and kept beside the document (``<doc dir>/_img/<index>.jpg``, see
  ``llamaindex/image_store.py``). Addressed by ``image_index``; the hit's
  ``Image:`` line names the index. Fetched at its own resolution instead of
  rendering the page it sits on.

Storage-key resolution goes through the BFF internal lookup
(``GET /api/internal/document-file``): the backend carries only
``(collection, filename)``, and the mapping to a SeaweedFS ``storage_key``
lives in the frontend's ``documents`` table. For a stored raster the BFF
builds the derived key from the document's own row, so this tool never names
an object key itself. Fail-open: every failure returns a text-only block
explaining what went wrong — the tool never raises.

The collection reaches here from ``look``'s resolution, never typed by the
model, and it is still checked before anything is looked up (ADR-0088): it must
be in the turn's scope, and a restricted folder's collection must also be one
the turn may draw on. The lookup echoes the turn's
signed envelope, and the BFF answers only inside the scope it signs. An image
returned from a collection is reported (``note_collections_read``), so the tools
node admits a restricted folder's image before the model sees it.

Bounded per turn: :mod:`aiq_agent.common.image_view_budget` caps how many
looks one turn may take, and how many of them may be whole pages; past either
cap the tool answers with a short text block instead of an image, and every
image it does return says how many looks are left.
"""

import asyncio
import base64
import io
import logging
import math
import os
from dataclasses import dataclass
from dataclasses import replace

from knowledge_layer.llamaindex.pdfium_lock import detached_pil
from knowledge_layer.llamaindex.pdfium_lock import pdfium_lock

from aiq_agent.common import seaweed_s3
from aiq_agent.common.image_view_budget import MAX_IMAGE_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import MAX_OVERVIEW_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import get_image_view_budget
from aiq_agent.common.image_view_budget import note_region_viewed
from aiq_agent.common.image_view_budget import remaining_views_text
from aiq_agent.common.image_view_budget import try_consume_image_view
from aiq_agent.common.source_kinds import office_shelf_organization_id
from aiq_agent.knowledge.restricted_use import note_collections_read

logger = logging.getLogger(__name__)

# Long edge of the rendered page, in pixels. Mirrors the ingestion-time
# visual-page render (AIQ_RENDER_VISUAL_PAGES) so the model sees the page at
# the same resolution it was captioned at.
_MAX_DIM_ENV = "AIQ_PAGE_RENDER_MAX_DIM"
_DEFAULT_MAX_DIM = 2048

# Gate env: when "off", the tool is available but answers with a text-only
# block. The capability half of the gate (vision key) is derived, never
# configured: without a VLM key no model in the fleet can consume images.
_VIEW_IMAGES_ENABLED_ENV = "AIQ_VIEW_IMAGES_ENABLED"

_JPEG_QUALITY = 90

# Standalone-image extensions (an uploaded image file, not a page of a PDF).
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}

# BFF internal lookup + SeaweedFS (S3) fetch. FRONTEND_INTERNAL_URL +
# GRID_INTERNAL_API_TOKEN are already present on the aiq-agent tier; the
# SEAWEED_* set is injected by the same tier once the backend fetches bytes
# directly (the client itself is `aiq_agent.common.seaweed_s3`, shared with the
# base-corpus store). All are read lazily so a base-corpus-only deployment (no
# project uploads) needs none of them.
_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"


def default_max_dim() -> int:
    """The long edge a page is rendered at: ``AIQ_PAGE_RENDER_MAX_DIM``, or 2048."""
    try:
        value = int(os.environ.get(_MAX_DIM_ENV, str(_DEFAULT_MAX_DIM)).strip())
    except ValueError:
        return _DEFAULT_MAX_DIM
    return value if value > 0 else _DEFAULT_MAX_DIM


def _is_enabled() -> bool:
    flag = os.environ.get(_VIEW_IMAGES_ENABLED_ENV, "true").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def _find_pdf(file_name: str) -> str | None:
    """The base-corpus PDF ``file_name``, fetched into this replica's cache if needed, or ``None``.

    The corpus table decides what a base-corpus file is
    (``corpus_store.ensure_local``). Fail-open like the rest of the tool: a
    corpus that cannot be read counts as "not a base-corpus file", and the caller
    goes on to the project/Archiv lookup.
    """
    try:
        from aiq_agent import corpus_store

        cached = corpus_store.ensure_local(file_name)
    except Exception:  # noqa: BLE001 - fail-open contract
        logger.warning("look: base-corpus lookup failed for %s", file_name, exc_info=True)
        return None
    return str(cached) if cached is not None else None


def _render_pdf_page(source: str | bytes, page_number: int, max_dim: int) -> tuple[bytes, int, int]:
    """Render one page (1-based) of a PDF, given as a path or its bytes, to JPEG bytes.

    Every PDFium call, the closes included, runs under the process-wide
    :func:`pdfium_lock` (this tool renders on the event loop's executor while
    the ingest pool renders on its own threads, and PDFium is not
    thread-safe). The image leaves the lock detached from the bitmap, and the
    JPEG encode runs after it is released.
    """
    import pypdfium2 as pdfium

    with pdfium_lock():
        doc = pdfium.PdfDocument(source)
        try:
            page = doc[page_number - 1]
            try:
                width_pt, height_pt = page.get_size()
                longest_pt = max(width_pt, height_pt) or 1.0
                pil_image = detached_pil(page.render(scale=max_dim / longest_pt))
            finally:
                page.close()
        finally:
            doc.close()

    rgb = pil_image.convert("RGB")
    buf = io.BytesIO()
    rgb.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue(), rgb.width, rgb.height


def _render_page(pdf_path: str, page_number: int, max_dim: int) -> tuple[bytes, int, int]:
    """Render one page (1-based) of a PDF on disk to JPEG bytes.

    Returns ``(jpeg_bytes, width_px, height_px)``. Raises on any failure; the
    caller turns errors into text-only blocks.
    """
    return _render_pdf_page(pdf_path, page_number, max_dim)


def _render_page_from_bytes(pdf_bytes: bytes, page_number: int, max_dim: int) -> tuple[bytes, int, int]:
    """Render one page (1-based) of a PDF held in memory to JPEG bytes.

    Same as :func:`_render_page` but takes raw bytes (a project/Archiv PDF
    fetched from SeaweedFS) instead of a path. pypdfium2 accepts a bytes-like
    object directly.
    """
    return _render_pdf_page(pdf_bytes, page_number, max_dim)


def _normalize_image_to_jpeg(image_bytes: bytes, max_dim: int) -> tuple[bytes, int, int]:
    """Re-encode a standalone image (PNG/JPG/…) to max-dim-capped JPEG bytes.

    Mirrors the ingestion-time normalization so the model sees the image at a
    consistent resolution and format regardless of the upload type. Returns
    ``(jpeg_bytes, width_px, height_px)``; raises on any decode failure.
    """
    from PIL import Image

    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    longest = max(pil_image.width, pil_image.height) or 1
    if longest > max_dim:
        scale = max_dim / longest
        pil_image = pil_image.resize((max(1, round(pil_image.width * scale)), max(1, round(pil_image.height * scale))))
    buf = io.BytesIO()
    pil_image.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue(), pil_image.width, pil_image.height


# ---------------------------------------------------------------------------
# A region of a page: the box a person drew on the review canvas
# ---------------------------------------------------------------------------
#
# The frame is the canvas's, and an Anmerkung's: shares of the page AS SHOWN
# (its /Rotate applied), origin top left, ``[x, y, w, h]``.
#
# pypdfium2 (5.x, ``_helpers/page.py``) renders a crop without the page around
# it: ``page.render(scale, crop=(left, bottom, right, top))`` takes the amounts
# to cut off from each edge in PDF points (1/72 in), multiplies each by
# ``scale`` and rounds it up, and allocates a bitmap of only what is left. The
# crop "applies on bitmap level (i.e. after rotation)", and
# ``page.get_size()`` already returns the rotated width and height, so the
# edges are those of the page as a viewer shows it and the canvas frame maps
# onto them directly. Both facts are pinned by real rotated pages in
# ``tests/knowledge_layer_tests/test_view_image_region.py``.

#: A box smaller than this, in points (about 8.5 mm), is widened about its
#: centre: a box drawn around one dimension line still needs the line's ends to
#: be read, and a 3-point box is a click, not a question.
_MIN_REGION_PT = 24.0
#: The finest rendering a region gets: 1200 dpi. Past that a vector line is
#: only wider and a raster inside the PDF only blurrier, and the scale would grow
#: without bound as the box shrinks.
_MAX_REGION_SCALE = 1200 / 72
#: The smallest crop of a standalone image, in pixels, for the same reason.
_MIN_REGION_PX = 16

Region = tuple[float, float, float, float]

_REGION_FORMAT = (
    "region is [x, y, w, h]: four shares of the page between 0 and 1, origin top left, "
    "w and h above 0, x + w and y + h at most 1"
)
_EDGE_EPSILON = 1e-6


def parse_region(value: object) -> Region:
    """``value`` as ``(x, y, w, h)``; raises ``ValueError`` naming the expected frame. Pure."""
    if not isinstance(value, list | tuple) or len(value) != 4:
        raise ValueError(_REGION_FORMAT)
    try:
        x, y, w, h = (float(part) for part in value)
    except (TypeError, ValueError) as exc:
        raise ValueError(_REGION_FORMAT) from exc
    if not all(map(math.isfinite, (x, y, w, h))):
        raise ValueError(_REGION_FORMAT)
    if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1):
        raise ValueError(_REGION_FORMAT)
    if x + w > 1 + _EDGE_EPSILON or y + h > 1 + _EDGE_EPSILON:
        raise ValueError(_REGION_FORMAT)
    return x, y, min(w, 1 - x), min(h, 1 - y)


def _grown(start: float, size: float, minimum: float, total: float) -> tuple[float, float]:
    """One axis of a box, widened about its centre to ``minimum`` and kept on the page. In page units."""
    if size >= minimum or total <= minimum:
        return (0.0, total) if total <= minimum else (start, size)
    centre = start + size / 2
    begin = min(max(centre - minimum / 2, 0.0), total - minimum)
    return begin, minimum


def region_box_pt(region: Region, width_pt: float, height_pt: float) -> tuple[float, float, float, float]:
    """The region as ``(left, top, width, height)`` in points of the shown page, widened to the minimum. Pure."""
    x, y, w, h = region
    left, box_w = _grown(x * width_pt, w * width_pt, _MIN_REGION_PT, width_pt)
    top, box_h = _grown(y * height_pt, h * height_pt, _MIN_REGION_PT, height_pt)
    return left, top, box_w, box_h


def region_render_args(
    region: Region, width_pt: float, height_pt: float, max_dim: int
) -> tuple[float, tuple[float, float, float, float]]:
    """``(scale, crop)`` for ``PdfPage.render``: the crop's long edge about ``max_dim`` pixels. Pure.

    ``crop`` is ``(left, bottom, right, top)``, the points cut off each edge of
    the shown page, which is pypdfium2's order.
    """
    left, top, box_w, box_h = region_box_pt(region, width_pt, height_pt)
    scale = min(max_dim / (max(box_w, box_h) or 1.0), _MAX_REGION_SCALE)
    right = max(width_pt - left - box_w, 0.0)
    bottom = max(height_pt - top - box_h, 0.0)
    return scale, (left, bottom, right, top)


def _render_pdf_region(
    source: str | bytes, page_number: int, region: Region, max_dim: int
) -> tuple[bytes, int, int, bool]:
    """Render ONE region of one page (1-based) of a PDF to JPEG bytes, never the whole page's bitmap.

    Returns ``(jpeg_bytes, width_px, height_px, widened)``; ``widened`` says the
    box was smaller than :data:`_MIN_REGION_PT` and was grown about its centre.
    The bitmap pypdfium2 allocates is the crop's size, so an A0 sheet costs what
    an A4 one does. Every PDFium call runs under :func:`pdfium_lock`, as in
    :func:`_render_pdf_page`. Raises on any failure.
    """
    import pypdfium2 as pdfium

    with pdfium_lock():
        doc = pdfium.PdfDocument(source)
        try:
            page = doc[page_number - 1]
            try:
                width_pt, height_pt = page.get_size()
                scale, crop = region_render_args(region, width_pt, height_pt, max_dim)
                bitmap = page.render(scale=scale, crop=crop, bitmap_maker=pdfium.PdfBitmap.new_native)
                pil_image = detached_pil(bitmap)
            finally:
                page.close()
        finally:
            doc.close()
    widened = region_box_pt(region, width_pt, height_pt)[2:] != (region[2] * width_pt, region[3] * height_pt)
    rgb = pil_image.convert("RGB")
    buf = io.BytesIO()
    rgb.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue(), rgb.width, rgb.height, widened


def _crop_image_region(image_bytes: bytes, region: Region, max_dim: int) -> tuple[bytes, int, int, bool]:
    """Crop a standalone image to ``region`` and re-encode it max-dim-capped. Same return as the PDF one."""
    from PIL import Image

    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    x0, w0 = _grown(region[0] * pil_image.width, region[2] * pil_image.width, _MIN_REGION_PX, pil_image.width)
    y0, h0 = _grown(region[1] * pil_image.height, region[3] * pil_image.height, _MIN_REGION_PX, pil_image.height)
    widened = (w0, h0) != (region[2] * pil_image.width, region[3] * pil_image.height)
    box = (math.floor(x0), math.floor(y0), math.ceil(x0 + w0), math.ceil(y0 + h0))
    cropped = pil_image.crop(box)
    longest = max(cropped.width, cropped.height) or 1
    if longest > max_dim:
        scale = max_dim / longest
        cropped = cropped.resize((max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))))
    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue(), cropped.width, cropped.height, widened


class StorageLocation(tuple):
    """``(storage_key, storage_bucket)``, and the Fassung (``version_id``) those bytes are, when the BFF said.

    A tuple so every caller that unpacks or compares the pair reads it as
    before; ``version_id`` rides along for ``look``'s card (ADR-0128).
    """

    version_id: str | None
    #: The document row the BFF resolved, when it said; the stored page text's ``index.json`` must name it.
    document_id: str | None

    def __new__(  # noqa: ANN204
        cls,
        storage_key: str,
        storage_bucket: str | None,
        version_id: str | None = None,
        document_id: str | None = None,
    ):
        location = super().__new__(cls, (storage_key, storage_bucket))
        location.version_id = version_id
        location.document_id = document_id
        return location


def location_version(location: object) -> str | None:
    """The Fassung a resolved location names; None for a bare pair or none."""
    return getattr(location, "version_id", None)


async def _resolve_storage_location(
    collection: str, file_name: str, organization_id: str | None = None, image_index: int | None = None
) -> StorageLocation | None:
    """Resolve a ``(collection, filename)`` pair to a SeaweedFS object location.

    With ``image_index`` the location is that of the stored raster the ingest
    pipeline kept under the document (``imageIndex`` query param); the BFF
    derives the key from the row, so an index it does not know yields ``None``.

    Returns ``(storage_key, storage_bucket)`` as a :class:`StorageLocation`
    that also carries the Fassung (``versionId``) when the BFF names one, where ``storage_bucket`` is
    ``None`` for a document in the deployment's shared bucket — which is every
    document written before per-organization buckets existed (ADR-0043). The
    bucket comes from the BFF rather than being derived here on purpose: the
    naming rule already exists in two places (TypeScript for the app, CommonJS
    for the purger) and a third implementation in Python would only ever be
    discovered when it disagreed, which surfaces as a silent 404 and a
    text-only answer rather than as an error.

    Calls the BFF internal lookup (service-token guarded). Returns ``None`` on
    any failure (unconfigured URL/token, non-200, transport error) — fail-open,
    so a base-corpus-only deployment with no BFF wiring simply never resolves.

    An optional ``organization_id`` is forwarded as the ``organizationId``
    query param (needed to scope office-shelf documents); when not passed it is
    derived from the collection prefix (``archiv_org_123`` or ``office_shelf_org_123`` -> ``org_123``).
    The param is only added to the request when one was derived/provided.
    """
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return None
    try:
        import httpx

        if organization_id is None:
            organization_id = office_shelf_organization_id(collection)
        params: dict[str, str] = {"collection": collection, "filename": file_name}
        if organization_id:
            params["organizationId"] = organization_id
        if image_index is not None:
            params["imageIndex"] = str(image_index)
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{base_url.rstrip('/')}/api/internal/document-file",
                params=params,
                headers={"x-grid-internal-token": token, **_envelope_headers()},
            )
        if response.status_code != 200:
            return None
        data = response.json()
        storage_key = data.get("storageKey")
        if not isinstance(storage_key, str) or not storage_key:
            return None
        storage_bucket = data.get("storageBucket")
        if not isinstance(storage_bucket, str) or not storage_bucket:
            storage_bucket = None
        version_id = data.get("versionId")
        document_id = data.get("documentId")
        return StorageLocation(
            storage_key,
            storage_bucket,
            version_id if isinstance(version_id, str) and version_id else None,
            document_id if isinstance(document_id, str) and document_id else None,
        )
    except Exception:  # noqa: BLE001 - fail-open contract
        logger.warning("look: storage-key lookup failed for %s/%s", collection, file_name, exc_info=True)
        return None


def _envelope_headers() -> dict[str, str]:
    """The turn's signed request-context envelope, ECHOED to the lookup; empty off a chat turn.

    The BFF answers for a collection only inside the scope this envelope signs,
    and for a restricted folder's collection only with one (ADR-0088). Echo,
    never sign (ADR-0054 §4): the two strings go out exactly as they arrived.
    """
    try:
        from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
        from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
        from aiq_agent.project_context import get_request_envelope_from_context

        header, signature = get_request_envelope_from_context()
    except Exception:  # noqa: BLE001 - no envelope is a legitimate state off a chat turn
        logger.debug("look: no request envelope to echo", exc_info=True)
        return {}
    if not header or not signature:
        return {}
    return {REQUEST_CONTEXT_ENVELOPE_HEADER: header, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: signature}


def _may_read(collection: str) -> bool:
    """Whether this turn may read ``collection``: the turn's scope, as every read path takes it.

    The scope is the signed one, narrowed to the restricted collections the
    turn may draw on (:func:`aiq_agent.knowledge.scoping.get_collection_scope_from_context`).
    A restricted folder's collection needs more than its name in a scope: a
    restricted use bound for the turn that lets it be drawn on, which only a
    verified envelope gets (ADR-0088). A run with no scope at all (a CLI run, an
    eval) reads no restricted collection and keeps reaching the others by name.
    """
    from aiq_agent.knowledge.restricted_collections import is_restricted_collection
    from aiq_agent.knowledge.restricted_use import current_restricted_use
    from aiq_agent.knowledge.scoping import get_collection_scope_from_context

    try:
        scope = get_collection_scope_from_context()
    except Exception:  # noqa: BLE001 - an unreadable scope reads nothing
        logger.warning("look: the turn's scope could not be read", exc_info=True)
        return False
    if is_restricted_collection(collection):
        use = current_restricted_use()
        return use is not None and use.allows(collection) and scope is not None and collection in scope
    return scope is None or collection in scope


def _out_of_scope(file_name: str) -> str:
    """The refusal for a collection this turn may not read. Names neither the collection nor whether the file exists."""
    return (
        f"[look] Cannot show '{file_name}': it is not in a collection this turn may read. "
        "Name a document from the inventory or a hit of this turn."
    )


def _fetch_seaweed_bytes(storage_key: str, storage_bucket: str | None = None) -> bytes | None:
    """Fetch an object's bytes from SeaweedFS via boto3 (S3, path-style).

    ``storage_bucket`` is the bucket the BFF recorded for this document;
    ``None`` means the deployment's shared bucket (``SEAWEED_BUCKET``), which is
    what every document predating ADR-0043 uses.

    Returns ``None`` on any failure (missing creds, transport error, NoSuchKey)
    so callers degrade to a text-only block. Imports boto3 lazily so the tool
    imports cleanly in a deployment that never fetches.
    """
    bucket = storage_bucket or seaweed_s3.default_bucket()
    try:
        client = seaweed_s3.s3_client()
        if client is None:
            return None
        response = client.get_object(Bucket=bucket, Key=storage_key)
        return response["Body"].read()
    except Exception:  # noqa: BLE001 - fail-open contract
        logger.warning("look: SeaweedFS fetch failed for %s/%s", bucket, storage_key, exc_info=True)
        return None


def _is_standalone_image(file_name: str) -> bool:
    """True when the file is an uploaded image (PNG/JPG/…), not a page of a PDF."""
    idx = file_name.rfind(".")
    return idx > 0 and file_name[idx:].lower() in _IMAGE_EXTENSIONS


@dataclass(frozen=True)
class ViewLimits:
    """How large and how long one view may be: ``look``'s config."""

    max_dim: int = _DEFAULT_MAX_DIM
    timeout: float = 30.0


@dataclass(frozen=True)
class View:
    """One rendered look: the words that go with it and the JPEG itself.

    ``region`` is the box that was asked for (shares of the page, origin top
    left), ``None`` for a whole page or image. ``look`` (``tools/look``) shows
    the model :meth:`blocks`, or, for a model that takes no images, only what a
    second reader made of ``jpeg`` (``tools/look/reading.py``).
    """

    text: str
    jpeg: bytes
    width: int
    height: int
    region: Region | None = None
    #: The Fassung the bytes are, when the document service named one; None for the base corpus.
    version_id: str | None = None

    def with_text(self, text: str) -> "View":
        return replace(self, text=text)

    def blocks(self) -> list[dict]:
        """The text block, then the image block (a data URL), as a vision model takes them."""
        image_b64 = base64.b64encode(self.jpeg).decode("ascii")
        return [
            {"type": "text", "text": self.text},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]


def _region_text(what: str, region: Region, width: int, height: int, widened: bool) -> str:
    """The text block that goes with a region crop: which box, in the canvas's frame, and what it holds."""
    x, y, w, h = region
    grown = " The box was smaller than about 8 mm and was widened about its centre." if widened else ""
    return (
        f"Region [x={x:.3f}, y={y:.3f}, w={w:.3f}, h={h:.3f}] (shares of the page, origin top left) of {what} "
        f"({width}x{height}px). Only what lies inside this box is shown: answer about it, and say when "
        f"something you need lies outside it.{grown}"
    )


async def turn_sees() -> bool | None:
    """Whether the turn's chat model takes images (``common/model_vision.py``); ``None`` when that is unknown.

    Unknown is not "no": the image is then sent, as before the check existed.
    """
    try:
        from aiq_agent.common.model_vision import turn_model_accepts_images

        return await asyncio.to_thread(turn_model_accepts_images)
    except Exception:  # noqa: BLE001 - unknown means the image is sent, as before the check
        logger.debug("look: the model's image input could not be determined", exc_info=True)
        return None


def _blind_sentence(tool: str) -> str:
    """What a text-only model is told when nothing can show it the page and no reading was asked for."""
    return (
        f"[{tool}] The model this office answers with takes no images, so the page cannot be shown to it. "
        "Say plainly that you cannot see the page or the box, answer only from text you have, and do not guess "
        "what the drawing shows."
    )


async def _off_loop(timeout: float, fn, *args):  # noqa: ANN001, ANN202 - a thin wait_for(to_thread(...))
    return await asyncio.wait_for(asyncio.to_thread(fn, *args), timeout=timeout)


async def _fetch(location: tuple[str, str | None], timeout: float, what: str) -> bytes | None:
    try:
        return await _off_loop(timeout, _fetch_seaweed_bytes, *location)
    except Exception as e:  # noqa: BLE001 - fail-open contract
        logger.warning("look: fetch failed for %s: %s", what, e)
        return None


async def _raster_view(
    image_bytes: bytes, region: Region | None, limits: ViewLimits, describe: str, what: str, tool: str
) -> View | str:
    """A stored or uploaded image, whole or cropped to ``region``, as content blocks."""
    try:
        if region is None:
            jpeg_bytes, width, height = await _off_loop(
                limits.timeout, _normalize_image_to_jpeg, image_bytes, limits.max_dim
            )
        else:
            jpeg_bytes, width, height, widened = await _off_loop(
                limits.timeout, _crop_image_region, image_bytes, region, limits.max_dim
            )
    except Exception as e:  # noqa: BLE001 - fail-open contract
        logger.warning("look: image decode failed for %s: %s", what, e)
        return f"[{tool}] Could not decode {what}: {e}"
    if region is None:
        return View(describe.format(size=f"{width}x{height}px"), jpeg_bytes, width, height)
    note_region_viewed()
    return View(_region_text(what, region, width, height, widened), jpeg_bytes, width, height, region)


async def _pdf_view(
    source: str | bytes,
    page_number: int,
    region: Region | None,
    limits: ViewLimits,
    file_name: str,
    origin: str,
    tool: str,
) -> View | str:
    """One page of a PDF on disk (a path) or in memory (bytes), whole or cropped to ``region``."""
    whole = _render_page if isinstance(source, str) else _render_page_from_bytes
    try:
        if region is None:
            jpeg_bytes, width, height = await _off_loop(limits.timeout, whole, source, page_number, limits.max_dim)
        else:
            jpeg_bytes, width, height, widened = await _off_loop(
                limits.timeout, _render_pdf_region, source, page_number, region, limits.max_dim
            )
    except Exception as e:  # noqa: BLE001 - fail-open contract
        logger.warning("look: render failed for %s page %d: %s", file_name, page_number, e)
        return f"[{tool}] Could not render page {page_number} of '{file_name}': {e}"
    if region is not None:
        note_region_viewed()
        return View(
            _region_text(f"page {page_number} of '{file_name}'{origin}", region, width, height, widened),
            jpeg_bytes,
            width,
            height,
            region,
        )
    return View(
        f"Rendered page {page_number} of '{file_name}'{origin} ({width}x{height}px). "
        "This is the actual page the retrieved chunk describes — inspect it "
        "for plans, drawings, scale, dimensions and relationships.",
        jpeg_bytes,
        width,
        height,
    )


async def _stored_raster(
    file_name: str,
    page_number: int,
    collection: str,
    image_index: int,
    region: Region | None,
    limits: ViewLimits,
    tool: str,
) -> View | str:
    if image_index < 0:
        return f"[{tool}] Invalid image_index {image_index}: indices are 0-based."
    if not collection:
        return (
            f"[{tool}] image_index addresses a raster stored beside a project or Büroablage "
            f"document, and '{file_name}' was found in none of this turn's collections."
        )
    location = await _resolve_storage_location(collection, file_name, image_index=image_index)
    if location is None:
        return (
            f"[{tool}] No stored image {image_index} for '{file_name}' (the hit "
            "carries no such Image line, or the document service is unreachable). Call again "
            f"without image_index to render page {page_number} instead."
        )
    image_bytes = await _fetch(location, limits.timeout, f"image {image_index} of {file_name}")
    if image_bytes is None:
        return (
            f"[{tool}] Could not fetch stored image {image_index} of '{file_name}' "
            "from object storage (credentials/endpoint unavailable, or the object is gone). "
            f"Call again without image_index to render page {page_number} instead."
        )
    note_collections_read([collection])
    describe = (
        f"Stored image {image_index} of '{file_name}' (page {page_number}) from collection "
        f"'{collection}' ({{size}}). This is the embedded image the retrieved "
        "chunk describes, at its own resolution — inspect it for what it shows; the "
        "surrounding page text is not included."
    )
    return await _raster_view(
        image_bytes, region, limits, describe, f"stored image {image_index} of '{file_name}'", tool
    )


async def _uploaded_image(
    file_name: str, collection: str, region: Region | None, limits: ViewLimits, tool: str
) -> View | str:
    if not collection:
        return (
            f"[{tool}] '{file_name}' is an uploaded image, and it was found in none of this "
            "turn's collections. Name it exactly as the inventory or a hit lists it."
        )
    location = await _resolve_storage_location(collection, file_name)
    if location is None:
        return (
            f"[{tool}] Could not locate the stored file for '{file_name}' "
            "(not in the document index, or the document service is unreachable)."
        )
    image_bytes = await _fetch(location, limits.timeout, file_name)
    if image_bytes is None:
        return (
            f"[{tool}] Could not fetch the stored bytes for '{file_name}' "
            "from object storage (credentials/endpoint unavailable, or the object is gone)."
        )
    note_collections_read([collection])
    describe = (
        f"Uploaded image '{file_name}' from collection '{collection}' "
        "({size}). This is the actual image the retrieved chunk "
        "describes — inspect it for plans, drawings, scale and relationships."
    )
    result = await _raster_view(image_bytes, region, limits, describe, f"the image '{file_name}'", tool)
    return replace(result, version_id=location_version(location)) if isinstance(result, View) else result


async def _stored_pdf(
    file_name: str, page_number: int, collection: str, region: Region | None, limits: ViewLimits, tool: str
) -> View | str:
    if not collection:
        return (
            f"[{tool}] Could not find the source PDF for '{file_name}': it is neither a "
            "base-corpus document nor in one of this turn's collections. Name it exactly as "
            "the inventory or a hit lists it."
        )
    location = await _resolve_storage_location(collection, file_name)
    if location is None:
        return (
            f"[{tool}] Could not locate the stored file for '{file_name}' "
            "(not in the document index, or the document service is unreachable)."
        )
    pdf_bytes = await _fetch(location, limits.timeout, file_name)
    if pdf_bytes is None:
        return (
            f"[{tool}] Could not fetch the stored bytes for '{file_name}' "
            "from object storage (credentials/endpoint unavailable, or the object is gone)."
        )
    result = await _pdf_view(
        pdf_bytes, page_number, region, limits, file_name, f" from collection '{collection}'", tool
    )
    if isinstance(result, View):
        note_collections_read([collection])
        return replace(result, version_id=location_version(location))
    return result


def _spent(tool: str) -> str:
    """Why the turn's budget refused a look: every look is spent, or only the whole pages are."""
    budget = get_image_view_budget()
    if budget is not None and budget.remaining > 0:
        return (
            f"[{tool}] Whole-page cap reached: at most {MAX_OVERVIEW_VIEWS_PER_TURN} whole pages per turn. "
            f"Look at a region instead (region=[x, y, w, h]); {budget.remaining_text()}"
        )
    return (
        f"[{tool}] Look cap reached: at most {MAX_IMAGE_VIEWS_PER_TURN} looks per turn. "
        "Answer from the text and the images already seen."
    )


async def _gate(
    collection: str, file_name: str, region: object, tool: str, *, overview: bool
) -> tuple[Region | None, str | None]:
    """Every check that comes before any work, in the order that costs least: the region, then the turn's say."""
    if not _is_enabled():
        return None, f"[{tool}] Image viewing is disabled ({_VIEW_IMAGES_ENABLED_ENV} is off)."
    try:
        parsed = parse_region(region) if region is not None else None
    except ValueError as exc:
        return None, f"[{tool}] Invalid region {region!r}: {exc}."
    # Before the budget and before any lookup: the model chose this name,
    # and nothing outside the turn's scope is fetched, rendered or counted.
    if collection and not _may_read(collection):
        return None, _out_of_scope(file_name)
    # The per-turn ceiling comes before any work: a spent budget costs no
    # lookup, no fetch and no render. Outside a turn nothing is bound and
    # the call proceeds.
    if not try_consume_image_view("overview" if overview else "region"):
        return None, _spent(tool)
    try:
        from knowledge_layer.llamaindex import adapter as _adapter

        if not _adapter._get_vlm_api_key():
            return None, (
                f"[{tool}] Image viewing is unavailable: no vision-model "
                "API key is configured, so no model in this deployment can consume images."
            )
    except Exception:  # noqa: BLE001 - capability must never block the tool
        return None, f"[{tool}] Image viewing is unavailable: vision capability could not be determined."
    return parsed, None


async def render_view(
    file_name: str,
    page_number: int = 1,
    collection: str = "",
    image_index: int | None = None,
    region: object = None,
    *,
    limits: ViewLimits | None = None,
    tool: str = "look",
) -> View | str:
    """A page (or a region of it), an uploaded image or a stored raster, rendered. Never raises.

    The whole of ``look`` once it knows the file and the collection, so every
    look takes the same scope check, image budget, vision-key gate and
    restricted-folder report. ``region`` is ``[x, y, w, h]`` in shares of the
    page as shown, origin top left; ``tool`` names the caller in every refusal,
    so the model reads the name of the tool it called. A page or image without
    ``region`` and ``image_index`` is an overview, which the turn's budget
    counts apart. A successful look ends its text with how many looks are left.
    Whether the turn's model can be shown the image is not decided here
    (:func:`turn_sees`): ``look`` decides what to hand a model that cannot see.
    """
    limits = limits or ViewLimits()
    collection = (collection or "").strip()
    overview = region is None and image_index is None
    parsed, refusal = await _gate(collection, file_name, region, tool, overview=overview)
    if refusal is not None:
        return refusal
    if page_number < 1:
        return f"[{tool}] Invalid page number {page_number}: pages are 1-based."
    return _with_remaining(await _view(file_name, page_number, collection, image_index, parsed, limits, tool))


async def view_image(
    file_name: str,
    page_number: int = 1,
    collection: str = "",
    image_index: int | None = None,
    region: object = None,
    *,
    limits: ViewLimits | None = None,
    tool: str = "look",
) -> list[dict] | str:
    """:func:`render_view` as content blocks, for a caller that only ever shows the image.

    A turn whose chat model takes no images is answered with a sentence saying
    so, before any look is spent.
    """
    if await turn_sees() is False:
        return _blind_sentence(tool)
    result = await render_view(file_name, page_number, collection, image_index, region, limits=limits, tool=tool)
    return result.blocks() if isinstance(result, View) else result


def _with_remaining(result: View | str) -> View | str:
    """The look's text, ending with how many looks the turn has left; unchanged outside a turn."""
    left = remaining_views_text()
    if not left or not isinstance(result, View):
        return result
    return result.with_text(f"{result.text} {left}")


async def _view(
    file_name: str,
    page_number: int,
    collection: str,
    image_index: int | None,
    parsed: Region | None,
    limits: ViewLimits,
    tool: str,
) -> View | str:
    """The source the arguments name, rendered: a stored raster, an uploaded image, or a PDF page."""
    # A stored embedded raster: the ingest pipeline kept the image the
    # caption chunk describes, so serve that instead of the page around it.
    if image_index is not None:
        return await _stored_raster(file_name, page_number, collection, image_index, parsed, limits, tool)
    # Standalone image upload (PNG/JPG): there is no page to render.
    if _is_standalone_image(file_name):
        return await _uploaded_image(file_name, collection, parsed, limits, tool)
    # PDF page. Base-corpus PDFs come from the local cache of the corpus; a
    # project/Archiv PDF falls back to a SeaweedFS fetch rendered from bytes.
    pdf_path = await asyncio.to_thread(_find_pdf, file_name)
    if pdf_path is not None:
        return await _pdf_view(pdf_path, page_number, parsed, limits, file_name, "", tool)
    return await _stored_pdf(file_name, page_number, collection, parsed, limits, tool)
