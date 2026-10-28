"""The folder channel of a ranked ``knowledge_search``: a hit can land on a folder (ADR-0127, S11c).

Beside the chunk search, one small dense query over the folder card points of
the office scopes in the turn (``qdrant.folders``) names up to three folders
whose card matches the question. They are printed after the passages as
``Folder: <path> — <abstract>`` lines with the two calls that look inside, and
nothing else: no grounding record, no citation key, because a card is an index
and an answer cites the documents it routes to.

Behind the organization's ``folder-cards`` flag like the rest of tier 1. The query vector is the
search's own (the retriever's embedding cache answers it without a second
call), and every failure is silence: the passages are the answer, the folders a
hint.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Any

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    """The turn's organization has the ``folder-cards`` flag. Blocking (the BFF answers, then a minute's cache)."""
    from agent.knowledge.folder_cards import gate
    from agent.project_context import get_organization_id_from_context

    return gate.enabled_for(get_organization_id_from_context())


def _office_scopes(collections: Sequence[str]) -> list[str]:
    from .qdrant.schema import Physical
    from .qdrant.schema import physical_for_scope

    return [name for name in dict.fromkeys(collections) if physical_for_scope(name) is Physical.OFFICE]


def _routes(retriever: Any, scopes: list[str], query_text: str, folder: str | None, hint: str) -> str:
    from .qdrant.folders import render_folder_hits
    from .qdrant.folders import search_folders
    from .qdrant.store import get_store

    vector = retriever.embed_query(query_text)
    store = get_store(retriever.embedding_identity())
    store.check_identity(scopes[0])
    return render_folder_hits(search_folders(store, scopes, vector, folder=folder), hint)


async def folder_routes(
    retriever: Any, collections: Sequence[str], query_text: str, *, folder: str | None, hint: str
) -> str:
    """The ``Folder:`` lines for this search, or ``""``. Never raises.

    ``collections`` are the turn's searched collections; only the office ones
    have cards. ``query_text`` is what the chunk search embedded, ``hint`` the
    query as the model wrote it, for the drill-down call the lines suggest.
    """
    scopes = _office_scopes(collections)
    if not scopes or not await asyncio.to_thread(_enabled):
        return ""
    try:
        return await asyncio.to_thread(_routes, retriever, scopes, query_text, folder, hint.replace('"', "'"))
    except Exception:  # noqa: BLE001 - the passages are the answer; a folder is a hint
        logger.debug("Folder channel skipped", exc_info=True)
        return ""
