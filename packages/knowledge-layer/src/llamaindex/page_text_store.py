"""Storing what each page of a document says, once per version: ``_text/pages.md`` and ``index.json``.

The pipeline reads every page (the text layer, a transcription of a scan, the vision
model's reading of a drawing) and until now kept only the chunks cut from it. A
re-chunk or a re-embed (a re-index, a move into a restricted folder, a quarantine
release) therefore parsed the PDF and called the vision model again, and the agent's
file reader (ADR-0133) had only chunks, with overlap and breadcrumbs, to rebuild a
page from. ADR-0134 stores the page itself, beside the version's file:

``<version dir>/_text/pages.md``
    UTF-8. Per page, the marker line ``<!-- page N -->`` (N the 1-indexed physical
    page), then that page's text: no breadcrumbs, no overlap, a table once at its
    page, running headers and footers stripped (and recorded as stripped).
``<version dir>/_text/index.json``
    ``schema_version`` 1; ``file`` (document id and version as the BFF resolved
    them, content hash, reader version, page count, failed pages, whether furniture
    was stripped, when) and ``pages``, one entry per page ``1..page_count`` in
    order, each with the byte offset and length of its body in ``pages.md``, its
    line count, its ``source`` (``text_layer`` | ``ocr`` | ``vlm_reading``) and the
    model that read it.

Written once the upload screen has passed and the vision batch has read the
drawings, through BFF-presigned PUTs like the stored rasters (``image_store``):
the backend holds a read-only object-store credential. The BFF builds each key
from the document's own row, and the presign answer carries the row's id and
version, which ``index.json`` repeats so the reader can refuse a stray file.
Fail-open: a failure here costs the stored text, never the ingest.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from collections.abc import Iterable
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
SOURCES = ("text_layer", "ocr", "vlm_reading")

_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_PRESIGN_PATH = "/api/internal/document-text-upload-url"
_HTTP_TIMEOUT_SECONDS = 15.0

#: The two parts of the stored text, as the presign route names them.
PAGES_PART = "pages.md"
INDEX_PART = "index.json"


@dataclass(frozen=True)
class Slot:
    """One presigned PUT, and the row the BFF resolved it for."""

    upload_url: str
    document_id: str
    version: int | None
    content_hash: str | None


#: ``(document_id, collection, part, organization_id) -> Slot``, or ``None`` when there is none.
Presigner = Callable[[str, str, str, str | None], Slot | None]
#: ``(upload_url, body, content_type)``; raises on any failure.
Uploader = Callable[[str, bytes, str], None]


@dataclass(frozen=True)
class PageText:
    """What one page says, and what read it."""

    page: int
    text: str
    source: str = "text_layer"
    model: str | None = None
    label: str | None = None


def strip_furniture(pages: list[PageText]) -> tuple[list[PageText], bool]:
    """The pages without the running headers and footers that repeat on most of them; and whether any were. Pure."""
    from aiq_agent.common.page_text import running_furniture
    from aiq_agent.common.page_text import without_furniture

    lines = [page.text.splitlines() for page in pages]
    furniture = running_furniture(lines)
    if not furniture:
        return pages, False
    stripped = [
        PageText(p.page, "\n".join(without_furniture(text, furniture)), p.source, p.model, p.label)
        for p, text in zip(pages, lines, strict=True)
    ]
    return stripped, True


def render(
    pages: Iterable[PageText],
    *,
    page_count: int,
    failed_pages: Iterable[int],
    document_id: str,
    version: int | None,
    content_hash: str | None,
    reader_version: str,
    furniture_stripped: bool,
    created_at: str | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """``pages.md`` and ``index.json`` for one version. Pure.

    Every page ``1..page_count`` gets an entry in order; a page nothing read (it
    failed, or it held no text) gets its marker and an empty body (``length`` 0).
    """
    by_page = {page.page: page for page in pages if 1 <= page.page <= page_count}
    failed = sorted({int(n) for n in failed_pages if 1 <= int(n) <= page_count})
    body = bytearray()
    entries: list[dict[str, Any]] = []
    for number in range(1, page_count + 1):
        page = by_page.get(number)
        body += f"<!-- page {number} -->\n".encode()
        text = "" if page is None or number in failed else page.text.strip()
        encoded = (text + "\n").encode("utf-8") if text else b""
        entries.append(
            {
                "page": number,
                "label": page.label if page is not None else None,
                "offset": len(body),
                "length": len(encoded),
                "lines": text.count("\n") + 1 if text else 0,
                "source": page.source if page is not None and page.source in SOURCES else "text_layer",
                "model": page.model if page is not None else None,
            }
        )
        body += encoded
    index = {
        "schema_version": SCHEMA_VERSION,
        "file": {
            "document_id": document_id,
            "version": version,
            "content_hash": content_hash,
            "reader_version": reader_version,
            "page_count": page_count,
            "failed_pages": failed,
            "furniture_stripped": furniture_stripped,
            "created_at": created_at or datetime.now(UTC).isoformat(timespec="seconds"),
        },
        "pages": entries,
    }
    return bytes(body), index


def request_slot(document_id: str, collection: str, part: str, organization_id: str | None = None) -> Slot | None:
    """Ask the BFF for a presigned PUT for one part of the stored text; ``None`` on any failure."""
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return None
    try:
        import httpx

        body: dict[str, Any] = {"documentId": document_id, "collection": collection, "part": part}
        if organization_id:
            body["organizationId"] = organization_id
        response = httpx.post(
            f"{base_url.rstrip('/')}{_PRESIGN_PATH}",
            json=body,
            headers={"x-internal-token": token},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.info(
                "page_text_store: no slot for %s of document %s (HTTP %d)", part, document_id, response.status_code
            )
            return None
        data = response.json()
        upload_url = data.get("uploadUrl")
        if not isinstance(upload_url, str) or not upload_url:
            return None
        version = data.get("version")
        return Slot(
            upload_url=upload_url,
            document_id=str(data.get("documentId") or document_id),
            version=version if isinstance(version, int) else None,
            content_hash=data.get("contentHash") if isinstance(data.get("contentHash"), str) else None,
        )
    except Exception as e:  # noqa: BLE001 - fail-open contract
        # Class name only: an httpx error's text embeds the request URL.
        logger.warning("page_text_store: presign failed for document %s: %s", document_id, type(e).__name__)
        return None


def put_part(upload_url: str, body: bytes, content_type: str) -> None:
    """PUT one part to its presigned slot. Raises on any failure."""
    import httpx

    response = httpx.put(
        upload_url, content=body, headers={"Content-Type": content_type}, timeout=_HTTP_TIMEOUT_SECONDS
    )
    response.raise_for_status()


def store_page_text(
    pages: list[PageText],
    *,
    page_count: int,
    failed_pages: Iterable[int],
    document_id: str,
    collection: str,
    organization_id: str | None = None,
    presign: Presigner | None = None,
    upload: Uploader | None = None,
) -> bool:
    """Write ``pages.md``, then ``index.json``, for the version the BFF resolves; True when both landed.

    ``index.json`` goes last, so a reader that finds it finds the text it describes.
    Never raises.
    """
    from knowledge_layer.reader_version import INGEST_READER_VERSION

    presign = presign or request_slot
    upload = upload or put_part
    if page_count <= 0:
        return False
    try:
        pages_slot = presign(document_id, collection, PAGES_PART, organization_id)
        index_slot = presign(document_id, collection, INDEX_PART, organization_id) if pages_slot else None
        if pages_slot is None or index_slot is None:
            return False
        stripped, furniture = strip_furniture(pages)
        body, index = render(
            stripped,
            page_count=page_count,
            failed_pages=failed_pages,
            document_id=pages_slot.document_id,
            version=pages_slot.version,
            content_hash=pages_slot.content_hash,
            reader_version=INGEST_READER_VERSION,
            furniture_stripped=furniture,
        )
        upload(pages_slot.upload_url, body, "text/markdown; charset=utf-8")
        upload(index_slot.upload_url, json.dumps(index, ensure_ascii=False).encode("utf-8"), "application/json")
        return True
    except Exception as e:  # noqa: BLE001 - fail-open contract
        # Class name only: a failed PUT's text renders the presigned URL, a live credential.
        logger.warning("page_text_store: storing the page text of %s failed (%s)", document_id, type(e).__name__)
        return False


def pdf_pages(
    text_pages: Iterable[Mapping[str, Any]],
    *,
    transcribed: Mapping[int, str],
    ocr_model: str | None,
    drawings: Iterable[Mapping[str, Any]],
    vision_model: str | None,
    tables: Iterable[Mapping[str, Any]] = (),
) -> list[PageText]:
    """Each page's text as the pipeline read it, with what read it. Pure.

    ``text_pages`` carry the text layer, a transcription already merged in where the
    page was a scan or garbled (``transcribed`` names those pages); a drawing's
    reading follows its text layer, and the page is then a ``vlm_reading``; an
    uncaptioned table is appended once to its page (a captioned one is already in
    the page's text).
    """
    text: dict[int, str] = {}
    for page in text_pages:
        number = page.get("page_number")
        if isinstance(number, int) and number > 0:
            text[number] = str(page.get("text") or "").strip()
    sources: dict[int, tuple[str, str | None]] = {number: ("ocr", ocr_model) for number in transcribed}
    for drawing in drawings:
        number = drawing.get("page_number")
        reading = str(drawing.get("caption") or "").strip()
        if isinstance(number, int) and number > 0 and reading:
            text[number] = f"{text.get(number, '')}\n\n{reading}".strip()
            sources[number] = ("vlm_reading", vision_model)
    for table in tables:
        number = table.get("page_number")
        body = str(table.get("table_text") or "").strip()
        if isinstance(number, int) and number > 0 and body:
            text[number] = f"{text.get(number, '')}\n\n{body}".strip()
    return [PageText(number, body, *sources.get(number, ("text_layer", None))) for number, body in sorted(text.items())]
