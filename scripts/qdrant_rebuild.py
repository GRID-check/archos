"""Rebuild a Qdrant collection as a new _vN beside the live one, then move its alias (ADR-0115).

Open-source Qdrant cannot reshard, so a new shard count or replication shape is
a new collection, a copy of the stored vectors (no re-embedding) and one atomic
alias switch. The old collection stays: switching back is the rollback.

    python scripts/qdrant_rebuild.py office --copy-to piloti_office_v2 --shards 12
    python scripts/qdrant_rebuild.py office --switch-to piloti_office_v2      # then backfill --prune --verify
    python scripts/qdrant_rebuild.py office --switch-to piloti_office_v1      # rollback

A copy also tunes the BM25 channel to the chunks it copies: it measures their
mean length and, when that is more than 10 % from the live collection's
``avg_len``, recomputes every lexical vector with the measured one (ADR-0127).
``--bm25-avg-len``, ``--bm25-k`` and ``--bm25-b`` set the values outright (a
parity sweep's result); ``--keep-bm25`` copies the lexical vectors as stored.
``scripts/qdrant_chunk_length_stats.py`` shows the measurement without copying.

It reads the environment the backend reads: ``AIQ_QDRANT_URL`` and
``AIQ_QDRANT_API_KEY``. The full procedure is ``docs/deployment/qdrant-runbook.md``.

EXIT CODES: ``0`` done (a copy with equal counts); ``1`` the copy's counts
differ, or the target is refused; ``2`` Qdrant could not be reached.
"""

from __future__ import annotations

import argparse
import logging
import sys

from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.schema import Physical
from knowledge_layer.qdrant.store import make_client

logger = logging.getLogger("qdrant_rebuild")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("physical", choices=[p.value for p in Physical], help="Which physical collection.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--copy-to", metavar="NAME", help="Create NAME and copy the live collection into it.")
    action.add_argument("--switch-to", metavar="NAME", help="Point the alias at NAME (also the rollback).")
    parser.add_argument("--shards", type=int, help="Shard count of the new collection (office only).")
    parser.add_argument("--replication", type=int, help="Replication factor of the new collection.")
    parser.add_argument("--page-size", type=int, default=rebuild.DEFAULT_PAGE_SIZE)
    bm25 = parser.add_argument_group("BM25 length normalisation of the new collection")
    bm25.add_argument("--bm25-avg-len", type=float, help="avg_len outright, instead of the measured mean.")
    bm25.add_argument("--bm25-k", type=float, help="k (term saturation); default: the live collection's.")
    bm25.add_argument("--bm25-b", type=float, help="b (length normalisation); default: the live collection's.")
    bm25.add_argument("--keep-bm25", action="store_true", help="Copy the lexical vectors as stored; measure nothing.")
    return parser.parse_args(argv)


def _bm25_length(client, live: str, args: argparse.Namespace) -> dict[str, float] | None:
    """The new collection's BM25 length when one is given on the command line, else None (measure, or keep)."""
    if args.keep_bm25 or (args.bm25_avg_len is None and args.bm25_k is None and args.bm25_b is None):
        return None
    source = schema.bm25_length_of(client.get_collection(live).config.metadata)
    measured = None if args.bm25_avg_len is not None else rebuild.measure_lengths(client, live)
    return rebuild.tuned_length(measured, source, k=args.bm25_k, b=args.bm25_b, avg_len=args.bm25_avg_len)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    args = _parse_args(argv)
    physical = Physical(args.physical)
    try:
        client = make_client()
        live = rebuild.current_collection(client, physical)
    except Exception as exc:  # noqa: BLE001 - unreachable and alias-less are the same hard stop
        logger.error("Could not read the alias from Qdrant: %s", exc)
        return 2
    logger.info("%s is %s", physical.value, live)
    try:
        if args.switch_to:
            previous = rebuild.switch_alias(client, physical, args.switch_to)
            logger.info("Switched; roll back with --switch-to %s", previous)
            return 0
        report = rebuild.copy_collection(
            client,
            physical,
            args.copy_to,
            shards=args.shards,
            replication=args.replication,
            page_size=args.page_size,
            bm25_length=_bm25_length(client, live, args),
            retune_bm25=not args.keep_bm25,
        )
    except (ValueError, RuntimeError) as exc:
        logger.error("%s", exc)
        return 1
    logger.info(
        "%s %s -> %s: copied=%d source=%d target=%d",
        "[ok]" if report.complete else "[gap]",
        report.source,
        report.target,
        report.copied,
        report.source_count,
        report.target_count,
    )
    logger.info("BM25 length %s (%s)", report.bm25_length, "recomputed" if report.relexed else "copied as stored")
    return 0 if report.complete else 1


if __name__ == "__main__":
    sys.exit(main())
