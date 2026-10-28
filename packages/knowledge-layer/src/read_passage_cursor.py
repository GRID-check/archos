"""The read cursor a long passage is paged by, and the page numbers a read asks for: encode and decode, and the
refusals when they do not fit.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .read_passage_ranges import _FILTER_KINDS
from .read_passage_ranges import _MAX_RANGE_PAGES
from .read_passage_ranges import ORDER_FILTERS
from .read_passage_ranges import _chunk_position
from .read_passage_ranges import _page_range_text


class RangeRefused(ValueError):
    """A ``pages`` or ``cursor`` the tool cannot read; the message is what the model is told, with the call to make."""


_PAGES_PATTERN = re.compile(r"^(?:s\.?|p\.?|pp\.?|seiten?|pages?)?\s*(\d+)\s*(?:(?:-|bis|to)\s*(\d+))?$")


def _coerce_page(page: Any) -> int | None:
    """Coerce a model-supplied page number to int; ``''`` means omitted (#656).

    The tool schema types ``page`` as int, but providers send ``''`` for
    "no page" and occasionally numeric strings. Pydantic rejects ``''`` with
    ``int_parsing`` before the function runs; accepting ``int | str | None``
    here and normalising keeps that miss a refusal, not a tool error.
    """
    if page is None:
        return None
    if isinstance(page, int):
        return page
    if isinstance(page, float):
        return int(page)
    if isinstance(page, str):
        stripped = page.strip()
        if not stripped:
            return None
        try:
            return int(float(stripped))
        except ValueError:
            return None
    return None


def _parse_pages(raw: Any, document: str = "<document>") -> tuple[int, int] | None:
    """``"4-6"`` as ``(4, 6)``; ``None`` when ``raw`` is empty. Also ``"4"``, ``"4–6"``, ``"4 bis 6"``, ``5``.

    Raises :class:`RangeRefused` for text that is no range, a reversed range (the refusal names the
    corrected call) and one longer than :data:`_MAX_RANGE_PAGES`.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    text = str(raw).strip().lower().replace("–", "-").replace("—", "-")
    match = _PAGES_PATTERN.match(text)
    if match is None:
        raise RangeRefused(f'`pages` must be a page or a range such as "4-6", not {raw!r}.')
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if first < 1:
        raise RangeRefused("Pages count from 1.")
    if last < first:
        raise RangeRefused(
            f'The range runs backwards. Call read_passage(document="{document}", pages="{last}-{first}").'
        )
    if last - first + 1 > _MAX_RANGE_PAGES:
        raise RangeRefused(
            f"At most {_MAX_RANGE_PAGES} pages per call. Split the range and request the parts in one round, "
            f'for example pages="{first}-{first + _MAX_RANGE_PAGES - 1}" and pages="{first + _MAX_RANGE_PAGES}-{last}".'
        )
    return first, last


@dataclass(frozen=True)
class ReadCursor:
    """Where a ranged read stopped: the last chunk it returned, and the page the whole read ends on.

    ``position`` is that chunk's whole :func:`~aiq_agent.knowledge.base.document_position`, the key the
    chunks are sorted and cut by, so the continuation compares the same key. ``filters`` is the filter
    family the read used (:data:`ORDER_FILTERS` or :data:`LABEL_FILTERS`). ``collection`` is empty when
    the read spanned more than one collection, and the continuation then reads every one it resolves to.
    """

    file_name: str
    collection: str
    position: tuple[int, int, int, int, int, int, str]
    last_page: int | None
    filters: str = ORDER_FILTERS

    @property
    def page(self) -> int:
        return self.position[0]


def _cursor_check(fields: Sequence[Any]) -> str:
    return hashlib.sha256(json.dumps(list(fields), ensure_ascii=False).encode()).hexdigest()[:10]


def encode_cursor(cursor: ReadCursor) -> str:
    """The cursor as an opaque token: URL-safe base64 of a small JSON list with a checksum.

    It names a POSITION in one document and nothing else. The scope a read runs in is never in it:
    the continuation resolves ``document`` against this turn's own scope again and refuses a token
    for another file, so editing the token can move the read within the document but cannot reach
    another one. The checksum is an unkeyed digest that catches a mangled or hand-written token; it
    guards nothing, because nothing in the token can widen the scope.
    """
    fields = [cursor.file_name, cursor.collection, list(cursor.position), cursor.last_page, cursor.filters]
    body = json.dumps([*fields, _cursor_check(fields)], ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def decode_cursor(token: str) -> ReadCursor | None:
    """The cursor a token holds, or ``None`` for anything that is not one this tool issued."""
    text = str(token or "").strip()
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))
        *fields, check = raw
        file_name, collection, position, last_page, filters = fields
    except ValueError, TypeError, binascii.Error:
        return None
    if not isinstance(check, str) or check != _cursor_check(fields):
        return None
    if not (isinstance(file_name, str) and isinstance(collection, str) and filters in _FILTER_KINDS):
        return None
    if not (isinstance(position, list) and len(position) == 7 and isinstance(position[6], str)):
        return None
    if not all(_is_int(number) for number in position[:6]) or position[0] < 1:
        return None
    if last_page is not None and not _is_int(last_page):
        return None
    return ReadCursor(file_name, collection, tuple(position), last_page, filters)  # type: ignore[arg-type]


def _next_cursor(kept: Sequence[Any], last_page: int | None, filters: str) -> str:
    """The token that continues a read after the last of ``kept``."""
    last_chunk = kept[-1]
    position = _chunk_position(last_chunk)
    collections = {str((getattr(chunk, "metadata", None) or {}).get("collection") or "") for chunk in kept}
    collection = collections.pop() if len(collections) == 1 else ""
    cursor = ReadCursor(last_chunk.file_name, collection, (max(position[0], 1), *position[1:]), last_page, filters)
    return encode_cursor(cursor)


def _cursor_refusal(document: str, span: tuple[int, int] | None) -> str:
    """The refusal for a cursor that is not one this tool issued for this document."""
    pages = _page_range_text(*span) if span else "4-6"
    return (
        f"That cursor does not belong to {document} (or is not one this tool issued). "
        f'Start over: read_passage(document={json.dumps(document, ensure_ascii=False)}, pages="{pages}").'
    )
