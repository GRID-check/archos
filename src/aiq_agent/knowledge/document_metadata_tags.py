from __future__ import annotations

from typing import TYPE_CHECKING

from aiq_agent.knowledge.document_classification import MAX_TOPIC_VOCABULARY

if TYPE_CHECKING:
    pass

from aiq_agent.knowledge.document_metadata_constants import TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import TAGS_SET_BY_PERSON
from aiq_agent.knowledge.document_metadata_constants import logger


def update_tags(store, collection: str, filename: str, tags: list[str] | None) -> bool:
    """Replace the machine's ``tags`` on an existing metadata row (sync).

    The one-sentence ``summary`` is NEVER touched — this is the backfill
    seam, distinct from :meth:`register` (which owns the summary). An empty
    or ``None`` ``tags`` clears the column (stored as SQL NULL, which decodes
    back to ``None``).

    A row whose tags a person chose is left alone, like :meth:`register`
    leaves it: a machine write never overrules a person's. A person's own
    edit goes through :meth:`set_tags_by_person`.

    Returns ``True`` when a row was updated, ``False`` when no metadata row
    exists for ``(collection, filename)`` or its tags are a person's.
    """
    import json

    from sqlalchemy import text

    tags_json = json.dumps(tags) if tags else None
    try:
        with store._sync_engine.connect() as conn:
            result = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {TABLE_NAME} SET tags = :tags "
                    "WHERE collection = :collection AND filename = :filename "
                    "AND (tags_set_by IS NULL OR tags_set_by <> :person)"
                ),
                {"tags": tags_json, "collection": collection, "filename": filename, "person": TAGS_SET_BY_PERSON},
            )
            conn.commit()
            return (result.rowcount or 0) > 0
    except Exception as e:
        logger.warning("Failed to update tags for %s: %s", filename, e)
        return False


def set_tags_by_person(store, collection: str, filename: str, tags: list[str] | None) -> bool:
    """Store the tags a PERSON chose, and mark them as theirs (sync).

    From then on neither a re-ingest (:meth:`register`) nor the backfill
    (:meth:`update_tags`) replaces them. An empty list is a choice too — "no
    tags" — and is kept the same way. ``False`` when no row exists.
    """
    return store._set_person_list(collection, filename, "tags", tags)


def set_topics_by_person(store, collection: str, filename: str, topics: list[str] | None) -> bool:
    """Store the topics a PERSON chose, and mark the row as theirs (sync).

    The topic twin of :meth:`set_tags_by_person`, on the same marker, so a
    re-ingest keeps them (see :meth:`register`). ``False`` when no row exists.
    """
    return store._set_person_list(collection, filename, "topics", topics)


def get_person_tags_batch(store, collection: str, filenames: list[str]) -> dict[str, list[str]]:
    """The tags a PERSON chose, for the rows among ``filenames`` that have them.

    A row whose person cleared every tag answers ``[]`` — still a choice, and
    distinct from a row that is absent (the machine's tags, or no row).
    Fail-open to ``{}``.
    """
    return store._person_list_batch(collection, filenames, "tags")


def get_person_topics_batch(store, collection: str, filenames: list[str]) -> dict[str, list[str]]:
    """The topics a PERSON chose, with the same answer shape as :meth:`get_person_tags_batch`."""
    return store._person_list_batch(collection, filenames, "topics")


def get_topic_vocabulary(store, collection: str, limit: int = MAX_TOPIC_VOCABULARY) -> list[str]:
    """The topics this collection already uses, most frequent first (sync).

    What ingestion offers the model to reuse, so one office's "Attika" stays
    "Attika". A topic counts once per document, whatever its case; the
    spelling kept is the most frequent one, and ties sort alphabetically.
    Fail-open to ``[]``.
    """
    from sqlalchemy import text

    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT topics FROM {TABLE_NAME} WHERE collection = :collection AND topics IS NOT NULL"),
                {"collection": collection},
            )
            documents = [store._decode_tags(row[0]) or [] for row in rows]
    except Exception as e:
        logger.warning("Failed to read topic vocabulary for %s: %s", collection, e)
        return []

    from collections import Counter
    from collections import defaultdict

    documents_per_topic: Counter[str] = Counter()
    spellings: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for topics in documents:
        first_spelling: dict[str, str] = {}
        for topic in topics:
            first_spelling.setdefault(topic.casefold(), topic)
        for key, spelling in first_spelling.items():
            documents_per_topic[key] += 1
            spellings[key][spelling] += 1

    ranked = sorted(documents_per_topic, key=lambda key: (-documents_per_topic[key], key))
    return [spellings[key].most_common(1)[0][0] for key in ranked[:limit]]


def _set_person_list(store, collection: str, filename: str, column: str, values: list[str] | None) -> bool:
    """Store a JSON list a PERSON chose in ``column`` and mark the row ``tags_set_by = 'person'``."""
    import json

    from sqlalchemy import text

    value_json = json.dumps(values) if values else None
    try:
        with store._sync_engine.connect() as conn:
            result = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {TABLE_NAME} SET {column} = :value, tags_set_by = :person "
                    "WHERE collection = :collection AND filename = :filename"
                ),
                {
                    "value": value_json,
                    "collection": collection,
                    "filename": filename,
                    "person": TAGS_SET_BY_PERSON,
                },
            )
            conn.commit()
            return (result.rowcount or 0) > 0
    except Exception as e:
        logger.warning("Failed to set %s for %s: %s", column, filename, e)
        return False


def _person_list_batch(store, collection: str, filenames: list[str], column: str) -> dict[str, list[str]]:
    """The JSON list in ``column`` for the rows among ``filenames`` a PERSON set. Fail-open to ``{}``."""
    if not filenames:
        return {}
    from sqlalchemy import bindparam
    from sqlalchemy import text

    result: dict[str, list[str]] = {}
    try:
        with store._sync_engine.connect() as conn:
            rows = conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT filename, {column} FROM {TABLE_NAME} "
                    "WHERE collection = :collection AND filename IN :filenames AND tags_set_by = :person"
                ).bindparams(bindparam("filenames", expanding=True)),
                {"collection": collection, "filenames": list(filenames), "person": TAGS_SET_BY_PERSON},
            )
            for row in rows:
                result[row[0]] = store._decode_tags(row[1]) or []
    except Exception as e:
        logger.warning("Failed to batch-get person %s for %s: %s", column, collection, e)
        return {}
    return result
