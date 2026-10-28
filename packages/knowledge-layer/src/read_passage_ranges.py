"""The chunk filters and budget of a passage read: which chunks a page range, a label or a clause window keeps,
and the trailer that says what was left out.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from .chunk_positions import body
from .chunk_positions import repeated_head
from .chunk_positions import split_prefix

#: The two filter families a ranged read can use, recorded in its cursor so a continuation reads the
#: same set: a range on ``reading_order``, or the ``page_label`` strings of a document written before
#: that field existed.
ORDER_FILTERS = "order"

LABEL_FILTERS = "label"

_FILTER_KINDS = (ORDER_FILTERS, LABEL_FILTERS)

#: How many chunks one locator fetch may return per collection.
#:
#: A Punkt is one chunk in 935 of the corpus's 946 cases and at most a handful
#: in the rest (``llamaindex/clause_chunking``), and a page of a Richtlinie holds
#: a few. The number is a guard against a pathological document rather than a
#: relevance budget: the metadata filter has already decided WHICH chunks exist,
#: so this only bounds how many of them travel.
_MAX_PASSAGE_CHUNKS = 12

#: How many characters one ranged read returns (about 6k tokens). Past it the read stops at a
#: chunk boundary and ends with a ``cursor`` the model passes back to continue.
_MAX_READ_CHARS = 24_000

#: The most pages one ranged read may ask for. A 14-page document is read in one round of
#: a few calls; past this the model splits the range, which costs one round whatever it fans out into.
_MAX_RANGE_PAGES = 30

#: How many pages before the requested one a chunk may start and still reach it.
#:
#: A section or Punkt chunk is filed under the page its text STARTS on
#: (``page_label``) and records where it ends (``page_end``), so page 2 of a
#: report whose section runs from page 1 to 3 is held by a chunk labelled 1.
#: The store cannot compare the stored strings as numbers, so a page read asks
#: for the labels of this window and keeps the chunks whose range covers the
#: page. A chunk is at most ~640 tokens, so it spans more than a page or two
#: only across near-empty pages; eight is a bound, not an estimate.
_PAGE_SPAN_WINDOW = 8


def _range_filters(file_name: str, first: int, last: int | None, window: int = _PAGE_SPAN_WINDOW) -> dict[str, Any]:
    """Admit the document's chunks whose START page lies in ``[first - window, last]``.

    ``reading_order`` is the start page as an integer, so this is one range on an indexed integer and
    not a list of labels. A chunk that started up to :data:`_PAGE_SPAN_WINDOW` pages before ``first``
    may run onto it; :func:`_meets_range` keeps the ones that do.
    """
    clauses: list[dict[str, Any]] = [
        {"file_name": {"$eq": file_name}},
        {"reading_order": {"$gte": max(1, first - window)}},
    ]
    if last is not None:
        clauses.append({"reading_order": {"$lte": last}})
    return {"$and": clauses}


def _range_label_filters(file_name: str, first: int, last: int, window: int = _PAGE_SPAN_WINDOW) -> dict[str, Any]:
    """The same set by ``page_label`` strings: for a document written before ``reading_order`` existed."""
    labels = [str(number) for number in range(max(1, first - window), last + 1)]
    return {"$and": [{"file_name": {"$eq": file_name}}, {"page_label": {"$in": labels}}]}


def _filters_for(kind: str, first: int, last: int | None, window: int = _PAGE_SPAN_WINDOW):
    """The filter builder of one family; the label family needs an end page, so without one it is the range."""
    if kind == LABEL_FILTERS and last is not None:
        return lambda file_name: _range_label_filters(file_name, first, last, window)
    return lambda file_name: _range_filters(file_name, first, last, window)


def _page_span(chunk: Any) -> tuple[int, int] | None:
    """``(page_label, page_end)`` of a chunk as integers, ``None`` when its label is no page number."""
    metadata = getattr(chunk, "metadata", None) or {}
    label = str(metadata.get("page_label") or getattr(chunk, "page_number", "") or "")
    if not label.isdigit():
        return None
    end = str(metadata.get("page_end") or "")
    return int(label), max(int(end) if end.isdigit() else int(label), int(label))


def _meets_range(chunk: Any, first: int, last: int | None) -> bool:
    """Whether the chunk's pages ``[page_label, page_end]`` meet ``[first, last]``, as :func:`_covers_page` does."""
    span = _page_span(chunk)
    if span is None:
        return False
    return span[1] >= first and (last is None or span[0] <= last)


def _chunk_ordinal(chunk: Any) -> int | None:
    ordinal = (getattr(chunk, "metadata", None) or {}).get("chunk_ordinal")
    return ordinal if isinstance(ordinal, int) and not isinstance(ordinal, bool) else None


def _chunk_position(chunk: Any) -> tuple[int, int, int, int, int, int, str]:
    """The chunk's :func:`~agent.knowledge.base.document_position`: what ranged reads sort, cut and continue by."""
    from agent.knowledge.base import document_position

    return document_position(getattr(chunk, "metadata", None), getattr(chunk, "chunk_id", ""))


def _range_order(chunks: Sequence[Any]) -> list[Any]:
    """The chunks in document order: page, the section structure, then place in the file, then chunk id."""
    return sorted(chunks, key=_chunk_position)


def _without_overlap(chunks: Sequence[Any]) -> list[Any]:
    """The chunks with each head cut by the words it repeats from the chunk before it.

    The splitter overlaps neighbours by about 96 tokens, so reading a range chunk by chunk delivers
    that text twice. Each chunk's own text stays its own: only a head that equals the END of the
    previous chunk's text (words compared after whitespace normalisation) is cut, only between two text
    chunks of one document that the chunker cut one after the other, only when the repeat is long enough
    not to be a repeated heading, and never when it would leave nothing. The Citation key and page are
    the chunk's own and do not change. A section chunk's breadcrumb stays where it is: the repeat is
    looked for in the bodies after it (``chunk_positions.split_prefix``), where the overlap stands.
    """
    result: list[Any] = []
    previous: Any = None
    for chunk in chunks:
        trimmed = chunk
        if previous is not None and _neighbours(previous, chunk):
            start = split_prefix(chunk)[0]
            cut = repeated_head(body(previous), chunk.content[start:])
            if cut:
                content = chunk.content[:start] + chunk.content[start + cut :].lstrip()
                trimmed = chunk.model_copy(update={"content": content})
        result.append(trimmed)
        previous = chunk
    return result


def _is_text(chunk: Any) -> bool:
    kind = getattr(chunk, "content_type", None)
    return getattr(kind, "value", kind) in (None, "text")


def _neighbours(previous: Any, chunk: Any) -> bool:
    """Whether ``chunk`` follows ``previous`` as the next cut of one file's text."""
    if not (_is_text(previous) and _is_text(chunk)) or previous.file_name != chunk.file_name:
        return False
    before, after = previous.metadata or {}, chunk.metadata or {}
    if before.get("collection") != after.get("collection") or before.get("chunking") != after.get("chunking"):
        return False
    before_ordinal, after_ordinal = _chunk_ordinal(previous), _chunk_ordinal(chunk)
    # A chunk without an ordinal has no known predecessor: legacy chunks of a page are ordered by id.
    return before_ordinal is not None and after_ordinal is not None and after_ordinal - before_ordinal == 1


def _is_range_text(value: Any) -> bool:
    """Whether a ``page`` argument is really a range (``"4-6"``, ``"4 bis 6"``), which belongs in ``pages``."""
    return (
        isinstance(value, str) and re.search(r"\d\s*(?:-|\u2013|\u2014|bis|to)\s*\d", value, re.IGNORECASE) is not None
    )


def _within_budget(chunks: Sequence[Any], cap: int) -> tuple[list[Any], bool]:
    """The leading chunks whose text fits ``cap`` characters, and whether any were left out.

    The cut falls between two chunks; the cursor names the last kept chunk's whole position
    (:func:`_chunk_position`, a total order), so the continuation starts at the next one. The first
    chunk is always taken, so a read always returns something.
    """
    kept: list[Any] = []
    size = 0
    for chunk in chunks:
        if kept and size + len(chunk.content) > cap:
            return kept, True
        kept.append(chunk)
        size += len(chunk.content)
    return kept, False


def _in_range(chunks: Sequence[Any], first: int, last: int | None, start: tuple[Any, ...] | None) -> list[Any]:
    """The fetched chunks that meet ``[first, last]`` and, on a continuation, come after ``start``."""
    return [
        chunk
        for chunk in chunks
        if _meets_range(chunk, first, last) and (start is None or _chunk_position(chunk) > tuple(start))
    ]


def _range_trailer(document: str, kept: Sequence[Any], first: int, last: int | None, cursor: str | None) -> str:
    """What a ranged read says about itself: which pages it delivered, what is missing and how to go on."""
    spans = [span for chunk in kept if (span := _page_span(chunk)) is not None]
    reached = max((end for _start, end in spans), default=first)
    upto = reached if last is None else min(reached, last)
    if cursor is not None:
        asked = "" if last is None else f" of the requested {_page_range_text(first, last)}"
        return (
            f"Read pages {_page_range_text(first, max(first, upto))}{asked}; the rest follows. Continue: "
            f"read_passage(document={json.dumps(document, ensure_ascii=False)}, cursor={json.dumps(cursor)}), "
            "or ask for several ranges in one round."
        )
    wanted = range(first, (last if last is not None else upto) + 1)
    covered = {page for start, end in spans for page in range(start, end + 1)}
    blank = [page for page in wanted if page not in covered]
    line = f"Read pages {_page_range_text(first, wanted[-1])}."
    if blank and len(blank) <= 10:
        line += f" No text on page{'s' if len(blank) > 1 else ''} {', '.join(map(str, blank))}."
    return line


def _passage_filters(file_name: str, clause: str | None, page: int | None) -> dict[str, Any]:
    """The metadata filter that admits exactly the requested chunks.

    ``page_label`` is stored as a STRING by every writer in the ingest path
    (``text_documents_for_pages``, the Punkt chunker, the table and image
    branches), so the page clause compares strings; comparing an int here
    matches nothing and looks like an empty document. A page asks for the
    labels of :data:`_PAGE_SPAN_WINDOW` pages up to it, because a chunk that
    started earlier may run onto it; :func:`_addresses` keeps the ones that do.
    """
    clauses: list[dict[str, Any]] = [{"file_name": {"$eq": file_name}}]
    if clause:
        spellings = _clause_spellings(clause)
        clauses.append({"clause_id": {"$eq": clause} if len(spellings) == 1 else {"$in": spellings}})
    if page is not None:
        clauses.append({"page_label": {"$in": _page_window(page)}})
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _locus_label(document: str, clause: str | None, page: int | None, pages: tuple[int, int] | None = None) -> str:
    """How this fetch names itself in a message the model reads."""
    parts = [document]
    if clause:
        parts.append(f"Pkt. {clause}")
    if page is not None:
        parts.append(f"S. {page}")
    if pages is not None:
        parts.append(f"S. {_page_range_text(*pages)}")
    return ", ".join(parts)


def _page_range_text(first: int, last: int) -> str:
    return str(first) if first == last else f"{first}\u2013{last}"


def _clause_spellings(clause: str) -> list[str]:
    """The requested locator and its one normal spelling (``§3`` -> ``§ 3``), which the chunkers write."""
    from knowledge_layer.llamaindex.section_chunking import normalise_locator

    return sorted({clause, normalise_locator(clause)})


def _page_window(page: int) -> list[str]:
    """The ``page_label`` values a chunk covering ``page`` can carry, as strings."""
    return [str(number) for number in range(max(1, page - _PAGE_SPAN_WINDOW), page + 1)]
