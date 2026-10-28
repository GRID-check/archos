"""Which collections a knowledge search reads.

The base corpus, the project and office shelves, and the turn's own scope.
"""

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from knowledge_layer.register import KnowledgeRetrievalConfig

logger = logging.getLogger(__name__)


_warned_legacy_fallback = False


def _normalize_session_collection_name(session_id: str | None) -> str | None:
    """Return the UI session collection name for a raw conversation ID."""
    if not session_id:
        return None
    from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX

    if session_id.startswith(SESSION_COLLECTION_PREFIX):
        return session_id
    return f"{SESSION_COLLECTION_PREFIX}{session_id}"


def resolve_base_collection(config: KnowledgeRetrievalConfig) -> str:
    """The base corpus collection for retrieval, country-profile-aware.

    Retrieval scope keys off the project country's ``CountryProfile.corpus_collection``
    rather than a hardcoded name — the RAG-side seam for country expansion. The
    country is read from the injected project context (``resolve_country``); an
    unknown country / missing profile falls back to the configured
    ``collection_name``.

    Behavior-neutral for Austria: its profile's ``corpus_collection`` IS the
    configured ``oib_knowledge``, so this returns the same name and never logs.
    A second country ships its own registry file naming its own corpus, and
    retrieval follows without a config change.

    Fail-open: any lookup problem keeps the configured ``collection_name``.
    """
    try:
        from aiq_agent.common.country_profile import DEFAULT_COUNTRY
        from aiq_agent.common.country_profile import get_country_profile
        from aiq_agent.common.norm_registry import resolve_country
        from aiq_agent.project_context import get_profile_context_from_context

        # Precedence: an EXPLICIT non-default config wins (test/bench/dev configs
        # pointing at e.g. `test_collection` must never be silently re-routed);
        # the profile only re-routes the default corpus, which is what a real
        # multi-country deployment runs on.
        default_profile = get_country_profile(DEFAULT_COUNTRY)
        default_corpus = default_profile.corpus_collection if default_profile else config.collection_name
        if config.collection_name != default_corpus:
            return config.collection_name
        country = resolve_country(get_profile_context_from_context())
        profile = get_country_profile(country)
        if profile is not None and profile.corpus_collection and profile.corpus_collection != config.collection_name:
            logger.debug(
                "Retrieval base collection from country profile '%s': %s (config collection_name: %s)",
                country,
                profile.corpus_collection,
                config.collection_name,
            )
            return profile.corpus_collection
    except Exception:  # noqa: BLE001 — profile routing must never break retrieval
        logger.debug("Country-profile base-collection resolution failed; using configured collection", exc_info=True)
    return config.collection_name


def resolve_scoped_collections(
    config: KnowledgeRetrievalConfig, session_id: str | None, base_collection: str | None = None
):
    """
    Build the ordered, de-duplicated set of collections to search, WITH shelves.

    Layers (in order): base corpus, per-session collection, project collections.

    - When the ``X-Grid-Collection-Scope`` header is present via NAT context,
      it takes precedence and is returned directly regardless of legacy flags.
      Its entries carry the shelf the BFF stated (ADR-0047); a legacy
      bare-string entry states none, and that is left UNKNOWN rather than
      guessed back from the collection id.
    - Legacy: when ``use_fixed_collection`` is True, only the base collection is
      searched (the session collection is ignored). This preserves
      backward-compatible pinned behavior.
    - Otherwise the search set is assembled from the enabled layers and
      de-duplicated while preserving order. If nothing is selected, fall back to
      the base collection.

    In the legacy path the shelf is not inferred either: this function BUILDS the
    layers, so it knows which is the base corpus, which is the session store and
    which are project stores, and simply states it.

    Args:
        config: Knowledge retrieval configuration.
        session_id: The resolved per-session collection name (conversation_id) or None.
        base_collection: The base corpus collection to use (country-profile-resolved
            by the caller). Defaults to ``config.collection_name`` when omitted.

    Returns:
        Ordered, de-duplicated list of ``ScopedCollection`` (never empty).
    """
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.knowledge.scoping import ScopedCollection

    # Header-based collection scope takes precedence.
    try:
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        header_scope = get_scoped_collections_from_context()
        if header_scope:
            return header_scope
    except ImportError:
        pass

    global _warned_legacy_fallback
    if not _warned_legacy_fallback:
        _warned_legacy_fallback = True
        logger.warning(
            "X-Grid-Collection-Scope header not present, falling back to legacy config-based collection resolution"
        )

    base = base_collection if base_collection is not None else config.collection_name

    if config.use_fixed_collection:
        # Legacy pinned behavior: base only, never the session collection.
        return [ScopedCollection(base, Shelf.BASE)]

    session_collection = _normalize_session_collection_name(session_id)

    targets: list[ScopedCollection] = []
    if config.include_base_collection and base:
        targets.append(ScopedCollection(base, Shelf.BASE))
    if config.include_session_collection and session_collection:
        targets.append(ScopedCollection(session_collection, Shelf.SESSION))
    targets.extend(ScopedCollection(name, Shelf.PROJECT) for name in config.project_collections)

    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered: list[ScopedCollection] = []
    for entry in targets:
        if entry.collection and entry.collection not in seen:
            seen.add(entry.collection)
            ordered.append(entry)

    # Empty search set -> fall back to the base collection.
    if not ordered:
        return [ScopedCollection(base, Shelf.BASE)]
    return ordered


def _shelf_name(entry) -> str | None:
    shelf = getattr(entry, "shelf", None)
    if shelf is None:
        return None
    return getattr(shelf, "value", None) or str(shelf)


def restrict_scope_to_turn(entries):
    """Subtract corpora the composer did not ask for.

    The signed header is the authorization ceiling. Turn intent
    (``focus_shelf`` / ``source_preset``, mapped by ``shelves_for_turn``)
    may only drop entries from it, so a "summarize this upload" turn cannot
    be padded with Archiv hits (#429) and a Projektunterlagen chip cannot
    keep searching the Büroablage (#436).
    """
    try:
        from aiq_agent.common.focus_file import get_turn_shelves

        allowed = get_turn_shelves()
    except Exception:
        allowed = None
    if not allowed:
        return entries
    filtered = [entry for entry in entries if _shelf_name(entry) in allowed or _shelf_name(entry) is None]
    return filtered if filtered else entries


def _resolve_target_collections(
    config: KnowledgeRetrievalConfig, session_id: str | None, base_collection: str | None = None
) -> list[str]:
    """Names-only projection of :func:`resolve_scoped_collections`.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    return [entry.collection for entry in resolve_scoped_collections(config, session_id, base_collection)]


#: The ``chunking`` value the base corpus uses for text that is not evidence.
#:
#: ``clause_documents`` (``llamaindex/clause_chunking.py``) cuts a Punkt-structured
#: Richtlinie into one chunk per numbered Punkt, tagged ``chunking: "clause"``, and
#: emits everything outside that run -- the cover page and the Impressum -- as
#: per-page Documents tagged ``chunking: "page"``. Neither is citable: pdfplumber
#: returns the cover's display type as garble, and the Impressum is furniture. A
#: title-shaped query ("OIB-Richtlinie 2 Ausgabe Mai 2023") matched exactly those
#: two, so an overview question came back as four cover pages at page 1 and the
#: model learned nothing.
#:
#: The exclusion is a STORE filter rather than a post-retrieval drop because a
#: dropped hit still costs its candidate slot. It is ``$ne`` rather than a
#: whitelist of ``clause`` on purpose: only Punkt-structured documents carry the
#: key at all -- Begriffsbestimmungen, Zitierte Normen, project uploads and office
#: files carry no ``chunking`` key -- and a whitelist would delete them from
#: search. ``$ne`` KEEPS records that lack the key (``qdrant.scope.translate``
#: compiles it to a ``must_not``), so the keyless majority of the corpus is
#: untouched. ``tests/knowledge_layer_tests/test_page_chunk_exclusion.py``
#: round-trips that through a real Qdrant, so a change that altered the
#: semantics fails a test rather than emptying the corpus silently.
#:
#: ``read_passage`` builds its own filters and is deliberately NOT subject to
#: this: naming page 1 of a Richtlinie is an explicit request, not a similarity hit.
_NON_EVIDENCE_CHUNKING = "page"


def base_collection_filters(config: KnowledgeRetrievalConfig, caller_filters: dict | None) -> dict:
    """Base-collection metadata filter: the page-chunk exclusion, file exclusions, caller filters.

    Three clauses, AND-ed, applied to the base collection only (session/project
    collections are user content and are never filtered):

    1. ``chunking != "page"``, always. See :data:`_NON_EVIDENCE_CHUNKING`.
    2. ``exclude_file_names`` as a ``file_name NOT IN [...]`` clause, when configured.
    3. the caller's optional ``filters`` dict, when given.

    Never returns None: clause 1 holds for every base-corpus search.
    """
    clauses: list[dict] = [{"chunking": {"$ne": _NON_EVIDENCE_CHUNKING}}]
    excluded = sorted(set(config.exclude_file_names))
    if excluded:
        clauses.append({"file_name": {"$nin": excluded}})
    if caller_filters:
        clauses.append(caller_filters)

    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}
