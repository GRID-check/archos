"""The folder card queue: which folders changed, when they went quiet, and who builds them (ADR-0127).

Three small tables in the agent database, beside ``document_metadata``:

* ``folder_card_queue``: one row per dirty folder, ``(collection, folder_path)``.
  :func:`mark` writes a folder and every ancestor in one statement; a second mark
  moves ``marked_at`` and keeps ``dirty_since``, so a burst of 200 uploads is one
  row per folder, not 200. :func:`claim` hands out rows that have been quiet for
  :data:`QUIET_SECONDS`, or dirty for :data:`MAX_DIRTY_SECONDS` whatever happens,
  deepest first, and never a folder while a folder below it is still queued: a
  card is built from its children's cards, so the children go first.
* ``folder_card_collections``: the organization each collection belongs to, as the
  builder learned it, and when the collection was last reconciled. The BFF route
  takes the organization in its body; a mark made outside an ingest (a folder
  move through a route) may not know it.
* ``folder_card_usage``: tokens spent per organization and month, the budget the
  builder checks before every model call.
* ``folder_card_manifests``: per card, the inputs it was written from
  (``incremental.Manifest`` as JSON), so the next build updates it from a diff. It
  lives here, beside the rest of the builder's state, rather than on the BFF's
  card row: it is the builder's bookkeeping, nothing a reader needs, and no BFF
  migration is needed for it. Lost, it costs one full rebuild.

A claim is optimistic: a conditional ``UPDATE`` that only one worker wins, so
several ingest workers can run the loop at once. A worker that dies leaves its
claim to go stale after :data:`CLAIM_STALE_SECONDS`. Plain SQL both SQLite (the
tests) and PostgreSQL speak; times are epoch seconds.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime

from aiq_agent.common.db_utils import ensure_schema

logger = logging.getLogger(__name__)

QUEUE_TABLE = "folder_card_queue"
COLLECTIONS_TABLE = "folder_card_collections"
USAGE_TABLE = "folder_card_usage"
MANIFEST_TABLE = "folder_card_manifests"

#: A folder is built once nothing marked it for this long (an import of 200 files is one build).
QUIET_SECONDS = 600
#: ... or once it has been dirty this long, however busy it stays.
MAX_DIRTY_SECONDS = 3600
#: A claim whose worker has not finished in this long is handed out again.
CLAIM_STALE_SECONDS = 900
#: Claims of one row before it is given up (the card, if any, is marked ``failed``).
MAX_ATTEMPTS = 3

_lock = threading.Lock()
_ensured: set[str] = set()


@dataclass(frozen=True)
class Claim:
    """One folder a worker now builds."""

    collection: str
    folder_path: str
    organization_id: str | None
    depth: int
    claimed_at: float
    attempts: int


def ancestors(folder_path: str) -> list[str]:
    """``a/b/c`` → ``["a/b/c", "a/b", "a"]``. The root is no folder and has no card. Pure."""
    parts = [part for part in (folder_path or "").strip().strip("/").split("/") if part]
    return ["/".join(parts[:count]) for count in range(len(parts), 0, -1)]


def parent_of(folder_path: str) -> str | None:
    """The folder above, or ``None`` at the top level. Pure."""
    chain = ancestors(folder_path)
    return chain[1] if len(chain) > 1 else None


def _depth(folder_path: str) -> int:
    return len(ancestors(folder_path))


def month_of(now: float) -> str:
    return datetime.fromtimestamp(now, tz=UTC).strftime("%Y-%m")


# ---------------------------------------------------------------------------
# Engine and schema
# ---------------------------------------------------------------------------


def db_url() -> str:
    """The agent database: the one ``document_metadata`` lives in."""
    from aiq_agent.knowledge.factory import _get_document_metadata_store

    return _get_document_metadata_store().db_url


def _engine(url: str):
    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    engine = DocumentMetadataStore._get_or_create_sync_engine(url)
    with _lock:
        if url not in _ensured:
            ensure_schema(engine, QUEUE_TABLE, _create_tables)
            _ensured.add(url)
    return engine


def _create_tables(conn) -> None:
    from sqlalchemy import Column
    from sqlalchemy import Float
    from sqlalchemy import Index
    from sqlalchemy import Integer
    from sqlalchemy import MetaData
    from sqlalchemy import String
    from sqlalchemy import Table
    from sqlalchemy import Text

    metadata = MetaData()
    Table(
        QUEUE_TABLE,
        metadata,
        Column("collection", String(255), primary_key=True),
        Column("folder_path", Text, primary_key=True),
        Column("organization_id", String(255), nullable=True),
        Column("depth", Integer, nullable=False),
        Column("dirty_since", Float, nullable=False),
        Column("marked_at", Float, nullable=False),
        Column("claimed_at", Float, nullable=True),
        Column("attempts", Integer, nullable=False, default=0),
        Index("ix_folder_card_queue_marked", "marked_at"),
    )
    Table(
        COLLECTIONS_TABLE,
        metadata,
        Column("collection", String(255), primary_key=True),
        Column("organization_id", String(255), nullable=False),
        Column("reconciled_at", Float, nullable=True),
    )
    Table(
        USAGE_TABLE,
        metadata,
        Column("organization_id", String(255), primary_key=True),
        Column("month", String(7), primary_key=True),
        Column("tokens", Integer, nullable=False, default=0),
    )
    Table(
        MANIFEST_TABLE,
        metadata,
        Column("collection", String(255), primary_key=True),
        Column("folder_path", Text, primary_key=True),
        Column("manifest", Text, nullable=False),
    )
    metadata.create_all(conn, checkfirst=True)


# ---------------------------------------------------------------------------
# Marks and claims
# ---------------------------------------------------------------------------


def mark(
    collection: str,
    folder_paths: Iterable[str],
    organization_id: str | None = None,
    *,
    with_ancestors: bool = True,
    now: float | None = None,
    url: str | None = None,
) -> int:
    """Mark each folder (and, by default, every folder above it) dirty; how many rows were written."""
    from sqlalchemy import text

    paths: set[str] = set()
    for path in folder_paths:
        chain = ancestors(path)
        paths.update(chain if with_ancestors else chain[:1])
    if not collection or not paths:
        return 0
    stamp = time.time() if now is None else now
    rows = [
        {
            "collection": collection,
            "folder_path": path,
            "organization_id": organization_id,
            "depth": _depth(path),
            "now": stamp,
        }
        for path in sorted(paths)
    ]
    statement = text(
        f"INSERT INTO {QUEUE_TABLE} "
        "(collection, folder_path, organization_id, depth, dirty_since, marked_at, claimed_at, attempts) "
        "VALUES (:collection, :folder_path, :organization_id, :depth, :now, :now, NULL, 0) "
        "ON CONFLICT (collection, folder_path) DO UPDATE SET marked_at = excluded.marked_at, "
        f"organization_id = COALESCE(excluded.organization_id, {QUEUE_TABLE}.organization_id)"
    )
    with _engine(url or db_url()).begin() as conn:
        conn.execute(statement, rows)
    return len(rows)


def _has_queued_descendant(path: str, queued: Sequence[str]) -> bool:
    prefix = f"{path}/"
    return any(other.startswith(prefix) for other in queued)


def claim(limit: int, *, now: float | None = None, url: str | None = None) -> list[Claim]:
    """Up to ``limit`` folders that are due, deepest first; each claimed by this call alone."""
    from sqlalchemy import text

    stamp = time.time() if now is None else now
    engine = _engine(url or db_url())
    with engine.begin() as conn:
        due = conn.execute(
            text(
                f"SELECT collection, folder_path, organization_id, depth, attempts FROM {QUEUE_TABLE} "
                "WHERE (claimed_at IS NULL OR claimed_at < :stale) "
                "AND (marked_at <= :quiet OR dirty_since <= :overdue) "
                "ORDER BY depth DESC, dirty_since ASC LIMIT :scan"
            ),
            {
                "stale": stamp - CLAIM_STALE_SECONDS,
                "quiet": stamp - QUIET_SECONDS,
                "overdue": stamp - MAX_DIRTY_SECONDS,
                "scan": max(1, limit) * 4,
            },
        ).fetchall()
        collections = sorted({row[0] for row in due})
        queued: dict[str, list[str]] = {name: [] for name in collections}
        for name in collections:
            queued[name] = [
                row[0]
                for row in conn.execute(
                    text(f"SELECT folder_path FROM {QUEUE_TABLE} WHERE collection = :collection"),
                    {"collection": name},
                ).fetchall()
            ]
    claims: list[Claim] = []
    for collection, path, organization_id, depth, attempts in due:
        if len(claims) >= limit:
            break
        if _has_queued_descendant(path, queued.get(collection, [])):
            continue
        with engine.begin() as conn:
            won = conn.execute(
                text(
                    f"UPDATE {QUEUE_TABLE} SET claimed_at = :now, attempts = attempts + 1 "
                    "WHERE collection = :collection AND folder_path = :path "
                    "AND (claimed_at IS NULL OR claimed_at < :stale)"
                ),
                {"now": stamp, "collection": collection, "path": path, "stale": stamp - CLAIM_STALE_SECONDS},
            ).rowcount
        if won == 1:
            claims.append(Claim(collection, path, organization_id, int(depth), stamp, int(attempts or 0) + 1))
    return claims


def finish(claim_: Claim, *, url: str | None = None) -> None:
    """The folder is built: the row goes, unless it was marked again while it was built."""
    from sqlalchemy import text

    keys = {"collection": claim_.collection, "path": claim_.folder_path, "claimed_at": claim_.claimed_at}
    with _engine(url or db_url()).begin() as conn:
        gone = conn.execute(
            text(
                f"DELETE FROM {QUEUE_TABLE} WHERE collection = :collection AND folder_path = :path "
                "AND marked_at <= :claimed_at"
            ),
            keys,
        ).rowcount
        if not gone:
            # Marked during the build: a new quiet period starts from that mark.
            conn.execute(
                text(
                    f"UPDATE {QUEUE_TABLE} SET claimed_at = NULL, attempts = 0, dirty_since = marked_at "
                    "WHERE collection = :collection AND folder_path = :path"
                ),
                keys,
            )


def fail(claim_: Claim, *, now: float | None = None, url: str | None = None) -> bool:
    """The build failed; whether the row was given up (out of attempts) rather than kept for a retry."""
    from sqlalchemy import text

    keys = {"collection": claim_.collection, "path": claim_.folder_path, "now": time.time() if now is None else now}
    with _engine(url or db_url()).begin() as conn:
        if claim_.attempts >= MAX_ATTEMPTS:
            conn.execute(
                text(f"DELETE FROM {QUEUE_TABLE} WHERE collection = :collection AND folder_path = :path"), keys
            )
            return True
        # A retry waits out a quiet period, so a provider outage is not a tight loop.
        conn.execute(
            text(
                f"UPDATE {QUEUE_TABLE} SET claimed_at = NULL, marked_at = :now "
                "WHERE collection = :collection AND folder_path = :path"
            ),
            keys,
        )
    return False


def queued(collection: str, *, url: str | None = None) -> list[tuple[str, float, float]]:
    """``(folder_path, dirty_since, marked_at)`` of a collection's rows: what is waiting, for an operator or a test."""
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        rows = conn.execute(
            text(
                f"SELECT folder_path, dirty_since, marked_at FROM {QUEUE_TABLE} "
                "WHERE collection = :collection ORDER BY folder_path"
            ),
            {"collection": collection},
        ).fetchall()
    return [(row[0], float(row[1]), float(row[2])) for row in rows]


# ---------------------------------------------------------------------------
# Which organization a collection belongs to
# ---------------------------------------------------------------------------


def remember_collection(collection: str, organization_id: str, *, url: str | None = None) -> None:
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        conn.execute(
            text(
                f"INSERT INTO {COLLECTIONS_TABLE} (collection, organization_id, reconciled_at) "
                "VALUES (:collection, :organization_id, NULL) "
                "ON CONFLICT (collection) DO UPDATE SET organization_id = excluded.organization_id"
            ),
            {"collection": collection, "organization_id": organization_id},
        )


def organization_of(collection: str, *, url: str | None = None) -> str | None:
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        row = conn.execute(
            text(f"SELECT organization_id FROM {COLLECTIONS_TABLE} WHERE collection = :collection"),
            {"collection": collection},
        ).fetchone()
    return row[0] if row else None


def collections_due_for_reconcile(
    older_than: float, *, now: float | None = None, url: str | None = None
) -> list[tuple[str, str]]:
    """``(collection, organization_id)`` not reconciled in the last ``older_than`` seconds."""
    from sqlalchemy import text

    stamp = time.time() if now is None else now
    with _engine(url or db_url()).begin() as conn:
        rows = conn.execute(
            text(
                f"SELECT collection, organization_id FROM {COLLECTIONS_TABLE} "
                "WHERE reconciled_at IS NULL OR reconciled_at < :before ORDER BY collection"
            ),
            {"before": stamp - older_than},
        ).fetchall()
    return [(row[0], row[1]) for row in rows]


def set_reconciled(collection: str, *, now: float | None = None, url: str | None = None) -> None:
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        conn.execute(
            text(f"UPDATE {COLLECTIONS_TABLE} SET reconciled_at = :now WHERE collection = :collection"),
            {"collection": collection, "now": time.time() if now is None else now},
        )


# ---------------------------------------------------------------------------
# The monthly budget
# ---------------------------------------------------------------------------


def tokens_used(organization_id: str, *, now: float | None = None, url: str | None = None) -> int:
    from sqlalchemy import text

    month = month_of(time.time() if now is None else now)
    with _engine(url or db_url()).begin() as conn:
        row = conn.execute(
            text(f"SELECT tokens FROM {USAGE_TABLE} WHERE organization_id = :organization_id AND month = :month"),
            {"organization_id": organization_id, "month": month},
        ).fetchone()
    return int(row[0]) if row else 0


def add_tokens(organization_id: str, tokens: int, *, now: float | None = None, url: str | None = None) -> None:
    from sqlalchemy import text

    if tokens <= 0:
        return
    with _engine(url or db_url()).begin() as conn:
        conn.execute(
            text(
                f"INSERT INTO {USAGE_TABLE} (organization_id, month, tokens) "
                "VALUES (:organization_id, :month, :tokens) "
                f"ON CONFLICT (organization_id, month) DO UPDATE SET tokens = {USAGE_TABLE}.tokens + excluded.tokens"
            ),
            {
                "organization_id": organization_id,
                "month": month_of(time.time() if now is None else now),
                "tokens": tokens,
            },
        )


# ---------------------------------------------------------------------------
# What each card was written from
# ---------------------------------------------------------------------------


def get_manifest(collection: str, folder_path: str, *, url: str | None = None) -> str | None:
    """The stored manifest's JSON, or ``None``."""
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        row = conn.execute(
            text(f"SELECT manifest FROM {MANIFEST_TABLE} WHERE collection = :collection AND folder_path = :path"),
            {"collection": collection, "path": folder_path},
        ).fetchone()
    return row[0] if row else None


def put_manifest(collection: str, folder_path: str, manifest: str, *, url: str | None = None) -> None:
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        conn.execute(
            text(
                f"INSERT INTO {MANIFEST_TABLE} (collection, folder_path, manifest) "
                "VALUES (:collection, :path, :manifest) "
                "ON CONFLICT (collection, folder_path) DO UPDATE SET manifest = excluded.manifest"
            ),
            {"collection": collection, "path": folder_path, "manifest": manifest},
        )


def delete_manifest(collection: str, folder_path: str, *, url: str | None = None) -> None:
    from sqlalchemy import text

    with _engine(url or db_url()).begin() as conn:
        conn.execute(
            text(f"DELETE FROM {MANIFEST_TABLE} WHERE collection = :collection AND folder_path = :path"),
            {"collection": collection, "path": folder_path},
        )
