"""The file rows the listing, the search and the estate tools read: one row per document, its facts, the Listing
a folder gives, and the selection a turn's filters make.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.common.source_kinds import canonical_shelf_value
from aiq_agent.knowledge.page_count import page_number
from aiq_agent.knowledge.title_block import display_date
from aiq_agent.knowledge.title_block import document_key
from aiq_agent.knowledge.title_block import newest_first

from .browse_text import _words
from .browse_text import fold
from .revision_series import find_revision_series
from .revision_series import revision_label

#: Rows one ``list_files`` page returns by default, and the most it may ask for.
#: A row is ~40 tokens with its summary, so the default page costs about what
#: one search result costs.
DEFAULT_PAGE_SIZE = 40

MAX_PAGE_SIZE = 100

#: How many subfolders the folder overview names before it counts the rest.
MAX_FOLDER_LINES = 30

#: Document types named in the listing's profile line before it stops (the vocabulary has 12).
MAX_TYPE_COUNTS = 8

#: Topics (Themen) named in the listing's profile line before it stops.
MAX_TOPIC_COUNTS = 8

#: The summary is a hint for choosing what to open, not something to answer from.
MAX_SUMMARY_CHARS = 160

#: The shelves a person calls "my files". Basiswissen is the platform corpus:
#: listable on request (``shelf="base"``), never part of a default listing.
USER_SHELVES = ("project", "office_shelf", "session")

KNOWN_SHELVES = (*USER_SHELVES, "base")

_SHELF_LABELS = {
    "project": "Projektwissen",
    "office_shelf": "Büroablage",
    "session": "Private Sitzung",
    "base": "Basiswissen",
}

#: What a listing row shows of the ingest's reading: a few facts and references, never the lot.
MAX_ROW_FACTS = 6

MAX_ROW_REFERENCES = 8


@dataclass(frozen=True)
class FileRow:
    """One file as the browser shows it. Built from an inventory row."""

    file_name: str
    shelf: str | None
    collection: str
    folder: str = ""
    display_title: str | None = None
    doc_class: str | None = None
    tags: tuple[str, ...] = ()
    summary: str = ""
    added_at: str | None = None
    #: Open topics (Themen) Piloti recognised, or a person set.
    topics: tuple[str, ...] = ()
    #: What the camera wrote: the ISO time it was taken, and make and model. Never a position.
    captured_at: str | None = None
    camera: str | None = None
    #: The newer file a PERSON confirmed replaces this one, and the files this one replaces.
    superseded_by: str | None = None
    supersedes: tuple[str, ...] = ()
    #: What changed against the Fassung it replaced, and the file name that was compared against.
    change_summary: str | None = None
    change_basis: str | None = None
    #: What the title block (Plankopf) of the document's first drawing page says: ``document_number``,
    #: ``revision`` (Index), ``revision_date`` (ISO), ``scale``, ``title``; present keys only.
    revision_facts: Mapping[str, Any] | None = field(default=None, compare=False)
    #: Pages the document has, when the store knows (None: not recorded, never "zero").
    page_count: int | None = None
    #: What the ingest read the document to be (the dossier's ``document_type``), the facts it
    #: states (``key value unit (p. N)``), what it points at, and how much of it was fully read.
    document_type: str | None = None
    facts: tuple[str, ...] = ()
    references: tuple[str, ...] = ()
    pages_not_read: int = 0
    #: What the facts say differently from the Fassung this one replaced: ``key before → after``.
    fact_changes: tuple[str, ...] = ()

    @property
    def document_date(self) -> str | None:
        """The document's OWN date (ISO day): the title block's Stand, else the day a photo was taken.

        The same rule as the ``document_date`` payload field (``qdrant/payload.py``), read from the
        facts the row already carries. None for a document that prints none; never the upload date.
        """
        stamp = str((self.revision_facts or {}).get("revision_date") or self.captured_at or "").strip()
        return stamp[:10] or None

    @property
    def searchable(self) -> str:
        return " ".join(_words(f"{self.file_name} {self.display_title or ''}"))


def _attr(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


def file_row(row: Any) -> FileRow | None:
    """An inventory row (``AvailableDocument`` or its dict) as a :class:`FileRow`."""
    file_name = str(_attr(row, "file_name") or "").strip()
    if not file_name:
        return None
    shelf = _attr(row, "shelf")
    shelf = getattr(shelf, "value", shelf)
    # Only the two facts a listing may show are read from the capture; the position stays unread.
    capture = _attr(row, "capture")
    capture = capture if isinstance(capture, dict) else {}
    revision_facts = _attr(row, "revision_facts")
    return FileRow(
        file_name=file_name,
        shelf=canonical_shelf_value(str(shelf)) if shelf else None,
        collection=str(_attr(row, "collection") or ""),
        folder=str(_attr(row, "folder_path") or "").strip().strip("/"),
        display_title=(str(_attr(row, "display_title") or "").strip() or None),
        doc_class=(str(_attr(row, "doc_class") or "").strip() or None),
        tags=tuple(str(tag) for tag in (_attr(row, "tags") or ()) if tag),
        summary=" ".join(str(_attr(row, "summary") or "").split()),
        added_at=(str(_attr(row, "added_at") or "").strip()[:10] or None),
        topics=tuple(str(topic) for topic in (_attr(row, "topics") or ()) if topic),
        captured_at=(str(capture.get("captured_at") or "").strip() or None),
        camera=(str(capture.get("camera") or "").strip() or None),
        superseded_by=(str(_attr(row, "superseded_by") or "").strip() or None),
        supersedes=tuple(str(name) for name in (_attr(row, "supersedes") or ()) if name),
        change_summary=(str(_attr(row, "change_summary") or "").strip() or None),
        change_basis=(str(_attr(row, "change_basis") or "").strip() or None),
        revision_facts=revision_facts if isinstance(revision_facts, dict) and revision_facts else None,
        page_count=page_number(_attr(row, "page_count")),
        **_reading_fields(row),
    )


def _reading_fields(row: Any) -> dict[str, Any]:
    """The dossier's type and facts, the references and the unread pages, as :class:`FileRow` fields."""
    dossier = _attr(row, "dossier")
    dossier = dossier if isinstance(dossier, dict) else {}
    facts = []
    for fact in dossier.get("facts") or []:
        if not isinstance(fact, dict) or not fact.get("key") or not fact.get("value"):
            continue
        unit = f" {fact['unit']}" if fact.get("unit") else ""
        page = f" (p. {fact['page']})" if fact.get("page") else ""
        facts.append(f"{fact['key']} {fact['value']}{unit}{page}")
    references = [
        str(ref.get("label") or ref.get("key"))
        for ref in (_attr(row, "doc_references") or [])
        if isinstance(ref, dict) and (ref.get("label") or ref.get("key"))
    ]
    coverage = _attr(row, "coverage")
    not_read = coverage.get("not_read") if isinstance(coverage, dict) else 0
    document_type = dossier.get("document_type")
    changes = [
        f"{change['key']} {change.get('before') or '–'} → {change.get('after') or '–'}"
        for change in dossier.get("changes") or []
        if isinstance(change, dict) and change.get("key")
    ]
    return {
        "fact_changes": tuple(changes[:MAX_ROW_FACTS]),
        "document_type": str(document_type) if document_type else None,
        "facts": tuple(facts[:MAX_ROW_FACTS]),
        "references": tuple(references[:MAX_ROW_REFERENCES]),
        "pages_not_read": not_read if isinstance(not_read, int) and not_read > 0 else 0,
    }


def file_rows(rows: Iterable[Any]) -> list[FileRow]:
    """Deduplicated by ``(collection, file_name)``, the inventory's identity."""
    seen: set[tuple[str, str]] = set()
    out: list[FileRow] = []
    for raw in rows:
        row = file_row(raw)
        if row is None or (row.collection, row.file_name) in seen:
            continue
        seen.add((row.collection, row.file_name))
        out.append(row)
    return out


def _in_folder(row: FileRow, folder: str) -> bool:
    return row.folder == folder or row.folder.startswith(f"{folder}/")


def _folder_matches(rows: Sequence[FileRow], folder: str) -> str | None:
    """The stored spelling of ``folder``, case- and umlaut-insensitively, or None."""
    wanted = fold(folder)
    for row in rows:
        parts = row.folder.split("/") if row.folder else []
        for depth in range(1, len(parts) + 1):
            candidate = "/".join(parts[:depth])
            if fold(candidate) == wanted:
                return candidate
    return None


@dataclass
class Listing:
    """What one ``list_files`` call selected, before it is rendered."""

    rows: list[FileRow]
    total: int
    offset: int
    limit: int
    folder: str | None
    subfolders: list[tuple[str, int]] = field(default_factory=list)
    here: int = 0
    shelves: tuple[str, ...] = ()
    notes: list[str] = field(default_factory=list)
    #: Document types Piloti assigned across the WHOLE selection (not just the
    #: page), most frequent first, and how many files carry none.
    types: list[tuple[str, int]] = field(default_factory=list)
    untyped: int = 0
    #: Topics (Themen) across the whole selection, most frequent first.
    topics: list[tuple[str, int]] = field(default_factory=list)
    #: What the file names say about Fassungen, keyed by ``(collection, file_name)``:
    #: the mark a row carries, and how many documents in the selection have several.
    revision_marks: dict[tuple[str, str], str] = field(default_factory=dict)
    revision_series: int = 0
    #: How many files a person confirmed as replaced, among the selection.
    confirmed_replacements: int = 0
    #: How many documents in the selection share a document number in their title blocks across several states.
    title_block_series: int = 0


def _type_profile(rows: Sequence[FileRow]) -> tuple[list[tuple[str, int]], int]:
    """What the selected files are, by the document type Piloti gave each: the folder's README line.

    The agent otherwise meets a folder of 300 files as 300 lines, of which a page
    of 50 is shown. One line of counts tells it what the folder holds before it
    reads any of them (and what the folder brief in Dateien shows a person).
    „Sonstiges“ is counted last whatever its size: it says nothing about the folder.
    """
    from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS

    known = set(DOCUMENT_TYPE_TAGS)
    counts: dict[str, int] = {}
    untyped = 0
    for row in rows:
        types = [tag for tag in dict.fromkeys(row.tags) if tag in known]
        if not types:
            untyped += 1
        for tag in types:
            counts[tag] = counts.get(tag, 0) + 1
    order = {tag: index for index, tag in enumerate(DOCUMENT_TYPE_TAGS)}
    ranked = sorted(counts.items(), key=lambda item: (item[0] == "Sonstiges", -item[1], order[item[0]]))
    return ranked, untyped


def _topic_profile(rows: Sequence[FileRow]) -> list[tuple[str, int]]:
    """The topics the selected files carry, counted per file, most frequent first.

    A topic counts once per file whatever its case, and the spelling shown is the
    first one seen. Ties sort alphabetically, so the line is the same on every page.
    """
    counts: dict[str, int] = {}
    spelling: dict[str, str] = {}
    for row in rows:
        seen: set[str] = set()
        for topic in row.topics:
            key = fold(topic)
            if key in seen:
                continue
            seen.add(key)
            spelling.setdefault(key, topic)
            counts[key] = counts.get(key, 0) + 1
    ranked = sorted(counts, key=lambda key: (-counts[key], key))
    return [(spelling[key], counts[key]) for key in ranked]


def _subfolders(rows: Sequence[FileRow], folder: str | None) -> tuple[list[tuple[str, int]], int]:
    """The folders one level below ``folder`` with their file counts (whole subtree), and the files AT it."""
    counts: dict[str, int] = {}
    here = 0
    base = folder or ""
    for row in rows:
        rest = row.folder[len(base) :].lstrip("/") if base else row.folder
        if not rest:
            here += 1
            continue
        child = rest.split("/", 1)[0]
        path = f"{base}/{child}" if base else child
        counts[path] = counts.get(path, 0) + 1
    return sorted(counts.items(), key=lambda item: fold(item[0])), here


_RowKey = tuple[str, str]


def revision_marks(rows: Sequence[FileRow]) -> tuple[dict[_RowKey, str], dict[_RowKey, _RowKey]]:
    """Which rows the names say are the current or an older Fassung of one document.

    The same grammar the folder brief reads (``revision_series.py``, its TS twin
    held to one fixture), grouped per collection: a Fassung lives on one shelf.
    Grouped over every row handed in, because an older Fassung is often moved
    into an ``alt/`` folder that the listing's folder filter would cut away.
    Returns the marks, and for each marked row the key of its series' current row.
    """
    by_collection: dict[str, list[FileRow]] = {}
    for row in rows:
        by_collection.setdefault(row.collection, []).append(row)
    marks: dict[tuple[str, str], str] = {}
    series_of: dict[_RowKey, _RowKey] = {}
    for members in by_collection.values():
        for series in find_revision_series(
            members, filename=lambda row: row.file_name, created_at=lambda row: row.added_at
        ):
            head = series.current.item
            label = revision_label(series.current.revision)
            head_key = (head.collection, head.file_name)
            series_of[head_key] = head_key
            marks[(head.collection, head.file_name)] = (
                f"current Fassung ({label}; {len(series.older)} older, by file name)"
            )
            for member in series.older:
                older = member.item
                series_of[(older.collection, older.file_name)] = head_key
                marks[(older.collection, older.file_name)] = (
                    f"older Fassung ({revision_label(member.revision)}), current by file name: {head.file_name}"
                )
    return marks, series_of


def _state_label(facts: Mapping[str, Any] | None) -> str:
    """``Index C, Stand 14.08.2026``: the state a title block names, without the number."""
    facts = facts or {}
    parts = [f"Index {facts['revision']}"] if facts.get("revision") else []
    if facts.get("revision_date"):
        parts.append(f"Stand {display_date(str(facts['revision_date']))}")
    return ", ".join(parts) or "no Index"


def title_block_marks(rows: Sequence[FileRow]) -> tuple[dict[_RowKey, str], dict[_RowKey, _RowKey]]:
    """Which rows the title blocks say are the current or an older Fassung of one document.

    Two files of one collection whose title blocks carry the same ``document_number`` are
    Fassungen of one document, whatever their names share, and the higher Index (else the later
    date) printed on the sheet is the current one. Needs two different states: the same number
    and the same Index twice is a copy. Returns the marks, and for each marked row the key of
    its series' current row.
    """
    groups: dict[tuple[str, str], list[FileRow]] = {}
    for row in rows:
        key = document_key((row.revision_facts or {}).get("document_number"))
        if key is not None:
            groups.setdefault((row.collection, key), []).append(row)
    marks: dict[_RowKey, str] = {}
    series_of: dict[_RowKey, _RowKey] = {}
    for members in groups.values():
        states = {
            ((m.revision_facts or {}).get("revision"), (m.revision_facts or {}).get("revision_date")) for m in members
        }
        if len(members) < 2 or len(states) < 2:
            continue
        ordered = newest_first(members, lambda row: row.revision_facts, lambda row: row.added_at or "")
        head, older = ordered[0], ordered[1:]
        head_key = (head.collection, head.file_name)
        series_of[head_key] = head_key
        marks[head_key] = f"current Fassung by Plankopf ({_state_label(head.revision_facts)}; {len(older)} older)"
        for row in older:
            series_of[(row.collection, row.file_name)] = head_key
            marks[(row.collection, row.file_name)] = (
                f"older Fassung by Plankopf ({_state_label(row.revision_facts)}), current by Plankopf: {head.file_name}"
            )
    return marks, series_of


def confirmed_revision_marks(rows: Sequence[FileRow]) -> dict[_RowKey, str]:
    """The rows a PERSON linked as one replacing another, with the mark each carries.

    The older file says by which it was replaced, the newer which it replaced.
    These are confirmations, not readings of a name, so they beat the name
    marks. A link counts only when both files are among ``rows``: the store
    clears a link whose newer file is gone, and this guards a row it missed.
    """
    present = {(row.collection, row.file_name) for row in rows}
    marks: dict[_RowKey, list[str]] = {}
    for row in rows:
        key = (row.collection, row.file_name)
        if row.superseded_by and (row.collection, row.superseded_by) in present:
            marks.setdefault(key, []).append(f"replaced by {row.superseded_by} (confirmed)")
        replaced = [name for name in row.supersedes if (row.collection, name) in present]
        if replaced:
            marks.setdefault(key, []).append(f"replaces {', '.join(replaced)} (confirmed)")
    return {key: "; ".join(parts) for key, parts in marks.items()}


def on_shelves(rows: Sequence[FileRow], *, shelf: str | None, default_shelves: Sequence[str]) -> list[FileRow]:
    """The rows on the asked shelf, or on the default shelves (plus rows with no shelf) when none is asked."""
    shelves = (shelf,) if shelf else tuple(default_shelves)
    return [row for row in rows if row.shelf in shelves or (not shelf and row.shelf is None)]


def _filter_rows(
    rows: list[FileRow],
    *,
    doc_class: str | None,
    added_since: str | None,
    name_contains: str | None,
    topic: str | None,
) -> list[FileRow]:
    """The rows every filter a call asked for keeps; a filter it did not ask for keeps them all."""
    if doc_class:
        rows = [row for row in rows if row.doc_class == doc_class]
    if added_since:
        rows = [row for row in rows if row.added_at and row.added_at >= added_since]
    if name_contains:
        words = _words(name_contains)
        rows = [row for row in rows if all(word in row.searchable for word in words)]
    if topic:
        needle = fold(topic)
        rows = [row for row in rows if any(needle in fold(name) for name in row.topics)]
    return rows


def _sort_rows(rows: list[FileRow], sort: str) -> None:
    """Order the rows in place: by folder (the default), by name, or newest first with undated rows last."""
    if sort == "newest":
        rows.sort(key=lambda row: (row.added_at or "", fold(row.file_name)), reverse=True)
        # Undated rows last, whatever the reverse did to the empty string.
        rows.sort(key=lambda row: row.added_at is None)
    elif sort == "name":
        rows.sort(key=lambda row: fold(row.file_name))
    else:
        rows.sort(key=lambda row: (fold(row.folder), fold(row.file_name)))


def select_files(
    rows: Sequence[FileRow],
    *,
    shelf: str | None = None,
    folder: str | None = None,
    name_contains: str | None = None,
    doc_class: str | None = None,
    added_since: str | None = None,
    topic: str | None = None,
    sort: str = "folder",
    offset: int = 0,
    limit: int = DEFAULT_PAGE_SIZE,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> Listing:
    """Filter, order and page the rows. Pure: the tool's whole behaviour is here.

    ``default_shelves`` is what „my files“ means when no ``shelf`` is asked
    for: the user shelves, or the subset of them this turn is restricted to.
    """
    notes: list[str] = []
    shelves = (shelf,) if shelf else tuple(default_shelves)
    selected = on_shelves(rows, shelf=shelf, default_shelves=default_shelves)
    marks, series_of = revision_marks(selected)
    block_marks, block_series_of = title_block_marks(selected)
    confirmed = confirmed_revision_marks(selected)

    resolved_folder: str | None = None
    if folder:
        resolved_folder = _folder_matches(selected, folder)
        if resolved_folder is None:
            notes.append(f'No folder "{folder}" on these shelves. Call without `folder` to see the folders.')
            return Listing([], 0, offset, limit, folder, shelves=shelves, notes=notes)
        selected = [row for row in selected if _in_folder(row, resolved_folder)]

    selected = _filter_rows(
        selected, doc_class=doc_class, added_since=added_since, name_contains=name_contains, topic=topic
    )

    filtered = bool(doc_class or added_since or name_contains or topic)
    subfolders, here = ([], 0) if filtered else _subfolders(selected, resolved_folder)

    _sort_rows(selected, sort)

    total = len(selected)
    page = selected[offset : offset + limit]
    types, untyped = _type_profile(selected)
    keys = {(row.collection, row.file_name) for row in selected}
    return Listing(
        page,
        total,
        offset,
        limit,
        resolved_folder,
        subfolders,
        here,
        shelves,
        notes,
        types,
        untyped,
        topics=_topic_profile(selected),
        revision_marks={key: mark for key, mark in {**marks, **block_marks, **confirmed}.items() if key in keys},
        revision_series=len(
            {series_of[key] for key in keys if key in series_of and key not in confirmed and key not in block_marks}
        ),
        title_block_series=len(
            {block_series_of[key] for key in keys if key in block_series_of and key not in confirmed}
        ),
        confirmed_replacements=sum(
            1 for row in selected if row.superseded_by and (row.collection, row.file_name) in confirmed
        ),
    )
