"""Page-count backfill for documents ingested before the page count was kept.

A document's page count is written by the ingest that read it (``set_document_page_count``,
``document_metadata.page_count``). Documents ingested before that column existed have none, so the
listing cannot say "14 pages". This script fills the gap from the chunks already in Qdrant: the
highest ``page_end`` (a chunk that spans pages) or ``page_label`` among a file's chunks. It never
re-ingests, re-embeds, or touches any other column.

Run it once per environment after deploying the column, then again only if a backfill was interrupted
(documents that already have a count are skipped).

    python scripts/backfill_page_counts.py                       # dry run: prints what it would write
    python scripts/backfill_page_counts.py --apply               # writes the counts
    python scripts/backfill_page_counts.py --collection oib_knowledge --apply

A file whose chunks carry no page number (a text file, a worksheet) stays without a count: the
listing says nothing for it, which is the truth.

STORE ACCESS
------------
The summaries DB is taken from ``AIQ_SUMMARY_DB`` (default ``sqlite+aiosqlite:///./summaries.db``),
overridable with ``--summary-db``. The chunks are read from the Qdrant cluster at ``AIQ_QDRANT_URL``
(``AIQ_QDRANT_API_KEY`` when it requires one), as every other knowledge-layer read does.

EXIT CODES
----------
* ``0``: success, or a dry run.
* ``1``: an ``--apply`` run finished but at least one file could not be read or written.
* ``2``: the Qdrant store could not be reached at all, so nothing was read.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Callable
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from aiq_agent.knowledge.page_count import largest_page
from aiq_agent.knowledge.schema import AvailableDocument

logger = logging.getLogger(__name__)

DEFAULT_SUMMARY_DB = os.environ.get("AIQ_SUMMARY_DB", "sqlite+aiosqlite:///./summaries.db")

#: The chunk payload keys a page count is read from. Nothing else of a chunk is fetched.
PAGE_FIELDS = ("page_label", "page_end")

# Outcome labels for a single file.
COUNTED = "counted"
UNKNOWN = "unknown"
SKIPPED = "skipped"
FAILED = "failed"

# Reads one file's chunk payloads (``PAGE_FIELDS`` only) from the vector store.
PayloadReader = Callable[[str, str], list[Mapping[str, Any]]]
# Stores one file's page count; ``False`` when the metadata row is absent.
PageCountWriter = Callable[[str, str, int], bool]


@dataclass
class BackfillStats:
    processed: int = 0
    counted: int = 0
    unknown: int = 0
    skipped: int = 0
    failed: int = 0

    def record(self, outcome: str) -> None:
        self.processed += 1
        if outcome == COUNTED:
            self.counted += 1
        elif outcome == UNKNOWN:
            self.unknown += 1
        elif outcome == SKIPPED:
            self.skipped += 1
        elif outcome == FAILED:
            self.failed += 1


def process_document(
    collection: str,
    file_name: str,
    *,
    read_payloads: PayloadReader,
    write_count: PageCountWriter,
    apply: bool,
) -> str:
    """Count one file's pages and, with ``apply``, store the count. Returns COUNTED, UNKNOWN or FAILED.

    Fail-soft: a file that cannot be read or written is logged and counted, and the batch goes on.
    A dry run reads the chunks and reports the count, but writes nothing.
    """
    try:
        payloads = read_payloads(collection, file_name)
    except Exception as e:  # noqa: BLE001 - an outage is logged per file; the batch carries on
        logger.warning("[fail] %s/%s the vector store could not be read: %s", collection, file_name, e)
        return FAILED

    count = largest_page(payloads)
    if count is None:
        logger.info("[unknown] %s/%s has no page numbers on its chunks; no count", collection, file_name)
        return UNKNOWN
    if not apply:
        logger.info("[dry-run] %s/%s -> %d page(s)", collection, file_name, count)
        return COUNTED
    if not write_count(collection, file_name, count):
        logger.warning("[fail] %s/%s store update matched no row", collection, file_name)
        return FAILED
    logger.info("[counted] %s/%s -> %d page(s)", collection, file_name, count)
    return COUNTED


def run_backfill(
    *,
    collections: list[str],
    get_documents: Callable[[str], list[AvailableDocument]],
    read_payloads: PayloadReader,
    write_count: PageCountWriter,
    apply: bool,
) -> BackfillStats:
    """Count the pages of every file in ``collections`` that has no count yet."""
    stats = BackfillStats()
    for collection in collections:
        documents = get_documents(collection)
        logger.info("Collection %s: %d document(s)", collection, len(documents))
        for doc in documents:
            if doc.page_count is not None:
                stats.record(SKIPPED)
                continue
            stats.record(
                process_document(
                    collection,
                    doc.file_name,
                    read_payloads=read_payloads,
                    write_count=write_count,
                    apply=apply,
                )
            )
    return stats


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--collection", default=None, help="Only this collection (default: every collection).")
    parser.add_argument("--apply", action="store_true", help="Write the counts. Without it, nothing is written.")
    parser.add_argument(
        "--summary-db",
        default=DEFAULT_SUMMARY_DB,
        help="Summaries DB URL (default: $AIQ_SUMMARY_DB or sqlite+aiosqlite:///./summaries.db).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s",
        stream=sys.stdout,
    )
    args = _parse_args(argv)

    from aiq_agent.knowledge.factory import configure_summary_db
    from aiq_agent.knowledge.factory import get_available_documents
    from aiq_agent.knowledge.factory import list_summary_collections
    from aiq_agent.knowledge.factory import set_document_page_count

    configure_summary_db(args.summary_db)

    try:
        from knowledge_layer.qdrant.store import get_store

        store = get_store()
    except Exception as e:  # noqa: BLE001 - nothing can be read without the store; report and stop
        logger.error("The Qdrant store could not be reached: %s", e)
        return 2

    def read_payloads(collection: str, file_name: str) -> list[Mapping[str, Any]]:
        records = store.scroll(collection, {"file_name": file_name}, fields=list(PAGE_FIELDS))
        return [record.payload or {} for record in records]

    collections = [args.collection] if args.collection else list_summary_collections()
    if not collections:
        logger.info("No collections with summaries found. Nothing to do.")
        return 0

    stats = run_backfill(
        collections=collections,
        get_documents=get_available_documents,
        read_payloads=read_payloads,
        write_count=set_document_page_count,
        apply=args.apply,
    )
    verb = "counted" if args.apply else "would count"
    logger.info(
        "Backfill complete: processed=%d %s=%d unknown=%d skipped=%d failed=%d",
        stats.processed,
        verb,
        stats.counted,
        stats.unknown,
        stats.skipped,
        stats.failed,
    )
    return 1 if args.apply and stats.failed else 0


if __name__ == "__main__":
    sys.exit(main())
