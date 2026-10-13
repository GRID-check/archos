"""Copy what Chroma holds into Qdrant, and repair drift between the two (ADR-0104).

Chroma stores every chunk's id, text, metadata AND its embedding, so the copy
re-parses nothing, calls no vision model and embeds nothing: each page of
``collection.get`` becomes a page of inserts. Point ids are the chunk ids and a
chunk id names immutable content, so a re-run inserts only what is missing and
the copy is idempotent.

The same module repairs what ``dual`` mode logs and moves on from:

* :func:`backfill_scope` inserts every chunk Chroma has and Qdrant lacks,
  leaving the points ingestion wrote as they are;
* :func:`prune_scope` deletes points whose chunk Chroma no longer has;
* :func:`orphan_scopes` finds scopes Qdrant holds and Chroma no longer does;
* :func:`verify_scope` compares the two id sets, not only their sizes;
* :func:`refresh_scope_facts` merges the person-set facts from the metadata store.

``scripts/backfill_qdrant.py`` is the command line around it.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Iterable
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from . import mirror
from .mirror import enrichment
from .mirror import records_from_chroma
from .schema import Physical
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
    #: Chunks one store holds and the other lacks, by id (``verify_scope``).
    missing: int = 0
    extra: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def in_step(self) -> bool:
        return (
            self.chroma_count is not None
            and self.chroma_count == self.qdrant_count
            and self.missing == 0
            and self.extra == 0
        )


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
    """Insert every chunk of one Chroma collection that ``scope`` lacks, and bring the rest up to date.

    Insert-only (``QdrantStore.upsert(insert_only=True)``): a point ingestion
    already wrote keeps its payload, including the office, project and BFF
    document ids the backfill cannot know; only the fields the chunk alone
    decides are merged onto it. The person-set facts are then merged onto
    every file (:func:`refresh_scope_facts`), so a full run leaves them in step too.
    """
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
            report.written += store.upsert(scope, file_records, {**base, **facts.get(file_name, {})}, insert_only=True)
    if not dry_run:
        _apply_facts(scope, store, facts)
    return report


def prune_scope(handle: Any, scope: str, store: QdrantStore, *, dry_run: bool = False) -> int:
    """Delete the points of ``scope`` whose chunk Chroma no longer holds; returns how many.

    Qdrant is read FIRST. Ingestion writes Chroma before it mirrors, so a
    chunk that lands while this runs is in Chroma by the time it can be in
    Qdrant: read in this order, a new point is either absent from the
    Qdrant snapshot or present in the Chroma one, and never pruned. Read the
    other way round, a file ingested between the two reads was deleted.
    """
    qdrant_ids = list(store.chunk_ids(scope))
    chroma_ids = _chroma_ids(handle)
    stale = [chunk_id for chunk_id in qdrant_ids if chunk_id not in chroma_ids]
    if stale and not dry_run:
        for start in range(0, len(stale), 512):
            store.delete_chunks(scope, stale[start : start + 512])
    return len(stale)


def _chroma_ids(handle: Any) -> set[str]:
    return {str(chunk_id) for page in _pages(handle, 2048, []) for chunk_id in page.get("ids") or []}


#: Up to this many chunks on either side, :func:`verify_scope` compares the
#: whole id sets; above it, a random sample of each side is looked up in the other.
VERIFY_FULL_LIMIT = 200_000
#: Ids sampled from each side above :data:`VERIFY_FULL_LIMIT`.
VERIFY_SAMPLE = 4096


@dataclass
class Verification:
    """How one collection compares between the stores."""

    chroma_count: int
    qdrant_count: int
    #: Chunks Chroma holds and Qdrant lacks (in the sample, when ``sampled``).
    missing: int
    #: Points Qdrant holds whose chunk Chroma lacks (in the sample, when ``sampled``).
    extra: int
    sampled: bool = False


def verify_scope(
    handle: Any,
    scope: str,
    store: QdrantStore,
    *,
    full_limit: int = VERIFY_FULL_LIMIT,
    sample: int = VERIFY_SAMPLE,
) -> Verification:
    """Compare one collection's chunk ids in both stores, not only their counts.

    Equal counts over different sets (a point missing, a stale one in its
    place) are a gap a count cannot see. Up to ``full_limit`` chunks the sets
    are compared whole, which reads ids only; above it ``sample`` ids from
    each side are looked up in the other, so a large collection costs a
    bounded number of requests.
    """
    chroma_count, qdrant_count = int(handle.count()), store.count(scope)
    if max(chroma_count, qdrant_count) <= full_limit:
        qdrant_ids = set(store.chunk_ids(scope))
        chroma_ids = _chroma_ids(handle)
        return Verification(chroma_count, qdrant_count, len(chroma_ids - qdrant_ids), len(qdrant_ids - chroma_ids))
    chroma_sample = _sample_chroma_ids(handle, chroma_count, sample)
    missing = len(store.missing_chunk_ids(scope, chroma_sample))
    qdrant_sample = store.sample_chunk_ids(scope, sample)
    present = {str(chunk_id) for chunk_id in (handle.get(ids=qdrant_sample, include=[]).get("ids") or [])}
    extra = sum(1 for chunk_id in qdrant_sample if chunk_id not in present)
    return Verification(chroma_count, qdrant_count, missing, extra, sampled=True)


def _sample_chroma_ids(handle: Any, count: int, sample: int, page: int = 256) -> list[str]:
    """About ``sample`` ids of a Chroma collection, read as pages at random offsets."""
    rng = random.Random()
    ids: dict[str, None] = {}
    for _ in range(max(1, sample // page)):
        offset = rng.randrange(max(1, count - page + 1))
        ids.update(
            dict.fromkeys(str(chunk_id) for chunk_id in handle.get(include=[], limit=page, offset=offset)["ids"])
        )
    return list(ids)


def orphan_scopes(store: QdrantStore, chroma_names: Iterable[str], qdrant_scopes: Iterable[str]) -> list[str]:
    """Scopes Qdrant holds points of and Chroma has no collection for.

    A failed ``delete_collection`` mirror, or a conversation scope Chroma's
    reaper dropped, leaves them behind, and a backfill driven by Chroma's
    collection list never visits them. ``qdrant_scopes`` must be read BEFORE
    ``chroma_names``, as in :func:`prune_scope`: ingestion creates the Chroma
    collection first, so a scope born between the reads is in the Chroma list.
    """
    known = set(chroma_names)
    return sorted(scope for scope in set(qdrant_scopes) if scope not in known)


def qdrant_scopes(store: QdrantStore) -> list[str]:
    """Every scope with at least one point, over both physical collections."""
    return [scope for physical in Physical for scope in store.scopes(physical)]


def refresh_scope_facts(scope: str, store: QdrantStore, *, dry_run: bool = False) -> int:
    """Merge every file's person-set facts onto its points; returns the files touched."""
    facts = mirror.facts_by_file(scope)
    if not dry_run:
        _apply_facts(scope, store, facts)
    return len(facts)


def _apply_facts(scope: str, store: QdrantStore, facts: Mapping[str, Mapping[str, Any]]) -> None:
    """Merge (never overwrite) ``facts`` onto their files, and put a file's own Dokumentart back when none is stored."""
    store.set_file_payloads(scope, facts)
    for file_name, values in facts.items():
        if "doc_class" not in values:
            store.restore_chunk_doc_class(scope, file_name)
