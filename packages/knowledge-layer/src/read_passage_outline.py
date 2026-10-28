"""The outline of a document: its clauses, sorted and excerpted, with the filters that select the chunks an
outline reads.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .read_passage_fetch import _fetch_all
from .read_passage_models import PassageTarget
from .read_passage_ranges import _clause_spellings

#: How many chunks one OUTLINE fetch may return per collection.
#:
#: Larger than the passage bound because the set is the whole top of a
#: document: OIB 2 carries ~214 Punkte, far fewer of them at depth 1 or 2, and a
#: long Punkt may arrive as several chunks that share one ``clause_id``. Still a
#: guard rather than a relevance budget — the metadata filter has already
#: decided WHICH chunks exist.
_MAX_OUTLINE_CHUNKS = 160

#: How many Gliederung lines the outline may print before it says how many more
#: exist. Headings are not rendered as passages (a heading is not evidence), so
#: 80 lines is roughly one search result in tokens.
_MAX_OUTLINE_LINES = 80

#: The two heading levels an outline lists. The Punkt chunker writes
#: ``clause_depth`` as an int and a backend that round-trips metadata through
#: JSON hands it back as a string, so :func:`_outline_filters` asks for both
#: spellings and :func:`_clause_depth` normalises them.
_OUTLINE_DEPTHS = (1, 2)

#: The one line that says what the Gliederung is and what it is not. English, like everything an
#: agent reads (AGENTS.md), and it names no tool: three agents read it, each with its own reader.
_OUTLINE_INSTRUCTION = (
    "Open a listed Punkt by its number. The Gliederung is an index, not evidence: only the passages above "
    "carry a Citation."
)

#: The same sentence for a document that has no Punkte to list.
_NO_CLAUSES_LINE = (
    "This document is not structured in Punkte, so it has no Gliederung: its first passages are above, and "
    "further pages open by their number."
)

#: How much of a Punkt's opening sentence a Gliederung line carries.
_EXCERPT_CHARS = 120


def _outline_filters(file_name: str) -> dict[str, Any]:
    """The metadata filter that admits a document's top-level structure.

    Punkt ``0`` (``Vorbemerkungen``, the passage that says what the Richtlinie
    is for) plus everything at depth 1 or 2 — the headings a reader would scan
    a contents page for. ``clause_depth`` is stored as an int by the Punkt
    chunker, and a backend that round-trips metadata through JSON may hand it
    back as a string, so the clause asks for BOTH spellings: :func:`_clause_depth`
    accepts either, and a clause that admitted only the int would leave that
    tolerance backing a set the store could never deliver.

    Two homogeneous ``$in`` clauses rather than one mixed list, because
    LlamaIndex's ``MetadataFilter.value`` is typed ``list[int] | list[str] |
    …``: a list holding both spellings fails validation before it reaches any
    store, which would take the outline down on the default backend.
    """
    return {
        "$and": [
            {"file_name": {"$eq": file_name}},
            {
                "$or": [
                    {"clause_id": {"$eq": "0"}},
                    {"clause_depth": {"$in": list(_OUTLINE_DEPTHS)}},
                    {"clause_depth": {"$in": [str(depth) for depth in _OUTLINE_DEPTHS]}},
                ]
            },
        ]
    }


def _whole_document_filters(file_name: str) -> dict[str, Any]:
    """The fallback outline's filter: the named document, nothing narrower.

    It used to narrow to ``page_label $in ("1", "2", "3")``, on the assumption
    that ``page_label`` holds a page number. It does not always: the Office
    extractors write the WORKSHEET NAME there for ``.xlsx``/``.xlsm``
    (``llamaindex/office_extractors``), so an indexed spreadsheet matched no
    chunk at all and the outline told the model the store held none of it.
    The file-name clause and ``_MAX_OUTLINE_CHUNKS`` bound the set; document
    order then decides which ``_MAX_PASSAGE_CHUNKS`` of it are returned, which
    is the opening of a paginated document and the first sheets of a workbook.
    """
    return {"file_name": {"$eq": file_name}}


def _covers_page(chunk: Any, page: int) -> bool:
    """Whether the chunk's page range ``[page_label, page_end]`` contains ``page``.

    A chunk without a numeric ``page_end`` covers its label only. A label that is
    not a page number (a worksheet name) never matches a page.
    """
    metadata = getattr(chunk, "metadata", None) or {}
    label = str(metadata.get("page_label") or getattr(chunk, "page_number", "") or "")
    if not label.isdigit():
        return False
    end = str(metadata.get("page_end") or "")
    last = int(end) if end.isdigit() else int(label)
    return int(label) <= page <= max(last, int(label))


def _addresses(chunk: Any, clause: str | None, page: int | None) -> bool:
    """Whether this chunk really IS the passage that was addressed.

    The metadata filter above is the store's job and the store does it — but
    "the store applies the filter" is a contract, and a retriever that honours
    a narrower set of clauses than it was sent (a test fake, a regression in
    the filter translation) would otherwise hand back the NEIGHBOURING
    requirement, which the model then cites under the number it asked for.
    Cheap to re-check here; the whole point of the tool is that the number is
    right.
    """
    metadata = getattr(chunk, "metadata", None) or {}
    if clause and str(metadata.get("clause_id") or "") not in _clause_spellings(clause):
        return False
    return page is None or _covers_page(chunk, page)


def _clause_number(raw: str) -> tuple[int, ...]:
    """``"3.10"`` -> ``(3, 10)``; empty for anything that is not a Punkt number.

    The numeric form is what puts 3.10 after 3.9, which a string sort gets
    backwards — the outline reads as wrongly as a passage list would.
    """
    try:
        return tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        return ()


def _clause_of(chunk: Any) -> str:
    """The ``clause_id`` this chunk carries, or ``""``."""
    return str((getattr(chunk, "metadata", None) or {}).get("clause_id") or "")


def _clause_sort_key(chunk: Any) -> tuple:
    """Page, then Punkt numerically, then a table's row-group order, then chunk id: stable across calls.

    Every row group of one captioned table shares its page and ``clause_id``
    („Tabelle 1a" has no number to sort on), and the chunk id is a random
    uuid, so without ``table_part`` its "Teil 1 von 5" … "Teil 5 von 5" came
    back shuffled.
    """
    raw = _clause_of(chunk)
    page = getattr(chunk, "page_number", None) or 0
    return (
        page,
        _clause_number(raw),
        _document_order(chunk),
        raw,
        _table_part(chunk),
        str(getattr(chunk, "chunk_id", "")),
    )


def _document_order(chunk: Any) -> tuple[int, int]:
    """Where a tenant section sits in its document: section ordinal, then first line.

    A Markdown section („Geschoße") or a text block („Zeilen 12-30") has no page and no
    Punkt number to sort on, so without this the opening passages of a Markdown file
    came back in alphabetical order of their headings. ``(0, 0)`` for an OIB chunk,
    which carries neither, so their order is unchanged.
    """
    from aiq_agent.knowledge.base import section_position

    return section_position(getattr(chunk, "metadata", None))[:2]


def _table_part(chunk: Any) -> int:
    """A row group's or section chunk's 1-based position, ``0`` for anything that is not one."""
    from aiq_agent.knowledge.base import section_position

    return section_position(getattr(chunk, "metadata", None))[2]


def _clause_depth(chunk: Any) -> int | None:
    """``clause_depth`` as an int — ``None`` when absent or not a number.

    Accepts the int the chunker writes and the string a backend that
    round-trips metadata through JSON may hand back, because the depth decides
    whether a chunk belongs in the outline at all.
    """
    raw = (getattr(chunk, "metadata", None) or {}).get("clause_depth")
    if isinstance(raw, bool) or raw is None:
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def _is_outline_chunk(chunk: Any) -> bool:
    """Whether this chunk really IS part of the outline that was asked for.

    The same re-check :func:`_addresses` does, for the same reason: the store
    applies the filter, but one backend reaches its index through an HTTP
    service that may honour a narrower set of clauses, and an outline that
    silently listed every depth-3 sub-Punkt would be a contents page nobody
    can read.
    """
    return _clause_of(chunk) == "0" or _clause_depth(chunk) in _OUTLINE_DEPTHS


@dataclass(frozen=True)
class OutlineEntry:
    """One line of the Gliederung: a Punkt the reader can ask to have opened."""

    clause_id: str
    title: str
    page: str
    depth: int
    #: The Punkt's opening sentence, bounded — what a chapter is ABOUT, beside
    #: what it is called. Empty below depth 1 and for a chunk with no body.
    excerpt: str = ""
    #: Document order for a heading with no number to sort on (a tenant section).
    order: tuple[int, int] = (0, 0)


def _excerpt_of(chunk: Any) -> str:
    """The opening sentence of one Punkt, bounded to :data:`_EXCERPT_CHARS`.

    A heading list answers "what is in this document" with names, and a name
    („Anforderungen") tells an overview question nothing it did not know. The
    first sentence does: the model can say what each chapter regulates from
    the outline alone, instead of opening every chapter to find out — which is
    one round of eight parallel opens per member, or three rounds once the
    fan-out crosses the per-round width cap. A Punkt chunk opens with its own
    heading line; the body follows the blank line, and only the body is quoted.
    """
    text = str(getattr(chunk, "content", "") or "")
    body = text.split("\n\n", 1)[1] if "\n\n" in text else text
    body = " ".join(body.split())
    if not body:
        return ""
    sentence = re.split(r"(?<=[.!?])\s", body, maxsplit=1)[0]
    if len(sentence) > _EXCERPT_CHARS:
        return sentence[:_EXCERPT_CHARS].rstrip() + "…"
    return sentence


def _outline_entries(chunks: Sequence[Any]) -> list[OutlineEntry]:
    """One entry per distinct Punkt at depth 1 or 2, ordered by the NUMBERING.

    Deduped by ``clause_id``: a Punkt long enough for ``SentenceSplitter`` to cut
    arrives as several chunks carrying the same id, and listing it twice would
    read as two Punkte.

    Ordered by :func:`_clause_number` alone, NOT by ``_clause_sort_key`` — an
    outline is an index of the document's own numbering, and 2.2 belongs under 2
    even if its stored ``page_label`` ran ahead of 3's. The passage path keeps
    the page-first key, because there the page is what the reader is being
    walked through.
    """
    entries: dict[str, OutlineEntry] = {}
    for chunk in sorted(chunks, key=_clause_sort_key):
        metadata = getattr(chunk, "metadata", None) or {}
        clause_id = _clause_of(chunk)
        depth = _clause_depth(chunk)
        if depth not in _OUTLINE_DEPTHS or not clause_id or clause_id in entries:
            continue
        entries[clause_id] = OutlineEntry(
            clause_id=clause_id,
            title=str(metadata.get("clause_title") or "").strip(),
            page=str(metadata.get("page_label") or getattr(chunk, "page_number", "") or ""),
            depth=depth,
            excerpt=_excerpt_of(chunk) if depth == 1 else "",
            order=_document_order(chunk),
        )
    return sorted(entries.values(), key=lambda entry: (_clause_number(entry.clause_id), entry.order, entry.clause_id))


def _scope_chunks(chunks: Sequence[Any]) -> list[Any]:
    """The chunks that ARE the passage of an outline: the document's scope.

    Punkt ``0`` (``Vorbemerkungen``) when the document has one, otherwise the
    lowest-numbered depth-1 Punkt, and failing both the first chunk in reading
    order — so an outline always carries at least one citable passage. An
    outline whose only evidence was a heading list would be a source a citation
    cannot resolve to.
    """
    ordered = sorted(chunks, key=_clause_sort_key)
    zero = [chunk for chunk in ordered if _clause_of(chunk) == "0"]
    if zero:
        return zero
    top = [chunk for chunk in ordered if _clause_depth(chunk) == 1]
    if not top:
        return ordered[:1]
    first = min((_clause_number(_clause_of(chunk)), _document_order(chunk), _clause_of(chunk)) for chunk in top)[2]
    return [chunk for chunk in top if _clause_of(chunk) == first]


def _outline_lines(entries: Sequence[OutlineEntry], limit: int = _MAX_OUTLINE_LINES) -> list[str]:
    """The Gliederung itself: one line per Punkt, depth 2 indented under depth 1.

    ``limit`` is the line budget. It is a parameter because a family overview
    prints one Gliederung per member and divides the budget between them
    (:data:`_MAX_FAMILY_OUTLINE_LINES`).
    """
    shown = list(entries)[:limit]
    lines = []
    for entry in shown:
        indent = "  " if entry.depth == 2 else ""
        # An unnumbered section is addressed by its title; saying it twice is noise.
        title = f": {entry.title}" if entry.title and entry.title != entry.clause_id else ""
        page = f" (p. {entry.page})" if entry.page else ""
        excerpt = f" — {entry.excerpt}" if entry.excerpt else ""
        lines.append(f"{indent}- Punkt {entry.clause_id}{title}{page}{excerpt}")
    remaining = len(entries) - len(shown)
    if remaining > 0:
        lines.append(f"(+{remaining} more Punkte not listed)")
    return lines


def _outline_block(entries: Sequence[OutlineEntry]) -> str:
    """The ``## Gliederung`` index appended under the outline's passage."""
    return "\n".join(["## Gliederung", *_outline_lines(entries), "", _OUTLINE_INSTRUCTION, ""])


@dataclass(frozen=True)
class Outline:
    """One document's top structure as :func:`outline_for` read it."""

    chunks: list[Any]
    entries: list[OutlineEntry]
    failures: list[BaseException]
    #: Read by filter alone, with no embedding (``BaseRetriever.fetch``).
    structural: bool


async def outline_for(targets: list[PassageTarget], query: str) -> Outline:
    """One document's top structure: its outline chunks, its Gliederung, what broke.

    The middle of an outline, shared by the two callers that need it: this
    tool's ``document=`` mode and :func:`family_overview`, which runs it once
    per member of a Richtlinien-Familie. Both then take the scope passage with
    :func:`_scope_chunks` and render the entries, so the family branch cannot
    drift into a second definition of what an outline IS.

    ``query`` is the probe text (:func:`_fetch_query`), which orders a set the
    filter has already chosen. The failures travel out rather than being logged
    here, because only the caller knows what to do with them: one document
    falls back to its opening pages, a family member contributes nothing.
    """
    fetched = await _fetch_all(targets, _outline_filters, query, _MAX_OUTLINE_CHUNKS)
    chunks = [chunk for chunk in fetched.chunks if _is_outline_chunk(chunk)]
    return Outline(chunks, _outline_entries(chunks), fetched.failures, fetched.structural)
