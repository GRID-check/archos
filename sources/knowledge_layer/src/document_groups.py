"""``knowledge_search(group_by="document")``: one line per document (ADR-0127, S7).

"Which documents deal with X" is not answered by the top passages: five chunks of
one PDF crowd out the rest. Grouped, the ranked pool becomes one entry per
document, its best passage first, with how many of the pool's passages it held.

The grouping runs here, over the pool the search already ranked and reranked,
and not in Qdrant: a group query whose query is a fusion fuses again for every
round of groups it collects (measured on 1.19.2, ``qdrant/search.py``
``grouped_search``), and this pool is fused across several collections besides.
Ranking is untouched: a group's place is its best passage's place.

A document is its ``grid_document_id`` (the BFF's id, on every point an ingest
job wrote), and, where a point carries none (the base corpus, a point written
before the field), its collection and file name: a file name is unique within
one collection only.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

#: The only grouping ``knowledge_search`` offers. Qdrant's own word for the parameter.
GROUP_BY_DOCUMENT = "document"

#: Candidates a grouped search ranks per document it shows: the pool must hold
#: more documents than the answer, or grouping returns fewer lines than asked.
GROUP_OVERFETCH = 4


@dataclass(frozen=True)
class DocumentGroup:
    """One document of a grouped search: its best passage, and what else of the pool it held."""

    best: Any
    #: Passages of the ranked pool from this document, the best one included.
    passages: int
    #: The pages those passages sit on, ascending; empty when none states a page.
    pages: tuple[int, ...]


def document_key(chunk: Any) -> tuple[str, ...]:
    """The document a chunk belongs to: its BFF id, else its collection and file name."""
    metadata = getattr(chunk, "metadata", None) or {}
    document_id = metadata.get("grid_document_id")
    if document_id:
        return ("id", str(document_id))
    return ("file", str(metadata.get("collection") or ""), str(getattr(chunk, "file_name", None) or ""))


def _page(chunk: Any) -> int | None:
    page = getattr(chunk, "page_number", None)
    return page if isinstance(page, int) and not isinstance(page, bool) and page > 0 else None


def _distinct(chunks: Iterable[Any]) -> list[Any]:
    seen: set[Any] = set()
    out: list[Any] = []
    for chunk in chunks:
        if chunk is None:
            continue
        key = getattr(chunk, "chunk_id", None) or id(chunk)
        if key in seen:
            continue
        seen.add(key)
        out.append(chunk)
    return out


def group_by_document(ordered: Sequence[Any], pool: Sequence[Any] = ()) -> list[DocumentGroup]:
    """The documents of ``ordered`` in ranking order, each with its best passage and its count. Pure.

    ``ordered`` is the final order (after the reranker, which may trim); ``pool``
    is the whole ranked candidate set it was cut from. A document the reranker
    trimmed away still counts, and still appears after every document it kept, in
    pool order. Counts are over the union; the caller cuts the list to its budget.
    """
    candidates = _distinct([*ordered, *pool])
    best: dict[tuple[str, ...], Any] = {}
    counts: dict[tuple[str, ...], int] = {}
    pages: dict[tuple[str, ...], set[int]] = {}
    for chunk in candidates:
        key = document_key(chunk)
        best.setdefault(key, chunk)
        counts[key] = counts.get(key, 0) + 1
        page = _page(chunk)
        if page is not None:
            pages.setdefault(key, set()).add(page)
    return [DocumentGroup(chunk, counts[key], tuple(sorted(pages.get(key, ())))) for key, chunk in best.items()]


#: Pages one row of the trailer names before it counts the rest.
_PAGES_SHOWN = 8


def _pages_cell(pages: tuple[int, ...]) -> str:
    if not pages:
        return "–"
    shown = ", ".join(str(page) for page in pages[:_PAGES_SHOWN])
    rest = len(pages) - _PAGES_SHOWN
    return f"{shown} (+{rest} more)" if rest > 0 else shown


def render_document_groups(groups: Sequence[DocumentGroup], pool_size: int) -> str:
    """The trailer under a grouped search's passages: one row per document, in the order shown. Pure.

    English labels (an agent reads it); file names as stored. The count is over
    the ranked pool, never every mention: that is ``match="exact"``.
    """
    if not groups:
        return ""
    lines = [
        f"## Documents ({len(groups)}, grouped from {pool_size} ranked passages)",
        "| # | Document | Passages in pool | Pages |",
        "|---|---|---|---|",
    ]
    for number, group in enumerate(groups, start=1):
        name = str(getattr(group.best, "file_name", None) or "?").replace("|", "/")
        lines.append(f"| {number} | {name} | {group.passages} | {_pages_cell(group.pages)} |")
    lines.append(
        "Each document's passage above is its best one. The counts are lower bounds over the ranked pool; "
        'for every mention use `match="exact"`, and to read a document use `read_passage`.'
    )
    return "\n".join(lines)
