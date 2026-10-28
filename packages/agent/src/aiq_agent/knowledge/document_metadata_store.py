"""Per-document metadata store (SQLAlchemy).

One row per ``(collection, filename)`` holding everything the system knows about
an ingested document beyond its chunks: the one-sentence ``summary``, the
controlled ``tags``, the explicit ``doc_class`` ("Dokumentart"), the
user-facing ``display_title``, the ``folder_path`` the document is filed
under (ADR-0049), and the ``provenance`` of a document Piloti wrote and a
person released (ADR-0054). The table is named ``document_metadata`` because
it is exactly that — the summary is only one of several columns.

Historically this was the ``summaries`` table (class ``SummaryStore``). A
startup migration renames that table in place the first time the store opens
against an older database, so existing rows are preserved untouched — see
:meth:`DocumentMetadataStore._ensure_schema`.

Configurable SQLite/PostgreSQL storage, following the same pattern as EventStore
in the jobs system.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import redact_db_url
from aiq_agent.knowledge.document_classification import MAX_TOPIC_VOCABULARY

if TYPE_CHECKING:
    from .schema import AvailableDocument

from aiq_agent.knowledge import document_metadata_decode as decode_impl
from aiq_agent.knowledge import document_metadata_engines as engines_impl
from aiq_agent.knowledge import document_metadata_fields as fields_impl
from aiq_agent.knowledge import document_metadata_folders as folders_impl
from aiq_agent.knowledge import document_metadata_reads as reads_impl
from aiq_agent.knowledge import document_metadata_records as records_impl
from aiq_agent.knowledge import document_metadata_revisions as revisions_impl
from aiq_agent.knowledge import document_metadata_schema as schema_impl
from aiq_agent.knowledge import document_metadata_tags as tags_impl
from aiq_agent.knowledge.document_metadata_constants import _DOCUMENT_COLUMNS
from aiq_agent.knowledge.document_metadata_constants import _INDEX_NAME
from aiq_agent.knowledge.document_metadata_constants import _LEGACY_INDEX_NAME
from aiq_agent.knowledge.document_metadata_constants import _OFFICE_TIMEZONE
from aiq_agent.knowledge.document_metadata_constants import _OPTIONAL_COLUMN_TYPES
from aiq_agent.knowledge.document_metadata_constants import _OPTIONAL_COLUMNS
from aiq_agent.knowledge.document_metadata_constants import _RETAINED_COLUMNS
from aiq_agent.knowledge.document_metadata_constants import ENGINE_CACHE_MAX_SIZE
from aiq_agent.knowledge.document_metadata_constants import ENGINE_CACHE_TTL_SECONDS
from aiq_agent.knowledge.document_metadata_constants import LEGACY_RETAINED_TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import LEGACY_TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import REFUSAL_REASON
from aiq_agent.knowledge.document_metadata_constants import RETAINED_TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import SUGGESTION_BASES
from aiq_agent.knowledge.document_metadata_constants import TABLE_NAME
from aiq_agent.knowledge.document_metadata_constants import TAGS_SET_BY_PERSON
from aiq_agent.knowledge.document_metadata_constants import logger
from aiq_agent.knowledge.document_metadata_helpers import LinkOutcome
from aiq_agent.knowledge.document_metadata_helpers import _current_doc_class
from aiq_agent.knowledge.document_metadata_helpers import _decode_page_count
from aiq_agent.knowledge.document_metadata_helpers import _encode_page_count
from aiq_agent.knowledge.document_metadata_helpers import _escape_like
from aiq_agent.knowledge.document_metadata_helpers import _kept_reason
from aiq_agent.knowledge.document_metadata_helpers import _link_lock_key
from aiq_agent.knowledge.document_metadata_helpers import _LinkRow
from aiq_agent.knowledge.document_metadata_helpers import _merged_suggestion
from aiq_agent.knowledge.document_metadata_helpers import _person_made_facts
from aiq_agent.knowledge.document_metadata_helpers import _refusal_record
from aiq_agent.knowledge.document_metadata_helpers import _set_columns
from aiq_agent.knowledge.document_metadata_helpers import _with_refusal
from aiq_agent.knowledge.document_metadata_helpers import dismissed_revisions

__all__ = [
    "DocumentMetadataStore",
    "ENGINE_CACHE_MAX_SIZE",
    "ENGINE_CACHE_TTL_SECONDS",
    "LEGACY_RETAINED_TABLE_NAME",
    "LEGACY_TABLE_NAME",
    "LinkOutcome",
    "REFUSAL_REASON",
    "RETAINED_TABLE_NAME",
    "SUGGESTION_BASES",
    "TABLE_NAME",
    "TAGS_SET_BY_PERSON",
    "_DOCUMENT_COLUMNS",
    "_INDEX_NAME",
    "_LEGACY_INDEX_NAME",
    "_LinkRow",
    "_OFFICE_TIMEZONE",
    "_OPTIONAL_COLUMNS",
    "_OPTIONAL_COLUMN_TYPES",
    "_RETAINED_COLUMNS",
    "_current_doc_class",
    "_decode_page_count",
    "_encode_page_count",
    "_escape_like",
    "_kept_reason",
    "_link_lock_key",
    "_merged_suggestion",
    "_normalize_db_url",
    "_person_made_facts",
    "_refusal_record",
    "_set_columns",
    "_with_refusal",
    "dismissed_revisions",
    "logger",
]


class DocumentMetadataStore:
    """SQLAlchemy-based store for per-document metadata.

    Features:
    - Automatic SQLite/PostgreSQL support based on db_url
    - Connection pooling with TTL-based cache management
    - Both sync and async operations supported
    - In-place migration of the legacy ``summaries`` table + added columns
    """

    """SQLAlchemy-based store for per-document metadata.

    Features:
    - Automatic SQLite/PostgreSQL support based on db_url
    - Connection pooling with TTL-based cache management
    - Both sync and async operations supported
    - In-place migration of the legacy ``summaries`` table + added columns
    """

    _async_engine_cache: dict[str, tuple[Any, float]] = {}
    _sync_engine_cache: dict[str, tuple[Any, float]] = {}
    _cache_lock = threading.Lock()
    _tables_initialized: set[str] = set()
    #: Serialises :meth:`link_revision` on SQLite, which has no advisory lock (dev and tests run one process).

    _link_lock = threading.Lock()

    def __init__(self, db_url: str):
        self.db_url = db_url
        self._sync_engine = self._get_or_create_sync_engine(db_url)
        self._ensure_table_sync()
        logger.info("DocumentMetadataStore initialized: %s", redact_db_url(db_url))

    #: The keys a ``capture`` object may carry, and the type each must have.

    _CAPTURE_TYPES: dict[str, type | tuple[type, ...]] = {
        "captured_at": str,
        "latitude": (int, float),
        "longitude": (int, float),
        "camera": str,
    }

    @classmethod
    def _get_or_create_sync_engine(cls, db_url: str):
        return engines_impl._get_or_create_sync_engine(cls, db_url)

    @classmethod
    def _get_or_create_async_engine(cls, db_url: str):
        return engines_impl._get_or_create_async_engine(cls, db_url)

    @classmethod
    def _cleanup_stale_engines(cls, cache: dict[str, tuple[Any, float]]):
        return engines_impl._cleanup_stale_engines(cls, cache)

    # ------------------------------------------------------------------
    # Schema management (create fresh · rename legacy · backfill columns)
    # ------------------------------------------------------------------

    def _is_postgres(self) -> bool:
        return schema_impl._is_postgres(self)

    def _ensure_table_sync(self):
        return schema_impl._ensure_table_sync(self)

    @classmethod
    async def _ensure_table_async(cls, db_url: str):
        return await schema_impl._ensure_table_async(cls, db_url)

    def _run_schema(self, conn) -> None:
        return schema_impl._run_schema(self, conn)

    def _rename_legacy_doc_classes(self, conn) -> None:
        return schema_impl._rename_legacy_doc_classes(self, conn)

    def _create_retained_table(self, conn) -> None:
        return schema_impl._create_retained_table(self, conn)

    def _create_table(self, conn) -> None:
        return schema_impl._create_table(self, conn)

    def _add_column_if_missing(self, conn, column: str, ddl_type: str = "TEXT") -> None:
        return schema_impl._add_column_if_missing(self, conn, column, ddl_type)

    def _ensure_index(self, conn) -> None:
        return schema_impl._ensure_index(self, conn)

    def register(
        self,
        collection: str,
        filename: str,
        summary: str,
        tags: list[str] | None = None,
        topics: list[str] | None = None,
    ) -> None:
        return records_impl.register(self, collection, filename, summary, tags, topics)

    def _take_back_retained(self, conn, collection: str, filename: str) -> None:
        return records_impl._take_back_retained(self, conn, collection, filename)

    @staticmethod
    def _closes_a_loop(conn, collection: str, older: str, newer: str) -> bool:
        return records_impl._closes_a_loop(conn, collection, older, newer)

    @staticmethod
    def _forget_retained(conn, collection: str, filename: str) -> None:
        return records_impl._forget_retained(conn, collection, filename)

    def update_tags(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        return tags_impl.update_tags(self, collection, filename, tags)

    def set_tags_by_person(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        return tags_impl.set_tags_by_person(self, collection, filename, tags)

    def set_topics_by_person(self, collection: str, filename: str, topics: list[str] | None) -> bool:
        return tags_impl.set_topics_by_person(self, collection, filename, topics)

    def get_person_tags_batch(self, collection: str, filenames: list[str]) -> dict[str, list[str]]:
        return tags_impl.get_person_tags_batch(self, collection, filenames)

    def get_person_topics_batch(self, collection: str, filenames: list[str]) -> dict[str, list[str]]:
        return tags_impl.get_person_topics_batch(self, collection, filenames)

    def get_topic_vocabulary(self, collection: str, limit: int = MAX_TOPIC_VOCABULARY) -> list[str]:
        return tags_impl.get_topic_vocabulary(self, collection, limit)

    def _set_person_list(self, collection: str, filename: str, column: str, values: list[str] | None) -> bool:
        return tags_impl._set_person_list(self, collection, filename, column, values)

    def _person_list_batch(self, collection: str, filenames: list[str], column: str) -> dict[str, list[str]]:
        return tags_impl._person_list_batch(self, collection, filenames, column)

    def set_doc_class(self, collection: str, filename: str, doc_class: str | None) -> bool:
        return fields_impl.set_doc_class(self, collection, filename, doc_class)

    def get_doc_class(self, collection: str, filename: str) -> str | None:
        return fields_impl.get_doc_class(self, collection, filename)

    def get_doc_classes_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return fields_impl.get_doc_classes_batch(self, collection, filenames)

    def set_doc_class_suggestion(self, collection: str, filename: str, doc_class: str | None) -> bool:
        return fields_impl.set_doc_class_suggestion(self, collection, filename, doc_class)

    def get_doc_class_suggestions_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return fields_impl.get_doc_class_suggestions_batch(self, collection, filenames)

    def set_display_title(self, collection: str, filename: str, display_title: str | None) -> bool:
        return fields_impl.set_display_title(self, collection, filename, display_title)

    def get_display_title(self, collection: str, filename: str) -> str | None:
        return fields_impl.get_display_title(self, collection, filename)

    def get_display_titles_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return fields_impl.get_display_titles_batch(self, collection, filenames)

    def set_folder_path(self, collection: str, filename: str, folder_path: str | None) -> bool:
        return fields_impl.set_folder_path(self, collection, filename, folder_path)

    def get_folder_path(self, collection: str, filename: str) -> str | None:
        return fields_impl.get_folder_path(self, collection, filename)

    def get_folder_paths_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return fields_impl.get_folder_paths_batch(self, collection, filenames)

    def set_provenance(self, collection: str, filename: str, provenance: dict[str, str] | None) -> bool:
        return fields_impl.set_provenance(self, collection, filename, provenance)

    def get_provenance(self, collection: str, filename: str) -> dict[str, str] | None:
        return fields_impl.get_provenance(self, collection, filename)

    def set_capture(self, collection: str, filename: str, capture: dict[str, Any] | None) -> bool:
        return fields_impl.set_capture(self, collection, filename, capture)

    def set_revision_facts(self, collection: str, filename: str, facts: dict[str, Any] | None) -> bool:
        return fields_impl.set_revision_facts(self, collection, filename, facts)

    def set_reading(
        self,
        collection: str,
        filename: str,
        *,
        dossier: dict[str, Any] | None,
        references: list[dict[str, Any]] | None,
        coverage: dict[str, Any] | None,
    ) -> bool:
        return fields_impl.set_reading(
            self, collection, filename, dossier=dossier, references=references, coverage=coverage
        )

    def set_page_count(self, collection: str, filename: str, page_count: int | None) -> bool:
        return fields_impl.set_page_count(self, collection, filename, page_count)

    def get_page_count(self, collection: str, filename: str) -> int | None:
        return fields_impl.get_page_count(self, collection, filename)

    def set_superseded_by(self, collection: str, older: str, newer: str | None) -> bool:
        return revisions_impl.set_superseded_by(self, collection, older, newer)

    def set_revision_suggestion(self, collection: str, filename: str, suggestion: dict[str, Any] | None) -> bool:
        return revisions_impl.set_revision_suggestion(self, collection, filename, suggestion)

    def dismiss_revision_suggestion(self, collection: str, filename: str, older: str) -> bool:
        return revisions_impl.dismiss_revision_suggestion(self, collection, filename, older)

    def _rewrite_suggestion(
        self, collection: str, filename: str, rewrite: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    ) -> bool:
        return revisions_impl._rewrite_suggestion(self, collection, filename, rewrite)

    def link_revision(self, collection: str, older: str, newer: str) -> LinkOutcome:
        return revisions_impl.link_revision(self, collection, older, newer)

    def _link_revision_locked(self, collection: str, older: str, newer: str) -> LinkOutcome:
        return revisions_impl._link_revision_locked(self, collection, older, newer)

    def _write_link(self, conn, collection: str, older: str, newer: str, rows: dict[str, _LinkRow]) -> None:
        return revisions_impl._write_link(self, conn, collection, older, newer, rows)

    def set_change_summary(self, collection: str, filename: str, summary: str | None, basis: str | None) -> bool:
        return fields_impl.set_change_summary(self, collection, filename, summary, basis)

    def get_superseded_by_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return revisions_impl.get_superseded_by_batch(self, collection, filenames)

    def files_linked_to(self, collection: str, newer: str) -> list[str]:
        return revisions_impl.files_linked_to(self, collection, newer)

    def get_superseded_files(self, collection: str) -> dict[str, str]:
        return revisions_impl.get_superseded_files(self, collection)

    def get_revision_suggestions_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        return revisions_impl.get_revision_suggestions_batch(self, collection, filenames)

    def rewrite_folder_paths(self, collection: str, from_path: str, to_path: str | None) -> int:
        return folders_impl.rewrite_folder_paths(self, collection, from_path, to_path)

    def rewrite_folder_paths_moved(self, collection: str, from_path: str, to_path: str | None) -> tuple[int, list[str]]:
        return folders_impl.rewrite_folder_paths_moved(self, collection, from_path, to_path)

    # ------------------------------------------------------------------
    # Column-level helpers (shared by tags/doc_class/display_title accessors)
    # ------------------------------------------------------------------

    def _update_column(self, collection: str, filename: str, column: str, value: Any) -> bool:
        return fields_impl._update_column(self, collection, filename, column, value)

    def _get_column(self, collection: str, filename: str, column: str) -> str | None:
        return fields_impl._get_column(self, collection, filename, column)

    def _get_column_batch(self, collection: str, filenames: list[str], column: str) -> dict[str, str]:
        return fields_impl._get_column_batch(self, collection, filenames, column)

    def find_tmp_upload_names(self, collection: str, filenames: list[str]) -> list[str]:
        return fields_impl.find_tmp_upload_names(self, collection, filenames)

    def list_collections(self) -> list[str]:
        return fields_impl.list_collections(self)

    @staticmethod
    def _decode_tags(raw: Any) -> list[str] | None:
        return decode_impl._decode_tags(raw)

    @staticmethod
    def _decode_json(raw: Any, kind: type) -> Any:
        return decode_impl._decode_json(raw, kind)

    @classmethod
    def _decode_object(cls, raw: Any) -> dict[str, Any] | None:
        return decode_impl._decode_object(cls, raw)

    @staticmethod
    def _decode_revision_facts(raw: Any) -> dict[str, Any] | None:
        return decode_impl._decode_revision_facts(raw)

    @staticmethod
    def _normalise_suggestion(value: Any) -> dict[str, Any] | None:
        return decode_impl._normalise_suggestion(value)

    @classmethod
    def _decode_suggestion(cls, raw: Any) -> dict[str, Any] | None:
        return decode_impl._decode_suggestion(cls, raw)

    def _row_to_document(self, row: Any, collection: str | None = None) -> AvailableDocument:
        return reads_impl._row_to_document(self, row, collection)

    @staticmethod
    def _attach_supersedes(documents: list[AvailableDocument]) -> list[AvailableDocument]:
        return reads_impl._attach_supersedes(documents)

    @staticmethod
    def _iso_date(raw: Any) -> str | None:
        return reads_impl._iso_date(raw)

    def get_all(self, collection: str) -> list[AvailableDocument]:
        return reads_impl.get_all(self, collection)

    def get_many(self, collection: str, filenames: list[str]) -> list[AvailableDocument]:
        return reads_impl.get_many(self, collection, filenames)

    async def get_all_async(self, collection: str) -> list[AvailableDocument]:
        return await reads_impl.get_all_async(self, collection)

    def unregister(self, collection: str, filename: str, *, permanent: bool = False) -> None:
        return records_impl.unregister(self, collection, filename, permanent=permanent)

    def _retain(self, conn, collection: str, filename: str) -> None:
        return records_impl._retain(self, conn, collection, filename)

    def _forget_links_to(self, conn, collection: str, filename: str) -> None:
        return records_impl._forget_links_to(self, conn, collection, filename)

    def clear_collection(self, collection: str) -> None:
        return records_impl.clear_collection(self, collection)

    def clear_all(self) -> None:
        return records_impl.clear_all(self)

    @classmethod
    async def dispose_engine_async(cls, db_url: str):
        return await engines_impl.dispose_engine_async(cls, db_url)

    @classmethod
    def dispose_engine(cls, db_url: str):
        return engines_impl.dispose_engine(cls, db_url)

    @classmethod
    def dispose_all_engines(cls):
        return engines_impl.dispose_all_engines(cls)
