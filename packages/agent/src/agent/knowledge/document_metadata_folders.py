from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from agent.knowledge.document_metadata_constants import TABLE_NAME
from agent.knowledge.document_metadata_constants import logger
from agent.knowledge.document_metadata_helpers import _escape_like


def rewrite_folder_paths(store, collection: str, from_path: str, to_path: str | None) -> int:
    """Re-file a whole subtree after a folder was renamed, moved or deleted.

    The BFF's ``project_folders.path`` is materialised, so one rename rewrites
    every descendant row there (``rewriteDescendantPaths``). This is the
    mirror of that single operation: every document whose ``folder_path`` is
    ``from_path`` OR sits under ``from_path/`` gets that prefix replaced by
    ``to_path``. ``to_path`` of ``None``/``""`` re-files the subtree at the
    project root (what a delete does to the folder's direct children).

    TWO statements, in one transaction, mirroring ``rewriteDescendantPaths``
    on the BFF side: the folder itself is an equality UPDATE, and its
    descendants are a single prefix-replace over the rows that share
    ``from_path/``. A row-by-row loop would be the same result with N
    statements and a half-moved subtree if it failed part-way; nothing is
    committed here until both have run.

    The second statement is deliberately NOT a bare ``LIKE 'from_path%'``: a
    folder called ``Plan`` must not carry ``Plangrundlagen`` with it, which
    is exactly the boundary the ``/`` enforces. LIKE metacharacters in the
    caller's path are escaped for the same reason the BFF escapes them — a
    folder named ``100 % Plans`` cannot be allowed to match half the project.

    Returns the number of rows re-filed (0 when nothing was under it).
    """
    return store.rewrite_folder_paths_moved(collection, from_path, to_path)[0]


def _rename_exact(conn, collection: str, prefix: str, target: str) -> int:
    """Re-file the rows whose folder is exactly the prefix; returns how many."""
    from sqlalchemy import text

    exact = conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(f"UPDATE {TABLE_NAME} SET folder_path = :target WHERE collection = :collection AND folder_path = :prefix"),
        {"target": target or None, "collection": collection, "prefix": prefix},
    )
    return exact.rowcount or 0


def _rename_descendants(conn, collection: str, prefix: str, target: str) -> int:
    """Re-file the rows under the prefix, keeping their sub-paths; returns how many."""
    from sqlalchemy import text

    # Descendants: swap the leading ``prefix/`` for ``target/`` (or
    # strip it when the subtree lands at the root). ``substr`` is
    # 1-indexed in both SQLite and Postgres, so the cut starts one
    # past the separator; ``||`` concatenates in both.
    descendants = conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"UPDATE {TABLE_NAME} SET folder_path = :new_prefix || substr(folder_path, :cut) "
            "WHERE collection = :collection AND folder_path LIKE :pattern ESCAPE '\\'"
        ),
        {
            "new_prefix": f"{target}/" if target else "",
            "cut": len(prefix) + 2,
            "collection": collection,
            "pattern": f"{_escape_like(prefix)}/%",
        },
    )
    return descendants.rowcount or 0


def rewrite_folder_paths_moved(store, collection: str, from_path: str, to_path: str | None) -> tuple[int, list[str]]:
    """:meth:`rewrite_folder_paths`, returning the files it re-filed beside the count.

    The names are read in the same transaction as the two updates, before
    them, so they are the rows those updates move; the count is still the
    updates' own.
    """
    from sqlalchemy import text

    prefix = (from_path or "").strip().strip("/")
    if not prefix:
        return 0, []
    target = (to_path or "").strip().strip("/")

    updated = 0
    try:
        with store._sync_engine.connect() as conn:
            moved = [
                row[0]
                for row in conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection "
                        "AND (folder_path = :prefix OR folder_path LIKE :pattern ESCAPE '\\')"
                    ),
                    {"collection": collection, "prefix": prefix, "pattern": f"{_escape_like(prefix)}/%"},
                )
            ]
            updated += _rename_exact(conn, collection, prefix, target)

            updated += _rename_descendants(conn, collection, prefix, target)
            conn.commit()
    except Exception as e:
        logger.warning("Failed to rewrite folder paths under %r in %s: %s", from_path, collection, e)
        return 0, []
    logger.info("Re-filed %d document(s) from %r to %r in %s", updated, prefix, target, collection)
    return updated, moved
