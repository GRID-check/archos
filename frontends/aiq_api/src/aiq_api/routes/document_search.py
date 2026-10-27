"""Semantic document-search endpoint.

Deterministic vector search over a single collection's already-embedded chunks
(NO LLM, no agent loop). The low-level structured retriever returns per-chunk
hits; this route aggregates them into a document-centric result — one hit per
file (its best-scoring chunk), sorted by score descending.
"""

import logging
import os
from typing import Any

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request

from aiq_agent.knowledge.base import FUSED_SCORE_KEY
from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.scoping import _normalize_collection_name
from aiq_agent.observability.direct_trace import observed_retrieval
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext

from ..models.requests import DocumentSearchHit
from ..models.requests import DocumentSearchRequest
from ..models.requests import DocumentSearchResponse
from ..models.requests import GroupedDocumentSearchRequest
from ..models.requests import GroupedSearchFilters
from .collections import _require_ingestor
from .collections import require_collection

logger = logging.getLogger(__name__)

# Max chars kept from a document's best-matching chunk as its snippet, unless the
# request asks for more (``DocumentSearchRequest.snippet_max_chars``).
SNIPPET_MAX_CHARS = 300


def _require_auth() -> bool:
    """Whether the backend is running in WorkOS-authenticated mode (REQUIRE_AUTH=true).

    Same flag ``plugin.py`` / ``AuthMiddleware`` / the envelope-enforcement
    middleware read. In authenticated deployments the BFF is the only intended
    caller of this route and always forwards a signed collection scope, so a
    request that arrives with no scope is not a legitimate one; in anonymous
    mode (REQUIRE_AUTH=false) there is no tenant boundary to enforce.
    """
    return os.getenv("REQUIRE_AUTH", "false").lower() == "true"


def _verified_collection_scope(http_request: Request) -> list[str] | None:
    """Return the caller's collection scope from the SIGNED request-context envelope.

    Defense-in-depth for cross-tenant reads (PB-SYNTH-4). This route is a plain
    FastAPI route, not a NAT workflow endpoint, so NAT's ``Context.metadata.headers``
    is never populated for it (verified empirically) — ``get_collection_scope_from_context()``
    used by the chat retrieval path would always read ``None`` here. We therefore
    parse the caller's actual HTTP headers with the SAME verified-envelope parser
    that ``get_collection_scope_from_context()`` prefers under the hood
    (``GridRequestContext.from_envelope``), fed the request headers directly.

    Only the HMAC-signed ``X-Grid-Request-Context`` envelope is honored — never
    the raw, forgeable ``X-Grid-Collection-Scope`` header on its own — because
    collection names are guessable (``proj_<uuid>`` / ``archiv_<orgId>`` / ``office_shelf_<orgId>``), so an
    attacker who could set a raw scope header would read another tenant's corpus.
    When ``GRID_INTERNAL_API_TOKEN`` is unset (dev), ``from_envelope`` accepts the
    envelope on shape alone, mirroring the rest of the codebase's fail-open dev
    posture. Returns ``None`` when no valid signed envelope is present.
    """
    ctx = GridRequestContext.from_envelope(
        http_request.headers.get(REQUEST_CONTEXT_ENVELOPE_HEADER),
        http_request.headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
        os.environ.get("GRID_INTERNAL_API_TOKEN"),
    )
    if ctx is None:
        return None
    return ctx.collection_scope


def _authorize_collection(http_request: Request, collection_name: str) -> None:
    """Reject a search whose target collection is outside the caller's signed scope.

    Mirrors the chat retrieval authorization boundary (``knowledge/scoping.py``):
    a turn may only read the collections the BFF signed into its request context.
    Enforcement matrix:

    - A valid signed scope is present → the target ``collection_name`` MUST be in
      it, else ``404`` (indistinguishable from a genuinely missing collection, so
      the route never confirms the existence of an out-of-scope/other-tenant
      collection).
    - No signed scope AND ``REQUIRE_AUTH=true`` → ``403``: an authenticated-mode
      deployment's only intended caller (the BFF) always forwards the signed
      scope, so its absence means the request did not come through the trusted
      path.
    - No signed scope AND anonymous mode (``REQUIRE_AUTH=false``) → allowed: there
      is no tenant boundary to enforce (parity with the pre-envelope behavior and
      the envelope-enforcement middleware, which also no-ops when auth is off).

    RESIDUAL TRUST BOUNDARY: ``GridContextEnvelopeMiddleware`` exempts
    ``/v1/collections`` from its deny-by-default envelope rule, and this route's
    BFF caller is a server-side service fetch carrying no WorkOS bearer token
    anyway, so the middleware would classify it as non-jwt and never enforce.
    The check here is the envelope's equivalent for this specific read route.
    """
    scope = _verified_collection_scope(http_request)
    if scope is not None:
        allowed = {_normalize_collection_name(name) for name in scope}
        if _normalize_collection_name(collection_name) not in allowed:
            # Same 404 as an unknown collection: never reveal that an out-of-scope
            # (possibly other-tenant) collection exists.
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")
    elif _require_auth():
        raise HTTPException(
            status_code=403,
            detail="missing or invalid X-Grid-Request-Context envelope",
        )


def _snippet(content: str, limit: int = SNIPPET_MAX_CHARS) -> str:
    """Truncate chunk content to a short snippet, on a whitespace-trimmed boundary."""
    text = (content or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _aggregate_hits(
    chunks: list[Chunk], collection_name: str, top_k_files: int, snippet_max_chars: int = SNIPPET_MAX_CHARS
) -> list[DocumentSearchHit]:
    """Group chunks by ``file_name`` and keep each file's max-score chunk.

    Within this one collection ``file_name`` uniquely identifies a document
    (v1), so a repeated filename is the same document — we keep its best-scoring
    chunk as the file's representative hit. Files are sorted by that max score
    descending and capped at ``top_k_files``.
    """
    best_by_file: dict[str, Chunk] = {}
    for chunk in chunks:
        existing = best_by_file.get(chunk.file_name)
        if existing is None or chunk.score > existing.score:
            best_by_file[chunk.file_name] = chunk

    hits = [
        DocumentSearchHit(
            file_name=chunk.file_name,
            score=chunk.score,
            snippet=_snippet(chunk.content, snippet_max_chars),
            page_number=chunk.page_number,
            collection=chunk.metadata.get("collection", collection_name),
        )
        for chunk in best_by_file.values()
    ]
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits[:top_k_files]


#: Chunks fetched per collection for each document a group may return: a
#: document's best chunk is not always its first-ranked one.
GROUP_CHUNKS_PER_FILE = 3


def _fused(chunk: Chunk) -> float:
    """A chunk's place in the one fused ranking (``FUSED_SCORE_KEY``); 0 from a backend that states none."""
    value = chunk.metadata.get(FUSED_SCORE_KEY)
    return float(value) if isinstance(value, (int, float)) else 0.0


def _document_id(chunk: Chunk) -> str | None:
    """The document's BFF id from the chunk's metadata, when the store put it there."""
    value = chunk.metadata.get("grid_document_id")
    return value if isinstance(value, str) and value else None


def _ranked_group_hits(
    grouped: list[tuple[str, list[Chunk]]], files_per_group: int, snippet_max_chars: int
) -> list[DocumentSearchHit]:
    """Every group's best documents as one list, ordered DOCUMENT by document across the groups.

    Each document is represented by its best chunk in the fused ranking, at
    most ``files_per_group`` per collection, and the documents are ordered by
    that chunk's fused score, ties in group order. A group-major list (the
    best collection's documents, then the next collection's) would let one
    project's weak documents fill a caller's first page ahead of another
    project's strong one. The order IS the ranking: a caller keeps it rather
    than re-sorting by ``score``, each document's cosine.

    ``collection`` is the group key, the collection that was searched and
    authorized, never what a chunk's own metadata claims (the
    single-collection search makes the same choice in the BFF).
    """
    ranked: list[tuple[float, int, int, DocumentSearchHit]] = []
    for group_index, (collection, chunks) in enumerate(grouped):
        best: dict[str, Chunk] = {}
        for chunk in chunks:
            current = best.get(chunk.file_name)
            if current is None or (_fused(chunk), chunk.score) > (_fused(current), current.score):
                best[chunk.file_name] = chunk
        documents = sorted(best.values(), key=lambda chunk: (_fused(chunk), chunk.score), reverse=True)
        for file_index, chunk in enumerate(documents[:files_per_group]):
            hit = DocumentSearchHit(
                file_name=chunk.file_name,
                score=chunk.score,
                snippet=_snippet(chunk.content, snippet_max_chars),
                page_number=chunk.page_number,
                collection=collection,
                grid_document_id=_document_id(chunk),
            )
            ranked.append((-_fused(chunk), group_index, file_index, hit))
    ranked.sort(key=lambda entry: entry[:3])
    return [entry[3] for entry in ranked]


#: A superseded Fassung stays out of the ranking (ADR-0099: search leaves it out
#: unless asked for by name, and the grouped search names no file). ``$ne``
#: keeps a point the mirror has not stamped yet, as ``knowledge_search``'s
#: pre-filter and the similar-passages query do; the BFF checks the row again.
CURRENT_REVISIONS: dict[str, Any] = {"superseded": {"$ne": True}}


class MatchesNothing(Exception):
    """The filters admit no passage: every ``refers_to`` text read as no reference at all."""


def reference_values(terms: list[str]) -> list[str]:
    """``terms`` as the ``references`` values a document carries, through the pushdown ``knowledge_search`` uses.

    A ``kind:key`` token (``norm:önorm b 1600``, the projection's own spelling)
    is taken as it stands; anything else is read as a person names a reference
    (``prefilter.plan``: ``references.reference_keys_for``, then
    ``payload.reference_value``). Any of the terms, so the values are their union.
    """
    from knowledge_layer.qdrant import prefilter
    from knowledge_layer.qdrant.payload import reference_value
    from knowledge_layer.references import KINDS

    values: list[str] = []
    for term in terms:
        kind, sep, key = term.partition(":")
        if sep and kind in KINDS and key.strip() == key and key:
            values.append(reference_value(kind, key))
            continue
        pushdown = prefilter.plan(doc_class=None, folder=None, file_name=None, refers_to=term)
        values.extend(pushdown.references)
    return list(dict.fromkeys(values))


def _reading_clauses(filters: GroupedSearchFilters) -> list[dict[str, Any]]:
    """The conditions on what ingestion put on every chunk: the document, its dossier type, its references.

    Raises :class:`MatchesNothing` when ``refers_to`` was asked and named no
    reference: dropping the condition would widen the search instead.
    """
    from knowledge_layer.qdrant import prefilter

    parts: list[dict[str, Any]] = []
    if filters.document_ids:
        parts.append({"grid_document_id": {"$in": list(dict.fromkeys(filters.document_ids))}})
    if filters.reading_types:
        parts.append({"document_type": {"$in": list(dict.fromkeys(filters.reading_types))}})
    if filters.refers_to:
        references = tuple(reference_values(filters.refers_to))
        if not references:
            raise MatchesNothing
        parts.extend(prefilter.Pushdown(hide_superseded=False, references=references).clauses(user_shelf=False))
    return parts


def grouped_filters(filters: GroupedSearchFilters | None) -> dict[str, Any]:
    """The typed request filters in the retriever's filter grammar, always with the superseded exclusion.

    The grammar is what ``knowledge_layer.qdrant.scope`` compiles into the
    scope filter, so these become pre-filters inside the one query. Each
    tag group is a separate any-of, as the BFF's ``matchesTags`` reads them.
    Raises :class:`MatchesNothing` for filters no passage can meet.
    """
    if filters is None:
        return CURRENT_REVISIONS
    parts: list[dict[str, Any]] = []
    for group in (filters.document_types, filters.disciplines):
        if group:
            parts.append({"tags": {"$in": list(group)}})
    parts.extend(_reading_clauses(filters))
    if filters.project_facts is not None:
        facts = filters.project_facts.to_store()
        for key, value in facts.items():
            values = [value] if isinstance(value, str) else list(value or [])
            if values:
                parts.append({f"project_facts.{key}": {"$in": values}})
    if filters.project_status:
        parts.append({"project_status": {"$in": list(filters.project_status)}})
    if not parts:
        return CURRENT_REVISIONS
    return {"$and": [*parts, CURRENT_REVISIONS]}


#: The trace the workspace search's content query files under, and the observation inside it.
WORKSPACE_SEARCH_FEATURE = "workspace-search"
WORKSPACE_SEARCH_STEP = "retrieve.workspace_search"
#: Collections whose hit counts the trace names, at most (the BFF names up to 500).
TRACE_COLLECTION_LIMIT = 50


def _filter_fields(filters: GroupedSearchFilters | None) -> list[str]:
    """The filter fields a request set (never their values)."""
    return sorted(filters.model_dump(exclude_defaults=True, exclude_none=True)) if filters else []


def prefilter_mode(filters: GroupedSearchFilters | None) -> str:
    """How the BFF narrowed the content query before ranking (ADR-0136 item 5), as a label.

    ``document_ids``: the SQL candidates themselves, few enough to name.
    ``payload``: too many to name, so what the documents are and cite
    (``reading_types``, ``refers_to``) or their tags. ``none``: only the
    superseded exclusion.
    """
    if filters is not None and filters.document_ids:
        return "document_ids"
    return "payload" if _filter_fields(filters) else "none"


def _trace_query(request: GroupedDocumentSearchRequest, collections: list[str]) -> dict[str, Any]:
    """The trace's input: the ask as data. The words stay out (ADR-0089); their length and word count do not."""
    return {
        "text_chars": len(request.query),
        "text_tokens": len(request.query.split()),
        "collections": len(collections),
        "groups": request.groups,
        "files_per_group": request.files_per_group,
        "prefilter": prefilter_mode(request.filters),
        "document_ids": len(request.filters.document_ids) if request.filters else 0,
        "filter_fields": _filter_fields(request.filters),
    }


def _trace_picks(grouped: list[tuple[str, list[Chunk]]], hits: list[DocumentSearchHit]) -> dict[str, Any]:
    """The trace's output: counts, by collection; never a passage, a file name or the words."""
    per_collection: dict[str, int] = {}
    for hit in hits:
        per_collection[hit.collection] = per_collection.get(hit.collection, 0) + 1
    ranked = sorted(per_collection.items(), key=lambda entry: entry[1], reverse=True)
    return {
        "candidates": sum(len(chunks) for _, chunks in grouped),
        "documents": len(hits),
        "with_document_id": sum(1 for hit in hits if hit.grid_document_id),
        "collections_with_hits": len(per_collection),
        "hits_per_collection": dict(ranked[:TRACE_COLLECTION_LIMIT]),
    }


async def _search_grouped(
    request: GroupedDocumentSearchRequest, collections: list[str]
) -> tuple[list[DocumentSearchHit], list[tuple[str, list[Chunk]]]]:
    """The grouped search's documents, and the groups it ranked them from; none when the filters admit nothing."""
    from aiq_agent.knowledge.factory import get_active_retriever

    try:
        filters = grouped_filters(request.filters)
    except MatchesNothing:
        return [], []
    try:
        grouped = await get_active_retriever().search_grouped(
            request.query,
            collections,
            groups=request.groups,
            group_size=request.files_per_group * GROUP_CHUNKS_PER_FILE,
            filters=filters,
            boost=(
                {"facts": request.boost.facts.to_store(), "weights": request.boost.weights.to_store()}
                if request.boost
                else None
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Grouped document search failed")
        raise HTTPException(status_code=500, detail="grouped document search failed") from e
    return _ranked_group_hits(grouped, request.files_per_group, request.snippet_max_chars), grouped


def add_document_search_routes(router: APIRouter):
    """Add semantic document-search routes to the FastAPI app."""

    @router.post(
        "/v1/collections/search",
        response_model=DocumentSearchResponse,
        tags=["documents"],
        summary="One semantic search ranked across many collections",
    )
    async def search_across_collections(
        request: GroupedDocumentSearchRequest, http_request: Request
    ) -> DocumentSearchResponse:
        """Rank every named collection's documents in one query (Qdrant, ADR-0116).

        Every collection must be in the caller's signed scope, as for the
        single-collection search. Qdrant is the only store (ADR-0115), so the
        BFF has nothing to fall back to: a failed search is a 500, as for the
        single-collection search, and the BFF surfaces it as an upstream error.

        The workspace search (``purpose="workspace_search"``) is a root trace
        ``workspace-search`` holding one ``retrieve.workspace_search``
        retriever observation; no NAT run sees this route. Other callers are
        traced where they run (``retrieve.project_lookup``).
        """
        collections = list(dict.fromkeys(request.collections))
        for collection in collections:
            _authorize_collection(http_request, collection)
        if request.purpose != "workspace_search":
            hits, _ = await _search_grouped(request, collections)
            return DocumentSearchResponse(hits=hits)
        mode = prefilter_mode(request.filters)
        with observed_retrieval(
            WORKSPACE_SEARCH_FEATURE,
            step=WORKSPACE_SEARCH_STEP,
            query=_trace_query(request, collections),
            metadata={"prefilter": mode, "collections": len(collections)},
        ) as trace:
            hits, grouped = await _search_grouped(request, collections)
            picks = _trace_picks(grouped, hits)
            trace.finish(
                picks,
                {"prefilter": mode, "candidates": picks["candidates"], "documents": picks["documents"]},
            )
        return DocumentSearchResponse(hits=hits)

    @router.post(
        "/v1/collections/{collection_name}/search",
        response_model=DocumentSearchResponse,
        tags=["documents"],
        summary="Semantic document search within a collection",
    )
    async def search_documents(
        collection_name: str,
        request: DocumentSearchRequest,
        http_request: Request,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> DocumentSearchResponse:
        """Deterministic semantic search over one collection's embedded chunks.

        Retrieves the top ``top_k`` chunks for the query, then aggregates them
        into a document-centric result: one hit per file (its best-scoring
        chunk), sorted by score descending, capped at ``top_k_files``. No LLM or
        agent loop is involved.
        """
        # Defense-in-depth (PB-SYNTH-4): only search collections the caller's
        # signed request-context scopes it to. Runs BEFORE the existence probe so
        # an out-of-scope collection is indistinguishable from a missing one.
        _authorize_collection(http_request, collection_name)

        # Verify collection exists (same 404 contract as the document routes).
        await require_collection(ingestor, collection_name)

        try:
            from aiq_agent.knowledge.factory import get_active_retriever

            result = await get_active_retriever().retrieve(
                query=request.query,
                collection_name=collection_name,
                top_k=request.top_k,
                filters=None,
            )
            hits = _aggregate_hits(result.chunks, collection_name, request.top_k_files, request.snippet_max_chars)
            return DocumentSearchResponse(hits=hits)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Document search failed for collection '{collection_name}': {e}")
            raise HTTPException(status_code=500, detail=str(e))
