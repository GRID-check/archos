"""Rebuild a physical collection as a new ``_vN`` and move its alias (ADR-0115).

Open-source Qdrant cannot reshard or change a collection's replication shape
in place, so a changed shape is a new collection beside the live one, a copy,
and one alias switch. Every client addresses the store through the alias
(``piloti_office``, ``piloti_corpus``), so nothing else changes.

The copy is a scroll of the live collection with its stored vectors, upserted
page by page into the new one: nothing is re-embedded, and the lexical sparse
vector is copied as Qdrant computed it. Each page is an upsert by point id,
so a transient failure is retried like every other write (``store.with_retry``)
instead of leaving a half copy behind a refused target. ``init_from`` is no shortcut: Qdrant
1.19.2 accepts it and ignores it, leaving the new collection empty (drilled
2026-10-13, ``docs/deployment/qdrant-runbook.md``).

The alias moves only in :func:`switch_alias`, one request that deletes and
recreates it, which Qdrant applies atomically. The old collection is left
where it was: switching back to it is the rollback. Writes that land in the old
collection while the copy runs are not in the new one, and nothing else holds
them, so ingestion is paused for the copy (the runbook,
``docs/deployment/qdrant-runbook.md``, says how).

A rebuild is also where the BM25 channel is tuned to our chunks (ADR-0127,
S12). Qdrant's ``qdrant/bm25`` normalises a chunk's term weights by its length
against ``avg_len`` (default 256), counted in ITS tokens: words left after the
German analysis drops stopwords, about 0.30 per ``cl100k`` token on our text
(measured on 1.19.2, ``docs/deployment/qdrant-runbook.md``). :func:`measure_lengths`
reads that length back out of the stored sparse vectors, and :func:`tuned_length`
turns the mean into the target's ``avg_len``. When the target's normalisation
differs from the source's, every lexical vector is recomputed from the chunk text
(server-side BM25 inference, no embedding call); otherwise it is copied as stored.
A chunk written before the stemmed text field (``schema.TEXT_STEM_FIELD``) gets it
in the copy, so a rebuild is also that field's backfill.

``scripts/qdrant_rebuild.py`` is the command line around it.
"""

from __future__ import annotations

import logging
import math
import statistics
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client import models

from .schema import ALIASES
from .schema import BM25_DEFAULT_LENGTH
from .schema import DENSE
from .schema import LEXICAL
from .schema import TEXT_FIELD
from .schema import TEXT_STEM_FIELD
from .schema import Physical
from .schema import bm25_length_of
from .schema import create_collection
from .schema import effective_bm25_length
from .store import bm25
from .store import with_retry

logger = logging.getLogger(__name__)

DEFAULT_PAGE_SIZE = 256
#: Points whose BM25 length a measurement reads.
LENGTH_SAMPLE = 5000
#: A measured mean this close to the source's ``avg_len`` keeps the source's: rewriting
#: every lexical vector for a few percent is churn, not tuning.
AVG_LEN_TOLERANCE = 0.10


@dataclass
class RebuildReport:
    """What one copy did, and whether the two collections now hold the same number of points."""

    source: str
    target: str
    copied: int
    source_count: int
    target_count: int
    #: The target's BM25 length normalisation, and whether the lexical vectors were recomputed for it.
    bm25_length: dict[str, float] | None = None
    relexed: bool = False

    @property
    def complete(self) -> bool:
        return self.source_count == self.target_count


def current_collection(client: QdrantClient, physical: Physical) -> str:
    """The collection the physical collection's alias points at; raises when there is no alias."""
    alias = ALIASES[physical]
    for entry in client.get_aliases().aliases:
        if entry.alias_name == alias:
            return entry.collection_name
    raise RuntimeError(f"alias {alias} does not exist")


def _exact_count(client: QdrantClient, name: str) -> int:
    return client.count(name, exact=True).count


def length_from_weight(weight: float, length: Mapping[str, float]) -> float | None:
    """The BM25 length of a chunk, from the weight Qdrant stored for a term it holds once. Pure.

    Qdrant stores ``tf·(k+1) / (tf + k·(1 − b + b·dl/avg_len))`` per term; a term
    with ``tf = 1`` (every chunk has one) gives ``dl`` back. ``None`` when ``b`` is 0
    (no length in the weight) or the weight is out of range.
    """
    k, b, avg_len = (length[key] for key in ("k", "b", "avg_len"))
    if weight <= 0 or b <= 0:
        return None
    dl = (((k + 1) / weight - 1) / k - (1 - b)) * avg_len / b
    return dl if dl >= 0 else None


@dataclass(frozen=True)
class LengthStats:
    """BM25 chunk lengths of one collection (in Qdrant's tokens), read from its stored vectors."""

    collection: str
    sampled: int
    mean: float
    p50: float
    p90: float

    def line(self) -> str:
        return f"{self.collection}: {self.sampled} chunks, mean {self.mean:.0f}, p50 {self.p50:.0f}, p90 {self.p90:.0f}"


def measure_lengths(client: QdrantClient, collection: str, sample: int = LENGTH_SAMPLE) -> LengthStats | None:
    """The BM25 lengths of up to ``sample`` chunks of ``collection``, read-only; ``None`` when it holds none."""
    length = effective_bm25_length(bm25_length_of(client.get_collection(collection).config.metadata))
    found: list[float] = []
    offset = None
    while len(found) < sample:
        page, offset = client.scroll(
            collection, limit=min(DEFAULT_PAGE_SIZE, sample - len(found)), offset=offset, with_vectors=[LEXICAL]
        )
        for record in page:
            sparse = (record.vector or {}).get(LEXICAL) if isinstance(record.vector, dict) else None
            values = getattr(sparse, "values", None)
            dl = length_from_weight(min(values), length) if values else None
            if dl is not None:
                found.append(dl)
        if offset is None:
            break
    if not found:
        return None
    ordered = sorted(found)
    return LengthStats(
        collection,
        len(ordered),
        statistics.fmean(ordered),
        ordered[len(ordered) // 2],
        ordered[min(len(ordered) - 1, math.ceil(0.9 * len(ordered)) - 1)],
    )


def tuned_length(
    measured: LengthStats | None,
    source: Mapping[str, float],
    *,
    k: float | None = None,
    b: float | None = None,
    avg_len: float | None = None,
) -> dict[str, float]:
    """The BM25 length normalisation for a rebuild's target. Pure.

    ``avg_len`` is the measured mean unless given, rounded, and the source's when
    the mean is within :data:`AVG_LEN_TOLERANCE` of it; ``k`` and ``b`` are the
    source's unless given (a parity sweep sets them). An empty source keeps its own.
    """
    current = effective_bm25_length(dict(source))
    wanted = dict(current)
    if avg_len is not None:
        wanted["avg_len"] = float(avg_len)
    elif measured is not None and abs(measured.mean - current["avg_len"]) > AVG_LEN_TOLERANCE * current["avg_len"]:
        wanted["avg_len"] = float(round(measured.mean))
    if k is not None:
        wanted["k"] = float(k)
    if b is not None:
        wanted["b"] = float(b)
    return wanted


def _copied_payload(record: Any) -> dict[str, Any]:
    """The record's payload, with the stemmed copy of its text if it predates that field: the rebuild backfills it."""
    payload = dict(record.payload or {})
    if TEXT_FIELD in payload and TEXT_STEM_FIELD not in payload:
        payload[TEXT_STEM_FIELD] = payload[TEXT_FIELD]
    return payload


def _copied_vector(record: Any, relex: Mapping[str, float] | None) -> Any:
    """The record's vectors as the target takes them: as stored, or with BM25 recomputed under ``relex``."""
    if relex is None:
        return record.vector
    vector: dict[str, Any] = {DENSE: record.vector[DENSE]}
    text = str((record.payload or {}).get(TEXT_FIELD) or "")
    if text.strip():
        vector[LEXICAL] = bm25(text, relex)
    return vector


def copy_collection(
    client: QdrantClient,
    physical: Physical,
    target: str,
    *,
    shards: int | None = None,
    replication: int | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    bm25_length: Mapping[str, float] | None = None,
    retune_bm25: bool = True,
) -> RebuildReport:
    """Create ``target`` in the live collection's shape (or ``shards``/``replication``) and copy every point into it.

    Refuses a ``target`` that exists: a half-copied collection from an earlier
    attempt is dropped by a person, never overwritten here.

    The target's BM25 length normalisation is ``bm25_length`` when given, else
    :func:`tuned_length` over the measured source (``retune_bm25=False`` keeps the
    source's). When it differs from the source's, each lexical vector is
    recomputed from the chunk text; the dense vectors are always copied.
    """
    source = current_collection(client, physical)
    if target == source:
        raise ValueError(f"{target} is the live collection behind {ALIASES[physical]}")
    if client.collection_exists(target):
        raise RuntimeError(f"{target} already exists: drop it, or rebuild into the next _vN")
    info = client.get_collection(source)
    params = info.config.params
    identity = dict(info.config.metadata or {})
    source_length = bm25_length_of(identity)
    if bm25_length is not None:
        target_length = effective_bm25_length(dict(bm25_length))
    elif retune_bm25:
        target_length = tuned_length(measure_lengths(client, source), source_length)
    else:
        target_length = effective_bm25_length(source_length)
    relex = target_length if target_length != effective_bm25_length(source_length) else None
    # A collection left on Qdrant's defaults records none, as it always has.
    recorded = None if target_length == BM25_DEFAULT_LENGTH else target_length
    # The live collection's shape unless told otherwise, never the environment's:
    # the process running this need not carry the backend's QDRANT_* values.
    create_collection(
        client,
        physical,
        target,
        params.vectors[DENSE].size,
        identity,
        shards=shards or params.shard_number,
        replication=replication or params.replication_factor,
        bm25_length=recorded,
    )
    if relex is not None:
        logger.info("BM25 length %s -> %s: every lexical vector is recomputed", source_length or "default", relex)
    copied = 0
    offset = None
    while True:
        page, offset = client.scroll(source, limit=page_size, offset=offset, with_payload=True, with_vectors=True)
        if page:
            points = [
                models.PointStruct(id=record.id, vector=_copied_vector(record, relex), payload=_copied_payload(record))
                for record in page
            ]
            with_retry(f"copy into {target}", lambda: client.upsert(target, points, wait=True))
            copied += len(page)
        if offset is None:
            break
    report = RebuildReport(
        source,
        target,
        copied,
        _exact_count(client, source),
        _exact_count(client, target),
        bm25_length=target_length,
        relexed=relex is not None,
    )
    logger.info(
        "Copied %d points %s -> %s (%d vs %d)", copied, source, target, report.source_count, report.target_count
    )
    return report


def switch_alias(client: QdrantClient, physical: Physical, target: str) -> str:
    """Point the physical collection's alias at ``target`` in one atomic request; returns the previous collection."""
    alias = ALIASES[physical]
    previous = current_collection(client, physical)
    if not client.collection_exists(target):
        raise RuntimeError(f"{target} does not exist")
    client.update_collection_aliases(
        change_aliases_operations=[
            models.DeleteAliasOperation(delete_alias=models.DeleteAlias(alias_name=alias)),
            models.CreateAliasOperation(create_alias=models.CreateAlias(collection_name=target, alias_name=alias)),
        ]
    )
    logger.info("Alias %s: %s -> %s", alias, previous, target)
    return previous
