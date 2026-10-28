"""The rows a turn may read: the session's collections and shelves, and the restriction to the files this turn
asked about.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from agent.common.source_kinds import canonical_shelf_value
from nat.plugin_api import Context

from .browse_rows import _SHELF_LABELS
from .browse_rows import KNOWN_SHELVES
from .browse_rows import USER_SHELVES
from .browse_rows import FileRow
from .browse_rows import file_rows

# Logs under the name browse always had, so a filter on that name still catches these records.
logger = logging.getLogger("knowledge_layer.browse")


def _session_collection() -> str | None:
    try:
        ctx = Context.get()
        return ctx.conversation_id if ctx else None
    except Exception:  # noqa: BLE001 — no context is a valid standalone run
        return None


def _scope_entries(search_config: Any) -> list[Any]:
    from .search_scope import resolve_base_collection
    from .search_scope import resolve_scoped_collections

    return list(
        resolve_scoped_collections(search_config, _session_collection(), resolve_base_collection(search_config))
    )


def _entry_shelf(entry: Any) -> str | None:
    shelf = getattr(entry, "shelf", None)
    return canonical_shelf_value(str(getattr(shelf, "value", shelf))) if shelf else None


async def _readable_rows(search_config: Any) -> list[FileRow]:
    from agent.knowledge.inventory import get_turn_documents
    from agent.knowledge.restricted_use import without_restricted

    bound = get_turn_documents()
    if bound:
        return file_rows(bound)
    from agent.knowledge import get_available_documents_async

    entries = without_restricted(_scope_entries(search_config))
    listings = await asyncio.gather(
        *(get_available_documents_async(entry.collection) for entry in entries), return_exceptions=True
    )
    rows: list[dict[str, Any]] = []
    for entry, docs in zip(entries, listings, strict=True):
        if isinstance(docs, BaseException):
            logger.warning("list_files: no rows for %s: %s", entry.collection, docs)
            continue
        for doc in docs:
            data = doc.model_dump() if hasattr(doc, "model_dump") else dict(doc)
            rows.append({**data, "collection": entry.collection, "shelf": _entry_shelf(entry)})
    return file_rows(rows)


@dataclass(frozen=True)
class TurnRows:
    """The rows this turn may list, and what its restriction left."""

    rows: list[FileRow]
    #: What „my files“ means this turn: the user shelves that remain.
    own_shelves: tuple[str, ...]
    #: The shelves the turn allows when a restriction applied, else None.
    allowed: frozenset[str] | None = None


def restrict_rows_to_turn(rows: Sequence[FileRow]) -> TurnRows:
    """Drop the shelves this turn did not ask for; the user shelves that remain.

    The row-level twin of ``search_scope.restrict_scope_to_turn``, with its rules:
    turn intent only ever subtracts, a row without a shelf is kept, and a
    restriction that would leave nothing keeps everything.
    """
    try:
        from agent.common.focus_file import get_turn_shelves

        allowed = get_turn_shelves()
    except Exception:  # noqa: BLE001 — no turn intent is a valid standalone run
        allowed = None
    if not allowed:
        return TurnRows(list(rows), USER_SHELVES)
    kept = [row for row in rows if row.shelf is None or row.shelf in allowed]
    if not kept:
        return TurnRows(list(rows), USER_SHELVES)
    # A law-only turn („nur Gesetz“) allows base alone: then base IS what it lists.
    own = tuple(shelf for shelf in USER_SHELVES if shelf in allowed)
    own = own or tuple(shelf for shelf in KNOWN_SHELVES if shelf in allowed) or USER_SHELVES
    return TurnRows(kept, own, frozenset(allowed))


def shelf_restricted_message(shelf: str, allowed: Iterable[str]) -> str:
    """An explicit ``shelf=`` the turn's restriction removed: say so, never „keine Datei“.

    „Keine Datei auf Projektwissen“ would be a false statement about the
    project; the shelf is only out of THIS question's reach.
    """
    allowed = set(allowed)
    names = [_SHELF_LABELS[known] for known in KNOWN_SHELVES if known in allowed]
    where = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return (
        f"The user's current selection limits this question to {where}, so {_SHELF_LABELS.get(shelf, shelf)} "
        "is not listed here. That says nothing about what lies there; only the user changes the selection."
    )
