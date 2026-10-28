from __future__ import annotations

import time
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import redact_db_url

if TYPE_CHECKING:
    pass

from aiq_agent.knowledge.document_metadata_constants import ENGINE_CACHE_MAX_SIZE
from aiq_agent.knowledge.document_metadata_constants import ENGINE_CACHE_TTL_SECONDS
from aiq_agent.knowledge.document_metadata_constants import logger


def _get_or_create_sync_engine(cls, db_url: str):
    """Get or create a sync SQLAlchemy engine with TTL-based caching."""
    with cls._cache_lock:
        cls._cleanup_stale_engines(cls._sync_engine_cache)

        if db_url in cls._sync_engine_cache:
            engine, _ = cls._sync_engine_cache[db_url]
            cls._sync_engine_cache[db_url] = (engine, time.monotonic())
            return engine

        from sqlalchemy import create_engine

        normalized_url = _normalize_db_url(db_url, async_mode=False)
        is_sqlite = normalized_url.startswith("sqlite")
        connect_args = {"check_same_thread": False, "timeout": 30} if is_sqlite else {}

        engine = create_engine(
            normalized_url,
            pool_pre_ping=True,
            pool_size=1 if is_sqlite else 5,
            max_overflow=0 if is_sqlite else 10,
            connect_args=connect_args,
        )
        cls._sync_engine_cache[db_url] = (engine, time.monotonic())
        logger.debug("Created sync engine for %s", redact_db_url(db_url))
        return engine


def _get_or_create_async_engine(cls, db_url: str):
    """Get or create an async SQLAlchemy engine with TTL-based caching."""
    with cls._cache_lock:
        cls._cleanup_stale_engines(cls._async_engine_cache)

        if db_url in cls._async_engine_cache:
            engine, _ = cls._async_engine_cache[db_url]
            cls._async_engine_cache[db_url] = (engine, time.monotonic())
            return engine

        from sqlalchemy.ext.asyncio import create_async_engine

        normalized_url = _normalize_db_url(db_url, async_mode=True)
        is_sqlite = normalized_url.startswith("sqlite")

        engine = create_async_engine(
            normalized_url,
            pool_pre_ping=True,
            pool_size=1 if is_sqlite else 5,
            max_overflow=0 if is_sqlite else 10,
        )
        cls._async_engine_cache[db_url] = (engine, time.monotonic())
        logger.debug("Created async engine for %s", redact_db_url(db_url))
        return engine


def _cleanup_stale_engines(cls, cache: dict[str, tuple[Any, float]]):
    """Remove engines that haven't been used recently."""
    now = time.monotonic()
    stale_keys = [key for key, (_, last_used) in cache.items() if now - last_used > ENGINE_CACHE_TTL_SECONDS]
    for key in stale_keys:
        engine, _ = cache.pop(key, (None, 0))
        if engine:
            try:
                engine.dispose()
                logger.debug("Disposed stale engine for %s", redact_db_url(key))
            except Exception as e:
                logger.warning("Failed to dispose engine: %s", e)

    if len(cache) > ENGINE_CACHE_MAX_SIZE:
        sorted_entries = sorted(cache.items(), key=lambda x: x[1][1])
        for key, (engine, _) in sorted_entries[: len(sorted_entries) - ENGINE_CACHE_MAX_SIZE]:
            cache.pop(key, None)
            if engine:
                try:
                    engine.dispose()
                except RuntimeError, OSError:
                    pass


async def dispose_engine_async(cls, db_url: str):
    """Awaitable variant of :meth:`dispose_engine` for callers inside a
    running event loop.

    The synchronous variant can only *schedule* the close of an async
    engine (``loop.create_task``); when the caller's loop is about to shut
    down — e.g. an async test's teardown — that task never runs, the
    aiosqlite connection stays open and a Windows SQLite temp file remains
    locked. Awaiting the dispose directly closes it before the caller
    proceeds.
    """
    with cls._cache_lock:
        engine = cls._sync_engine_cache.pop(db_url, (None,))[0]
        if engine:
            try:
                engine.dispose()
            except RuntimeError, OSError:
                pass

        engine = cls._async_engine_cache.pop(db_url, (None,))[0]
        if engine:
            try:
                await engine.dispose()
            except RuntimeError, OSError:
                pass


def dispose_engine(cls, db_url: str):
    """Dispose the cached engines for one db_url (e.g. temp-file teardown).

    Unlike ``dispose_all_engines`` this leaves every other cached store
    intact — engine caches are shared process-globally, so tests that point
    the store at a fresh temp SQLite file must release exactly that file's
    handle before removing the directory (Windows: unlink of an open SQLite
    file fails with PermissionError).
    """
    import asyncio

    with cls._cache_lock:
        engine = cls._sync_engine_cache.pop(db_url, (None,))[0]
        if engine:
            try:
                engine.dispose()
            except RuntimeError, OSError:
                pass

        engine = cls._async_engine_cache.pop(db_url, (None,))[0]
        if engine:
            try:
                coro = engine.dispose()
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(coro)
                except RuntimeError:
                    asyncio.run(coro)
            except RuntimeError, OSError:
                pass


def dispose_all_engines(cls):
    """Dispose all cached engines (for shutdown)."""
    import asyncio

    with cls._cache_lock:
        for key, (engine, _) in list(cls._sync_engine_cache.items()):
            try:
                engine.dispose()
            except RuntimeError, OSError:
                pass
        cls._sync_engine_cache.clear()

        for key, (engine, _) in list(cls._async_engine_cache.items()):
            try:
                coro = engine.dispose()
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(coro)
                except RuntimeError:
                    asyncio.run(coro)
            except RuntimeError, OSError:
                pass
        cls._async_engine_cache.clear()

        cls._tables_initialized.clear()
