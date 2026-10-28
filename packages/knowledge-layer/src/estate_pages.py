"""The page numbers an estate read asks for: parsing them, naming them back, and the refusal when they are too many."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from . import stored_pages
from .estate_constants import _PAGES_ITEM
from .estate_constants import MAX_READ_PAGES


class PagesRefused(ValueError):
    """A ``pages=`` the reader cannot serve; the message is what the model reads."""


def parse_pages(raw: Any) -> list[int] | None:
    """``"3"``, ``"3-5"`` or ``"3,7,11"`` as the page numbers, in the order asked, without repeats. Pure.

    ``None`` for no ``pages``. More than :data:`MAX_READ_PAGES` pages, or an
    item that is not a page or a range, raises :class:`PagesRefused`.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    numbers: list[int] = []
    for item in text.split(","):
        found = _PAGES_ITEM.match(item.strip().lower().removeprefix("p.").removeprefix("s."))
        if found is None:
            raise PagesRefused(f'`pages` takes "3", "3-5" or "3,7,11"; got {text!r}.')
        first = int(found.group(1))
        last = int(found.group(2) or first)
        if first < 1 or last < first:
            raise PagesRefused(f"`pages` counts from 1, first page before last; got {text!r}.")
        numbers.extend(range(first, last + 1))
        if len(numbers) > MAX_READ_PAGES:
            raise PagesRefused(f"At most {MAX_READ_PAGES} pages per read; split {text!r} into several reads.")
    return list(dict.fromkeys(numbers))


def pages_label(numbers: Sequence[int]) -> str:
    """``[3, 4, 5, 9]`` as ``"3-5, 9"``. Pure."""
    ordered = sorted(set(numbers))
    parts: list[str] = []
    start = previous = None
    for number in ordered:
        if start is None:
            start = previous = number
            continue
        if number == previous + 1:
            previous = number
            continue
        parts.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = number
    if start is not None:
        parts.append(str(start) if start == previous else f"{start}-{previous}")
    return ", ".join(parts)


def pages_for_lines(pages: Sequence[stored_pages.Page], offset: int, limit: int) -> list[int]:
    """The pages a line window ``[offset, offset+limit)`` falls on, counting the pages' lines in order. Pure."""
    first_line = max(0, offset)
    last_line = first_line + max(1, limit)
    out: list[int] = []
    position = 0
    for page in pages:
        lines = max(1, page.text.count("\n") + 1)
        if position < last_line and position + lines > first_line:
            out.append(page.number)
        position += lines
    return out or ([pages[-1].number] if pages else [])
