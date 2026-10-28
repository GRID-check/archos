from __future__ import annotations

import logging
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


#: The clock an upload date is read on. The product serves Austrian offices;
#: a second country reads it from its profile when one arrives.

_OFFICE_TIMEZONE = ZoneInfo("Europe/Vienna")


ENGINE_CACHE_TTL_SECONDS = 3600


ENGINE_CACHE_MAX_SIZE = 10


#: Current table name. The store renames the legacy ``summaries`` table to this
#: on first open (see :meth:`DocumentMetadataStore._ensure_schema`).

TABLE_NAME = "document_metadata"


#: The pre-rename table name, migrated in place when found.

LEGACY_TABLE_NAME = "summaries"


_INDEX_NAME = "idx_document_metadata_collection"


_LEGACY_INDEX_NAME = "idx_summaries_collection"


#: Optional (nullable) columns added after the original schema shipped. Kept as a
#: single list so both the fresh-create path and the in-place backfill add the
#: exact same set — a new column is introduced by appending one entry here.

_OPTIONAL_COLUMNS: tuple[str, ...] = (
    "tags",
    "doc_class",
    "display_title",
    "folder_path",
    "provenance",
    "doc_class_suggestion",
    "tags_set_by",
    "topics",
    "capture",
    "superseded_by",
    "revision_suggestion",
    "change_summary",
    "change_basis",
    "revision_facts",
    "page_count",
    "dossier",
    "doc_references",
    "coverage",
)


#: DDL type of an optional column that is not TEXT. Every other column is TEXT.

_OPTIONAL_COLUMN_TYPES: dict[str, str] = {"page_count": "INTEGER"}


#: ``tags_set_by`` value for tags a PERSON chose. Machine writes (ingest, the
#: backfill script) never overwrite them — see :meth:`DocumentMetadataStore.register`.
#: Topics ride on the same marker: a person's curation covers both columns.

TAGS_SET_BY_PERSON = "person"


#: What a ``revision_suggestion`` may say its confidence rests on: the title block
#: (the same ``document_number`` on two documents), the file names (the series grammar
#: of ``revision_series.py``) or the model's reading of the content. Anything else is not stored.

SUGGESTION_BASES = ("title_block", "name", "content")


#: The columns :meth:`DocumentMetadataStore.get_all` reads, in the order
#: :meth:`DocumentMetadataStore._row_to_document` expects them.

_DOCUMENT_COLUMNS = (
    "filename, summary, tags, doc_class, display_title, folder_path, created_at, "
    "topics, capture, superseded_by, revision_suggestion, change_summary, change_basis, revision_facts, "
    "page_count, dossier, doc_references, coverage"
)


#: Where the Fassung facts a person made outlive a purge that can be undone (an archive, the folder
#: bin, a publish that re-reads a document). One row per ``(collection, filename)`` whose metadata row
#: went; the next :meth:`DocumentMetadataStore.register` of that name takes them back and deletes it.

RETAINED_TABLE_NAME = "document_revision_retained"


#: The name this table had before the English rename: renamed in place on the first open that finds it
#: (see :meth:`DocumentMetadataStore._create_retained_table`), the way ``summaries`` became ``document_metadata``.

LEGACY_RETAINED_TABLE_NAME = "document_fassung_retained"


#: What :data:`RETAINED_TABLE_NAME` keeps: the link a person confirmed, the suggestions a person
#: refused, and the change line told against a linked Fassung (its basis is another file).

_RETAINED_COLUMNS = ("superseded_by", "revision_suggestion", "change_summary", "change_basis")


#: The reason a refusal is stored with when nothing else was suggested: the record keeps its shape.

REFUSAL_REASON = "Von einer Person abgelehnt."
