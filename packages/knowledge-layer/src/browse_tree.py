"""The folder tree and the folder cards: each folder's abstract, its current files and its revision series,
rendered as a tree.
"""

from __future__ import annotations

from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .browse_render import _in_flight_line
from .browse_rows import MAX_TYPE_COUNTS
from .browse_rows import FileRow
from .browse_rows import _RowKey
from .browse_rows import _state_label
from .browse_rows import _subfolders
from .browse_rows import _type_profile
from .browse_rows import confirmed_revision_marks
from .browse_rows import revision_marks
from .browse_rows import title_block_marks
from .browse_text import fold
from .revision_series import parse_revision_name
from .revision_series import revision_label

#: Levels of folders below the asked one that get a card, by default and at most.
DEFAULT_TREE_DEPTH = 2

MAX_TREE_DEPTH = 4

#: Cards one tree call renders before it counts the rest, and current Fassungen one card names.
MAX_TREE_CARDS = 30

MAX_CURRENT_LINES = 3

#: Subfolders a card names, and older files one "replaces" clause names.
MAX_CARD_SUBFOLDERS = 8

MAX_REPLACED_NAMES = 3

#: A folder holding at most this many documents directly names them on its card.
MAX_CARD_FILES = 8

#: The tree view, which a binding with ``ls(depth=…)`` leaves out (``chat_binding``).
TREE_PARAGRAPH = (
    '`view="tree"` (`depth=` 1-4, default 2) returns a card per folder instead of file lines: counts, '
    "Dokumentart mix, pages, dates, the current Fassung; filters apply, no paging.\n"
)


@dataclass(frozen=True)
class FolderCard:
    """What one folder holds, counted from the rows alone: tier 0, nothing stored, nothing stale."""

    path: str
    #: Levels below the folder the call asked about (the asked folder is 0).
    depth: int
    #: Documents directly in the folder, and in the whole subtree (the direct ones included).
    direct: int
    total: int
    #: Child folders with their subtree counts.
    subfolders: tuple[tuple[str, int], ...]
    #: Document types over the subtree, most frequent first, and how many documents carry none.
    types: tuple[tuple[str, int], ...]
    untyped: int
    #: Pages summed over the documents that have a count, and how many have none.
    pages: int
    pages_unknown: int
    first_added: str | None
    last_added: str | None
    #: ``"name (date)"`` of the most recently added document, or empty.
    newest: str
    #: One line per series whose current Fassung is in the subtree, and how many older Fassungen it holds.
    current: tuple[str, ...]
    superseded: int
    #: ``"name (date)"`` of the document with the latest date of its own (Plankopf Stand, photo), or empty.
    newest_document: str = ""
    #: The names of the documents filed directly here when there are at most :data:`MAX_CARD_FILES`.
    files: tuple[str, ...] = ()


@dataclass(frozen=True)
class _Series:
    """A document in several Fassungen: the current one, what says so, and the names it replaces."""

    head: FileRow
    basis: str
    older: tuple[str, ...]


def _confirmed_head(row: FileRow, by_key: dict[_RowKey, FileRow]) -> FileRow | None:
    """The end of the confirmed chain ``row`` starts: A → B → C gives C. ``None`` for a chain that loops."""
    seen: set[_RowKey] = set()
    current = row
    while current.superseded_by and (current.collection, current.superseded_by) in by_key:
        seen.add((current.collection, current.file_name))
        current = by_key[(current.collection, current.superseded_by)]
        if (current.collection, current.file_name) in seen:
            return None
    return current


def _revision_series(rows: Sequence[FileRow]) -> list[_Series]:
    """Every series of Fassungen among ``rows``, by the same precedence ``select_files`` marks them.

    A person's confirmation beats the title block, which beats the file name. A confirmed chain
    A → B → C is ONE series headed by C: B is not current because something replaces it. A
    title-block or name series whose head a person confirmed as replaced joins the series of the
    chain's end, so no file a person marked as replaced is ever called current.
    """
    by_key = {(row.collection, row.file_name): row for row in rows}
    confirmed = confirmed_revision_marks(rows)
    heads: dict[_RowKey, _RowKey] = {}
    for row in rows:
        if row.superseded_by and (row.collection, row.superseded_by) in by_key:
            head = _confirmed_head(row, by_key)
            if head is not None:
                heads[(row.collection, row.file_name)] = (head.collection, head.file_name)
    replaced: dict[_RowKey, list[str]] = {}
    for key, head_key in heads.items():
        replaced.setdefault(head_key, []).append(key[1])
    _, block_series_of = title_block_marks(rows)
    _, name_series_of = revision_marks(rows)
    grouped: list[tuple[str, dict[_RowKey, list[str]]]] = []
    for basis, series_of, skip in (
        ("by Plankopf", block_series_of, set(confirmed)),
        ("by file name", name_series_of, set(confirmed) | set(block_series_of)),
    ):
        groups: dict[_RowKey, list[str]] = {}
        for key, head_key in series_of.items():
            if key == head_key or key in skip:
                continue
            if head_key in heads:
                replaced.setdefault(heads[head_key], []).append(key[1])
            else:
                groups.setdefault(head_key, []).append(key[1])
        grouped.append((basis, groups))
    series = [_Series(by_key[head], "confirmed", tuple(sorted(names, key=fold))) for head, names in replaced.items()]
    for basis, groups in grouped:
        series += [_Series(by_key[head], basis, tuple(sorted(names, key=fold))) for head, names in groups.items()]
    return series


def _series_label(head: FileRow, basis: str) -> str:
    """``Index B, Stand 03.02.2026; by Plankopf``: the state the current file carries, and what says it is current."""
    facts = head.revision_facts or {}
    state = _state_label(facts) if facts.get("revision") or facts.get("revision_date") else ""
    if not state:
        name_revision = parse_revision_name(head.file_name)
        state = revision_label(name_revision) if name_revision is not None else ""
    return "; ".join(part for part in (state, basis) if part)


def _current_lines(series: Sequence[_Series], keys: set[_RowKey]) -> tuple[list[str], int]:
    """The ``Current Fassung`` lines for the series whose current file is among ``keys``, and the older files held."""
    lines: list[str] = []
    older_held = 0
    for entry in sorted(series, key=lambda item: fold(item.head.file_name)):
        collection = entry.head.collection
        older_held += sum(1 for name in entry.older if (collection, name) in keys)
        if (collection, entry.head.file_name) not in keys:
            continue
        shown = ", ".join(entry.older[:MAX_REPLACED_NAMES])
        more = len(entry.older) - MAX_REPLACED_NAMES
        replaces = f"{shown} and {more} more" if more > 0 else shown
        lines.append(f"{entry.head.file_name} ({_series_label(entry.head, entry.basis)}) replaces {replaces}")
    return lines, older_held


def _folder_card(path: str, depth: int, rows: Sequence[FileRow], series: Sequence[_Series]) -> FolderCard:
    subfolders, direct = _subfolders(rows, path or None)
    types, untyped = _type_profile(rows)
    dated = [row for row in rows if row.added_at]
    newest = max(dated, key=lambda row: (row.added_at or "", fold(row.file_name)), default=None)
    current, older_held = _current_lines(series, {(row.collection, row.file_name) for row in rows})
    own_dated = [row for row in rows if row.document_date]
    newest_own = max(own_dated, key=lambda row: (row.document_date or "", fold(row.file_name)), default=None)
    direct_rows = sorted((row for row in rows if row.folder == path), key=lambda row: fold(row.file_name))
    return FolderCard(
        path=path,
        depth=depth,
        direct=direct,
        total=len(rows),
        subfolders=tuple(subfolders),
        types=tuple(types),
        untyped=untyped,
        pages=sum(row.page_count or 0 for row in rows),
        pages_unknown=sum(1 for row in rows if row.page_count is None),
        first_added=min((row.added_at or "" for row in dated), default=None),
        last_added=max((row.added_at or "" for row in dated), default=None),
        newest=f"{newest.file_name} ({newest.added_at})" if newest else "",
        newest_document=f"{newest_own.file_name} ({newest_own.document_date})" if newest_own else "",
        files=tuple(row.file_name for row in direct_rows) if 0 < len(direct_rows) <= MAX_CARD_FILES else (),
        current=tuple(current),
        superseded=older_held,
    )


def _card_ancestors(folder: str, root: str, depth: int) -> list[str]:
    """``root`` and every folder from it down to ``folder``, no deeper than ``depth`` below ``root``."""
    base = len(root.split("/")) if root else 0
    parts = folder.split("/") if folder else []
    return ["/".join(parts[:count]) for count in range(base, min(len(parts), base + depth) + 1)]


def _card_order(card: FolderCard) -> list[str]:
    """Parents before children, siblings by name."""
    return [fold(part) for part in card.path.split("/")] if card.path else []


def folder_cards(
    rows: Sequence[FileRow],
    *,
    root: str | None,
    depth: int = DEFAULT_TREE_DEPTH,
    series_rows: Sequence[FileRow] | None = None,
) -> list[FolderCard]:
    """One card for ``root`` and for every folder up to ``depth`` levels below it, parents first.

    Pure, and one pass over the rows: each row is folded into every card above
    it. ``rows`` are the selection (already inside ``root``); the Fassungen are
    read over ``series_rows`` when given, because an older Fassung is often
    filed in a folder the selection cut away.
    """
    root = root or ""
    depth = max(0, min(depth, MAX_TREE_DEPTH))
    members: dict[str, list[FileRow]] = {}
    for row in rows:
        for path in _card_ancestors(row.folder, root, depth):
            members.setdefault(path, []).append(row)
    series = _revision_series(series_rows if series_rows is not None else rows)
    base = len(root.split("/")) if root else 0
    cards = [
        _folder_card(path, (len(path.split("/")) if path else 0) - base, group, series)
        for path, group in members.items()
    ]
    return sorted(cards, key=_card_order)


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"


def abstract_lines(found: Mapping[tuple[str, str], Any]) -> dict[str, list[str]]:
    """The written (tier-1) abstracts by folder path, one ``About:`` line per collection that has one.

    ``found`` maps ``(collection, folder_path)`` to what
    ``agent.knowledge.folder_cards.listing_abstracts`` read: ``abstract``,
    ``status``, ``generated_at``. A card that is not fresh says so and since when.
    """
    lines: dict[str, list[str]] = {}
    for (_collection, path), card in sorted(found.items()):
        line = f"About: {card.abstract}"
        if card.status != "fresh":
            written = f", written {str(card.generated_at)[:10]}" if card.generated_at else ""
            line += f" ({card.status}{written})"
        lines.setdefault(path, []).append(line)
    return lines


def _card_lines(card: FolderCard, about: Sequence[str] = ()) -> list[str]:
    """One card as the model reads it: counts, the written abstract, document types, dates, Fassungen, subfolders."""
    older = f"; {card.superseded} older Fassung{'' if card.superseded == 1 else 'en'}" if card.superseded else ""
    here = f"{card.direct} here, {card.total - card.direct} below{older}" if card.subfolders else f"all here{older}"
    head = f"{card.path}/" if card.path else "Top level"
    head += f"  {_count(card.total, 'document')} ({here})"
    if card.subfolders:
        head += f", {_count(len(card.subfolders), 'subfolder')}"
    if card.pages:
        head += f", {_count(card.pages, 'page')}"
        head += f" ({card.pages_unknown} without count)" if card.pages_unknown else ""
    lines = [head, *(f"  {line}" for line in about)]
    types = [f"{tag} {count}" for tag, count in card.types[:MAX_TYPE_COUNTS]]
    if card.untyped:
        types.append(f"untyped {card.untyped}")
    lines.append(f"  Dokumentart: {' · '.join(types)}")
    if card.first_added:
        span = card.first_added if card.first_added == card.last_added else f"{card.first_added} to {card.last_added}"
        # Two different dates: the upload day says when it reached the office, the document's own date
        # (Plankopf Stand, photo) says how old the content is. "Newest" names which one it means.
        if card.newest_document:
            lines.append(f"  Added: {span}. Newest by document date (Plankopf Stand or photo): {card.newest_document}")
        else:
            lines.append(f"  Added: {span}. Newest upload (no document date known): {card.newest}")
    if card.files:
        lines.append(f"  Files here: {' · '.join(card.files)}")
    elif card.direct > MAX_CARD_FILES:
        call = "a listing of the folder"
        lines.append(
            f"  Files here: {card.direct}, too many to name (a card names them up to {MAX_CARD_FILES}); "
            f"{call} lists them."
        )
    lines.extend(f"  Current Fassung: {line}" for line in card.current[:MAX_CURRENT_LINES])
    if len(card.current) > MAX_CURRENT_LINES:
        lines.append(f"  … and {len(card.current) - MAX_CURRENT_LINES} more documents with several Fassungen")
    if card.subfolders:
        names = [f"{path.rsplit('/', 1)[-1]}/ ({count})" for path, count in card.subfolders[:MAX_CARD_SUBFOLDERS]]
        rest = len(card.subfolders) - MAX_CARD_SUBFOLDERS
        lines.append(f"  Subfolders: {' · '.join(names)}{f' · and {rest} more' if rest > 0 else ''}")
    indent = "  " * card.depth
    return [indent + line for line in lines]


def render_tree(
    cards: Sequence[FolderCard],
    *,
    total_rows: int,
    notes: Sequence[str] = (),
    scope: str = "",
    in_flight: Sequence[str] = (),
    abstracts: Mapping[str, Sequence[str]] | None = None,
) -> str:
    """The folder tree as the model reads it: a card per folder, bounded, ending with how to go on.

    ``abstracts`` are the written cards' ``About:`` lines by folder path (:func:`abstract_lines`).
    """
    abstracts = abstracts or {}
    lines: list[str] = [*notes]
    if not cards:
        if not notes:
            lines.append(f"No file{f' on {scope}' if scope else ''} matches these filters.")
        return "\n".join(lines)
    lines.append(f"{_count(total_rows, 'document')}{f' on {scope}' if scope else ''}, as folder cards:")
    shown = sorted(
        sorted(cards, key=lambda card: (card.depth, -card.total, _card_order(card)))[:MAX_TREE_CARDS], key=_card_order
    )
    for card in shown:
        lines.extend(_card_lines(card, abstracts.get(card.path, ())))
    hidden = len(cards) - len(shown)
    if hidden:
        lines.append(
            f"… {_count(hidden, 'folder')} not shown (the {MAX_TREE_CARDS} largest of the shallowest levels are). "
            'Open one with `list_files(folder="…", view="tree")`.'
        )
    if in_flight:
        lines.append(_in_flight_line(in_flight))
    lines.append(
        'The files of a folder: `list_files(folder="…")`. An index, not a source: never cite it; '
        "open a document with read_passage."
    )
    return "\n".join(lines)
