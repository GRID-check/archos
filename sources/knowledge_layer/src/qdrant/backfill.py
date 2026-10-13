"""Copy what Chroma holds into Qdrant, and repair drift between the two (ADR-0103).

Chroma stores every chunk's id, text, metadata AND its embedding, so the copy
re-parses nothing, calls no vision model and embeds nothing: each page of
``collection.get`` becomes a page of upserts. Point ids are the chunk ids, so
a re-run overwrites in place and the copy is idempotent.

The same module repairs what ``dual`` mode logs and moves on from:

* :func:`backfill_scope` writes every chunk Chroma has (missing or stale points);
* :func:`prune_scope` deletes points whose chunk Chroma no longer has;
* :func:`verify_scope` compares the two counts;
* :func:`refresh_scope_facts` re-copies the person-set facts from the metadata store.

``scripts/backfill_qdrant.py`` is the command line around it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from . import mirror
from .mirror import enrichment
from .mirror import records_from_chroma
from .store import QdrantStore

logger = logging.getLogger(__name__)

DEFAULT_PAGE_SIZE = 256


@dataclass
class ScopeReport:
    """What one collection's backfill did."""

    scope: str
    read: int = 0
    written: int = 0
    pruned: int = 0
    chroma_count: int | None = None
    qdrant_count: int | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def in_step(self) -> bool:
        return self.chroma_count is not None and self.chroma_count == self.qdrant_count


def identity_of(handle: Any, fallback: Mapping[str, str]) -> dict[str, str]:
    """The embedder a Chroma collection's vectors came from: its own fingerprint, else the configured one."""
    metadata = getattr(handle, "metadata", None) or {}
    fingerprint, model = metadata.get("aiq:embed_fingerprint"), metadata.get("aiq:embed_model")
    if fingerprint:
        return {"aiq:embed_fingerprint": fingerprint, "aiq:embed_model": model or "unknown"}
    return dict(fallback)


def _pages(handle: Any, page_size: int, include: list[str]):
    offset = 0
    while True:
        page = handle.get(include=include, limit=page_size, offset=offset)
        ids = page.get("ids") or []
        if not ids:
            return
        yield page
        if len(ids) < page_size:
            return
        offset += page_size


def backfill_scope(
    handle: Any, scope: str, store: QdrantStore, *, page_size: int = DEFAULT_PAGE_SIZE, dry_run: bool = False
) -> ScopeReport:
    """Upsert every chunk of one Chroma collection into ``scope``."""
    report = ScopeReport(scope)
    facts = mirror.facts_by_file(scope)
    base = enrichment(scope)
    for page in _pages(handle, page_size, ["documents", "metadatas", "embeddings"]):
        records = records_from_chroma(page)
        report.read += len(page.get("ids") or [])
        if dry_run:
            report.written += len(records)
            continue
        by_file: dict[str, list] = {}
        for record in records:
            by_file.setdefault(str(record.metadata.get("file_name") or ""), []).append(record)
        for file_name, file_records in by_file.items():
            report.written += store.upsert(scope, file_records, {**base, **facts.get(file_name, {})})
    return report


def prune_scope(handle: Any, scope: str, store: QdrantStore, *, dry_run: bool = False) -> int:
    """Delete the points of ``scope`` whose chunk Chroma no longer holds; returns how many."""
    chroma_ids = {str(chunk_id) for page in _pages(handle, 2048, []) for chunk_id in page.get("ids") or []}
    stale = [
        str((record.payload or {}).get("chunk_id"))
        for record in store.scroll(scope)
        if str((record.payload or {}).get("chunk_id")) not in chroma_ids
    ]
    if stale and not dry_run:
        for start in range(0, len(stale), 512):
            store.delete_chunks(scope, stale[start : start + 512])
    return len(stale)


def verify_scope(handle: Any, scope: str, store: QdrantStore) -> tuple[int, int]:
    """``(chunks in Chroma, points in Qdrant)`` for one collection."""
    return int(handle.count()), store.count(scope)


def refresh_scope_facts(scope: str, store: QdrantStore, *, dry_run: bool = False) -> int:
    """Re-copy every file's person-set facts onto its points; returns the files touched."""
    facts = mirror.facts_by_file(scope)
    if not dry_run:
        for file_name, values in facts.items():
            store.set_file_payload(scope, file_name, values)
    return len(facts)
