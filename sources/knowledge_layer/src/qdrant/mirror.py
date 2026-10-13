"""Keeping Qdrant in step with Chroma while both are written (``dual``, ``qdrant``).

Chroma stays the write-side record until the slice that removes it: its ids
decide which version is retired and which partial attempt is discarded. Every
place the adapter changes Chroma calls the matching function here, exactly as
it already keeps the Postgres lexical mirror in step, and the vectors Chroma
holds are copied, never recomputed.

Failure policy follows what reads the store. Under ``dual`` nothing reads
Qdrant yet, so a failed mirror is logged and the backfill heals it; under
``qdrant`` a chunk missing from Qdrant is a chunk no search finds, so the
failure propagates and the file fails where a person can see it.

Deletes run in the order that never leaves deleted content readable
(:func:`ordered_delete`): under ``qdrant`` the store reads come from goes
first, so a failure there aborts before Chroma loses anything and the whole
delete can be retried; under ``dual`` Chroma goes first and the mirror is
best effort. Either way a mirror failure never skips the Chroma-side cleanup
that follows a Chroma delete (the metadata row, the lexical mirror, the
collection version): the caller runs that after this returns.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any
from typing import TypeVar

from .config import reads_qdrant
from .config import writes_qdrant
from .payload import ChunkRecord
from .payload import document_facts
from .prefilter import FOLDER_FIELD
from .store import get_store

logger = logging.getLogger(__name__)

T = TypeVar("T")

#: Chunks read from Chroma per page while mirroring one file.
CHROMA_PAGE = 512


def enabled() -> bool:
    """True when ingestion writes Qdrant."""
    return writes_qdrant()


def _guarded(label: str, work: Callable[[], T], default: T) -> T:
    """Run ``work`` under the failure policy above."""
    try:
        return work()
    except Exception:
        if reads_qdrant():
            raise
        logger.warning("Qdrant mirror: %s failed; the backfill will repair it", label, exc_info=True)
        return default


def records_from_chroma(fetched: Mapping[str, Any]) -> list[ChunkRecord]:
    """A ``collection.get(include=[documents, metadatas, embeddings])`` page as records."""
    ids = list(fetched.get("ids") or [])
    documents = list(fetched.get("documents") or [])
    metadatas = list(fetched.get("metadatas") or [])
    embeddings = fetched.get("embeddings")
    embeddings = list(embeddings) if embeddings is not None else []
    records: list[ChunkRecord] = []
    for index, chunk_id in enumerate(ids):
        embedding = embeddings[index] if index < len(embeddings) else None
        if embedding is None:
            continue
        records.append(
            ChunkRecord(
                chunk_id=str(chunk_id),
                text=(documents[index] if index < len(documents) else "") or "",
                embedding=[float(value) for value in embedding],
                metadata=dict((metadatas[index] if index < len(metadatas) else None) or {}),
            )
        )
    return records


def facts_by_file(scope: str, file_names: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """The person-set facts of each file in ``scope`` (only of ``file_names`` when given), from the metadata store.

    Given names, only their rows are read: a change to one file must not load
    every document of the scope.
    """
    if file_names is None:
        from aiq_agent.knowledge import get_available_documents

        documents = get_available_documents(scope)
    else:
        from aiq_agent.knowledge import get_documents

        documents = get_documents(scope, sorted(set(file_names)))
    return {document.file_name: document_facts(document) for document in documents}


def enrichment(scope: str, config: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """What the collection name only implied, made explicit on every point.

    ``office_id`` comes from the ingest job (the BFF's ``x-grid-organization-id``)
    or, for the Büroablage, from the collection name itself; ``project_id``
    and ``grid_document_id`` from the job. A backfilled point without a job
    has the ids its collection name carries and nothing invented.
    """
    config = config or {}
    office_id = config.get("organization_id")
    if not office_id and scope.startswith("archiv_"):
        office_id = scope.removeprefix("archiv_")
    return {
        "office_id": office_id,
        "project_id": config.get("project_id"),
        "grid_document_id": config.get("document_id"),
        "folder_path": config.get("folder_path"),
    }


def mirror_file(
    chroma_collection: Any,
    scope: str,
    file_name: str,
    *,
    identity: Mapping[str, str],
    config: Mapping[str, Any] | None = None,
    exclude_ids: Iterable[str] = (),
) -> int:
    """Copy one file's chunks from Chroma into Qdrant; returns the points written."""

    def work() -> int:
        store = get_store(identity)
        skip = set(exclude_ids)
        fetched = chroma_collection.get(
            where={"file_name": file_name}, include=["documents", "metadatas", "embeddings"]
        )
        records = [record for record in records_from_chroma(fetched) if record.chunk_id not in skip]
        base = enrichment(scope, config)
        # A fact the store does not hold yet (None) leaves the job's own value,
        # as before the store stated a root folder; the refresh that follows
        # the store's write (``refresh_facts``) settles it.
        facts = facts_by_file(scope, [file_name]).get(file_name, {})
        base.update({key: value for key, value in facts.items() if value is not None})
        return store.upsert(scope, records, base)

    return _guarded(f"mirror {scope}/{file_name}", work, 0)


def ordered_delete(
    scope: str,
    chroma_work: Callable[[], T],
    *,
    chunk_ids: Sequence[str] = (),
    file_name: str | None = None,
    matches: Callable[[str], bool] | None = None,
    whole_scope: bool = False,
) -> T:
    """Delete from both stores in the order that never leaves deleted content readable.

    What goes from Qdrant: ``chunk_ids``, every chunk of ``file_name`` under
    each stored spelling ``matches`` accepts, or the whole scope.

    * ``chroma``: only ``chroma_work`` runs.
    * ``qdrant``: Qdrant first, and a failure (after the store's retries)
      raises before ``chroma_work`` has run: nothing is deleted anywhere, and
      the caller's retry starts over. Deleting Chroma first left content
      retrievable that the caller had been told was gone.
    * ``dual``: ``chroma_work`` first, then the mirror, whose failure is
      logged for the backfill and never reaches the caller.

    Returns what ``chroma_work`` returns. The caller's Chroma-side cleanup
    runs after this, so the mirror cannot skip it.
    """
    if not enabled():
        return chroma_work()

    def qdrant_work() -> None:
        store = get_store()
        if whole_scope:
            store.delete_scope(scope)
            return
        ids = [str(chunk_id) for chunk_id in chunk_ids if chunk_id]
        if ids:
            store.delete_chunks(scope, ids)
        if file_name is not None:
            store.delete_file(scope, file_name, matches)

    if reads_qdrant():
        qdrant_work()
        return chroma_work()
    result = chroma_work()
    _guarded(f"delete in {scope}", qdrant_work, None)
    return result


#: The facts a folder move changes, and all a re-filed subtree needs mirrored.
FOLDER_FACTS = frozenset({"folder_path", FOLDER_FIELD})


def refresh_facts(scope: str, file_names: Iterable[str] | None = None, *, fields: Iterable[str] | None = None) -> None:
    """Re-mirror the person-set facts of these files (all of ``scope`` when None) onto their points.

    Called after the metadata store changed a fact. Never raises: the store
    has the change, a person's edit must not fail over its mirror, and the
    backfill (``--facts-only``) repairs drift.

    The facts of every file go in bounded batches, not one request per file
    (a folder rename re-files a whole subtree). A file with no stored
    Dokumentart gets its own one back (``QdrantStore.restore_chunk_doc_class``),
    so clearing a person's class is mirrored too. ``fields`` limits the copy
    to those facts (:data:`FOLDER_FACTS` after a folder move), and the
    Dokumentart is then put back only when it is one of them.
    """
    if not enabled():
        return
    try:
        store = get_store()
        facts = facts_by_file(scope, file_names)
        wanted = set(fields) if fields is not None else None
        if wanted is not None:
            facts = {
                name: {key: value for key, value in values.items() if key in wanted} for name, values in facts.items()
            }
        store.set_file_payloads(scope, facts)
        restores = wanted is None or "doc_class" in wanted
        for file_name, values in facts.items():
            if restores and "doc_class" not in values:
                store.restore_chunk_doc_class(scope, file_name)
    except Exception:  # noqa: BLE001 - see the docstring
        logger.warning("Qdrant mirror: refreshing facts of %s failed", scope, exc_info=True)
