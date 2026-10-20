"""What the operator rewrite of payload keys changes on one point (``schema.LEGACY_FIELDS``).

Points written before the English rename hold ``punkt_id``, ``richtlinie``, ``chunking: "punkt"`` and a
``project_facts`` object with German keys and tokens. :func:`rewrite_payload` says what to write and
what to delete so the point reads exactly as a freshly ingested one. It is pure; the batching, the
dry run and the verification live in ``scripts/qdrant_rename_payload_keys.py``, and the procedure is
``docs/deployment/qdrant-payload-rename-runbook.md``.

Delete this module, the script and the runbook section with the read fallback once the rewrite has run on
every collection.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Iterator
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client import models

from aiq_agent.profile_names import normalize_profile_token

from .schema import FACT_KEYS
from .schema import INDEXED_FIELDS
from .schema import LEGACY_CHUNKING
from .schema import LEGACY_FIELDS
from .schema import PROJECT_FACTS_FIELD
from .schema import ensure_payload_indexes

_FACTS_PREFIX = f"{PROJECT_FACTS_FIELD}."


@dataclass(frozen=True)
class PayloadRewrite:
    """Fields to set on a point, then top-level keys to delete from it (in that order, so a crash keeps both)."""

    set: dict[str, Any]
    delete: tuple[str, ...]

    @property
    def fields(self) -> tuple[str, ...]:
        """The names this rewrite touches, for a dry run's tally."""
        return (*self.set, *self.delete)


def _english_token(key: str, value: Any) -> Any:
    if isinstance(value, str):
        return normalize_profile_token(key, value)
    if isinstance(value, list):
        return [_english_token(key, item) for item in value]
    return value


def _facts(facts: Mapping[str, Any]) -> dict[str, Any] | None:
    """The ``project_facts`` object under its English keys and tokens; None when it already is."""
    legacy_leaves = {
        new: old.removeprefix(_FACTS_PREFIX) for new, old in LEGACY_FIELDS.items() if old.startswith(_FACTS_PREFIX)
    }
    if not any(old in facts for old in legacy_leaves.values()):
        return None
    rebuilt: dict[str, Any] = {}
    for key in FACT_KEYS:
        old = legacy_leaves[f"{_FACTS_PREFIX}{key}"]
        if key in facts:
            rebuilt[key] = facts[key]
        elif old in facts:
            rebuilt[key] = _english_token(key, facts[old])
    return rebuilt


def rewrite_payload(payload: Mapping[str, Any]) -> PayloadRewrite | None:
    """The rewrite that brings ``payload`` to the English spelling, or None when it already is.

    The English key wins over a legacy one on the same point (a re-ingest wrote it after the rename), and
    the legacy key is deleted either way. Running it twice changes nothing the second time.
    """
    to_set: dict[str, Any] = {}
    to_delete: list[str] = []
    for new, old in LEGACY_FIELDS.items():
        if old.startswith(_FACTS_PREFIX) or old not in payload:
            continue
        if new not in payload:
            to_set[new] = payload[old]
        to_delete.append(old)
    inverse = {old: new for new, old in LEGACY_CHUNKING.items()}
    if payload.get("chunking") in inverse:
        to_set["chunking"] = inverse[payload["chunking"]]
    facts = payload.get(PROJECT_FACTS_FIELD)
    rebuilt = _facts(facts) if isinstance(facts, Mapping) else None
    if rebuilt is not None:
        to_set[PROJECT_FACTS_FIELD] = rebuilt
    if not to_set and not to_delete:
        return None
    return PayloadRewrite(set=to_set, delete=tuple(to_delete))


# The operator side: scripts/qdrant_rename_payload_keys.py drives these. They live here because
# only this package talks to qdrant_client (test_qdrant_import_boundary.py).

logger = logging.getLogger(__name__)


def _pages(client: QdrantClient, collection: str, page_size: int) -> Iterator[list[models.Record]]:
    offset: Any = None
    while True:
        points, offset = client.scroll(
            collection, limit=page_size, offset=offset, with_payload=True, with_vectors=False
        )
        if points:
            yield points
        if offset is None:
            return


def _operations(rewrites: dict[Any, PayloadRewrite]) -> list[Any]:
    """Every SET first, then the DELETEs grouped by key set: one request per page, in the order a crash can survive."""
    sets = [
        models.SetPayloadOperation(set_payload=models.SetPayload(payload=rewrite.set, points=[point_id]))
        for point_id, rewrite in rewrites.items()
        if rewrite.set
    ]
    by_keys: dict[tuple[str, ...], list[Any]] = {}
    for point_id, rewrite in rewrites.items():
        if rewrite.delete:
            by_keys.setdefault(rewrite.delete, []).append(point_id)
    deletes = [
        models.DeletePayloadOperation(delete_payload=models.DeletePayload(keys=list(keys), points=ids))
        for keys, ids in by_keys.items()
    ]
    return [*sets, *deletes]


def legacy_remaining(client: QdrantClient, collection: str) -> Counter[str]:
    """Points that still hold each German key (or the German ``chunking`` value), counted exactly."""
    left: Counter[str] = Counter()
    for old in dict.fromkeys(LEGACY_FIELDS.values()):
        has_key = models.Filter(must_not=[models.IsEmptyCondition(is_empty=models.PayloadField(key=old))])
        left[old] = client.count(collection, count_filter=has_key, exact=True).count
    for old in LEGACY_CHUNKING.values():
        match = models.FieldCondition(key="chunking", match=models.MatchValue(value=old))
        left[f"chunking={old}"] = client.count(collection, count_filter=models.Filter(must=[match]), exact=True).count
    return left


def rename_collection(client: QdrantClient, collection: str, *, apply: bool, page_size: int) -> int:
    """Rewrite (or, without ``apply``, count) one collection's points; returns how many points need or got it."""
    missing = sorted(INDEXED_FIELDS - set(client.get_collection(collection).payload_schema or {}))
    if apply:
        created = ensure_payload_indexes(client, collection)
        logger.info("%s: created payload indexes %s", collection, created or "(none missing)")
    else:
        logger.info(
            "%s: payload indexes missing, created by --apply (or by the next backend start): %s",
            collection,
            missing or "(none)",
        )
    tally: Counter[str] = Counter()
    seen = changed = 0
    for page in _pages(client, collection, page_size):
        rewrites = {
            point.id: rewrite for point in page if (rewrite := rewrite_payload(point.payload or {})) is not None
        }
        seen += len(page)
        changed += len(rewrites)
        for rewrite in rewrites.values():
            tally.update(rewrite.fields)
        if apply and rewrites:
            client.batch_update_points(collection, update_operations=_operations(rewrites), wait=True)
        if seen % (page_size * 20) < page_size:
            logger.info("%s: read %d points, %d %s", collection, seen, changed, "rewritten" if apply else "to rewrite")
    logger.info(
        "%s: %d points read, %d %s", collection, seen, changed, "rewritten" if apply else "would be rewritten (dry run)"
    )
    for name, count in sorted(tally.items()):
        logger.info("  %-40s %d", name, count)
    return changed
