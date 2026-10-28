"""Resolving the document names a read asks for to the corpus's documents, and the names those documents are read
under.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .read_passage_models import PassageTarget
from .read_passage_revisions import _current_revision

# Logs under the name read_passage always had, so a filter on that name still catches these records.
logger = logging.getLogger("knowledge_layer.read_passage")


def _document_names(document: Any) -> list[str]:
    """Every name an :class:`AvailableDocument` can honestly be called by.

    The indexed file name, the stored display title (admin-editable, the source
    of truth for what a reader sees) and the derived OIB title, which is what a
    citation chip printed and therefore what a conclusion is likely to name.
    """
    names = [str(getattr(document, "file_name", "") or "")]
    stored = getattr(document, "display_title", None)
    if stored:
        names.append(str(stored))
    try:
        from aiq_agent.common.norm_registry import guess_display_title
        from aiq_agent.common.norm_registry import oib_family_member

        derived = guess_display_title(names[0])
        member = oib_family_member(names[0])
    except Exception:  # noqa: BLE001 — a missing title helper must not hide the file name
        derived = None
        member = None
    if derived:
        names.append(derived)
        # The title without its edition: the head a conclusion names when the
        # edition is not what it is talking about ("OIB-Richtlinie 2.1").
        head = derived.split(",", 1)[0].strip()
        if head and head != derived:
            names.append(head)
    if member:
        # The three spellings the prompt's own family line and the office use
        # for a part of a Richtlinie. Exact names, each — `_matches` still
        # refuses "OIB 2" for OIB 2.1, because the member number is the name.
        names += [f"OIB {member}", f"OIB-RL {member}", f"OIB-Richtlinie {member}"]
    seen: set[str] = set()
    unique: list[str] = []
    for name in names:
        if name.strip() and name.casefold() not in seen:
            seen.add(name.casefold())
            unique.append(name)
    return unique


def _matches(document: Any, wanted: str) -> bool:
    """Whether ``wanted`` IS one of this document's names.

    Exact, up to case and surrounding whitespace, and nothing else. A locator
    that accepts a substring is a search with one candidate and no ranking:
    "OIB-Richtlinie 2" would silently open "OIB-Richtlinie 2.3".
    """
    return any(name.strip().casefold() == wanted for name in _document_names(document))


async def _documents_in(collection: str) -> list[Any]:
    """The documents registered for one collection; empty on any store error."""
    from aiq_agent.knowledge.factory import get_available_documents_async

    try:
        return await get_available_documents_async(collection)
    except Exception:  # noqa: BLE001 — one unreachable collection must not refuse the rest
        logger.warning("read_passage: document listing failed for %s", collection, exc_info=True)
        return []


async def _resolve_targets(entries: list[Any], document: str) -> list[PassageTarget]:
    """Every (collection, file) in scope whose document IS ``document``.

    Usually one. More than one is the ambiguous-filename case a search already
    handles: the same name on two shelves is two documents, and both are read so
    the formatter can qualify their citation keys rather than this tool picking
    a shelf the caller did not name.
    """
    wanted = document.strip().casefold()
    if not wanted:
        return []
    listings = await asyncio.gather(*(_documents_in(entry.collection) for entry in entries))
    targets: list[PassageTarget] = []
    for entry, docs in zip(entries, listings, strict=True):
        shelf = getattr(entry, "shelf", None)
        for candidate in docs:
            if not _matches(candidate, wanted):
                continue
            targets.append(
                PassageTarget(
                    collection=entry.collection,
                    file_name=str(getattr(candidate, "file_name", "")),
                    shelf=str(shelf) if shelf is not None else None,
                    current=_current_revision(candidate, docs),
                )
            )
    return targets
