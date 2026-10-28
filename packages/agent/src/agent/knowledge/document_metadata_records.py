from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

from agent.knowledge.document_metadata_constants import _RETAINED_COLUMNS
from agent.knowledge.document_metadata_constants import RETAINED_TABLE_NAME
from agent.knowledge.document_metadata_constants import TABLE_NAME
from agent.knowledge.document_metadata_constants import TAGS_SET_BY_PERSON
from agent.knowledge.document_metadata_constants import logger
from agent.knowledge.document_metadata_helpers import _LinkRow
from agent.knowledge.document_metadata_helpers import _person_made_facts


def register(
    store,
    collection: str,
    filename: str,
    summary: str,
    tags: list[str] | None = None,
    topics: list[str] | None = None,
) -> None:
    """Store a document summary, its controlled tags and its open topics (sync).

    Owns the ``summary`` and ``tags`` columns and NOTHING ELSE. The other
    columns on the row — ``doc_class``, ``display_title``, ``folder_path`` —
    are set by people (a reclassification, a rename, a folder move) or by the
    BFF, and re-summarising a document must not undo any of them.

    That is why both engines run the same ``ON CONFLICT … DO UPDATE`` and the
    SQLite branch no longer uses ``INSERT OR REPLACE``: replace is a DELETE
    plus an INSERT, so every column absent from the statement came back NULL.
    A re-ingest silently un-renamed and un-filed the document, and the only
    symptom was the agent describing a folder structure the user no longer
    had. ``excluded`` is spelled the same in SQLite and Postgres.

    Tags a PERSON set (``tags_set_by = 'person'``) are kept as they are: the
    classifier's fresh output replaces only its own earlier guess. Without
    this, „Erneut lesen" silently threw away every correction anybody had
    made, because the re-read re-classifies and this upsert wrote the result
    over whatever was there.

    Topics follow the same rule, on the same marker: a person's curation
    covers ``tags`` AND ``topics``. So a person who edited only the topics
    also freezes the tags (and the reverse), because the row carries one
    ``tags_set_by`` flag. That is deliberate: one "a person touched this
    row" answer, not two that a re-read could disagree with.
    """
    import json

    tags_json = json.dumps(tags) if tags else None
    topics_json = json.dumps(topics) if topics else None

    try:
        with store._sync_engine.connect() as conn:
            _upsert_metadata(conn, collection, filename, summary, tags_json, topics_json)
            store._take_back_retained(conn, collection, filename)
            conn.commit()
            logger.debug("Registered metadata for %s in %s", filename, collection)
    except Exception as e:
        logger.warning("Failed to register metadata for %s: %s", filename, e)


def _upsert_metadata(
    conn, collection: str, filename: str, summary: str, tags_json: str | None, topics_json: str | None
) -> None:
    """The one upsert :func:`register` runs, in its caller's transaction."""
    from sqlalchemy import text

    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"INSERT INTO {TABLE_NAME} (collection, filename, summary, tags, topics) "
            "VALUES (:collection, :filename, :summary, :tags, :topics) "
            "ON CONFLICT (collection, filename) DO UPDATE SET "
            "summary = excluded.summary, "
            f"tags = CASE WHEN {TABLE_NAME}.tags_set_by = :person "
            f"THEN {TABLE_NAME}.tags ELSE excluded.tags END, "
            f"topics = CASE WHEN {TABLE_NAME}.tags_set_by = :person "
            f"THEN {TABLE_NAME}.topics ELSE excluded.topics END"
        ),
        {
            "collection": collection,
            "filename": filename,
            "summary": summary,
            "tags": tags_json,
            "topics": topics_json,
            "person": TAGS_SET_BY_PERSON,
        },
    )


def _take_back_retained(store, conn, collection: str, filename: str) -> None:
    """Put the Fassung facts a reversible purge kept back onto the row, in the caller's transaction.

    A column the row already fills wins: a fact written since is newer than the one kept. The kept
    entry goes either way, so it is taken back exactly once.
    """
    from sqlalchemy import text

    params = {"collection": collection, "filename": filename}
    kept = conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"SELECT {', '.join(_RETAINED_COLUMNS)} FROM {RETAINED_TABLE_NAME} "
            "WHERE collection = :collection AND filename = :filename"
        ),
        params,
    ).first()
    if kept is None:
        return
    kept = dict(zip(_RETAINED_COLUMNS, kept, strict=True))
    if kept["superseded_by"] and store._closes_a_loop(conn, collection, filename, kept["superseded_by"]):
        # Linked meanwhile the other way round (X over this file while it was gone): that link stands.
        kept["superseded_by"] = None
    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"UPDATE {TABLE_NAME} SET "
            "superseded_by = COALESCE(superseded_by, :superseded_by), "
            "revision_suggestion = COALESCE(revision_suggestion, :revision_suggestion), "
            "change_basis = CASE WHEN change_summary IS NULL THEN :change_basis ELSE change_basis END, "
            "change_summary = COALESCE(change_summary, :change_summary) "
            "WHERE collection = :collection AND filename = :filename"
        ),
        {**params, **kept},
    )
    store._forget_retained(conn, collection, filename)
    logger.info("Took back the Fassung facts kept for %s in %s", filename, collection)


def _closes_a_loop(conn, collection: str, older: str, newer: str) -> bool:
    """Whether ``older -> newer`` would close a loop over the links the collection's rows hold now."""
    from sqlalchemy import text

    from .document_revisions import would_loop

    rows = {
        row[0]: _LinkRow(row[1], None, None)
        for row in conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(f"SELECT filename, superseded_by FROM {TABLE_NAME} WHERE collection = :collection"),
            {"collection": collection},
        )
    }
    return would_loop(rows, newer=newer, older=older)


def _forget_retained(conn, collection: str, filename: str) -> None:
    from sqlalchemy import text

    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(f"DELETE FROM {RETAINED_TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
        {"collection": collection, "filename": filename},
    )


def unregister(store, collection: str, filename: str, *, permanent: bool = False) -> None:
    """Remove a document's metadata row (sync), keeping the Fassung facts a person made unless ``permanent``.

    Most purges can be undone: an archive, the folder bin and a publish take the
    chunks and the row out and read the document again later. A link only a
    person makes must survive that, so by default the row's own link, its
    refusals and a change line told against a linked Fassung are kept under
    ``(collection, filename)`` (:data:`RETAINED_TABLE_NAME`) for the next
    :meth:`register` of the name, and the links OTHER rows hold to it stay as
    they are. While the row is gone they read as nothing: :meth:`_attach_supersedes`
    and :meth:`get_superseded_files` count a link only while both rows exist.

    ``permanent`` is a delete nobody undoes (the document is erased, or leaves the
    collection): what was kept for the name goes, and the rows it replaced are
    current again for good.
    """
    from sqlalchemy import text

    params = {"collection": collection, "filename": filename}
    try:
        with store._sync_engine.begin() as conn:
            if permanent:
                store._forget_links_to(conn, collection, filename)
            else:
                store._retain(conn, collection, filename)
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"DELETE FROM {TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
                params,
            )
        logger.debug("Unregistered metadata for %s in %s (permanent=%s)", filename, collection, permanent)
    except Exception as e:
        logger.warning("Failed to unregister metadata for %s: %s", filename, e)


def _retain(store, conn, collection: str, filename: str) -> None:
    """Keep the Fassung facts a person made on the row about to go, in the caller's transaction."""
    from sqlalchemy import text

    params = {"collection": collection, "filename": filename}
    row = conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"SELECT {', '.join(_RETAINED_COLUMNS)} FROM {TABLE_NAME} "
            "WHERE collection = :collection AND filename = :filename"
        ),
        params,
    ).first()
    kept = _person_made_facts(filename, *row) if row is not None else None
    store._forget_retained(conn, collection, filename)
    if kept is None:
        return
    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"INSERT INTO {RETAINED_TABLE_NAME} (collection, filename, {', '.join(_RETAINED_COLUMNS)}) "
            "VALUES (:collection, :filename, :superseded_by, :revision_suggestion, :change_summary, :change_basis)"
        ),
        {**params, **kept},
    )


def _forget_links_to(store, conn, collection: str, filename: str) -> None:
    """A permanent delete: nothing kept for ``filename``, and no row, kept or live, replaced by it any longer."""
    from sqlalchemy import text

    store._forget_retained(conn, collection, filename)
    for table in (TABLE_NAME, RETAINED_TABLE_NAME):
        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE {table} SET superseded_by = NULL WHERE collection = :collection AND superseded_by = :filename"
            ),
            {"collection": collection, "filename": filename},
        )


def clear_collection(store, collection: str) -> None:
    """Remove all metadata for a collection (sync)."""
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"DELETE FROM {TABLE_NAME} WHERE collection = :collection"),
                {"collection": collection},
            )
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"DELETE FROM {RETAINED_TABLE_NAME} WHERE collection = :collection"),
                {"collection": collection},
            )
            conn.commit()
            logger.debug("Cleared metadata for collection %s", collection)
    except Exception as e:
        logger.warning("Failed to clear metadata for %s: %s", collection, e)


def clear_all(store) -> None:
    """Remove all metadata rows (sync)."""
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"DELETE FROM {TABLE_NAME}"))
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"DELETE FROM {RETAINED_TABLE_NAME}"))
            conn.commit()
            logger.debug("Cleared all document metadata")
    except Exception as e:
        logger.warning("Failed to clear all document metadata: %s", e)
