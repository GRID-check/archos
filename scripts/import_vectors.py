"""Load a ``piloti-vectors/1`` export into Qdrant, without re-embedding (ADR-0111).

The second half of the move off Chroma: ``deploy/migration/chroma_export.py``
wrote the export beside Chroma, and this reads it with nothing of Chroma
installed (the format: ``deploy/migration/README.md``). Point ids are the
chunk ids and every write is insert-only, so a re-run adds what is missing,
leaves what ingestion wrote (its office, project and document ids) in place,
and finishes a run that stopped halfway.

    python scripts/import_vectors.py --in /exchange/export --dry-run     # read and check everything, write nothing
    python scripts/import_vectors.py --in /exchange/export --verify      # import every collection, then compare ids
    python scripts/import_vectors.py --in /exchange/export --collection oib_knowledge
    python scripts/import_vectors.py --in /exchange/export --prune --verify
    python scripts/import_vectors.py --in /exchange/export --verify-only

Without ``--collection``, the scopes Qdrant holds and the export does not are
found too: ``--prune`` deletes them, ``--verify`` counts them as out of step.
``--prune`` treats the export as the whole truth: run it only before the new
release takes writes, or it deletes what was uploaded since the export.

Each collection's vectors must come from the embedder the Qdrant collection
was created with (``aiq:embed_fingerprint``); a mismatch refuses the run
before anything is written. A collection the export names no embedder for
takes the configured one (``AIQ_EMBED_MODEL``, ``AIQ_EMBED_BASE_URL``). It
reads ``AIQ_QDRANT_URL``, ``AIQ_QDRANT_API_KEY`` and, for the person-set
facts, the metadata store's settings, as the backend does.

EXIT CODES: ``0`` done and, with ``--verify``, every collection in step;
``1`` a collection failed or, with ``--verify``, differs (run it again);
``2`` Qdrant unreachable, or the export invalid, incomplete or refused.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Mapping
from pathlib import Path

from knowledge_layer.qdrant import import_vectors
from knowledge_layer.qdrant.import_vectors import Export
from knowledge_layer.qdrant.import_vectors import InvalidExport
from knowledge_layer.qdrant.import_vectors import ScopeReport
from knowledge_layer.qdrant.store import QdrantStore
from knowledge_layer.qdrant.store import make_client

logger = logging.getLogger("import_vectors")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--in", dest="export", type=Path, required=True, help="The export directory.")
    parser.add_argument("--collection", action="append", help="Only this collection (repeatable).")
    parser.add_argument("--dry-run", action="store_true", help="Read and check the export; write nothing.")
    parser.add_argument("--prune", action="store_true", help="Delete Qdrant points and scopes the export lacks.")
    parser.add_argument("--verify", action="store_true", help="Compare chunk ids per collection; exit 1 on a gap.")
    parser.add_argument("--verify-only", action="store_true", help="Only compare; import nothing.")
    args = parser.parse_args(argv)
    args.verify = args.verify or args.verify_only
    return args


def _configured_identity() -> dict[str, str]:
    """The embedder this deployment is configured for: the fallback for a collection the export names none for."""
    from knowledge_layer.llamaindex.adapter import embed_fingerprint_metadata

    return embed_fingerprint_metadata(
        os.environ.get("AIQ_EMBED_MODEL", "openai/text-embedding-3-large"),
        os.environ.get("AIQ_EMBED_BASE_URL", "https://openrouter.ai/api/v1"),
    )


def _run_one(
    export: Export, store: QdrantStore, name: str, identity: Mapping[str, str], args: argparse.Namespace
) -> ScopeReport:
    scoped = QdrantStore(store.client, identity)
    if args.verify_only:
        report, ids = ScopeReport(name), export.id_set(name)
    else:
        report, ids = import_vectors.import_scope(export, name, scoped, dry_run=args.dry_run)
    if args.prune:
        report.pruned = import_vectors.prune_scope(ids, name, scoped, dry_run=args.dry_run)
    if args.verify:
        verification = import_vectors.verify_scope(ids, name, scoped)
        report.export_count, report.qdrant_count = verification.export_count, verification.qdrant_count
        report.missing, report.extra, report.sampled = verification.missing, verification.extra, verification.sampled
    return report


def _orphans(store: QdrantStore, scopes: list[str], names: list[str], args: argparse.Namespace) -> list[ScopeReport]:
    """A report per scope Qdrant holds and the export does not: pruned with ``--prune``, a gap under ``--verify``."""
    reports = []
    for scope in import_vectors.orphan_scopes(names, scopes):
        report = ScopeReport(scope, export_count=0, qdrant_count=store.count(scope))
        if args.prune:
            report.pruned = report.qdrant_count
            if not args.dry_run:
                store.delete_scope(scope)
                report.qdrant_count = store.count(scope)
        reports.append(report)
    return reports


def _log(report: ScopeReport, gap: bool) -> None:
    logger.info(
        "%s %s: read=%d written=%d pruned=%d export=%s qdrant=%s missing=%d extra=%d%s",
        "[gap]" if gap else "[ok]",
        report.scope,
        report.read,
        report.written,
        report.pruned,
        report.export_count,
        report.qdrant_count,
        report.missing,
        report.extra,
        " (sampled)" if report.sampled else "",
    )


def _open(args: argparse.Namespace) -> tuple[Export, list[str]]:
    export = Export.open(args.export)
    names = sorted(set(args.collection)) if args.collection else sorted(export.collections)
    unknown = [name for name in names if name not in export.collections]
    if unknown:
        raise InvalidExport(f"the export holds no collection {', '.join(unknown)}")
    return export, names


def _fallback_identity(export: Export, names: list[str]) -> dict[str, str] | None:
    """The configured embedder, read only when a collection's own fingerprint is missing from the export."""
    if all(export.collections[name].has_identity for name in names):
        return None
    return _configured_identity()


def _refused(store: QdrantStore, export: Export, names: list[str], fallback: Mapping[str, str] | None) -> bool:
    refusals = import_vectors.identity_refusals(store, export, names, fallback)
    for name, reason in refusals.items():
        logger.error("[refused] %s: %s", name, reason)
    return bool(refusals)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per Qdrant request otherwise
    args = _parse_args(argv)
    try:
        export, names = _open(args)
    except InvalidExport as exc:
        logger.error("Invalid export: %s", exc)
        return 2
    try:
        client = make_client()
        client.get_aliases()
        store = QdrantStore(client)
        scopes = [] if args.collection else import_vectors.qdrant_scopes(store)
    except Exception as exc:  # noqa: BLE001 - an unreachable Qdrant is the same hard stop whatever the cause
        logger.error("Could not reach Qdrant: %s", exc)
        return 2
    fallback = _fallback_identity(export, names)
    if _refused(store, export, names, fallback):
        logger.error("Nothing written: the export's embedder does not match Qdrant's")
        return 2
    logger.info("Export of %s (Chroma %s): %d collection(s)", export.created_at, export.chroma_version, len(names))

    failed = invalid = 0
    for name in names:
        try:
            report = _run_one(export, store, name, export.collections[name].identity(fallback), args)
        except InvalidExport as exc:
            invalid += 1
            logger.error("[invalid] %s: %s", name, exc)
            continue
        except Exception as exc:  # noqa: BLE001 - one collection failing never stops the rest
            failed += 1
            logger.error("[fail] %s: %s", name, exc)
            continue
        gap = args.verify and not report.in_step
        failed += int(gap)
        _log(report, gap)
    failed += _report_orphans(store, scopes, names, args)
    logger.info(
        "Done: %d collection(s), %d failed or out of step, %d invalid%s",
        len(names),
        failed,
        invalid,
        " (dry run)" * args.dry_run,
    )
    return 2 if invalid else 1 if failed else 0


def _report_orphans(store: QdrantStore, scopes: list[str], names: list[str], args: argparse.Namespace) -> int:
    """Log the scopes only Qdrant holds; returns how many count as failed."""
    try:
        orphans = _orphans(store, scopes, names, args)
    except Exception as exc:  # noqa: BLE001 - reported like a failed collection
        logger.error("[fail] scopes only Qdrant holds: %s", exc)
        return 1
    failed = 0
    for report in orphans:
        gap = args.verify and bool(report.qdrant_count)
        failed += int(gap)
        _log(report, gap)
    return failed


if __name__ == "__main__":
    sys.exit(main())
