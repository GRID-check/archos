"""Rewrite the German payload keys of every point in place to their English names (ADR-0115).

Points written before the rename hold ``punkt_id`` / ``punkt_path`` / ``punkt_title`` / ``punkt_parent_id`` /
``punkt_depth``, ``richtlinie``, ``chunking: "punkt"`` and a ``project_facts`` object with German keys
(``bundesland`` ...) and German tokens (``wien`` ...). New points carry the English ones, and reads accept both
(``knowledge_layer.qdrant.schema.LEGACY_FIELDS``). This script ends the "both":

    python scripts/qdrant_rename_payload_keys.py all                  # DRY RUN: counts, writes nothing
    python scripts/qdrant_rename_payload_keys.py all --apply          # create the indexes, rewrite, verify
    python scripts/qdrant_rename_payload_keys.py all --verify         # counts only; exit 1 while any legacy key is left

It reads the environment the backend reads: ``AIQ_QDRANT_URL`` and ``AIQ_QDRANT_API_KEY``. Without ``--apply`` it
writes nothing at all, not even the payload indexes. With it, per collection: the payload indexes the English
names need (idempotent, the same call the backend makes at start), then for each point one request that SETS
the English fields and one that DELETES the German keys, in that order, so an interrupted run leaves a point
readable under both names and the next run finishes it. A second run changes nothing. Vectors are not read or
written. The full procedure is ``docs/deployment/qdrant-payload-rename-runbook.md``.

EXIT CODES: ``0`` done (``--apply``: no legacy key is left; dry run: always); ``1`` legacy keys remain after
``--apply`` or under ``--verify``; ``2`` Qdrant could not be reached.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter
from collections.abc import Iterator
from typing import Any

from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant.legacy_rewrite import PayloadRewrite
from knowledge_layer.qdrant.legacy_rewrite import rewrite_payload
from knowledge_layer.qdrant.schema import INDEXED_FIELDS
from knowledge_layer.qdrant.schema import LEGACY_CHUNKING
from knowledge_layer.qdrant.schema import LEGACY_FIELDS
from knowledge_layer.qdrant.schema import Physical
from knowledge_layer.qdrant.schema import ensure_payload_indexes
from knowledge_layer.qdrant.store import make_client
from qdrant_client import QdrantClient
from qdrant_client import models

logger = logging.getLogger("qdrant_rename_payload_keys")

DEFAULT_PAGE_SIZE = 256


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("physical", choices=["all", *(p.value for p in Physical)], help="Which physical collection.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Write. Without it nothing is changed.")
    mode.add_argument("--verify", action="store_true", help="Count what is left; write nothing.")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    return parser.parse_args(argv)


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


def _legacy_remaining(client: QdrantClient, collection: str) -> Counter[str]:
    """Points that still hold each German key (or the German ``chunking`` value), counted exactly."""
    left: Counter[str] = Counter()
    for old in dict.fromkeys(LEGACY_FIELDS.values()):
        has_key = models.Filter(must_not=[models.IsEmptyCondition(is_empty=models.PayloadField(key=old))])
        left[old] = client.count(collection, count_filter=has_key, exact=True).count
    for old in LEGACY_CHUNKING.values():
        match = models.FieldCondition(key="chunking", match=models.MatchValue(value=old))
        left[f"chunking={old}"] = client.count(collection, count_filter=models.Filter(must=[match]), exact=True).count
    return left


def _report_remaining(collection: str, left: Counter[str]) -> int:
    total = sum(left.values())
    for name, count in sorted(left.items()):
        logger.info("  %-40s %d", name, count)
    logger.info("%s: %s", collection, "no legacy key left" if total == 0 else f"{total} legacy value(s) left")
    return total


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


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    args = _parse_args(argv)
    physicals = list(Physical) if args.physical == "all" else [Physical(args.physical)]
    try:
        client = make_client()
        collections = {physical: rebuild.current_collection(client, physical) for physical in physicals}
    except Exception as exc:  # noqa: BLE001 - unreachable and alias-less are the same hard stop
        logger.error("Could not read the aliases from Qdrant: %s", exc)
        return 2
    remaining = 0
    for physical, collection in collections.items():
        logger.info("%s is %s", physical.value, collection)
        if not args.verify:
            rename_collection(client, collection, apply=args.apply, page_size=args.page_size)
        if args.apply or args.verify:
            remaining += _report_remaining(collection, _legacy_remaining(client, collection))
    if not args.apply and not args.verify:
        logger.info("Dry run: nothing was written. Re-run with --apply to rewrite.")
    return 1 if remaining else 0


if __name__ == "__main__":
    sys.exit(main())
