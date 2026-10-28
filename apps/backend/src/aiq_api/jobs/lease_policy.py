"""What the research and ingest workers share about holding a claim (ADR-0079).

Both queues use these defaults. The BFF's claim loop
(``frontends/ui/workers/jobs/index.js``) shares max attempts and dead retention,
and drains for 60 s instead of 600 because a slice is short;
``frontends/aiq_api/tests/test_lease_policy.py`` holds both sides to that. Each
caller keeps its own floors, and its own values where the queues differ on
purpose: the stale window (research 90 s, ingest 180 s) and the per-organization
cap are product choices, not drift.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

SECONDS_PER_DAY = 86_400

#: Claims of one job before it is given up as dead.
MAX_ATTEMPTS = 3
#: How often a worker refreshes the claims it holds.
HEARTBEAT_SECONDS = 30
#: How long a stopping worker waits for its jobs before it gives them back.
DRAIN_SECONDS = 600
#: How long a dead row is kept as a trace.
DEAD_RETENTION_DAYS = 14


def int_env(name: str, default: int, *, floor: int | None = None) -> int:
    """``name`` as an int; ``default`` when unset, not a number, or below ``floor``."""
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    if floor is not None and value < floor:
        return default
    return value


def touch_liveness(path: str) -> None:
    """Write the marker file the pod's liveness probe checks the age of.

    A failed write is logged, not raised: the probe then fails on the stale file,
    which is the signal, and the loop that holds claims keeps them.
    """
    try:
        with open(path, "w") as handle:
            handle.write("ok")
    except OSError:
        logger.warning("Could not write the liveness file %s", path, exc_info=True)
