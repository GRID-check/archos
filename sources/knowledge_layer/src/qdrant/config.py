"""Which vector store this process reads and writes, and how it reaches Qdrant.

The move off Chroma (ADR-0104) runs in three steps, each one flag flip:

* ``chroma`` — today. Chroma is read and written; Qdrant is not touched.
* ``dual`` — ingestion writes both stores; retrieval still reads Chroma. The
  backfill (``scripts/backfill_qdrant.py``) fills Qdrant with what Chroma
  already holds, so the two converge without a re-embed.
* ``qdrant`` — retrieval reads Qdrant. Ingestion still writes both, because
  Chroma remains the write-side record (its ids drive version retirement and
  deletion) until the slice that removes it.

Every value is read from the environment per call: the flag is cheap to read
and a test, or an operator, can flip it without rebuilding a process-wide
singleton.
"""

from __future__ import annotations

import os

# @environment_variable AIQ_VECTOR_BACKEND
# @category Knowledge Layer
# @type str
# @default chroma
# @required false
# Which vector store the knowledge layer reads and writes: chroma | dual | qdrant.
VECTOR_BACKENDS = ("chroma", "dual", "qdrant")

#: Bounds one request to Qdrant. The chromadb client set none, and one dead
#: Chroma pod drained the API's thread pool on 2026-10-12; the Qdrant client
#: takes a timeout natively, so this is a constant, not a reach-in.
REQUEST_TIMEOUT_SECONDS = 30


def vector_backend() -> str:
    """The configured backend; an unknown value raises rather than silently meaning Chroma."""
    value = (os.environ.get("AIQ_VECTOR_BACKEND") or "chroma").strip().lower()
    if value not in VECTOR_BACKENDS:
        raise ValueError(f"AIQ_VECTOR_BACKEND={value!r} is not one of {', '.join(VECTOR_BACKENDS)}")
    return value


def writes_qdrant() -> bool:
    """True when ingestion must also write Qdrant (``dual`` and ``qdrant``)."""
    return vector_backend() != "chroma"


def reads_qdrant() -> bool:
    """True when retrieval reads Qdrant."""
    return vector_backend() == "qdrant"


# @environment_variable AIQ_QDRANT_URL
# @category Knowledge Layer
# @type str
# @default (unset)
# @required false
# Qdrant HTTP endpoint, e.g. http://qdrant:6333. Required unless AIQ_VECTOR_BACKEND=chroma.
def qdrant_url() -> str:
    """The Qdrant HTTP endpoint; required whenever the backend touches Qdrant."""
    url = (os.environ.get("AIQ_QDRANT_URL") or "").strip()
    if not url:
        raise RuntimeError("AIQ_QDRANT_URL is not set, but AIQ_VECTOR_BACKEND needs Qdrant")
    return url


# @environment_variable AIQ_QDRANT_API_KEY
# @category Knowledge Layer
# @type str
# @default (unset)
# @required false
# API key for Qdrant (service.api_key). Unset only for a local, unauthenticated instance.
def qdrant_api_key() -> str | None:
    """The API key Qdrant expects, or None for an unauthenticated local instance."""
    return (os.environ.get("AIQ_QDRANT_API_KEY") or "").strip() or None


def _positive_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    value = int(raw)
    if value < 1:
        raise ValueError(f"{name} must be at least 1, got {value}")
    return value


# @environment_variable AIQ_QDRANT_SHARD_NUMBER
# @category Knowledge Layer
# @type int
# @default 1
# @required false
# Shards per Qdrant collection, set once at creation. 6 on the 3-node cluster (fits 1/2/3/6 nodes).
def shard_number() -> int:
    """Shards for the tenant collection, fixed at creation (open-source Qdrant cannot reshard)."""
    return _positive_int("AIQ_QDRANT_SHARD_NUMBER", 1)


# @environment_variable AIQ_QDRANT_REPLICATION_FACTOR
# @category Knowledge Layer
# @type int
# @default 1
# @required false
# Replicas per shard, set once at creation. 2 on the 3-node cluster; writes need only one (consistency 1).
def replication_factor() -> int:
    """Replicas per shard, fixed at creation; a self-hosted cluster does not re-replicate by itself."""
    return _positive_int("AIQ_QDRANT_REPLICATION_FACTOR", 1)
