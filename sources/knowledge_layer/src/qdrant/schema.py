"""The physical shape of the Qdrant store: collections, vectors, payload indexes.

Two collections by data shape, not one per scope (ADR-0104):

* ``corpus`` holds the shared legal corpus (``oib_knowledge`` and any other
  collection without a tenant prefix). Every office reads it.
* ``office`` holds everything an office owns: Büroablage (``archiv_``),
  projects and their restricted folders (``proj_``), conversation uploads
  (``s_``).

The logical collection name every caller still speaks is the ``scope``
payload field, indexed ``is_tenant`` so each scope's points sit together on
disk. Clients address each collection through an alias (``piloti_corpus``,
``piloti_office``); a rebuild is a new ``_vN`` collection and one atomic alias
switch, which is how open-source Qdrant changes a shard count it cannot
reshard.

Every field a read filters on is indexed BEFORE the first point lands, because
strict mode refuses a filter on an unindexed field rather than scanning, and
filterable HNSW builds its extra links at index time.
"""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client import models

from .config import replication_factor
from .config import shard_number

logger = logging.getLogger(__name__)

#: The dense named vector: the production embedder's vectors, copied unchanged.
DENSE = "dense"
#: The sparse named vector: BM25 computed by Qdrant itself from the chunk text.
LEXICAL = "lexical"

#: The server-side BM25 model, and the analysis it runs. German stemming and
#: stopwords, umlauts folded. The SAME options go with every write and every
#: query: a query analysed differently from the documents matches nothing.
BM25_MODEL = "qdrant/bm25"
BM25_OPTIONS: dict[str, Any] = {"language": "german", "ascii_folding": True}

#: Payload field holding the logical collection a point belongs to.
SCOPE_FIELD = "scope"
#: Payload field holding the chunk text: what BM25 reads, what the full-text
#: index serves phrase queries from, and what a hit's content is.
TEXT_FIELD = "text"
#: Payload field holding the chunk id every caller knows (the id Chroma gave it).
CHUNK_ID_FIELD = "chunk_id"

#: Fields stored and filtered as strings. A writer that hands one an int (or a
#: reader that asks with one) is coerced, so ``page_label`` 3 and "3" agree.
KEYWORD_FIELDS: tuple[str, ...] = (
    SCOPE_FIELD,
    CHUNK_ID_FIELD,
    "file_name",
    "punkt_id",
    "page_label",
    "chunking",
    "content_type",
    "doc_class",
    "richtlinie",
    "office_id",
    "project_id",
    "grid_document_id",
    "folder_path",
    # Every folder a document is filed in or beneath, case-folded: "this
    # folder and below" is one exact match (``prefilter.folder_ancestors``).
    "folder_ancestors",
    "tags",
    "topics",
)
#: Fields stored and filtered as integers. The Punkt chunker writes
#: ``punkt_depth`` as an int and some readers ask with "1"; both become 1.
INTEGER_FIELDS: tuple[str, ...] = ("punkt_depth", "section_order")
#: Fields stored and filtered as booleans.
BOOL_FIELDS: tuple[str, ...] = ("superseded",)

INDEXED_FIELDS = frozenset(KEYWORD_FIELDS + INTEGER_FIELDS + BOOL_FIELDS + (TEXT_FIELD,))

#: Prefixes of collections an office owns. Anything else is shared corpus.
TENANT_PREFIXES = ("archiv_", "proj_", "s_")

#: Collection metadata keys naming the embedder every dense vector came from.
EMBED_IDENTITY_KEYS = ("aiq:embed_fingerprint", "aiq:embed_model")


class Physical(StrEnum):
    """The two physical collections."""

    CORPUS = "corpus"
    OFFICE = "office"


#: Alias each physical collection is addressed by, and the collection it
#: points at when this code creates it.
ALIASES = {Physical.CORPUS: "piloti_corpus", Physical.OFFICE: "piloti_office"}
FIRST_VERSION = "_v1"


def physical_for_scope(scope: str) -> Physical:
    """Which physical collection holds a logical collection's points."""
    return Physical.OFFICE if scope.startswith(TENANT_PREFIXES) else Physical.CORPUS


def _field_schema(field: str) -> Any:
    if field == SCOPE_FIELD:
        return models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD, is_tenant=True)
    if field == TEXT_FIELD:
        return models.TextIndexParams(
            type=models.TextIndexType.TEXT,
            tokenizer=models.TokenizerType.MULTILINGUAL,
            lowercase=True,
            ascii_folding=True,
            phrase_matching=True,
        )
    if field in INTEGER_FIELDS:
        return models.PayloadSchemaType.INTEGER
    if field in BOOL_FIELDS:
        return models.PayloadSchemaType.BOOL
    return models.PayloadSchemaType.KEYWORD


def _create(client: QdrantClient, physical: Physical, name: str, dense_size: int, identity: dict[str, str]) -> None:
    """Create one physical collection with its vectors, quantization, strict mode and indexes."""
    tenant = physical is Physical.OFFICE
    client.create_collection(
        name,
        vectors_config={DENSE: models.VectorParams(size=dense_size, distance=models.Distance.COSINE)},
        sparse_vectors_config={LEXICAL: models.SparseVectorParams(modifier=models.Modifier.IDF)},
        # The corpus is small and read by every query: one shard, on every node.
        shard_number=shard_number() if tenant else 1,
        replication_factor=replication_factor(),
        write_consistency_factor=replication_factor(),
        # Per-scope graph links beside the global graph: a project-filtered
        # query walks its own scope's graph, a cross-project one the global.
        hnsw_config=models.HnswConfigDiff(payload_m=16) if tenant else None,
        quantization_config=models.TurboQuantization(
            turbo=models.TurboQuantQuantizationConfig(bits=models.TurboQuantBitSize.BITS4)
        ),
        strict_mode_config=models.StrictModeConfig(
            enabled=True, unindexed_filtering_retrieve=False, unindexed_filtering_update=False
        ),
        metadata=dict(identity),
    )
    ensure_payload_indexes(client, name)
    client.update_collection_aliases(
        change_aliases_operations=[
            models.CreateAliasOperation(
                create_alias=models.CreateAlias(collection_name=name, alias_name=ALIASES[physical])
            )
        ]
    )
    logger.info("Created Qdrant collection %s behind alias %s", name, ALIASES[physical])


def ensure_payload_indexes(client: QdrantClient, collection: str) -> list[str]:
    """Create every index in :data:`INDEXED_FIELDS` the collection lacks; returns the fields created.

    The migration for a field added after a collection was made: strict mode
    refuses a filter on it until its index exists, so every process that
    reads or writes a collection runs this once before its first query.
    Idempotent: an index that exists is left alone, its points untouched.
    """
    present = set(client.get_collection(collection).payload_schema or {})
    missing = sorted(INDEXED_FIELDS - present)
    for field in missing:
        client.create_payload_index(collection, field, field_schema=_field_schema(field), wait=True)
    if missing and present:
        logger.info("Qdrant collection %s: created missing payload indexes %s", collection, missing)
    return missing


def _alias_exists(client: QdrantClient, alias: str) -> bool:
    return any(entry.alias_name == alias for entry in client.get_aliases().aliases)


def identity_mismatch(stored: dict[str, Any] | None, identity: dict[str, str]) -> str | None:
    """Why the collection's vectors are not from this process's embedder, or None when they are."""
    stored = stored or {}
    fingerprint = EMBED_IDENTITY_KEYS[0]
    if stored.get(fingerprint) == identity.get(fingerprint):
        return None
    return (
        f"embedding mismatch: Qdrant collection was written with {stored.get(EMBED_IDENTITY_KEYS[1])!r}, "
        f"this process embeds with {identity.get(EMBED_IDENTITY_KEYS[1])!r}"
    )


def ensure_collection(client: QdrantClient, physical: Physical, dense_size: int, identity: dict[str, str]) -> None:
    """Create the physical collection behind its alias if missing; refuse a foreign vector space.

    Idempotent and safe to race: a second process that loses the create sees
    the alias the first one made.
    """
    alias = ALIASES[physical]
    if not _alias_exists(client, alias):
        try:
            _create(client, physical, alias + FIRST_VERSION, dense_size, identity)
        except Exception:
            if not _alias_exists(client, alias):
                raise
    stored = client.get_collection(alias).config.metadata
    mismatch = identity_mismatch(stored, identity)
    if mismatch:
        raise RuntimeError(f"{alias}: {mismatch}")
    ensure_payload_indexes(client, alias)
