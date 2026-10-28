"""Reading a document's stored page text (ADR-0134), or rebuilding it from its chunks when there is none.

The ingest writes ``<version dir>/_text/pages.md`` and ``index.json`` per version
(``llamaindex/page_text_store.py``, schema 1). This is the read side, and the one
place the agent's file tools (``knowledge_layer.estate``) get a page from:

1. **Never from a model-supplied path.** The caller has already resolved the
   document from the turn's scoped rows; here a ``(collection, file name)`` pair
   goes through the BFF's scoped lookup (``/api/internal/document-file``, the
   turn's envelope echoed, the same call ``look`` makes) to the published
   version's storage key, and only the key's own directory is read. The
   read-only SeaweedFS credential could read the whole bucket, so the key is
   never built from anything the model wrote.
2. **The index must name the document.** ``index.json`` repeats the document id
   and version the BFF resolved when it was written. A file whose id is not the
   looked-up document's, or whose version is not the one the key's ``v<n>``
   directory names, is refused: it is somebody else's text, or an older one.
3. **Absent is normal.** The base corpus, images, spreadsheets and every document
   uploaded before the backfill have no ``_text/``. They are rebuilt from their
   chunks (``collection_pages.read_pages``: breadcrumbs stripped, overlap
   removed), and the result says so, because a page break inside a chunk is
   approximate.

Fail-open everywhere: any lookup, fetch or parse failure is "no stored text", and
the caller falls back to the chunks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: The schema this reader understands (``page_text_store.SCHEMA_VERSION``).
SCHEMA_VERSION = 1

#: The two parts, as the writer names them.
PAGES_PART = "pages.md"
INDEX_PART = "index.json"

#: Where a version's text lives, beside its file.
TEXT_DIRECTORY = "_text/"

#: Seconds one fetch of a part may take before the reader falls back to the chunks.
FETCH_TIMEOUT_SECONDS = 6.0

#: Where the page came from: printed text, a vision model's transcription of a scan, or its reading of a drawing.
SOURCE_TEXT_LAYER = "text_layer"
SOURCE_OCR = "ocr"
SOURCE_VLM_READING = "vlm_reading"

_VERSION_SEGMENT = re.compile(r"/v(\d+)/")


@dataclass(frozen=True)
class Page:
    """One page of a document as a reader serves it."""

    number: int
    text: str
    #: ``text_layer`` | ``ocr`` | ``vlm_reading`` for stored text; ``chunks`` for a page rebuilt from the index.
    source: str = SOURCE_TEXT_LAYER
    #: For a page rebuilt from chunks: the content types of the chunks it was built from.
    content_types: tuple[str, ...] = ()

    @property
    def is_drawing(self) -> bool:
        return self.source == SOURCE_VLM_READING or "drawing" in self.content_types


@dataclass
class PageText:
    """A document's pages, and where they came from."""

    pages: list[Page]
    #: ``stored`` (``_text/``) or ``chunks`` (rebuilt from the index).
    origin: str
    #: Every page the document has; for a rebuild, the highest page any chunk names.
    page_count: int
    #: Pages the ingest could not read (stored text only).
    failed_pages: tuple[int, ...] = ()
    #: Why stored text was not used although it was looked for ("mismatch", "schema"), for the log and the header.
    refused: str | None = None
    by_number: dict[int, Page] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.by_number = {page.number: page for page in self.pages}

    @property
    def rebuilt(self) -> bool:
        return self.origin == "chunks"


#: ``(collection, file_name) -> location`` (``view_image.StorageLocation``) or ``None``.
Resolver = Callable[[str, str], Awaitable[Any]]
#: ``(key, bucket, byte_range) -> bytes`` or ``None``; ``byte_range`` is ``(start, end)`` inclusive, or ``None``.
Fetcher = Callable[[str, str | None, tuple[int, int] | None], bytes | None]
#: ``(collection, file_name) -> [(page_label, text, metadata)]`` in reading order, or ``None``.
ChunkReader = Callable[[str, str], list[tuple[Any, str, dict[str, Any]]] | None]


async def _resolve(collection: str, file_name: str) -> Any:
    from .view_image import _resolve_storage_location

    return await _resolve_storage_location(collection, file_name)


def _fetch(key: str, bucket: str | None, byte_range: tuple[int, int] | None) -> bytes | None:
    """One object (or a byte range of it) on the read-only credential; ``None`` on any failure, NoSuchKey included."""
    from agent.common import seaweed_s3

    try:
        client = seaweed_s3.s3_client()
        if client is None:
            return None
        kwargs: dict[str, Any] = {"Bucket": bucket or seaweed_s3.default_bucket(), "Key": key}
        if byte_range is not None:
            kwargs["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
        return client.get_object(**kwargs)["Body"].read()
    except Exception as error:  # noqa: BLE001 - absent is the common case, and every failure means "rebuild"
        logger.debug("stored_pages: no %s (%s)", key, type(error).__name__)
        return None


def _read_chunks(collection: str, file_name: str) -> list[tuple[Any, str, dict[str, Any]]] | None:
    """The file's chunks in reading order, as their own text: no breadcrumb, no repeated overlap."""
    from agent.knowledge.collection_pages import _document_hits
    from agent.knowledge.collection_pages import own_page_texts

    hits = _document_hits(collection, file_name)
    rows = [
        (hit.payload.get("page_label"), text, dict(hit.payload or {}))
        for hit, text in zip(hits, own_page_texts(hits), strict=True)
        if text
    ]
    return rows or None


def text_prefix(storage_key: str) -> str | None:
    """``<dir>/_text/`` for a version's storage key, the ``buildPageTextPrefix`` rule; ``None`` without a directory."""
    if "/" not in storage_key:
        return None
    return f"{storage_key.rsplit('/', 1)[0]}/{TEXT_DIRECTORY}"


def key_version(storage_key: str) -> int | None:
    """The version a storage key's ``v<n>`` directory names, or ``None`` (a first version's key has none)."""
    found = _VERSION_SEGMENT.findall(storage_key)
    return int(found[-1]) if found else None


def check_index(index: Any, *, document_id: str | None, storage_key: str) -> str | None:
    """Why ``index.json`` may not be served for this document; ``None`` when it may. Pure.

    ``schema``: not a schema-1 index. ``mismatch``: it names another document,
    or another version than the key's directory. A lookup that returned no
    document id cannot vouch for the file, so that is a mismatch too.
    """
    if not isinstance(index, dict) or index.get("schema_version") != SCHEMA_VERSION:
        return "schema"
    meta = index.get("file")
    pages = index.get("pages")
    if not isinstance(meta, dict) or not isinstance(pages, list):
        return "schema"
    if not document_id or str(meta.get("document_id") or "") != document_id:
        return "mismatch"
    expected = key_version(storage_key)
    stored = meta.get("version")
    if expected is not None and isinstance(stored, int) and stored != expected:
        return "mismatch"
    return None


def _page_entries(index: dict[str, Any]) -> list[dict[str, Any]]:
    entries = []
    for entry in index.get("pages") or ():
        if not isinstance(entry, dict):
            continue
        number, offset, length = entry.get("page"), entry.get("offset"), entry.get("length")
        if isinstance(number, int) and isinstance(offset, int) and isinstance(length, int) and number > 0:
            entries.append(entry)
    return entries


def pages_from_body(index: dict[str, Any], body: bytes, *, base: int = 0, wanted: set[int] | None = None) -> list[Page]:
    """The pages ``index`` describes, cut out of ``body`` (which starts at byte ``base`` of ``pages.md``). Pure."""
    pages: list[Page] = []
    for entry in _page_entries(index):
        number = entry["page"]
        if wanted is not None and number not in wanted:
            continue
        start = entry["offset"] - base
        length = entry["length"]
        if start < 0 or start + length > len(body):
            continue
        text = body[start : start + length].decode("utf-8", errors="replace").rstrip("\n")
        source = str(entry.get("source") or SOURCE_TEXT_LAYER)
        pages.append(Page(number=number, text=text, source=source))
    return pages


def pages_from_chunks(rows: list[tuple[Any, str, dict[str, Any]]]) -> list[Page]:
    """A rebuild: each chunk's own text under the page it starts on, in reading order. Pure.

    A chunk with no page label (a text file, a spreadsheet) is page 1: such a
    file has no pages, and the caller serves it as one window.
    """
    texts: dict[int, list[str]] = {}
    types: dict[int, set[str]] = {}
    for label, text, metadata in rows:
        try:
            number = int(str(label).strip())
        except TypeError, ValueError:
            number = 1
        number = max(1, number)
        texts.setdefault(number, []).append(text.strip())
        content_type = str((metadata or {}).get("content_type") or "").strip()
        if content_type:
            types.setdefault(number, set()).add(content_type)
    return [
        Page(
            number=number,
            text="\n\n".join(part for part in texts[number] if part),
            source="chunks",
            content_types=tuple(sorted(types.get(number, ()))),
        )
        for number in sorted(texts)
    ]


async def read_stored(
    collection: str,
    file_name: str,
    *,
    wanted: set[int] | None = None,
    resolve: Resolver | None = None,
    fetch: Fetcher | None = None,
) -> PageText | None:
    """The stored pages of the published version, or ``None`` when there are none to serve.

    ``wanted`` limits the read to those pages, by one range request over their
    span; ``None`` reads every page. A refused index is ``None`` too, with the
    reason logged: the caller rebuilds, which is what it would do without one.
    """
    resolve = resolve or _resolve
    fetch = fetch or _fetch
    try:
        location = await asyncio.wait_for(resolve(collection, file_name), FETCH_TIMEOUT_SECONDS)
    except Exception as error:  # noqa: BLE001 - fail-open: rebuild
        logger.info("stored_pages: lookup failed for a document (%s)", type(error).__name__)
        return None
    if not location:
        return None
    storage_key, bucket = location[0], location[1]
    prefix = text_prefix(str(storage_key))
    if prefix is None:
        return None
    raw_index = await _fetch_part(fetch, prefix + INDEX_PART, bucket, None)
    if raw_index is None:
        return None
    try:
        index = json.loads(raw_index.decode("utf-8"))
    except UnicodeDecodeError, json.JSONDecodeError:
        logger.warning("stored_pages: an index.json does not parse; rebuilding from the chunks")
        return None
    refusal = check_index(index, document_id=getattr(location, "document_id", None), storage_key=str(storage_key))
    if refusal is not None:
        logger.warning("stored_pages: index.json refused (%s); rebuilding from the chunks", refusal)
        return None
    entries = [entry for entry in _page_entries(index) if wanted is None or entry["page"] in wanted]
    meta = index["file"]
    page_count = int(meta.get("page_count") or len(_page_entries(index)) or 0)
    failed = tuple(int(n) for n in meta.get("failed_pages") or () if isinstance(n, int))
    if not entries:
        return PageText(pages=[], origin="stored", page_count=page_count, failed_pages=failed)
    start = min(entry["offset"] for entry in entries)
    end = max(entry["offset"] + entry["length"] for entry in entries)
    if end <= start:
        pages = [Page(number=entry["page"], text="", source=str(entry.get("source") or "")) for entry in entries]
        return PageText(pages=pages, origin="stored", page_count=page_count, failed_pages=failed)
    body = await _fetch_part(fetch, prefix + PAGES_PART, bucket, (start, end - 1))
    if body is None:
        return None
    wanted_numbers = {entry["page"] for entry in entries}
    pages = pages_from_body(index, body, base=start, wanted=wanted_numbers)
    return PageText(pages=pages, origin="stored", page_count=page_count, failed_pages=failed)


async def _fetch_part(fetch: Fetcher, key: str, bucket: str | None, byte_range: tuple[int, int] | None) -> bytes | None:
    try:
        return await asyncio.wait_for(asyncio.to_thread(fetch, key, bucket, byte_range), FETCH_TIMEOUT_SECONDS)
    except Exception as error:  # noqa: BLE001 - fail-open: rebuild
        logger.info("stored_pages: fetch of %s failed (%s)", key.rsplit("/", 1)[-1], type(error).__name__)
        return None


async def rebuild(collection: str, file_name: str, *, read_chunks: ChunkReader | None = None) -> PageText | None:
    """The document's pages rebuilt from its chunks; ``None`` when it has none. Raises when the store is down.

    An outage is not evidence that a file has no text, so it is never ``None``
    (``collection_pages.read_pages`` holds the same line).
    """
    rows = await asyncio.to_thread(read_chunks or _read_chunks, collection, file_name)
    if not rows:
        return None
    pages = pages_from_chunks(rows)
    return PageText(pages=pages, origin="chunks", page_count=max((page.number for page in pages), default=0))


async def read_pages(
    collection: str,
    file_name: str,
    *,
    wanted: set[int] | None = None,
    resolve: Resolver | None = None,
    fetch: Fetcher | None = None,
    read_chunks: ChunkReader | None = None,
    stored: bool = True,
) -> PageText | None:
    """The stored pages when there are any, else the rebuild; ``None`` when the document has neither."""
    if stored:
        found = await read_stored(collection, file_name, wanted=wanted, resolve=resolve, fetch=fetch)
        if found is not None:
            return found
    return await rebuild(collection, file_name, read_chunks=read_chunks)
