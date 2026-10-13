"""Copy every Chroma collection into Qdrant, without re-embedding, and repair drift (ADR-0104).

Chroma holds each chunk's id, text, metadata and embedding, so this is a paged
copy: no re-parse, no vision model, no embedding call. Point ids are the chunk
ids and the copy is insert-only, so a re-run adds what is missing, leaves what
ingestion wrote (its office, project and document ids) in place, and is safe
to repeat.

    python scripts/backfill_qdrant.py --dry-run                 # read everything, write nothing
    python scripts/backfill_qdrant.py                           # copy every collection
    python scripts/backfill_qdrant.py --collection oib_knowledge
    python scripts/backfill_qdrant.py --prune --verify          # also drop stale points and scopes, then compare ids
    python scripts/backfill_qdrant.py --facts-only              # merge tags, Dokumentart, Fassung, folder

Without ``--collection``, the scopes Qdrant holds and Chroma no longer does (a
failed delete, a reaped conversation) are found too: ``--prune`` deletes them,
``--verify`` counts them as out of step.

Run it once ``AIQ_VECTOR_BACKEND=dual`` is live, so writes after the copy land
in both stores; then ``--prune --verify`` until every collection is in step,
before flipping to ``qdrant``. It reads the environment the backend reads:
``AIQ_CHROMA_URL`` (or ``AIQ_CHROMA_DIR``), ``AIQ_QDRANT_URL``,
``AIQ_QDRANT_API_KEY``, ``AIQ_SUMMARY_DB`` and the embedder settings.

EXIT CODES: ``0`` done and, with ``--verify``, every collection in step;
``1`` a collection failed or, with ``--verify``, differs; ``2`` Chroma or
Qdrant could not be reached at all.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from knowledge_layer.llamaindex.adapter import _make_chroma_client
from knowledge_layer.llamaindex.adapter import embed_fingerprint_metadata
from knowledge_layer.qdrant import backfill
from knowledge_layer.qdrant.store import QdrantStore
from knowledge_layer.qdrant.store import make_client

logger = logging.getLogger("backfill_qdrant")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--collection", action="append", help="Only this collection (repeatable).")
    parser.add_argument("--dry-run", action="store_true", help="Read and report; write nothing.")
    parser.add_argument("--prune", action="store_true", help="Delete Qdrant points and scopes Chroma no longer holds.")
    parser.add_argument("--verify", action="store_true", help="Compare chunk ids per collection; exit 1 on a gap.")
    parser.add_argument("--facts-only", action="store_true", help="Only merge person-set facts; no chunks.")
    parser.add_argument("--page-size", type=int, default=backfill.DEFAULT_PAGE_SIZE)
    parser.add_argument("--chroma-dir", default=os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data"))
    return parser.parse_args(argv)


def _collection_names(client) -> list[str]:
    names = [entry if isinstance(entry, str) else getattr(entry, "name", None) for entry in client.list_collections()]
    return sorted(name for name in names if name)


def _run_one(chroma, store: QdrantStore, name: str, args: argparse.Namespace) -> backfill.ScopeReport:
    handle = chroma.get_collection(name=name)
    report = backfill.ScopeReport(name)
    if args.facts_only:
        backfill.refresh_scope_facts(name, store, dry_run=args.dry_run)
    else:
        report = backfill.backfill_scope(handle, name, store, page_size=args.page_size, dry_run=args.dry_run)
        if args.prune:
            report.pruned = backfill.prune_scope(handle, name, store, dry_run=args.dry_run)
    if args.verify:
        verification = backfill.verify_scope(handle, name, store)
        report.chroma_count, report.qdrant_count = verification.chroma_count, verification.qdrant_count
        report.missing, report.extra = verification.missing, verification.extra
    return report


def _orphans(store: QdrantStore, scopes: list[str], names: list[str], args: argparse.Namespace) -> list:
    """A report per scope Qdrant holds and Chroma does not: pruned with ``--prune``, a gap under ``--verify``."""
    reports = []
    for scope in backfill.orphan_scopes(store, names, scopes):
        report = backfill.ScopeReport(scope, chroma_count=0, qdrant_count=store.count(scope))
        if args.prune:
            report.pruned = report.qdrant_count
            if not args.dry_run:
                store.delete_scope(scope)
                report.qdrant_count = store.count(scope)
        reports.append(report)
    return reports


def _log(report: backfill.ScopeReport, gap: bool) -> None:
    logger.info(
        "%s %s: read=%d written=%d pruned=%d chroma=%s qdrant=%s missing=%d extra=%d",
        "[gap]" if gap else "[ok]",
        report.scope,
        report.read,
        report.written,
        report.pruned,
        report.chroma_count,
        report.qdrant_count,
        report.missing,
        report.extra,
    )


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    args = _parse_args(argv)
    configured = embed_fingerprint_metadata(
        os.environ.get("AIQ_EMBED_MODEL", "openai/text-embedding-3-large"),
        os.environ.get("AIQ_EMBED_BASE_URL", "https://openrouter.ai/api/v1"),
    )
    try:
        client = make_client()
        client.get_aliases()
        # Qdrant's scopes BEFORE Chroma's collections (``backfill.orphan_scopes``).
        scopes = [] if args.collection else backfill.qdrant_scopes(QdrantStore(client, configured))
        chroma = _make_chroma_client(args.chroma_dir)
        names = args.collection or _collection_names(chroma)
    except Exception as exc:  # noqa: BLE001 - either store unreachable is the same hard stop
        logger.error("Could not reach Chroma or Qdrant: %s", exc)
        return 2

    failed = 0
    for name in names:
        try:
            identity = backfill.identity_of(chroma.get_collection(name=name), configured)
            report = _run_one(chroma, QdrantStore(client, identity), name, args)
        except Exception as exc:  # noqa: BLE001 - one collection failing never stops the rest
            failed += 1
            logger.error("[fail] %s: %s", name, exc)
            continue
        gap = args.verify and not report.in_step
        failed += int(gap)
        _log(report, gap)
    try:
        orphans = _orphans(QdrantStore(client, configured), scopes, names, args)
    except Exception as exc:  # noqa: BLE001 - reported like a failed collection
        failed += 1
        logger.error("[fail] scopes only Qdrant holds: %s", exc)
        orphans = []
    for report in orphans:
        gap = args.verify and bool(report.qdrant_count)
        failed += int(gap)
        _log(report, gap)
    logger.info(
        "Done: %d collection(s), %d scope(s) only in Qdrant, %d failed or out of step%s",
        len(names),
        len(orphans),
        failed,
        " (dry run)" * args.dry_run,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
