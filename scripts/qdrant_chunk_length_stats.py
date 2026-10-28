"""Measure the BM25 length of the chunks in each Qdrant collection, read-only (ADR-0127).

Qdrant's ``qdrant/bm25`` normalises a chunk's term weights by its length against
``avg_len``, counted in its own tokens (the words left after the German
analysis). This reads that length back out of the stored lexical vectors of a
sample of chunks and prints the mean and percentiles per physical collection,
next to the ``avg_len`` the collection was written with. Nothing is written.

    python scripts/qdrant_chunk_length_stats.py              # both collections
    python scripts/qdrant_chunk_length_stats.py office --sample 20000

The rebuild (``scripts/qdrant_rebuild.py --copy-to``) measures the same way and
writes the mean into the new collection; this is how to see the number first.
It reads ``QDRANT_URL`` and ``QDRANT_API_KEY`` like the backend.

EXIT CODES: ``0`` measured; ``2`` Qdrant could not be reached.
"""

from __future__ import annotations

import argparse
import logging
import sys

from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.schema import Physical
from knowledge_layer.qdrant.store import make_client

logger = logging.getLogger("qdrant_chunk_length_stats")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("physical", nargs="*", choices=[p.value for p in Physical], help="Which collections (both).")
    parser.add_argument("--sample", type=int, default=rebuild.LENGTH_SAMPLE, help="Chunks read per collection.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.WARNING, format="%(message)s", stream=sys.stderr)
    args = _parse_args(argv)
    physicals = [Physical(name) for name in args.physical] or list(Physical)
    try:
        client = make_client()
        for physical in physicals:
            live = rebuild.current_collection(client, physical)
            length = schema.effective_bm25_length(schema.bm25_length_of(client.get_collection(live).config.metadata))
            stats = rebuild.measure_lengths(client, live, args.sample)
            if stats is None:
                print(f"{physical.value} ({live}): no chunk with a lexical vector")
                continue
            tuned = rebuild.tuned_length(stats, length)
            print(f"{stats.line()}, written with {length}; a rebuild would write {tuned}")
    except Exception as exc:  # noqa: BLE001 - unreachable and alias-less are the same hard stop
        logger.error("Could not read from Qdrant: %s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
