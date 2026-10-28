"""Folder cards, tier 1: a written abstract per folder, built bottom-up only when something changed (ADR-0127).

Tier 0 (counts, Dokumentart mix, current Fassung) is computed live by
``knowledge_layer.browse.folder_cards`` and costs nothing. Tier 1 is this package:

* :func:`mark_files` / :func:`mark_folders` are the hooks. ``knowledge/factory.py``
  calls them where every change to a document's facts already arrives
  (``_mirror_facts``, so ``register_summary`` and every retag, reclassification and
  move; the folder rewrite; the delete). Each marks the folder and its ancestors in
  ``queue``, and never raises.
* ``worker.run_once`` claims the folders that went quiet, deepest first, and builds
  each card (``inputs`` → ``build`` → the BFF route through ``client``), skipping a
  folder whose input hash did not change and stopping the climb when the new abstract
  is the old one. A card that exists is updated from the diff of its inputs against
  the manifest it was written from (``incremental``), with a full rebuild as the
  safety net. Under a per-organization monthly token budget.
* :func:`listing_abstracts` is what ``list_files(view="tree")`` reads.

All of it is behind the ``folder-cards`` WorkOS flag, per organization (an
entitlement, off until an operator targets the organization; :mod:`.gate` asks the
BFF). Off, a hook marks nothing, the builder drops what is queued and the listing
makes no read.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass

from . import gate

logger = logging.getLogger(__name__)


def organization_hint(collection: str) -> str | None:
    """The organization a change to ``collection`` belongs to, from whatever this context knows.

    An ingest runs under a cost tracker that names its organization; a route runs
    with the caller's request context; an office shelf's collection names its own.
    ``None`` leaves it to ``queue.organization_of`` at build time.
    """
    try:
        from agent.common.cost_tracking import grid_cost_tracker_var

        tracker = grid_cost_tracker_var.get()
        if tracker is not None and tracker.organization_id:
            return tracker.organization_id
    except Exception:  # noqa: BLE001 — a hint, never a reason to fail
        pass
    try:
        from agent.project_context import get_organization_id_from_context

        organization_id = get_organization_id_from_context()
        if organization_id:
            return organization_id
    except Exception:  # noqa: BLE001
        pass
    try:
        from agent.common.source_kinds import office_shelf_organization_id

        return office_shelf_organization_id(collection)
    except Exception:  # noqa: BLE001
        return None


def organization_for(collection: str) -> str | None:
    """:func:`organization_hint`, then the organization the builder learned for ``collection``. Never raises."""
    hint = organization_hint(collection)
    if hint:
        return hint
    try:
        from . import queue

        return queue.organization_of(collection)
    except Exception:  # noqa: BLE001
        return None


def enabled_for_collection(collection: str) -> bool:
    """Whether the organization ``collection`` belongs to has the ``folder-cards`` flag. Never raises.

    An organization nobody can name has no cards: a mark made without one is found
    by the nightly reconcile, which knows the organization of every collection it saw.
    """
    return gate.enabled_for(organization_for(collection))


def mark_folders(collection: str, folder_paths: Iterable[str | None]) -> None:
    """Mark these folders and every folder above them dirty. Never raises."""
    paths = [path for path in folder_paths if path and path.strip("/")]
    if not paths:
        return
    try:
        organization_id = organization_for(collection)
        if not gate.enabled_for(organization_id):
            return
        from . import queue

        queue.mark(collection, paths, organization_id)
    except Exception:  # noqa: BLE001 — a card is derived; a lost mark is found by the reconcile
        logger.warning("folder cards: could not mark %s in %s", paths, collection, exc_info=True)


def mark_files(collection: str, file_names: Sequence[str] | None, store=None) -> None:
    """Mark the folders these files are filed in. Never raises."""
    if not file_names or not enabled_for_collection(collection):
        return
    try:
        if store is None:
            from agent.knowledge.factory import _get_document_metadata_store

            store = _get_document_metadata_store()
        mark_folders(collection, store.get_folder_paths_batch(collection, list(file_names)).values())
    except Exception:  # noqa: BLE001
        logger.warning("folder cards: could not mark the folders of %d file(s)", len(file_names), exc_info=True)


@dataclass(frozen=True)
class ListedAbstract:
    """What a tree listing shows of one card."""

    abstract: str
    status: str
    generated_at: str | None


async def listing_abstracts(collections: Sequence[str]) -> dict[tuple[str, str], ListedAbstract]:
    """The written abstracts of these collections' folders, by ``(collection, folder_path)``. Never raises.

    Read for the turn's organization only; a collection that is not its own is a
    404 the BFF answers and this drops. Each call waits at most
    ``client.READ_TIMEOUT_SECONDS``, so a slow BFF costs the listing its tier-1
    lines, never the listing.
    """
    if not collections:
        return {}
    from agent.project_context import get_organization_id_from_context

    from . import client

    organization_id = get_organization_id_from_context()
    if not organization_id or not await asyncio.to_thread(gate.enabled_for, organization_id):
        return {}

    def read(collection: str) -> dict[str, dict]:
        return client.get_cards(organization_id, collection, timeout=client.READ_TIMEOUT_SECONDS)

    replies = await asyncio.gather(
        *(asyncio.to_thread(read, collection) for collection in collections), return_exceptions=True
    )
    found: dict[tuple[str, str], ListedAbstract] = {}
    for collection, reply in zip(collections, replies, strict=True):
        if isinstance(reply, BaseException):
            logger.info("folder cards: none read for %s: %s", collection, reply)
            continue
        for path, card in reply.items():
            abstract = " ".join(str(card.get("abstract") or "").split())
            if abstract:
                found[(collection, path)] = ListedAbstract(
                    abstract, str(card.get("status") or "fresh"), card.get("generated_at")
                )
    return found
