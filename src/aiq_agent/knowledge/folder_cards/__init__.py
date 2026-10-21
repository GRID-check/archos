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

All of it is behind ``GRID_FOLDER_CARDS`` (off by default): off, a hook is one
environment read and the listing makes no call.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass

logger = logging.getLogger(__name__)

ENABLED_ENV = "GRID_FOLDER_CARDS"


def enabled() -> bool:
    return os.environ.get(ENABLED_ENV, "off").strip().lower() in ("on", "true", "1", "yes")


def organization_hint(collection: str) -> str | None:
    """The organization a change to ``collection`` belongs to, from whatever this context knows.

    An ingest runs under a cost tracker that names its organization; a route runs
    with the caller's request context; an office shelf's collection names its own.
    ``None`` leaves it to ``queue.organization_of`` at build time.
    """
    try:
        from aiq_agent.common.cost_tracking import grid_cost_tracker_var

        tracker = grid_cost_tracker_var.get()
        if tracker is not None and tracker.organization_id:
            return tracker.organization_id
    except Exception:  # noqa: BLE001 — a hint, never a reason to fail
        pass
    try:
        from aiq_agent.project_context import get_organization_id_from_context

        organization_id = get_organization_id_from_context()
        if organization_id:
            return organization_id
    except Exception:  # noqa: BLE001
        pass
    try:
        from aiq_agent.common.source_kinds import office_shelf_organization_id

        return office_shelf_organization_id(collection)
    except Exception:  # noqa: BLE001
        return None


def mark_folders(collection: str, folder_paths: Iterable[str | None]) -> None:
    """Mark these folders and every folder above them dirty. Never raises."""
    if not enabled():
        return
    paths = [path for path in folder_paths if path and path.strip("/")]
    if not paths:
        return
    try:
        from . import queue

        queue.mark(collection, paths, organization_hint(collection))
    except Exception:  # noqa: BLE001 — a card is derived; a lost mark is found by the reconcile
        logger.warning("folder cards: could not mark %s in %s", paths, collection, exc_info=True)


def mark_files(collection: str, file_names: Sequence[str] | None, store=None) -> None:
    """Mark the folders these files are filed in. Never raises."""
    if not enabled() or not file_names:
        return
    try:
        if store is None:
            from aiq_agent.knowledge.factory import _get_document_metadata_store

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
    if not enabled() or not collections:
        return {}
    from aiq_agent.project_context import get_organization_id_from_context

    from . import client

    organization_id = get_organization_id_from_context()
    if not organization_id:
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
