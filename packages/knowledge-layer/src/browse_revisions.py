"""The revision chain of one document and its rendering: which sheets supersede which, in order."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import replace

from aiq_agent.knowledge.title_block import document_key
from aiq_agent.knowledge.title_block import newest_first
from aiq_agent.knowledge.title_block import title_block_label

from .browse_render import MAX_CHAIN_CHANGE_CHARS
from .browse_render import _change_text
from .browse_render import _compared_with_own_upload
from .browse_rows import _SHELF_LABELS
from .browse_rows import USER_SHELVES
from .browse_rows import FileRow
from .browse_rows import confirmed_revision_marks
from .browse_text import _words
from .browse_text import fold
from .revision_series import find_revision_series
from .revision_series import parse_revision_name
from .revision_series import revision_label
from .revision_series import series_key_of

#: Fassungen one answer lists before it counts the rest.
MAX_CHAIN_LINES = 30

#: Different documents one name may match before the answer asks for the exact name.
MAX_CHAIN_CANDIDATES = 8

_EXTENSION = re.compile(r"\.([a-z0-9]{1,5})\Z", re.IGNORECASE | re.ASCII)


def _series_ident(file_name: str) -> tuple[str, str]:
    """What Fassungen of one document share on the name: the key without index and date, and the format.

    A PDF and a DWG of one Fassung are not versions of each other, and a first
    state with neither index nor date (``Grundriss EG.pdf``) shares the key of
    its indexed successor (``Grundriss EG Index B.pdf``).
    """
    extension = _EXTENSION.search(file_name.strip())
    return series_key_of(file_name), extension.group(1).lower() if extension else ""


def _chain_members(rows: Sequence[FileRow], start: FileRow) -> list[FileRow]:
    """Every file of ``start``'s collection that is a Fassung of the same document, in no order.

    Three things connect files: a link a PERSON confirmed (``superseded_by``,
    followed in both directions through any number of steps), the same
    ``document_number`` in the title blocks (Plankopf), and the file name's own
    series (:func:`_series_ident`). All are followed transitively, so a confirmed
    link joins a differently named older document to a name series.
    """
    same = [row for row in rows if row.collection == start.collection]
    by_name = {row.file_name: row for row in same}
    neighbours: dict[str, set[str]] = {name: set() for name in by_name}
    for row in same:
        if row.superseded_by and row.superseded_by in by_name and row.superseded_by != row.file_name:
            neighbours[row.file_name].add(row.superseded_by)
            neighbours[row.superseded_by].add(row.file_name)
    groups: dict[tuple[str, ...], list[str]] = {}
    for row in same:
        groups.setdefault(("name", *_series_ident(row.file_name)), []).append(row.file_name)
        number = document_key((row.revision_facts or {}).get("document_number"))
        if number is not None:
            groups.setdefault(("plankopf", number), []).append(row.file_name)
    for names in groups.values():
        for name in names:
            neighbours[name].update(other for other in names if other != name)
    seen = {start.file_name}
    queue = [start.file_name]
    while queue:
        for other in neighbours[queue.pop()]:
            if other not in seen:
                seen.add(other)
                queue.append(other)
    return [by_name[name] for name in sorted(seen, key=fold)]


def _with_supersedes(members: Sequence[FileRow]) -> list[FileRow]:
    """The members with ``supersedes`` read off ``superseded_by``, the one fact a link is stored as."""
    return [
        replace(row, supersedes=tuple(sorted(old.file_name for old in members if old.superseded_by == row.file_name)))
        for row in members
    ]


def _by_title_block(members: Sequence[FileRow]) -> bool:
    """Whether every member's title block states an Index or a date, so the sheets themselves can be compared."""
    return len(members) > 1 and all(
        (row.revision_facts or {}).get("revision") or (row.revision_facts or {}).get("revision_date") for row in members
    )


def _sheet_order(members: Sequence[FileRow]) -> list[str]:
    """The members' file names, newest state first by what their title blocks print."""
    ordered = newest_first(members, lambda row: row.revision_facts, lambda row: row.added_at or "")
    return [row.file_name for row in ordered]


def _name_order(members: Sequence[FileRow]) -> list[str]:
    """The members whose NAME carries an Index or a date, newest first (the folder brief's grammar)."""
    names: list[str] = []
    for series in find_revision_series(
        [row for row in members if parse_revision_name(row.file_name)],
        filename=lambda row: row.file_name,
        created_at=lambda row: row.added_at,
    ):
        names += [series.current.item.file_name, *(entry.item.file_name for entry in series.older)]
    return names


def _chain_order(members: Sequence[FileRow]) -> list[FileRow]:
    """Newest first: a confirmed replacement always precedes what it replaced, the names order the rest.

    When every member's title block states an Index or a date, that is the order
    (what the office printed on the sheet beats the file name, ``title_block.newest_first``).
    Otherwise it is the name order, the folder brief's (``find_revision_series``); a file
    whose name carries neither index nor date is the first state of the
    document, so it follows the others, by upload date.
    """
    names_order = _sheet_order(members) if _by_title_block(members) else _name_order(members)
    rest = sorted((row for row in members if row.file_name not in names_order), key=lambda row: fold(row.file_name))
    rest.sort(key=lambda row: row.added_at or "", reverse=True)
    position = {name: index for index, name in enumerate([*names_order, *(row.file_name for row in rest)])}

    pending = sorted(members, key=lambda row: position[row.file_name])
    ordered: list[FileRow] = []
    while pending:
        # Ready: the file that replaced it is already out (or is not among these). A loop, which the store
        # refuses, would leave none ready and then emits in name order.
        waiting = {row.file_name for row in pending}
        ready = [row for row in pending if row.superseded_by not in waiting]
        row = (ready or pending)[0]
        pending.remove(row)
        ordered.append(row)
    return ordered


def _chain_line(position: int, row: FileRow, *, current: bool, mark: str | None, basis: str) -> str:
    """One Fassung: the Index and date its name carries, its Plankopf, who vouches for its place, upload, change.

    ``basis`` is what ordered the chain when no person confirmed the row: "by Plankopf" or "by file name".
    """
    revision = parse_revision_name(row.file_name)
    label = revision_label(revision) if revision is not None else ""
    bits = [label or "no Index and no date in the name"]
    title_block = title_block_label(row.revision_facts)
    if title_block:
        bits.append(f"Plankopf: {title_block}")
    if current:
        bits.append("current Fassung" + ("" if mark else f" ({basis})"))
    elif not mark:
        bits.append(f"older Fassung ({basis})")
    if mark:
        bits.append(mark)
    if row.added_at:
        bits.append(f"uploaded {row.added_at}")
    text = _change_text(row, MAX_CHAIN_CHANGE_CHARS)
    if text and _compared_with_own_upload(row):
        bits.append(f"changed against its previous upload (same file name): {text}")
    elif text and row.change_basis:
        bits.append(f"changed against {row.change_basis}: {text}")
    elif text:
        bits.append(f"changed: {text}")
    else:
        bits.append("no change note stored")
    return f"{position}. {row.file_name} · {' · '.join(bits)}"


def _chain_candidates(rows: Sequence[FileRow], wanted: str) -> list[FileRow]:
    """The files ``wanted`` names: an exact file name or title first, else every file whose name has all its words."""
    folded = fold(wanted.strip())
    exact = [row for row in rows if folded in (fold(row.file_name), fold(row.display_title or ""))]
    if exact:
        return exact
    words = set(_words(wanted))
    return [row for row in rows if words and words <= set(row.searchable.split())]


def _resolve_chain(
    rows: Sequence[FileRow],
    wanted: str,
    *,
    shelf: str | None,
    default_shelves: Sequence[str],
) -> tuple[list[FileRow], str]:
    """The ordered chain of Fassungen ``wanted`` names, newest first, or the sentence that says why there is none.

    One lookup for the listing (:func:`render_revisions`) and the compare
    (:func:`resolve_compare`), so the two cannot disagree about which document
    a name means.
    """
    shelves = (shelf,) if shelf else tuple(default_shelves)
    scoped = [row for row in rows if row.shelf in shelves or (not shelf and row.shelf is None)]
    where = " and ".join(_SHELF_LABELS.get(name, name) for name in shelves)
    matches = _chain_candidates(scoped, wanted)
    if not matches:
        return [], (
            f'No file on {where} is named or contains "{wanted.strip()}". Find the exact name with '
            "`list_files(name_contains=…)`."
        )
    chains: dict[frozenset[tuple[str, str]], list[FileRow]] = {}
    for row in matches:
        members = _chain_members(scoped, row)
        chains.setdefault(frozenset((member.collection, member.file_name) for member in members), members)
    if len(chains) > 1:
        names = [row.file_name for row in matches[:MAX_CHAIN_CANDIDATES]]
        rest = len(matches) - len(names)
        return [], (
            f'"{wanted.strip()}" matches {len(chains)} different documents: {", ".join(names)}'
            f"{f' and {rest} more' if rest > 0 else ''}. Call `list_files(revisions_of=…)` with the exact "
            "file name of one of them."
        )
    return _chain_order(_with_supersedes(next(iter(chains.values())))), ""


def render_revisions(
    rows: Sequence[FileRow],
    wanted: str,
    *,
    shelf: str | None = None,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> str:
    """The whole chain of Fassungen of the document ``wanted`` names, newest first, as the model reads it.

    Pure, over the rows the turn may list and nothing else: the same shelves
    ``select_files`` lists, so a Fassung on a shelf this turn did not ask for,
    or a file nobody may name, is not in the chain. The chain spans folders (an
    older Fassung is often filed under ``alt/``) and ignores every other filter.
    """
    members, refusal = _resolve_chain(rows, wanted, shelf=shelf, default_shelves=default_shelves)
    if refusal:
        return refusal
    confirmed = confirmed_revision_marks(members)
    where = " and ".join(dict.fromkeys(_SHELF_LABELS.get(row.shelf or "", row.shelf or "") for row in members))
    basis = "by Plankopf" if _by_title_block(members) else "by file name"
    asked = wanted.strip()
    lines = [
        f'Fassungen of "{asked}" on {where}: {len(members)} files, newest first.'
        if len(members) > 1
        else f'"{asked}" on {where}: only this one Fassung.'
    ]
    for number, row in enumerate(members[:MAX_CHAIN_LINES], start=1):
        lines.append(
            _chain_line(
                number, row, current=number == 1, mark=confirmed.get((row.collection, row.file_name)), basis=basis
            )
        )
    if len(members) > MAX_CHAIN_LINES:
        lines.append(f"… and {len(members) - MAX_CHAIN_LINES} more, older Fassungen.")
    if len(members) == 1:
        lines.append(
            "No other file name on this shelf belongs to it by name (Index, date), and no person has confirmed a "
            "replacement. If the same file was uploaded again, the row says so as a change against the previous "
            "upload."
        )
        return "\n".join(lines)
    lines.append(
        "The change note sits on the NEWER Fassung and compares it with the base named beside it; between two "
        "Fassungen that are not neighbours, read the rows in between together. It is a summary by Piloti, not "
        "proof: what changed page by page is shown by `list_files(revisions_of=…, compare_to=…)`, and you check a "
        "measurement by reading the document. An older Fassung stays readable on request; otherwise "
        "rely on the current one. Write file names exactly as they appear here."
    )
    return "\n".join(lines)
