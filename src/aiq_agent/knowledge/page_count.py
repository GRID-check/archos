"""How many pages a document has, read from the page numbers its chunks carry.

Ingestion stamps ``page_label`` and ``page_end`` on every chunk; the highest one
is the document's page count. Used at ingest time.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Mapping
from typing import Any


def page_number(value: Any) -> int | None:
    """A page number as stored: a whole number of at least 1, from an int or its string; ``None`` otherwise."""
    if isinstance(value, bool):
        return None
    try:
        page = int(value)
    except (TypeError, ValueError):
        return None
    return page if page >= 1 else None


def largest_page(payloads: Iterable[Mapping[str, Any]]) -> int | None:
    """The highest page any of the chunks reaches: its ``page_end``, or its ``page_label`` where it has no end.

    ``None`` when no chunk carries a page number. Pure: the chunks are plain mappings.
    """
    pages = [
        page
        for payload in payloads
        for page in (page_number(payload.get("page_label")), page_number(payload.get("page_end")))
        if page is not None
    ]
    return max(pages, default=None)
