from __future__ import annotations

from typing import TYPE_CHECKING
from typing import Any

from agent.knowledge.title_block import normalise_revision_facts

if TYPE_CHECKING:
    pass

from agent.knowledge.document_metadata_constants import TABLE_NAME
from agent.knowledge.document_metadata_constants import logger
from agent.knowledge.document_metadata_helpers import _current_doc_class
from agent.knowledge.document_metadata_helpers import _decode_page_count
from agent.knowledge.document_metadata_helpers import _encode_page_count
from agent.knowledge.document_metadata_helpers import _escape_like


def set_doc_class(store, collection: str, filename: str, doc_class: str | None) -> bool:
    """Replace only the ``doc_class`` of an existing metadata row (sync).

    The explicit "Dokumentart" seam, distinct from :meth:`register` (which
    owns the summary) and :meth:`update_tags` (which owns the tags). Follows
    the same UPDATE-only contract as :meth:`update_tags`: returns ``True``
    when a row existed and was updated, ``False`` when no metadata row exists
    for ``(collection, filename)`` — so ingestion/edit callers never create a
    summary-less, NOT NULL-violating row. A ``None`` value clears the column.
    """
    return store._update_column(collection, filename, "doc_class", _current_doc_class(doc_class))


def get_doc_class(store, collection: str, filename: str) -> str | None:
    """Return the stored explicit ``doc_class`` for a document, or ``None`` (sync).

    ``None`` covers both "no metadata row" and "row present but doc_class not
    set" — callers treat both as "no explicit class yet" and fall back to the
    filename guess.
    """
    return _current_doc_class(store._get_column(collection, filename, "doc_class"))


def get_doc_classes_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """Return stored explicit ``doc_class`` values for many documents in one query."""
    found = store._get_column_batch(collection, filenames, "doc_class")
    return {name: _current_doc_class(value) for name, value in found.items()}


def set_doc_class_suggestion(store, collection: str, filename: str, doc_class: str | None) -> bool:
    """Store (or clear, with ``None``) the decided Dokumentart a human has not confirmed.

    A suggestion, never the class: nothing reads it but the base-knowledge
    page, which offers it to the platform owner. Same UPDATE-only contract
    as :meth:`set_doc_class`.
    """
    return store._update_column(collection, filename, "doc_class_suggestion", _current_doc_class(doc_class))


def get_doc_class_suggestions_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """Stored Dokumentart suggestions for many documents in one query."""
    found = store._get_column_batch(collection, filenames, "doc_class_suggestion")
    return {name: _current_doc_class(value) for name, value in found.items()}


def set_display_title(store, collection: str, filename: str, display_title: str | None) -> bool:
    """Replace only the ``display_title`` of an existing metadata row (sync).

    The user-facing document name shown on citation chips and in the base
    corpus admin UI. Same UPDATE-only contract as :meth:`set_doc_class`:
    returns ``False`` when no metadata row exists (callers 404). A ``None``
    value clears the override so the derived default applies again.
    """
    return store._update_column(collection, filename, "display_title", display_title)


def get_display_title(store, collection: str, filename: str) -> str | None:
    """Return the stored ``display_title`` for a document, or ``None`` (sync).

    ``None`` covers both "no metadata row" and "row present but no title set";
    callers fall back to the derived default (``guess_display_title``).
    """
    return store._get_column(collection, filename, "display_title")


def get_display_titles_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """Return stored ``display_title`` values for many documents in one query."""
    return store._get_column_batch(collection, filenames, "display_title")


def set_folder_path(store, collection: str, filename: str, folder_path: str | None) -> bool:
    """Replace only the ``folder_path`` of an existing metadata row (sync).

    The materialised folder path the document is filed under
    (``Brandschutz/Fluchtwege``), denormalised from the BFF's
    ``project_folders.path`` — ADR-0049. Same UPDATE-only contract as
    :meth:`set_display_title`: returns ``False`` when no metadata row exists
    (callers 404 / skip). ``None`` clears it, which is what "filed at the
    project root" means.
    """
    return store._update_column(collection, filename, "folder_path", folder_path)


def get_folder_path(store, collection: str, filename: str) -> str | None:
    """Return the stored ``folder_path`` for a document, or ``None`` (sync).

    ``None`` covers both "no metadata row" and "row present but filed at the
    project root" — callers treat both as "no folder".
    """
    return store._get_column(collection, filename, "folder_path")


def get_folder_paths_batch(store, collection: str, filenames: list[str]) -> dict[str, str]:
    """Return stored ``folder_path`` values for many documents in one query."""
    return store._get_column_batch(collection, filenames, "folder_path")


def set_provenance(store, collection: str, filename: str, provenance: dict[str, str] | None) -> bool:
    """Replace only the ``provenance`` of an existing metadata row (sync).

    Who wrote the document and who released it (ADR-0054), stored as the
    same JSON object the chunks carry as four separate keys — one nullable
    column rather than four because nothing queries the parts, every reader
    wants the whole record, and a column per key would make the fifth key
    this record ever grows a migration instead of an edit to
    ``agent.common.provenance``.

    Same UPDATE-only contract as :meth:`set_folder_path`: returns ``False``
    when no metadata row exists, so an ingest that produced no summary never
    creates a summary-less, NOT NULL-violating row. ``None`` or an empty
    mapping clears the column, which is what "a human wrote this" means.
    """
    import json

    return store._update_column(collection, filename, "provenance", json.dumps(provenance) if provenance else None)


def get_provenance(store, collection: str, filename: str) -> dict[str, str] | None:
    """Return the stored provenance for a document, or ``None`` (sync).

    ``None`` covers "no metadata row", "row present but unmarked" and
    "stored value is not a JSON object" — every one of which means the same
    thing to a caller, and none of which is worth raising over: a document
    whose provenance cannot be read is a document with no provenance, which
    is what an unmarked human document already is.
    """
    import json

    raw = store._get_column(collection, filename, "provenance")
    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except TypeError, ValueError:
        logger.warning("Ignoring unreadable provenance for %s in %s", filename, collection)
        return None
    return decoded if isinstance(decoded, dict) else None


def set_capture(store, collection: str, filename: str, capture: dict[str, Any] | None) -> bool:
    """Replace only the ``capture`` facts of an existing metadata row (sync).

    What the camera wrote into a photo (:class:`PhotoFacts`, as its
    ``as_metadata()``): ``captured_at``, ``latitude``, ``longitude``,
    ``camera``. The coordinates are stored and read back for the BFF; they
    are never rendered into anything a model reads, which is the readers'
    rule, not this store's. Same UPDATE-only contract as
    :meth:`set_provenance`. ``None`` or an empty mapping clears the column.
    """
    import json

    return store._update_column(collection, filename, "capture", json.dumps(capture) if capture else None)


def set_revision_facts(store, collection: str, filename: str, facts: dict[str, Any] | None) -> bool:
    """Replace only the ``revision_facts`` of an existing metadata row (sync): the title block that was read.

    ``document_number``, ``revision`` (the Index as printed), ``revision_date``
    (ISO), ``scale``, ``title`` and the ``page`` they were read on, present
    keys only (:func:`~agent.knowledge.title_block.normalise_revision_facts`).
    A mapping with nothing printed in it clears the column, which is what a
    re-upload without a title block means: the old sheet's number must not
    outlive the sheet. Same UPDATE-only contract as :meth:`set_capture`.
    """
    import json

    normalised = normalise_revision_facts(facts)
    return store._update_column(
        collection, filename, "revision_facts", json.dumps(normalised, ensure_ascii=False) if normalised else None
    )


def set_reading(
    store,
    collection: str,
    filename: str,
    *,
    dossier: dict[str, Any] | None,
    references: list[dict[str, Any]] | None,
    coverage: dict[str, Any] | None,
) -> bool:
    """Replace what the ingest read of the document (sync): its dossier, its references, its coverage.

    All three are written by the ingest that read the file, together, so a re-ingest
    replaces the whole reading and a document never carries one reading's references
    beside another's dossier. ``None`` (or empty) clears a column. Shapes:
    ``docs/architecture/document-dossier.md``. Same UPDATE-only contract as
    :meth:`set_capture`; ``False`` when the document has no row.
    """
    import json

    written = True
    for column, value in (("dossier", dossier), ("doc_references", references), ("coverage", coverage)):
        encoded = json.dumps(value, ensure_ascii=False) if value else None
        written = store._update_column(collection, filename, column, encoded) and written
    return written


def set_page_count(store, collection: str, filename: str, page_count: int | None) -> bool:
    """Replace only the ``page_count`` of an existing metadata row (sync): how many pages the file has.

    Written by the ingest that read the file, so a re-ingest overwrites it with the newest count, and by
    the backfill for files ingested before the column existed. Nobody sets it by hand. A text file has no
    pages, so it is ``None``. Same UPDATE-only contract as :meth:`set_capture`.
    """
    return store._update_column(collection, filename, "page_count", _encode_page_count(page_count))


def get_page_count(store, collection: str, filename: str) -> int | None:
    """The stored page count of a document, or ``None`` when there is none (sync)."""
    return _decode_page_count(store._get_column(collection, filename, "page_count"))


def set_change_summary(store, collection: str, filename: str, summary: str | None, basis: str | None) -> bool:
    """Store what changed in ``filename`` against the Fassung named ``basis`` (sync); ``None`` clears both.

    ``basis`` is the file name compared against: the document's own name for
    its previous upload, another name for a Fassung a person confirmed. One
    UPDATE writes both columns, so a summary is never left with another
    file's basis.
    """
    from sqlalchemy import text

    text_value = (summary or "").strip() or None
    basis_value = (basis or "").strip() or None if text_value else None
    try:
        with store._sync_engine.connect() as conn:
            result = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {TABLE_NAME} SET change_summary = :summary, change_basis = :basis "
                    "WHERE collection = :collection AND filename = :filename"
                ),
                {"summary": text_value, "basis": basis_value, "collection": collection, "filename": filename},
            )
            conn.commit()
            return (result.rowcount or 0) > 0
    except Exception as e:
        logger.warning("Failed to set the change summary for %s: %s", filename, e)
        return False


def _update_column(store, collection: str, filename: str, column: str, value: Any) -> bool:
    """UPDATE a single column of an existing row; ``False`` if the row is absent."""
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            result = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {TABLE_NAME} SET {column} = :value WHERE collection = :collection AND filename = :filename"
                ),
                {"value": value, "collection": collection, "filename": filename},
            )
            conn.commit()
            updated = (result.rowcount or 0) > 0
            if updated:
                logger.debug("Updated %s for %s in %s", column, filename, collection)
            else:
                logger.debug("No metadata row to update %s for %s in %s", column, filename, collection)
            return updated
    except Exception as e:
        logger.warning("Failed to update %s for %s: %s", column, filename, e)
        return False


def _get_column(store, collection: str, filename: str, column: str) -> str | None:
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            result = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT {column} FROM {TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
                {"collection": collection, "filename": filename},
            )
            row = result.first()
            return row[0] if row and row[0] else None
    except Exception as e:
        logger.warning("Failed to get %s for %s: %s", column, filename, e)
        return None


def _get_column_batch(store, collection: str, filenames: list[str], column: str) -> dict[str, str]:
    if not filenames:
        return {}
    from sqlalchemy import bindparam
    from sqlalchemy import text

    result: dict[str, str] = {}
    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT filename, {column} FROM {TABLE_NAME} "
                    "WHERE collection = :collection AND filename IN :filenames"
                ).bindparams(bindparam("filenames", expanding=True)),
                {"collection": collection, "filenames": list(filenames)},
            )
            for row in rows:
                if row[1]:
                    result[row[0]] = row[1]
    except Exception as e:
        logger.warning("Failed to batch-get %s for %s: %s", column, collection, e)
        return {}
    return result


def find_tmp_upload_names(store, collection: str, filenames: list[str]) -> list[str]:
    """The stored names that are one of ``filenames`` behind a ``tmp[8]_`` upload prefix.

    The vector store cannot filter by pattern, and the prefix is random, so
    this row table is where a re-upload learns those spellings without
    reading every chunk of the collection. One indexed query per call. Empty
    on any failure: the caller then misses a legacy spelling, never fails.
    """
    names = [name for name in dict.fromkeys(filenames) if name]
    if not names:
        return []
    from sqlalchemy import text

    # tmp + exactly eight characters + a literal underscore + the name.
    patterns = {f"p{index}": f"tmp{'_' * 8}\\_{_escape_like(name)}" for index, name in enumerate(names)}
    where = " OR ".join(f"filename LIKE :{key} ESCAPE '\\'" for key in patterns)
    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection AND ({where})"),
                {"collection": collection, **patterns},
            )
            return [row[0] for row in rows]
    except Exception as e:
        logger.warning("Failed to look up tmp-prefixed names in %s: %s", collection, e)
        return []


def list_collections(store) -> list[str]:
    """Return every distinct collection present in the metadata table (sync).

    The store is the only place that knows which collections have persisted
    metadata; the backfill script iterates these when no ``--collection`` is
    given. Ordered for stable, log-friendly output.
    """
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            result = conn.execute(text(f"SELECT DISTINCT collection FROM {TABLE_NAME} ORDER BY collection"))
            return [row[0] for row in result]
    except Exception as e:
        logger.warning("Failed to list metadata collections: %s", e)
        return []
