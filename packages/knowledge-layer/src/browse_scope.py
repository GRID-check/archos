"""The shelves an exact search covers, and the statements and notes that say what it could and could not read."""

from __future__ import annotations

from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .browse_matches import FileMatches
from .browse_rows import _SHELF_LABELS
from .browse_rows import KNOWN_SHELVES
from .browse_text import fold
from .browse_tree import _count
from .browse_turn import _entry_shelf


@dataclass(frozen=True)
class ShelfScope:
    """One shelf a literal search read: how many documents it held in scope, or None when that is not counted."""

    shelf: str | None
    documents: int | None


def shelf_scopes(entries: Sequence[Any], documents: Mapping[str, int]) -> list[ShelfScope]:
    """The shelves of the searched ``entries`` in a stable order, each with the documents searched on it.

    ``documents`` counts the inventory's documents per collection that the search could read. A shelf
    whose collections have no inventory (the Basiswissen corpus is not enumerated) has no count.
    """
    order = [*KNOWN_SHELVES, None]
    by_shelf: dict[str | None, list[str]] = {}
    for entry in entries:
        by_shelf.setdefault(_entry_shelf(entry), []).append(entry.collection)
    scopes = []
    for shelf in sorted(by_shelf, key=lambda known: order.index(known) if known in order else len(order)):
        counted = [documents[name] for name in by_shelf[shelf] if name in documents]
        scopes.append(ShelfScope(shelf, sum(counted) if counted else None))
    return scopes


def _scope_statement(scopes: Sequence[ShelfScope]) -> str:
    """How many documents were searched, and on which shelves: the denominator of every "no" and every count."""
    if not scopes:
        return ""
    parts = []
    for scope in scopes:
        label = _SHELF_LABELS.get(scope.shelf or "", "unknown shelf")
        parts.append(
            f"{label} {scope.documents} documents" if scope.documents is not None else f"{label} (whole corpus)"
        )
    counted = [scope.documents for scope in scopes if scope.documents is not None]
    total = f"{sum(counted)} documents" + (" plus a corpus" if len(counted) < len(scopes) else "")
    return f"Searched: {total} ({', '.join(parts)})."


def _shelf_lines(groups: Sequence[FileMatches], scopes: Sequence[ShelfScope]) -> list[str]:
    """One line per searched shelf: its matches and files with matches against the files it holds, 0 included."""
    lines = []
    for scope in scopes:
        mine = [group for group in groups if group.shelf == scope.shelf]
        label = _SHELF_LABELS.get(scope.shelf or "", "unknown shelf")
        found = _count(sum(group.occurrences for group in mine), "match").replace("matchs", "matches")
        if scope.documents is None:
            lines.append(f"{label}: {found} in {_count(len(mine), 'file')} (documents not counted)")
        elif mine:
            lines.append(f"{label}: {found} in {len(mine)} of {_count(scope.documents, 'file')}")
        else:
            lines.append(f"{label}: {found} in {_count(scope.documents, 'file')}")
    return lines


def _collection_names(collections: Sequence[str]) -> str:
    """Collections as a message names them: a restricted folder's by what it is, never by its id.

    Its id in a result would make the admission treat the whole result as that
    folder's content (ADR-0088), and an outage is not content.
    """
    from agent.knowledge.restricted_collections import is_restricted_collection

    return ", ".join(
        "folder with restricted access" if is_restricted_collection(name) else name for name in collections
    )


def _failed_note(failed: Sequence[str]) -> str:
    return (
        f"INCOMPLETE: {len(failed)} collection(s) could not be searched ({_collection_names(failed)}). "
        "What is in them is missing from this answer; tell the reader so instead of turning it into a no."
    )


#: What the pattern tolerates, said where a count or a „Nein“ is stated.
_TOLERATED = (
    "ignoring case, umlaut spelling (ä/ae, ö/oe, ü/ue, ß/ss), and a line break, space or hyphen between the words"
)

#: Said above the table of a stemmed search: what "a match" meant.
_STEMMED_NOTE = (
    "Inflected forms included (German stemming): a passage matches when it holds the words in any inflected "
    "form („Fluchtwegbreiten“ for „Fluchtwegbreite“) or literally as before; a compound matches only literally."
)

#: What a person's regex tolerates: nothing but what they wrote, apart from case.
_TOLERATED_REGEX = (
    "as a regex in Python syntax, ignoring case; umlaut spellings and line breaks are not matched for you"
)


def _wanted(phrases: Sequence[str], regex_mode: bool) -> str:
    if regex_mode:
        return f"regex `{phrases[0]}`"
    return " | ".join(f'"{phrase}"' for phrase in phrases)


def _candidate_lines(candidates: Mapping[str, int] | None, counted: Mapping[str, int], limit: int = 10) -> list[str]:
    """The files a capped search could not finish counting, by how many passages hold the pattern's words."""
    if not candidates:
        return []
    ranked = sorted(candidates.items(), key=lambda item: (-item[1], fold(item[0])))
    shown = ", ".join(f"{name} {count}" for name, count in ranked[:limit])
    more = f" … (+{len(ranked) - limit} files)" if len(ranked) > limit else ""
    return [
        "Passages that hold the pattern's words, per file (an upper bound of its matching passages; "
        f"the counted matches above are the lower bound): {shown}{more}."
    ]
