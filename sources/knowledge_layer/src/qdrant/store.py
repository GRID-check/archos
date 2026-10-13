"""The Qdrant client and every write the knowledge layer makes.

This package is the only code that imports ``qdrant_client`` (an
import-linter contract fails the build otherwise), so the scope filter, the
BM25 options and the payload shape cannot drift between callers.

Writes address points by scope and chunk id or by scope and file name, never
by a bare id list from elsewhere: a delete names what it deletes.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client import models

from .config import REQUEST_TIMEOUT_SECONDS
from .config import qdrant_api_key
from .config import qdrant_url
from .payload import ChunkRecord
from .payload import build_payload
from .payload import point_id
from .schema import ALIASES
from .schema import BM25_MODEL
from .schema import BM25_OPTIONS
from .schema import CHUNK_ID_FIELD
from .schema import DENSE
from .schema import LEXICAL
from .schema import TEXT_FIELD
from .schema import Physical
from .schema import ensure_collection
from .schema import identity_mismatch
from .schema import physical_for_scope
from .scope import scope_condition
from .scope import scope_filter

logger = logging.getLogger(__name__)

#: Points per upsert request. A 3072-d vector is about 30 KB of JSON, so this
#: keeps one request near 2 MB.
UPSERT_BATCH = 64
#: Points per scroll page.
SCROLL_PAGE = 256


def bm25(text: str) -> models.Document:
    """The text as Qdrant's server-side BM25 input, with the one set of German options."""
    return models.Document(text=text, model=BM25_MODEL, options=dict(BM25_OPTIONS))


class QdrantStore:
    """Writes and plain reads against the two physical collections."""

    def __init__(self, client: QdrantClient, identity: Mapping[str, str] | None = None):
        self.client = client
        self.identity = dict(identity or {})
        self._ensured: set[Physical] = set()
        self._present: set[Physical] = set()
        self._verified: set[Physical] = set()
        self._ensure_lock = threading.Lock()

    @staticmethod
    def alias(scope: str) -> str:
        """The alias of the physical collection holding ``scope``."""
        return ALIASES[physical_for_scope(scope)]

    def ensure(self, scope: str, dense_size: int) -> str:
        """Make sure ``scope``'s physical collection exists; returns its alias."""
        physical = physical_for_scope(scope)
        if physical not in self._ensured:
            with self._ensure_lock:
                if physical not in self._ensured:
                    ensure_collection(self.client, physical, dense_size, self.identity)
                    self._ensured.add(physical)
        return ALIASES[physical]

    def exists(self, scope: str) -> bool:
        """True when ``scope``'s physical collection exists (no point need exist in it).

        A positive answer is remembered: a collection is never dropped under a
        running process (a rebuild switches the alias to a new one), so only
        "not yet" needs asking again.
        """
        physical = physical_for_scope(scope)
        if physical in self._ensured or physical in self._present:
            return True
        alias = ALIASES[physical]
        if any(entry.alias_name == alias for entry in self.client.get_aliases().aliases):
            self._present.add(physical)
            return True
        return False

    def check_identity(self, scope: str) -> None:
        """Raise when ``scope``'s collection holds vectors from another embedder than this process's.

        Checked once per physical collection per process. Without a known
        identity (a process that never embeds) there is nothing to compare.
        """
        physical = physical_for_scope(scope)
        if not self.identity or physical in self._verified or not self.exists(scope):
            return
        mismatch = identity_mismatch(self.client.get_collection(ALIASES[physical]).config.metadata, self.identity)
        if mismatch:
            raise RuntimeError(f"{ALIASES[physical]}: {mismatch}")
        self._verified.add(physical)

    # ------------------------------------------------------------------ writes

    def upsert(self, scope: str, records: Sequence[ChunkRecord], enrichment: Mapping[str, Any] | None = None) -> int:
        """Write ``records`` into ``scope``; returns how many points were written.

        The dense vector is the one already computed for Chroma (no embedding
        call); the lexical vector is computed by Qdrant from the text.
        """
        usable = [record for record in records if record.embedding is not None and len(record.embedding)]
        if not usable:
            return 0
        alias = self.ensure(scope, len(usable[0].embedding))
        for start in range(0, len(usable), UPSERT_BATCH):
            batch = usable[start : start + UPSERT_BATCH]
            points = [self._point(scope, record, enrichment) for record in batch]
            self.client.upsert(alias, points, wait=True)
        return len(usable)

    @staticmethod
    def _point(scope: str, record: ChunkRecord, enrichment: Mapping[str, Any] | None) -> models.PointStruct:
        vector: dict[str, Any] = {DENSE: [float(value) for value in record.embedding]}
        if (record.text or "").strip():
            vector[LEXICAL] = bm25(record.text)
        return models.PointStruct(
            id=point_id(record.chunk_id), vector=vector, payload=build_payload(scope, record, enrichment)
        )

    def _delete(self, scope: str, *conditions: models.Condition) -> None:
        if not self.exists(scope):
            return
        selector = models.FilterSelector(filter=models.Filter(must=[scope_condition([scope]), *conditions]))
        self.client.delete(self.alias(scope), points_selector=selector, wait=True)

    def delete_chunks(self, scope: str, chunk_ids: Sequence[str]) -> None:
        """Delete these chunks of ``scope``."""
        ids = [str(chunk_id) for chunk_id in chunk_ids if chunk_id]
        if ids:
            self._delete(scope, models.FieldCondition(key=CHUNK_ID_FIELD, match=models.MatchAny(any=ids)))

    def delete_file(self, scope: str, file_name: str) -> None:
        """Delete every chunk of one file in ``scope``."""
        self._delete(scope, models.FieldCondition(key="file_name", match=models.MatchValue(value=file_name)))

    def delete_scope(self, scope: str) -> None:
        """Delete every chunk of ``scope``: what dropping a Chroma collection did."""
        self._delete(scope)

    def set_file_payload(self, scope: str, file_name: str, payload: Mapping[str, Any]) -> None:
        """Overwrite these payload fields on every chunk of one file (a person changed a fact)."""
        if not payload or not self.exists(scope):
            return
        selector = models.Filter(
            must=[
                scope_condition([scope]),
                models.FieldCondition(key="file_name", match=models.MatchValue(value=file_name)),
            ]
        )
        self.client.set_payload(self.alias(scope), payload=dict(payload), points=selector, wait=True)

    # ------------------------------------------------------------------ plain reads

    def count(self, scope: str, filters: dict[str, Any] | None = None, *extra: models.Condition) -> int:
        """Chunks of ``scope`` matching ``filters`` (exact)."""
        if not self.exists(scope):
            return 0
        result = self.client.count(self.alias(scope), count_filter=scope_filter([scope], filters, *extra), exact=True)
        return result.count

    def scroll(
        self, scope: str, filters: dict[str, Any] | None = None, *, limit: int | None = None
    ) -> Iterator[models.Record]:
        """Every chunk of ``scope`` matching ``filters``, in point-id order, payload only."""
        if not self.exists(scope):
            return
        query_filter = scope_filter([scope], filters)
        offset: Any = None
        seen = 0
        while True:
            page, offset = self.client.scroll(
                self.alias(scope),
                scroll_filter=query_filter,
                limit=SCROLL_PAGE,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for record in page:
                yield record
                seen += 1
                if limit is not None and seen >= limit:
                    return
            if offset is None:
                return

    def health(self) -> bool:
        """True when the cluster answers."""
        try:
            self.client.get_aliases()
            return True
        except Exception:  # noqa: BLE001 - a health probe reports, it does not raise
            return False


_store: QdrantStore | None = None
_store_lock = threading.Lock()


def make_client() -> QdrantClient:
    """A client for the configured cluster. ``cloud_inference`` sends ``Document``
    inputs to the server, whose own BM25 analyses them, rather than to a local
    FastEmbed model this image does not ship."""
    return QdrantClient(
        url=qdrant_url(),
        api_key=qdrant_api_key(),
        timeout=REQUEST_TIMEOUT_SECONDS,
        cloud_inference=True,
        check_compatibility=False,
    )


def get_store(identity: Mapping[str, str] | None = None) -> QdrantStore:
    """The process-wide store. ``identity`` (the embedder's fingerprint) is
    taken from the first caller that passes one; every later caller shares it."""
    global _store
    with _store_lock:
        if _store is None:
            _store = QdrantStore(make_client(), identity)
        elif identity and not _store.identity:
            _store.identity = dict(identity)
        return _store


def reset_store() -> None:
    """Drop the process-wide store (tests, and a process that changed its config)."""
    global _store
    with _store_lock:
        _store = None


__all__ = ["QdrantStore", "bm25", "get_store", "make_client", "reset_store", "TEXT_FIELD"]
