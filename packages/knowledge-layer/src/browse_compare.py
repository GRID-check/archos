"""Comparing two revisions of one document: resolving which two, and the change between their stored passages."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Any

from .browse_revisions import MAX_CHAIN_CANDIDATES
from .browse_revisions import _chain_candidates
from .browse_revisions import _resolve_chain
from .browse_rows import USER_SHELVES
from .browse_rows import FileRow
from .browse_text import fold

# Logs under the name browse always had, so a filter on that name still catches these records.
logger = logging.getLogger("knowledge_layer.browse")

#: What ``compare_to`` may say to mean "the Fassung right before this one".
_PREVIOUS_WORDS = frozenset({"", "vorige", "vorherige", "letzte", "previous", "prev"})


def resolve_compare(
    rows: Sequence[FileRow],
    wanted: str,
    compare_to: str | None,
    *,
    shelf: str | None = None,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> tuple[FileRow | None, FileRow | None, str]:
    """``(older, newer, "")`` for ``list_files(revisions_of=…, compare_to=…)``, or ``(None, None, refusal)``.

    ``wanted`` names the document and, when it names one Fassung exactly, that
    Fassung; otherwise the current one. ``compare_to`` names the other Fassung
    in the same chain, or says "previous" (the default) for the one right before.
    Pure, over the rows the turn may list, like :func:`render_revisions`.
    """
    members, refusal = _resolve_chain(rows, wanted, shelf=shelf, default_shelves=default_shelves)
    if refusal:
        return None, None, refusal
    if len(members) < 2:
        return (
            None,
            None,
            (
                f'Of "{wanted.strip()}" there is only this one file on this shelf, so there is nothing to compare. '
                "Earlier uploads under the SAME file name are not in the index yet; what changed there is in the "
                "change note of `list_files(revisions_of=…)`."
            ),
        )
    exact = [row for row in members if fold(wanted.strip()) in (fold(row.file_name), fold(row.display_title or ""))]
    anchor = exact[0] if len(exact) == 1 else members[0]
    position = members.index(anchor)
    target = (compare_to or "").strip()
    if fold(target) in _PREVIOUS_WORDS:
        other = members[position + 1] if position + 1 < len(members) else members[position - 1]
    else:
        candidates = _chain_candidates(members, target)
        names = ", ".join(row.file_name for row in members[:MAX_CHAIN_CANDIDATES])
        if not candidates:
            return None, None, f'"{target}" is not a Fassung of this document. Its Fassungen: {names}.'
        if len(candidates) > 1:
            return None, None, f'"{target}" matches several Fassungen; name one exactly: {names}.'
        other = candidates[0]
    if other is anchor:
        return None, None, "That is the same file twice. Name a different Fassung in `compare_to`."
    newer, older = (anchor, other) if position < members.index(other) else (other, anchor)
    return older, newer, ""


def _change_line_between(older: FileRow, newer: FileRow) -> str | None:
    """The stored change summary, only when it was written against exactly this older file."""
    if newer.change_summary and newer.change_basis == older.file_name:
        return newer.change_summary
    return None


def _stored_chunks(collection: str, file_name: str) -> list[Any] | None:
    """Both Fassungen are read from what the index holds: blocking, so the tool runs it on a thread.

    None when the index holds no chunk of the file; raises when the store cannot be read.
    """
    from aiq_agent.knowledge.collection_pages import read_chunks
    from aiq_agent.knowledge.revision_diff import chunk_from_store

    stored = read_chunks(collection, file_name)
    if stored is None:
        return None
    return [chunk for text, meta in stored if (chunk := chunk_from_store(text, meta)) is not None]


async def compare_revisions(older: FileRow, newer: FileRow) -> str:
    """The compare of two Fassungen the turn may list, from their stored chunks and title blocks (ADR-0104)."""
    from aiq_agent.common.tool_calls import FETCH_FAILED_MARKER
    from aiq_agent.knowledge.restricted_use import note_collections_read
    from aiq_agent.knowledge.revision_diff import diff_revisions
    from aiq_agent.knowledge.revision_diff import render_diff

    try:
        older_chunks, newer_chunks = await asyncio.gather(
            asyncio.to_thread(_stored_chunks, older.collection, older.file_name),
            asyncio.to_thread(_stored_chunks, newer.collection, newer.file_name),
        )
    except Exception:  # noqa: BLE001 - an outage is said as one, never as "not in the index"
        logger.warning("compare_revisions: the index did not answer", exc_info=True)
        # Marked like read_passage's failed fetch, so a retry is not refused as a repeat.
        return (
            f'{FETCH_FAILED_MARKER} The index is not reachable right now; "{older.file_name}" and '
            f'"{newer.file_name}" were not compared. Try once more; if it fails again, say so and claim no '
            "difference."
        )
    missing = [row.file_name for row, chunks in ((older, older_chunks), (newer, newer_chunks)) if chunks is None]
    if missing:
        names = " and ".join(f'"{name}"' for name in missing)
        return (
            f"The read content of {names} is not in the index, "
            "so nothing can be compared. If the file is still being read, try again later."
        )
    # The report quotes both files' content: reported for the restricted-use
    # admission (ADR-0088), as every read of a document's text is.
    note_collections_read({older.collection, newer.collection})
    diff = diff_revisions(
        older_chunks or [],
        newer_chunks or [],
        older_facts=older.revision_facts,
        newer_facts=newer.revision_facts,
    )
    return render_diff(diff, older.file_name, newer.file_name, change_summary=_change_line_between(older, newer))
