from __future__ import annotations

import json
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    pass

from aiq_agent.knowledge import document_metadata_store as facade
from aiq_agent.knowledge.document_metadata_constants import TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import logger
from aiq_agent.knowledge.document_metadata_helpers import LinkOutcome
from aiq_agent.knowledge.document_metadata_helpers import _link_lock_key
from aiq_agent.knowledge.document_metadata_helpers import _LinkRow
from aiq_agent.knowledge.document_metadata_helpers import _merged_suggestion
from aiq_agent.knowledge.document_metadata_helpers import _set_columns
from aiq_agent.knowledge.document_metadata_helpers import _with_refusal


def set_superseded_by(store, collection: str, older: str, newer: str | None) -> bool:
    """Record that a PERSON confirmed ``newer`` replaces ``older`` (sync), or lift it with ``None``.

    The link lives on the OLDER document's row, as the file name of the newer
    one in the same collection. Only a person's confirmation writes it;
    ingestion and models suggest through :meth:`set_revision_suggestion` and
    never here. A re-ingest of either file keeps it: :meth:`register` writes
    only the summary, tags and topics. Same UPDATE-only contract as
    :meth:`set_doc_class`.

    Without a loop check, so it is for lifting a link (``None``) and for
    carrying one that already exists onto another spelling. A NEW link goes
    through :meth:`link_revision`, which refuses a loop in the same transaction.
    """
    return store._update_column(collection, older, "superseded_by", newer or None)


def set_revision_suggestion(store, collection: str, filename: str, suggestion: dict[str, Any] | None) -> bool:
    """Store (or clear, with ``None``) Piloti's suggestion that ``filename`` is a newer Fassung of another.

    A suggestion, never a link: nothing hides or re-ranks a document because
    of it. A dict that is not a valid suggestion (:meth:`_normalise_suggestion`)
    is refused with ``False`` rather than stored. UPDATE-only, like the rest.

    The refusals a person made (``dismissed_of``) outlive every write here: a new
    suggestion keeps them, and one naming a refused file is stored dismissed, so
    it is not offered again. ``None`` clears the open suggestion and keeps them.
    """
    normalised = None
    if suggestion is not None:
        normalised = store._normalise_suggestion(suggestion)
        if normalised is None:
            logger.warning("Refused an invalid revision suggestion for %s", filename)
            return False
    return store._rewrite_suggestion(collection, filename, lambda stored: _merged_suggestion(stored, normalised))


def dismiss_revision_suggestion(store, collection: str, filename: str, older: str) -> bool:
    """Record that a person refused ``older`` as the Fassung ``filename`` replaces (sync).

    Added to the refusals the row already holds, so „Nein" to one file never
    undoes „Nein" to another. An open suggestion about ``older`` is marked
    dismissed; one about another file stays open. ``False`` when no row exists.
    """
    if not older.strip():
        return False
    return store._rewrite_suggestion(collection, filename, lambda stored: _with_refusal(stored, older))


def _rewrite_suggestion(
    store, collection: str, filename: str, rewrite: Callable[[dict[str, Any] | None], dict[str, Any] | None]
) -> bool:
    """Read the stored suggestion, ``rewrite`` it, and write the result back in one transaction."""
    from sqlalchemy import text

    params = {"collection": collection, "filename": filename}
    try:
        with store._sync_engine.begin() as conn:
            row = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT revision_suggestion FROM {TABLE_NAME} "
                    "WHERE collection = :collection AND filename = :filename"
                ),
                params,
            ).first()
            if row is None:
                return False
            written = rewrite(store._decode_suggestion(row[0]))
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {TABLE_NAME} SET revision_suggestion = :value "
                    "WHERE collection = :collection AND filename = :filename"
                ),
                {**params, "value": json.dumps(written) if written else None},
            )
            return True
    except Exception as e:
        logger.warning("Failed to write the revision suggestion for %s: %s", filename, e)
        return False


def link_revision(store, collection: str, older: str, newer: str) -> LinkOutcome:
    """Record that a PERSON confirmed ``newer`` replaces ``older``, refusing a loop, in one locked transaction.

    The loop check and the write are one step: two people confirming A over B
    and B over A at the same moment each read a collection with no link, and
    writing after a separate check stored both. Here the second waits for the
    first (an advisory lock per collection on Postgres, a process lock on
    SQLite) and then sees its link.

    In the same transaction: a suggestion on ``newer`` that named ``older`` is
    cleared (its refusals stay), and when ``older`` was replaced by another file
    X until now, X's change line told against ``older`` goes, because X no longer
    replaces it. ``newer`` need not have a row yet: an upload whose summary is
    still missing has the link waiting for it (:meth:`_attach_supersedes`).
    """
    if store._is_postgres():
        return store._link_revision_locked(collection, older, newer)
    with facade.DocumentMetadataStore._link_lock:
        return store._link_revision_locked(collection, older, newer)


def _link_revision_locked(store, collection: str, older: str, newer: str) -> LinkOutcome:
    from sqlalchemy import text

    from .document_revisions import would_loop

    with store._sync_engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(
                text("SELECT pg_advisory_xact_lock(CAST(:key AS bigint))"), {"key": _link_lock_key(collection)}
            )
        rows = {
            row[0]: _LinkRow(row[1], row[2], row[3])
            for row in conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT filename, superseded_by, change_basis, revision_suggestion FROM {TABLE_NAME} "
                    "WHERE collection = :collection"
                ),
                {"collection": collection},
            )
        }
        if older not in rows:
            return LinkOutcome.MISSING
        if would_loop(rows, newer=newer, older=older):
            return LinkOutcome.LOOP
        store._write_link(conn, collection, older, newer, rows)
    return LinkOutcome.LINKED


def _write_link(store, conn, collection: str, older: str, newer: str, rows: dict[str, _LinkRow]) -> None:
    """The three writes of a confirmed link, on the caller's locked transaction."""
    _set_columns(conn, collection, older, superseded_by=newer)
    previous = rows[older].superseded_by
    if previous and previous != newer and previous in rows and rows[previous].change_basis == older:
        _set_columns(conn, collection, previous, change_summary=None, change_basis=None)
    own = rows.get(newer)
    stored = store._decode_suggestion(own.revision_suggestion) if own is not None else None
    if stored is not None and stored["of"] == older and not stored["dismissed"]:
        kept = _merged_suggestion(stored, None)
        _set_columns(conn, collection, newer, revision_suggestion=json.dumps(kept) if kept else None)


def get_superseded_by_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """The confirmed ``superseded_by`` of the rows among ``filenames`` that have one."""
    return store._get_column_batch(collection, filenames, "superseded_by")


def files_linked_to(store, collection: str, newer: str) -> list[str]:
    """The rows whose stored ``superseded_by`` names ``newer``, whether or not ``newer`` has a row (sync).

    What a register or an unregister of ``newer`` changes the meaning of: the
    link counts only while ``newer`` has its row (:meth:`get_superseded_files`),
    so each of these rows reads as replaced or as current again. Fail-open to
    ``[]``.
    """
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection AND superseded_by = :newer"),
                {"collection": collection, "newer": newer},
            )
            return sorted(row[0] for row in rows)
    except Exception as e:
        logger.warning("Failed to read the files linked to %s in %s: %s", newer, collection, e)
        return []


def get_superseded_files(store, collection: str) -> dict[str, str]:
    """Every file of ``collection`` a person replaced, with the file that replaced it (sync).

    Read at search time, so the answer is the store's and a delete or an
    unlink applies to the next search. A link counts only while the newer
    document still has its row, which the same query checks. Fail-open to
    ``{}``: a search that cannot read it hides nothing.
    """
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT older.filename, older.superseded_by FROM {TABLE_NAME} older "
                    "WHERE older.collection = :collection AND older.superseded_by IS NOT NULL "
                    f"AND EXISTS (SELECT 1 FROM {TABLE_NAME} newer "
                    "WHERE newer.collection = older.collection AND newer.filename = older.superseded_by)"
                ),
                {"collection": collection},
            )
            return {row[0]: row[1] for row in rows}
    except Exception as e:
        logger.warning("Failed to read the replaced files of %s: %s", collection, e)
        return {}


def get_revision_suggestions_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """The stored ``revision_suggestion`` JSON of the rows among ``filenames`` that have one (raw text)."""
    return store._get_column_batch(collection, filenames, "revision_suggestion")
