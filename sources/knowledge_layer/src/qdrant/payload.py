"""One chunk's Qdrant point: id, vectors and a flat, typed payload.

The payload carries the chunk's own metadata as LlamaIndex wrote it (minus
LlamaIndex's bookkeeping), the chunk text as a top-level field, the logical
``scope`` it belongs to, and what the collection name used to only imply:
the office, project and BFF document it came from, and the facts a person
set on the document (tags, Dokumentart, Fassung status, folder).

Point ids stay the chunk ids Chroma holds, so a citation, an ``already_read``
digest or a Langfuse score that names a chunk still names the same one in
both stores during the move. A chunk id that is not a UUID (a writer outside
LlamaIndex) gets a stable UUIDv5 point id; the payload keeps the original.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from .schema import BOOL_FIELDS
from .schema import CHUNK_ID_FIELD
from .schema import INTEGER_FIELDS
from .schema import KEYWORD_FIELDS
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELD

#: LlamaIndex's own keys on a stored node. ``_node_content`` is a second, JSON
#: copy of the whole node including its text; ``doc_id``/``ref_doc_id``/
#: ``document_id`` name LlamaIndex's source Document, not the BFF document
#: (that one is ``grid_document_id``).
LLAMA_INTERNAL_KEYS = frozenset({"_node_content", "_node_type", "doc_id", "ref_doc_id", "document_id"})

#: Fields multi-valued by nature: a scalar is wrapped, so a filter can match any.
LIST_FIELDS = frozenset({"tags", "topics"})

_POINT_NAMESPACE = uuid.UUID("5b0c7f8e-6b8a-4f0e-9a51-2c1d8f3e7a10")


@dataclass
class ChunkRecord:
    """A chunk as Chroma holds it: id, text, vector and metadata."""

    chunk_id: str
    text: str
    embedding: list[float]
    metadata: dict[str, Any] = field(default_factory=dict)


def point_id(chunk_id: str) -> str:
    """The Qdrant point id for a chunk: the chunk id itself when it is a UUID."""
    try:
        return str(uuid.UUID(chunk_id))
    except (ValueError, AttributeError, TypeError):
        return str(uuid.uuid5(_POINT_NAMESPACE, str(chunk_id)))


def _as_int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def coerce_field(key: str, value: Any) -> Any:
    """A value in the type its index expects; None when it cannot be one.

    Used for writes AND for filter values, so the two always agree: the same
    coercion that stores ``page_label`` 3 as "3" turns a filter's 3 into "3".
    """
    if value is None:
        return None
    if key in INTEGER_FIELDS:
        return _as_int(value)
    if key in BOOL_FIELDS:
        return bool(value)
    if key in LIST_FIELDS:
        items = value if isinstance(value, (list, tuple, set)) else [value]
        return [str(item) for item in items if item is not None and str(item)]
    if key in KEYWORD_FIELDS:
        return str(value)
    return value


def document_facts(document: Any | None) -> dict[str, Any]:
    """The person-set facts of one document, as payload fields.

    ``document`` is an ``AvailableDocument`` row from the metadata store, the
    authority for every one of these: Postgres decides, the payload mirrors.
    """
    if document is None:
        return {}
    facts: dict[str, Any] = {
        "tags": list(getattr(document, "tags", None) or []),
        "topics": list(getattr(document, "topics", None) or []),
        "superseded": bool(getattr(document, "superseded_by", None)),
    }
    if doc_class := getattr(document, "doc_class", None):
        facts["doc_class"] = doc_class
    if folder_path := getattr(document, "folder_path", None):
        facts["folder_path"] = folder_path
    return facts


def build_payload(scope: str, record: ChunkRecord, enrichment: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The payload for one chunk; ``scope``, ``text`` and ``chunk_id`` always win."""
    payload: dict[str, Any] = {
        key: value for key, value in (record.metadata or {}).items() if key not in LLAMA_INTERNAL_KEYS
    }
    payload.update({key: value for key, value in (enrichment or {}).items() if value is not None})
    typed: dict[str, Any] = {}
    for key, value in payload.items():
        coerced = coerce_field(key, value)
        if coerced is not None:
            typed[key] = coerced
    typed[SCOPE_FIELD] = scope
    typed[TEXT_FIELD] = record.text or ""
    typed[CHUNK_ID_FIELD] = str(record.chunk_id)
    return typed


#: Fields the mirror adds for filtering. A hit's metadata leaves them out, so a
#: chunk read from Qdrant carries exactly the metadata it carried from Chroma;
#: the facts themselves are read from the metadata store, their authority.
MIRROR_ONLY_FIELDS = frozenset(
    {TEXT_FIELD, SCOPE_FIELD, CHUNK_ID_FIELD, "office_id", "project_id", "grid_document_id"}
    | {"folder_path", "tags", "topics", "superseded"}
)


def chunk_metadata(payload: Mapping[str, Any]) -> dict[str, Any]:
    """The chunk metadata a caller sees on a hit: the payload minus what only the mirror adds."""
    return {key: value for key, value in payload.items() if key not in MIRROR_ONLY_FIELDS}
