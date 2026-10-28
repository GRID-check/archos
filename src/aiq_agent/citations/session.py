"""The registry a session and a turn share.

The per-session ContextVar, its persistence in the shared cache, and the per-turn capture log.
"""

from __future__ import annotations

import contextvars
import dataclasses
import logging
import os
import threading
from collections import OrderedDict
from collections.abc import Sequence
from typing import Any

from aiq_agent.citations.binding import LEGACY_BINDING_STATUS
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.entries import normalize_url
from aiq_agent.citations.registry import SourceRegistry
from aiq_agent.common.grounding_block import SourceRegion

logger = logging.getLogger(__name__)


_session_source_registry: contextvars.ContextVar[SourceRegistry | None] = contextvars.ContextVar(
    "_session_source_registry", default=None
)


_MAX_SESSION_REGISTRIES = 1000


_session_registries: OrderedDict[str, SourceRegistry] = OrderedDict()


_session_registries_lock = threading.Lock()


# Cross-turn citation state survives process restarts and replica moves via
# the shared cache (ADR-0020); the in-process LRU stays the fast path.
_REGISTRY_CACHE_PREFIX = "citations:"


_REGISTRY_CACHE_TTL_SECONDS = int(os.environ.get("CITATION_REGISTRY_TTL_SECONDS", "86400"))


def _registry_from_cached_entries(entries: Any) -> SourceRegistry:
    """Rebuild a session's registry from the cached dicts ``persist_session_registry`` wrote.

    Every field a later turn can still read off an entry is restored, including
    ``clause`` and ``score``: they reach the wire (``source_entry_to_wire``), so
    dropping them made a resumed conversation's chips lose the locus and the
    match strength that the same conversation had shown a minute earlier, on a
    replica move nobody could see.
    """
    from aiq_agent.common.norm_registry import LEGACY_NORM_RANK

    registry = SourceRegistry()
    if isinstance(entries, list):
        for item in entries:
            if isinstance(item, dict):
                try:
                    rank = item.get("rank")
                    status = item.get("binding_status", "unknown")
                    registry.add(
                        SourceEntry(
                            url=item.get("url"),
                            title=item.get("title"),
                            citation_key=item.get("citation_key"),
                            source_type=item.get("source_type", ""),
                            tool_name=item.get("tool_name", ""),
                            collection=item.get("collection"),
                            shelf=item.get("shelf"),
                            doc_class=item.get("doc_class"),
                            authored_by=item.get("authored_by"),
                            chunk_text=item.get("chunk_text"),
                            clause=item.get("clause", item.get("punkt")),
                            score=item.get("score"),
                            rank=LEGACY_NORM_RANK.get(rank, rank) if isinstance(rank, str) else rank,
                            binding_status=LEGACY_BINDING_STATUS.get(status, status),
                            regions=[
                                region
                                for region in map(SourceRegion.from_cached, item.get("regions") or [])
                                if region is not None
                            ],
                            read=item.get("read"),
                            page_end=item.get("page_end"),
                            project_id=item.get("project_id"),
                            project_name=item.get("project_name"),
                            project_status=item.get("project_status"),
                            project_federal_state_note=item.get("project_federal_state_note"),
                        )
                    )
                except Exception:
                    logger.debug("Skipping malformed cached source entry", exc_info=True)
    return registry


def persist_session_registry(session_id: str | None) -> None:
    """Write a session's captured sources to the shared cache (best-effort).

    Call after a turn that may have captured sources; synchronous (wrap in
    ``asyncio.to_thread`` from the event loop).
    """
    if not session_id:
        return
    with _session_registries_lock:
        registry = _session_registries.get(session_id)
    if registry is None or not registry._all:
        return
    from aiq_agent.common import cache

    cache.set_json(
        f"{_REGISTRY_CACHE_PREFIX}{session_id}",
        [dataclasses.asdict(entry) for entry in registry._all],
        _REGISTRY_CACHE_TTL_SECONDS,
    )


def get_or_create_session_registry(session_id: str | None) -> SourceRegistry:
    """Get or create a session-scoped SourceRegistry (LRU, max 1000 sessions).

    When session_id is None (e.g. CLI or batch modes with no conversation context),
    a fresh isolated SourceRegistry is returned on every call to prevent anonymous
    sessions from sharing state and leaking citations across concurrent requests.

    On a local miss the shared cache is consulted, so a conversation resumed on
    another replica (or after a restart) keeps its prior-turn citation sources.
    """
    if session_id is None:
        return SourceRegistry()
    from aiq_agent.common.profiler import annotate_current_span

    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            annotate_current_span(cache_citation_registry="hit")
            return _session_registries[session_id]

    # Shared-cache hydration outside the lock (network I/O must not serialize
    # unrelated sessions); the double-checked insert below resolves races.
    from aiq_agent.common import cache

    hydrated: SourceRegistry | None = None
    try:
        entries = cache.get_json(f"{_REGISTRY_CACHE_PREFIX}{session_id}")
        if entries:
            hydrated = _registry_from_cached_entries(entries)
    except Exception:
        logger.debug("Citation registry hydration failed for %s", session_id, exc_info=True)
    annotate_current_span(cache_citation_registry="hit-shared" if hydrated is not None else "miss")

    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            return _session_registries[session_id]
        registry = hydrated if hydrated is not None else SourceRegistry()
        _session_registries[session_id] = registry
        while len(_session_registries) > _MAX_SESSION_REGISTRIES:
            _session_registries.popitem(last=False)
        return registry


_turn_captured_sources: contextvars.ContextVar[list[SourceEntry] | None] = contextvars.ContextVar(
    "_turn_captured_sources", default=None
)


def begin_turn_capture() -> contextvars.Token:
    """Start recording this turn's captured sources. Pair with :func:`end_turn_capture`."""
    return _turn_captured_sources.set([])


def end_turn_capture(token: contextvars.Token) -> None:
    """Stop recording this turn's captured sources."""
    _turn_captured_sources.reset(token)


def record_turn_capture(entries: Sequence[SourceEntry]) -> None:
    """Note sources a tool call returned during this turn. No-op when not recording."""
    log = _turn_captured_sources.get()
    if log is not None:
        log.extend(entries)


def get_turn_captures() -> list[SourceEntry]:
    """Distinct sources this turn's tool calls returned, in first-seen order.

    Deduplicated on the same identity the registry uses (URL / document key), so
    a document returned by two queries in one turn counts once — but a document
    retrieved again in a LATER turn counts again for that turn, which
    ``registry.all_sources()`` could not express.
    """
    log = _turn_captured_sources.get()
    if not log:
        return []
    seen: set[str] = set()
    unique: list[SourceEntry] = []
    for entry in log:
        identity = normalize_url(entry.url) if entry.url else (entry.citation_key or "").lower()
        if not identity or identity in seen:
            continue
        seen.add(identity)
        unique.append(entry)
    return unique


def set_session_registry(registry: SourceRegistry | None) -> contextvars.Token:
    """Set the session-scoped SourceRegistry for the current async context."""
    return _session_source_registry.set(registry)


def reset_session_registry(token: contextvars.Token) -> None:
    """Restore the session-scoped SourceRegistry to its previous value."""
    _session_source_registry.reset(token)


def get_session_registry() -> SourceRegistry | None:
    """Get the session-scoped SourceRegistry for the current async context."""
    return _session_source_registry.get()
