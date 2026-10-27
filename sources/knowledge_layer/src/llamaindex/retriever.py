"""The retriever: a query embedded once, one fused Qdrant search, hits as ``Chunk`` records.

Embeds the query through the OpenAI-compatible endpoint and reads Qdrant
(``knowledge_layer.qdrant``, ADR-0115); registered with the knowledge factory as
the ``llamaindex`` backend.
"""

import asyncio
import json
import logging
import os
import threading
import time
from collections.abc import Sequence
from typing import Any

from aiq_agent.knowledge.base import BaseRetriever
from aiq_agent.knowledge.factory import register_retriever
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import RetrievalResult

from . import dependencies
from . import embedding
from .dependencies import retrieval_dependency_error
from .embedding import EMBED_BATCH_SIZE
from .embedding import EMBED_MAX_RETRIES
from .embedding import QUERY_EMBED_TIMEOUT_SECONDS
from .embedding import embed_fingerprint_metadata
from .env import env_int
from .lexical_query import lexical_inputs
from .query_embeddings import QueryEmbeddingCache
from .retrieved_chunks import chunk_from_node

logger = logging.getLogger(__name__)


def collection_version(collection_name: str) -> int | None:
    """The collection's write version, or ``None`` when it cannot be resolved.

    NOTE the contract: ``None`` means UNKNOWN, not 0. A caller must not build a cache
    key from it and must not store a result. Coercing unknown to 0 is precisely how a
    replica keeps serving superseded legal text through a cache outage -- every entry
    another replica stored under version 0 would match again.
    """
    from aiq_agent.knowledge import collection_version as _collection_version

    return _collection_version.current(collection_name)


def _filters_fingerprint(filters: dict[str, Any] | None) -> str:
    """Stable cache-key fragment for a filter dict (empty string when unfiltered)."""
    if not filters:
        return ""
    return json.dumps(filters, sort_keys=True, default=str)


@register_retriever("llamaindex")
class LlamaIndexRetriever(BaseRetriever):
    """
    LlamaIndex-based document retriever.

    Embeds the query through an OpenAI-compatible endpoint and reads Qdrant
    (``knowledge_layer.qdrant``, ADR-0115).

    Configuration options:
        embed_model: Embedding model id (default from AIQ_EMBED_MODEL)
        top_k: Default number of results (default: 10)
        hybrid_search: Enable lexical+vector hybrid retrieval (default from AIQ_HYBRID_RETRIEVAL)

    Environment variables:
        AIQ_QDRANT_URL: The Qdrant cluster every chunk is written to
        AIQ_EMBED_MODEL: Default embedding model name
        AIQ_EMBED_BASE_URL: Default embedding model base URL
        AIQ_RETRIEVER_TOP_K: Default top_k value
        AIQ_HYBRID_RETRIEVAL: Enable hybrid lexical+vector retrieval (default: true)
    """

    # Default configuration from environment variables
    DEFAULT_EMBED_MODEL = os.environ.get("AIQ_EMBED_MODEL", "openai/text-embedding-3-large")
    DEFAULT_EMBED_BASE_URL = os.environ.get("AIQ_EMBED_BASE_URL", "https://openrouter.ai/api/v1")
    # @environment_variable AIQ_RETRIEVER_TOP_K
    # @category Knowledge Layer
    # @type int
    # @default 10
    # @required false
    # Default number of results returned by the LlamaIndex retriever.
    DEFAULT_TOP_K = env_int("AIQ_RETRIEVER_TOP_K", 10)
    # @environment_variable AIQ_HYBRID_RETRIEVAL
    # @category Knowledge Layer
    # @type bool
    # @default true
    # @required false
    # Enable the lexical channels beside the dense one: German BM25 and the
    # exact-term phrase channels, fused in Qdrant by reciprocal rank fusion.
    DEFAULT_HYBRID_SEARCH = os.environ.get("AIQ_HYBRID_RETRIEVAL", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }

    backend_name = "llamaindex"

    def __init__(self, config: dict[str, Any] | None = None):
        super().__init__(config)

        self.embed_model_name = self.config.get("embed_model", self.DEFAULT_EMBED_MODEL)
        self.embed_base_url = self.config.get("embed_base_url", self.DEFAULT_EMBED_BASE_URL)
        self.default_top_k = self.config.get("top_k", self.DEFAULT_TOP_K)
        # Explicit config wins; otherwise the environment default (on).
        self.hybrid_search = bool(self.config.get("hybrid_search", self.DEFAULT_HYBRID_SEARCH))

        # Lazy-loaded components
        self._embed_model = None
        self._initialized = False
        self._init_lock = threading.Lock()

        # One embedding per (model, query), shared by every caller that asks
        # while it is computed (``query_embeddings``).
        self._query_embeddings = QueryEmbeddingCache()

        # Document frequency of each BM25 and exact term, per collection size,
        # as Qdrant counts it (a phrase on the word-tokenized text index), so
        # pricing a term costs one count per new term rather than one per
        # retrieval (`lexical_query.lexical_inputs`).
        self._qdrant_term_df: dict[tuple[str, int, str], int] = {}

        # Result cache for static corpora (the shared OIB knowledge base):
        # identical questions recur across users and conversations, and the
        # corpus only changes on re-sync. Keyed on the collection write
        # version, so in-process ingestion invalidates immediately.
        self._result_cache: dict[tuple[str, int, str, int, str], tuple[float, RetrievalResult]] = {}
        self._result_cache_order: list[tuple[str, int, str, int, str]] = []
        self._result_cache_lock = threading.Lock()

        logger.info("LlamaIndexRetriever initialized")

    # @environment_variable AIQ_STATIC_RESULT_CACHE_COLLECTIONS
    # @category Knowledge Layer
    # @type str
    # @default oib_knowledge
    # @required false
    # Comma-separated collections whose retrieval results may be cached
    # (static corpora only — never project/session collections).
    STATIC_RESULT_CACHE_COLLECTIONS = frozenset(
        name.strip()
        for name in os.environ.get("AIQ_STATIC_RESULT_CACHE_COLLECTIONS", "oib_knowledge").split(",")
        if name.strip()
    )
    # @environment_variable AIQ_STATIC_RESULT_CACHE_TTL_SECONDS
    # @category Knowledge Layer
    # @type int
    # @default 3600
    # @required false
    # TTL for cached static-collection retrieval results.
    STATIC_RESULT_CACHE_TTL_SECONDS = int(os.environ.get("AIQ_STATIC_RESULT_CACHE_TTL_SECONDS", "3600"))
    RESULT_CACHE_MAX = 256

    def _ensure_initialized(self):
        """Lazy initialization of components. Thread-safe: retrieval runs off-loop."""
        if self._initialized:
            return

        with self._init_lock:
            if self._initialized:
                return
            self._initialize_components()

    def _initialize_components(self):
        # Same complete preflight as the ingestion path: "initialized" has to
        # mean usable, not "the first import worked".
        dependencies.ensure_retrieval_dependencies()

        try:
            embed_api_key = embedding.resolve_embed_api_key(self.embed_base_url, self.embed_model_name)
            if not embed_api_key:
                logger.error(
                    "No embeddings API key resolved (AIQ_EMBED_API_KEY / "
                    "the provider key for AIQ_EMBED_BASE_URL) - retrieval/ingestion will fail."
                )

            self._embed_model = embedding.make_embed_model(
                base_url=self.embed_base_url,
                model=self.embed_model_name,
                api_key=embed_api_key,
                embed_batch_size=EMBED_BATCH_SIZE,
                # The retriever embeds queries a reader is waiting on: bounded
                # tightly and retried, never the ingestion batch's 60 s.
                timeout=QUERY_EMBED_TIMEOUT_SECONDS,
                max_retries=EMBED_MAX_RETRIES,
            )
            # Not installed as the process-wide `Settings.embed_model`: the
            # global would put this 3 s query model under anything else in the
            # process that reads it.

            self._initialized = True
            logger.info("LlamaIndex retriever components initialized")

        except ImportError as e:
            raise retrieval_dependency_error(e) from e

    async def retrieve(
        self,
        query: str,
        collection_name: str,
        top_k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> RetrievalResult:
        """Retrieve documents matching the query.

        The embedding call and the Qdrant query are synchronous; they run in a
        worker thread so a retrieval never stalls the server's event loop (and
        the per-collection fan-out in the knowledge tool actually parallelizes).
        """
        return await asyncio.to_thread(self._retrieve_sync, query, collection_name, top_k, filters)

    async def warm_query(self, query: str) -> None:
        """Embed ``query`` ahead of the search that will ask for it; never raises.

        The query embedding is a remote round trip (280-980 ms measured
        2026-09-24) that the knowledge tool pays before it can rank anything.
        A caller that knows the query before the search starts runs it here,
        and the search then finds it in the LRU (or waits for it in flight).
        It also absorbs the adapter's lazy initialisation on a cold process.
        """
        try:
            await asyncio.to_thread(self._warm_sync, query)
        except Exception:  # noqa: BLE001 - a warm-up is worth less than the turn
            logger.debug("Query warm-up failed", exc_info=True)

    async def find_text(
        self,
        collection_name: str,
        pattern: str,
        filters: dict[str, Any] | None = None,
        limit: int = 500,
        user_regex: bool = False,
        stem_phrases: list[str] | None = None,
    ) -> list[Chunk] | None:
        """Every chunk matching the regex ``pattern`` (``qdrant.retrieval.find_text``).

        ``user_regex`` marks a person's own pattern (``match="regex"``), which is read
        with a match timeout and raises ``PatternTooCostly`` when it backtracks.
        ``stem_phrases`` adds the chunks holding an inflected form of those phrases
        (the German-stemmed index, ``knowledge_search(stemmed=true)``).

        The vector store is the source of truth for chunk text, so this reads it
        there. No embedding, no ranking: a scroll over the collection, narrowed
        on the server by the words every match must hold and decided by the
        regex. A collection with no chunks is an empty answer, not a failure;
        a store error raises, so the caller can say the search did not run.
        """
        return await asyncio.to_thread(
            self._find_text_sync, collection_name, pattern, filters, limit, user_regex, stem_phrases
        )

    async def candidate_counts(
        self, collection_name: str, pattern: str, filters: dict[str, Any] | None = None, user_regex: bool = False
    ) -> dict[str, int] | None:
        """``file_name -> chunks that hold the pattern's words`` (``qdrant.retrieval.candidate_counts``), or None."""
        from ..qdrant import retrieval as qdrant_retrieval

        return await asyncio.to_thread(
            qdrant_retrieval.candidate_counts, collection_name, pattern, filters, user_regex=user_regex
        )

    async def fetch(
        self,
        collection_name: str,
        filters: dict[str, Any] | None,
        limit: int,
        order_by: str | None = None,
        start_from: tuple[int, int] | None = None,
    ) -> list[Chunk] | None:
        """The chunks ``filters`` admits, by scroll, with no query vector and no ranking.

        No embedding and no lazy adapter start-up: nothing here needs the
        embedder (``qdrant/reads.py``).
        """
        return await asyncio.to_thread(self._fetch_sync, collection_name, filters, limit, order_by, start_from)

    def _fetch_sync(
        self,
        collection_name: str,
        filters: dict[str, Any] | None,
        limit: int,
        order_by: str | None,
        start_from: tuple[int, int] | None = None,
    ) -> list[Chunk]:
        from ..qdrant import reads as qdrant_reads
        from ..qdrant.schema import CHUNK_ORDINAL_FIELD

        if start_from is None:
            hits = qdrant_reads.fetch(collection_name, filters, limit, order_by)
        else:
            hits = qdrant_reads.fetch_from(collection_name, filters, start_from, limit)
        chunks = [self._chunk_from_hit(hit) for hit in hits]
        for rank, (chunk, hit) in enumerate(zip(chunks, hits, strict=True)):
            chunk.retrieval_rank = rank
            # A reader that continues a read needs the chunk's place in its file, which the hit's
            # metadata leaves out as store-only (``payload.STORE_ONLY_FIELDS``).
            if isinstance(hit.payload.get(CHUNK_ORDINAL_FIELD), int):
                chunk.metadata.setdefault(CHUNK_ORDINAL_FIELD, hit.payload[CHUNK_ORDINAL_FIELD])
        return chunks

    def _find_text_sync(
        self,
        collection_name: str,
        pattern: str,
        filters: dict[str, Any] | None,
        limit: int,
        user_regex: bool = False,
        stem_phrases: list[str] | None = None,
    ) -> list[Chunk]:
        if not pattern or limit <= 0:
            return []
        from ..qdrant import retrieval as qdrant_retrieval
        from ..qdrant.schema import CHUNK_ORDINAL_FIELD

        # Every returned chunk matches, so none ranks above another; the
        # caller orders them by document and page (cosine 1.0).
        hits = qdrant_retrieval.find_text(
            collection_name, pattern, filters, limit, user_regex=user_regex, stem_phrases=stem_phrases
        )
        chunks = [self._chunk_from_hit(hit) for hit in hits]
        for chunk, hit in zip(chunks, hits, strict=True):
            # The count finds a chunk's overlap by its place in the file (``chunk_positions``), which
            # the hit's metadata leaves out as store-only.
            if isinstance(hit.payload.get(CHUNK_ORDINAL_FIELD), int):
                chunk.metadata.setdefault(CHUNK_ORDINAL_FIELD, hit.payload[CHUNK_ORDINAL_FIELD])
        return chunks

    def warm_components(self) -> None:
        """Pay the lazy initialisation now, so the first search of the process does not. Blocking.

        The preflight imports ``llama_index.core`` and ``qdrant_client`` and
        the embedding client is built (``_initialize_components``); the Qdrant
        read path is imported with them. None of it touches the network.
        Measured 2026-10-27 in a process that had done the boot imports:
        1.0 s + 0.6 s + 0.4 s from a warm disk cache, 6.1 s for the
        ``llama_index.core`` import alone from a cold one. On the first turn
        of a process that sat inside the round-0 prefetch, before its
        embedding call. The knowledge tool calls this at build time
        (``knowledge_layer.register``).
        """
        self._ensure_initialized()
        from ..qdrant import retrieval  # noqa: F401 - the read path's imports, paid here

    def _warm_sync(self, query: str) -> None:
        self._ensure_initialized()
        self._embed_query_cached(query)

    def _embed_query_cached(self, query: str) -> list[float]:
        """``query`` as this retriever's embedder embeds it, once per (model, text) (``QueryEmbeddingCache``)."""
        return self._query_embeddings.embed(
            (self.embed_model_name, query), lambda: self._embed_model.get_query_embedding(query)
        )

    def _cached_static_result(self, key: tuple[str, int, str, int, str]) -> RetrievalResult | None:
        with self._result_cache_lock:
            entry = self._result_cache.get(key)
            if entry is None:
                return None
            cached_at, result = entry
            if time.monotonic() - cached_at >= self.STATIC_RESULT_CACHE_TTL_SECONDS:
                self._result_cache.pop(key, None)
                if key in self._result_cache_order:
                    self._result_cache_order.remove(key)
                return None
            # Deep copy: callers merge/annotate results and must never mutate
            # the cached object.
            return result.model_copy(deep=True)

    def _store_static_result(self, key: tuple[str, int, str, int, str], result: RetrievalResult) -> None:
        with self._result_cache_lock:
            self._result_cache[key] = (time.monotonic(), result.model_copy(deep=True))
            if key in self._result_cache_order:
                self._result_cache_order.remove(key)
            self._result_cache_order.append(key)
            while len(self._result_cache_order) > self.RESULT_CACHE_MAX:
                evicted = self._result_cache_order.pop(0)
                self._result_cache.pop(evicted, None)

    def _static_cache_key(
        self, collection_name: str, query: str, top_k: int, filters: dict[str, Any] | None
    ) -> tuple[str, int, str, int, str] | None:
        """The result-cache key for this search, or ``None`` when its result may not be cached.

        No resolvable write version => no cache key at all. `None` is unknown,
        not 0: an entry stored or matched against a version we cannot vouch for
        is how one replica keeps answering from a corpus another replica has
        already changed. Read through instead -- the cache is an optimisation,
        the version is a correctness invariant.

        Membership is tested FIRST because resolving the version is a shared-cache
        round trip. Every query also fans out across the per-conversation session
        collection and any project collections, and none of those is cacheable, so
        resolving first spent one EVAL per non-cacheable collection per query on the
        retrieval hot path -- and grew a permanent memo entry for each -- to discard
        the answer immediately afterwards.
        """
        if collection_name not in self.STATIC_RESULT_CACHE_COLLECTIONS:
            return None
        version = collection_version(collection_name)
        if version is None:
            return None
        return (collection_name, version, query, top_k, _filters_fingerprint(filters))

    def _retrieve_sync(
        self,
        query: str,
        collection_name: str,
        top_k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> RetrievalResult:
        try:
            self._ensure_initialized()

            logger.info(f"LlamaIndexRetriever.retrieve: query='{query[:50]}...', collection={collection_name}")

            cache_key = self._static_cache_key(collection_name, query, top_k, filters)
            if cache_key is not None:
                cached = self._cached_static_result(cache_key)
                if cached is not None:
                    logger.info(f"Static retrieval cache hit for collection {collection_name}")
                    return cached

            chunks = self._qdrant_chunks(query, collection_name, top_k, filters)

            # State each hit's rank in this collection's FINAL order, after the lexical
            # fusion has had its say. `_rank_channel` in register.py documents reading it
            # here and nothing ever wrote it, so every cross-collection merge fell back to
            # list position. That fallback happens to be correct today -- position is the
            # final order -- but it made the field dead weight and the docstring false,
            # and it left the fuser unable to tell a genuine rank from a coincidence.
            for rank, chunk in enumerate(chunks):
                chunk.retrieval_rank = rank

            logger.info(f"LlamaIndex retrieval returned {len(chunks)} chunks")

            result = RetrievalResult(
                chunks=chunks,
                query=query,
                backend=self.backend_name,
                success=True,
            )
            if cache_key is not None:
                self._store_static_result(cache_key, result)
            return result

        except Exception as e:
            # ``exception``, not ``error``: these failures are routinely chained
            # (a RuntimeError raised *from* the ImportError that actually
            # explains it), and the bare f-string dropped the chain. Combined
            # with the 100-char cut below, issue #330 reached us as the string
            # "LlamaIndex retrieval failed: LlamaIndex dependencies not instal"
            # -- truncated mid-word, cause discarded, and the surviving half was
            # a misdescription of the fault. The log now carries the whole chain;
            # the caller-facing summary stays bounded.
            logger.exception("LlamaIndex retrieval failed")
            return RetrievalResult(
                chunks=[],
                query=query,
                backend=self.backend_name,
                success=False,
                error_message=f"Retrieval failed: {str(e)[:500]}",
            )

    def _identity(self) -> dict[str, str]:
        """The embedder this retriever's query vectors come from, as Qdrant collection metadata holds it."""
        return embed_fingerprint_metadata(self.embed_model_name, self.embed_base_url)

    def _qdrant_chunks(
        self, query: str, collection_name: str, top_k: int, filters: dict[str, Any] | None
    ) -> list[Chunk]:
        """One Query API call fusing dense, German BM25 and exact-term channels.

        The channels run server-side: the dense ranking, BM25 over the chunk
        text (with the EN->DE glossary terms), and per selective exact term the
        dense ranking restricted to chunks containing it. ``hybrid_search`` off
        leaves the dense channel alone.
        """
        from ..qdrant import retrieval as qdrant_retrieval

        query_vector = self._embed_query_cached(query)
        lexical_text, terms = "", []
        if self.hybrid_search:
            lexical_text, terms = self._lexical_inputs(query, collection_name)
        hits = qdrant_retrieval.search(
            collection_name,
            vector=query_vector,
            lexical_text=lexical_text,
            top_k=top_k,
            filters=filters,
            exact_terms=terms,
            identity=self._identity(),
        )
        return [self._chunk_from_hit(hit) for hit in hits]

    async def search_grouped(
        self,
        query: str,
        collection_names: list[str],
        groups: int,
        group_size: int,
        filters: dict[str, Any] | None = None,
        boost: dict[str, Any] | None = None,
    ) -> list[tuple[str, list[Chunk]]]:
        """One fused ranking over ``collection_names``, grouped per collection."""
        return await asyncio.to_thread(
            self._search_grouped_sync, query, collection_names, groups, group_size, filters, boost
        )

    def _search_grouped_sync(
        self,
        query: str,
        collection_names: list[str],
        groups: int,
        group_size: int,
        filters: dict[str, Any] | None,
        boost: dict[str, Any] | None,
    ) -> list[tuple[str, list[Chunk]]]:
        from ..qdrant import retrieval as qdrant_retrieval

        self._ensure_initialized()
        lexical_text, terms = "", []
        if self.hybrid_search:
            lexical_text, terms = self._lexical_inputs(query, collection_names)
        grouped = qdrant_retrieval.search_grouped(
            collection_names,
            vector=self._embed_query_cached(query),
            lexical_text=lexical_text,
            groups=groups,
            group_size=group_size,
            identity=self._identity(),
            filters=filters,
            boost=boost,
            exact_terms=terms,
        )
        return [(scope, [self._grouped_chunk(hit) for hit in hits]) for scope, hits in grouped]

    def _grouped_chunk(self, hit: Any) -> Chunk:
        """A grouped hit as a Chunk that also states its place in the one fused ranking."""
        from aiq_agent.knowledge.base import FUSED_SCORE_KEY

        chunk = self._chunk_from_hit(hit)
        chunk.metadata[FUSED_SCORE_KEY] = float(hit.fused)
        return chunk

    def embed_query(self, text: str) -> list[float]:
        """``text`` as the production embedder's query vector, from the same LRU and in-flight dedupe a search uses."""
        self._ensure_initialized()
        return self._embed_query_cached(text)

    def embedding_identity(self) -> dict[str, str]:
        """The embedder behind :meth:`embed_query`, as Qdrant collection metadata records it."""
        return self._identity()

    def _lexical_inputs(self, query: str, collection_names: str | Sequence[str]) -> tuple[str, list[str]]:
        """The BM25 text and exact terms for ``query``, priced against these collections (``lexical_query``)."""
        return lexical_inputs(query, collection_names, self._qdrant_term_df)

    def _chunk_from_hit(self, hit: Any) -> Chunk:
        """A Qdrant hit as a Chunk, through ``normalize``, with the hit's true cosine as its score."""
        from llama_index.core.schema import NodeWithScore
        from llama_index.core.schema import TextNode

        from ..qdrant.payload import chunk_metadata

        node = TextNode(text=hit.text, id_=hit.chunk_id, metadata=chunk_metadata(hit.payload))
        return self.normalize(NodeWithScore(node=node, score=float(hit.cosine)))

    def normalize(self, raw_result: Any) -> Chunk:
        """Convert LlamaIndex NodeWithScore to universal Chunk (``retrieved_chunks.chunk_from_node``)."""
        return chunk_from_node(raw_result)

    async def health_check(self) -> bool:
        """Whether Qdrant, the one store this retriever reads, answers."""
        from ..qdrant import retrieval as qdrant_retrieval

        return await asyncio.to_thread(qdrant_retrieval.healthy)
