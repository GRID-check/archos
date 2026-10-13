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
    """The person-set facts of each file in ``scope``, from the metadata store (the authority)."""
    from aiq_agent.knowledge import get_available_documents

    wanted = set(file_names) if file_names is not None else None
    return {
        document.file_name: document_facts(document)
        for document in get_available_documents(scope)
        if wanted is None or document.file_name in wanted
    }


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
        base.update(facts_by_file(scope, [file_name]).get(file_name, {}))
        return store.upsert(scope, records, base)

    return _guarded(f"mirror {scope}/{file_name}", work, 0)


def delete_chunks(scope: str, chunk_ids: Sequence[str]) -> None:
    """Delete chunks Chroma just deleted."""
    if enabled() and chunk_ids:
        _guarded(f"delete chunks in {scope}", lambda: get_store().delete_chunks(scope, chunk_ids), None)


def delete_file(scope: str, file_name: str) -> None:
    """Delete a file's chunks Chroma just deleted."""
    if enabled():
        _guarded(f"delete {scope}/{file_name}", lambda: get_store().delete_file(scope, file_name), None)


def delete_scope(scope: str) -> None:
    """Delete a scope Chroma just dropped as a collection."""
    if enabled():
        _guarded(f"delete scope {scope}", lambda: get_store().delete_scope(scope), None)


def refresh_facts(scope: str, file_names: Iterable[str] | None = None) -> None:
    """Re-mirror the person-set facts of these files (all of ``scope`` when None) onto their points.

    Called after the metadata store changed a fact. Never raises: the store
    has the change, a person's edit must not fail over its mirror, and the
    backfill (``--facts-only``) repairs drift.
    """
    if not enabled():
        return
    try:
        store = get_store()
        for file_name, facts in facts_by_file(scope, file_names).items():
            store.set_file_payload(scope, file_name, facts)
    except Exception:  # noqa: BLE001 - see the docstring
        logger.warning("Qdrant mirror: refreshing facts of %s failed", scope, exc_info=True)
