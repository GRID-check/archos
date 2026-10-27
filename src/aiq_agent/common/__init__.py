"""Common utilities for the AI-Q blueprint."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.lazy_exports import lazy_exports

if TYPE_CHECKING:
    from langgraph.checkpoint.base import BaseCheckpointSaver
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
    from psycopg_pool import AsyncConnectionPool

# What this package re-exports, and from where. Loaded on first use (PEP 562),
# not when the package is: importing `aiq_agent.common.turn_status` executes
# this file first, and the eager form made every such import pay for LangGraph's
# checkpointers, psycopg's pool, NAT and LangChain, ~1.7 s of a 2.0 s import
# (docs/audit/blast-radius-2026-10.md). `tests/test_import_weight.py` keeps it
# that way.
_LAZY: dict[str, str] = {
    "BudgetGuardCallback": ".budget_guard",
    "RunBudgetExceededError": ".budget_guard",
    "create_budget_guard_callback": ".budget_guard",
    "VerboseTraceCallback": ".callbacks",
    "SourceRegistry": ".citation_verification",
    "get_or_create_session_registry": ".citation_verification",
    "get_session_registry": ".citation_verification",
    "register_source_parser": ".citation_verification",
    "reset_session_registry": ".citation_verification",
    "sanitize_report": ".citation_verification",
    "set_session_registry": ".citation_verification",
    "verify_citations": ".citation_verification",
    "get_all_tool_refs": ".data_source_registry",
    "get_source_id_for_tool": ".data_source_registry",
    "DEFAULT_DATA_SOURCES": ".data_sources",
    "DISABLED_SOURCES_HEADER": ".data_sources",
    "all_mapped_tools_filtered_out": ".data_sources",
    "disabled_source_notice": ".data_sources",
    "extract_messages_and_sources": ".data_sources",
    "filter_tools_by_sources": ".data_sources",
    "format_data_source_tools": ".data_sources",
    "get_disabled_sources_from_context": ".data_sources",
    "parse_data_sources": ".data_sources",
    "parse_disabled_sources": ".data_sources",
    "unavailable_source_ids": ".data_sources",
    "redact_db_url": ".db_utils",
    "build_human_prompt": ".human_prompt",
    "extract_user_response": ".human_prompt",
    "extract_json": ".json_utils",
    "OrgLLMCredential": ".llm_credentials",
    "apply_org_credential": ".llm_credentials",
    "get_org_llm_credential_from_context": ".llm_credentials",
    "resolve_org_llm_credential": ".llm_credentials",
    "apply_openrouter_structured_defaults": ".llm_factory",
    "enforce_chat_request_contract": ".llm_factory",
    "get_langchain_llm": ".llm_factory",
    "strict_json_response_format": ".llm_factory",
    "strict_response_format": ".llm_factory",
    "LLMProvider": ".llm_provider",
    "LLMRole": ".llm_provider",
    "CONTINUATION_TURN": ".message_contract",
    "ends_on_model_turn": ".message_contract",
    "normalize_chat_request": ".message_contract",
    "content_to_text": ".message_utils",
    "get_latest_user_query": ".message_utils",
    "MODEL_OVERRIDES_HEADER": ".model_overrides",
    "AgentGroup": ".model_overrides",
    "apply_model_override": ".model_overrides",
    "apply_zdr_routing": ".model_overrides",
    "get_model_overrides_from_context": ".model_overrides",
    "get_zdr_only_from_context": ".model_overrides",
    "is_reasoning_incompatible_error": ".model_overrides",
    "parse_model_overrides": ".model_overrides",
    "sanitize_model_overrides": ".model_overrides",
    "SpanClosingProfilerHandler": ".nat_step_repair",
    "load_prompt": ".prompt_utils",
    "render_prompt_template": ".prompt_utils",
    "get_reasoning_efforts": ".reasoning_settings",
    "format_tool_unavailability_error": ".tool_validation",
    "format_user_facing_tool_error": ".tool_validation",
    "validate_tool_availability": ".tool_validation",
    # The checkpointer backends, read through `_lazy` below so a test that
    # patches `aiq_agent.common.AsyncPostgresSaver` still reaches the call.
    "AsyncConnectionPool": "psycopg_pool",
    "AsyncPostgresSaver": "langgraph.checkpoint.postgres.aio",
    "AsyncSqliteSaver": "langgraph.checkpoint.sqlite.aio",
    "JsonPlusSerializer": "langgraph.checkpoint.serde.jsonplus",
    "aiosqlite": "aiosqlite",
    "dict_row": "psycopg.rows",
}


__getattr__ = lazy_exports(__name__, _LAZY)


def _lazy(name: str) -> Any:
    """`name` as this module holds it now: patched by a test, loaded, or loaded on this call."""
    return getattr(sys.modules[__name__], name)


logger = logging.getLogger(__name__)

# Shared checkpointer caches
_checkpointers: dict[str, BaseCheckpointSaver] = {}
_postgres_pools: dict[str, AsyncConnectionPool] = {}
# Serializes checkpointer creation: connect/setup are awaits, so a bare
# check-then-act would let two concurrent callers both connect and leak the
# loser's connection when it is overwritten in the cache.
_checkpointer_lock = asyncio.Lock()


def _pool_int_env(name: str, default: int) -> int:
    """Positive-int env override for pool sizing; falls back on unset/invalid/≤0."""
    try:
        val = int(os.environ.get(name, ""))
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


__all__ = [
    "DEFAULT_DATA_SOURCES",
    "DISABLED_SOURCES_HEADER",
    "AgentGroup",
    "BudgetGuardCallback",
    "LLMProvider",
    "MODEL_OVERRIDES_HEADER",
    "LLMRole",
    "OrgLLMCredential",
    "RunBudgetExceededError",
    "SourceRegistry",
    "SpanClosingProfilerHandler",
    "VerboseTraceCallback",
    "all_mapped_tools_filtered_out",
    "disabled_source_notice",
    "CONTINUATION_TURN",
    "content_to_text",
    "create_budget_guard_callback",
    "apply_model_override",
    "apply_zdr_routing",
    "get_zdr_only_from_context",
    "is_reasoning_incompatible_error",
    "apply_org_credential",
    "get_disabled_sources_from_context",
    "get_model_overrides_from_context",
    "get_org_llm_credential_from_context",
    "parse_disabled_sources",
    "resolve_org_llm_credential",
    "parse_model_overrides",
    "redact_db_url",
    "sanitize_model_overrides",
    "get_reasoning_efforts",
    "build_human_prompt",
    "extract_json",
    "extract_user_response",
    "extract_messages_and_sources",
    "filter_tools_by_sources",
    "unavailable_source_ids",
    "format_data_source_tools",
    "format_tool_unavailability_error",
    "format_user_facing_tool_error",
    "get_all_tool_refs",
    "get_checkpoint_pool",
    "get_checkpointer",
    "get_or_create_session_registry",
    "get_source_id_for_tool",
    "get_session_registry",
    "get_latest_user_query",
    "is_postgres_dsn",
    "load_prompt",
    "parse_data_sources",
    "register_source_parser",
    "render_prompt_template",
    "reset_session_registry",
    "sanitize_report",
    "set_session_registry",
    "validate_tool_availability",
    "apply_openrouter_structured_defaults",
    "ends_on_model_turn",
    "enforce_chat_request_contract",
    "get_langchain_llm",
    "normalize_chat_request",
    "strict_response_format",
    "strict_json_response_format",
    "verify_citations",
]


# @environment_variable AGENT_VERBOSE
# @category Debug
# @type bool
# @default false
# @required false
# Enable verbose logging output. Accepts true/1/yes or false/0/no.
def is_verbose(config_verbose: bool) -> bool:
    """Check if verbose mode is enabled via env var or config."""
    env_verbose = os.getenv("AGENT_VERBOSE", "").lower()
    if env_verbose in ("true", "1", "yes"):
        return True
    if env_verbose in ("false", "0", "no"):
        return False
    return config_verbose


def is_postgres_dsn(value: str) -> bool:
    """Return True when the checkpoint DSN is a Postgres URL."""
    try:
        from urllib.parse import urlparse

        parsed = urlparse(value)
        return parsed.scheme in ("postgresql", "postgres")
    except ValueError:
        return value.startswith(("postgresql://", "postgres://"))


def _build_checkpointer_serde() -> JsonPlusSerializer:
    """Build the checkpointer serializer with an explicit msgpack allow-list.

    This flips the checkpointer from permissive to STRICT deserialization: only
    the listed pydantic state types may be reconstructed from a checkpoint. The
    list below is the complete set of custom pydantic types carried in
    ``ConversationState`` (a research turn's own state is never checkpointed).
    Any NEW pydantic state type MUST be added here or restore will break for it.

    A type that was on this list and is gone (``ShallowResult``, whose one
    escalation bit is a plain field now) needs no entry: a blocked type decodes
    to its own kwargs dict instead of raising, and a channel the graph no
    longer declares is dropped on restore.
    """
    # Imported lazily to avoid a circular import: the agent state modules import
    # from ``aiq_agent.common`` at module load time.
    from aiq_agent.common.wire_v2 import FocusRegion
    from aiq_agent.common.wire_v2 import TurnTrigger
    from aiq_agent.knowledge.schema import AvailableDocument

    return _lazy("JsonPlusSerializer")(
        allowed_msgpack_modules=[AvailableDocument, FocusRegion, TurnTrigger],
    )


def get_checkpoint_pool(dsn: str) -> AsyncConnectionPool:
    """The process-wide connection pool for the checkpoint database, per DSN.

    ONE pool per DSN, whoever asks: the conversation checkpointer opens it, and
    the chat working directory's LangGraph store (``tools/documents``) rides the
    same connections rather than opening a second ceiling's worth against the
    same database.
    """
    pool = _postgres_pools.get(dsn)
    if pool is not None:
        return pool
    # Per-replica connection ceiling for checkpoint reads/writes. The old
    # hard-coded max_size=3 throttled the chat tier's concurrent turns (every
    # super-step checks out a connection); make it tunable and default higher
    # now that the tier scales (ADR-0028).
    min_size = _pool_int_env("CHECKPOINT_POOL_MIN_SIZE", 1)
    max_size = max(min_size, _pool_int_env("CHECKPOINT_POOL_MAX_SIZE", 10))
    pool = _lazy("AsyncConnectionPool")(
        conninfo=dsn,
        min_size=min_size,
        max_size=max_size,
        kwargs={"autocommit": True, "row_factory": _lazy("dict_row")},
    )
    _postgres_pools[dsn] = pool
    return pool


async def get_checkpointer(checkpoint_db: str) -> BaseCheckpointSaver:
    """Return a shared checkpointer for the given database/DSN.

    This function caches checkpointers by database path/DSN to avoid
    creating multiple connections to the same database. It supports
    both SQLite (file path) and Postgres (DSN) backends.

    Args:
        checkpoint_db: SQLite database path or Postgres DSN.

    Returns:
        A configured and initialized checkpointer instance.
    """
    checkpointer = _checkpointers.get(checkpoint_db)
    if checkpointer is not None:
        return checkpointer

    async with _checkpointer_lock:
        # Re-check: another caller may have created it while we waited.
        checkpointer = _checkpointers.get(checkpoint_db)
        if checkpointer is not None:
            return checkpointer

        if is_postgres_dsn(checkpoint_db):
            # Lazy: `aiq_agent.knowledge` imports from this package.
            from aiq_agent.knowledge.leader_lock import keyed_lock_async

            saver = _lazy("AsyncPostgresSaver")
            checkpointer = saver(get_checkpoint_pool(checkpoint_db), serde=_build_checkpointer_serde())
            # Every role runs `setup()` at start and it is not safe against that: it creates tables and
            # indexes one statement at a time (CREATE INDEX CONCURRENTLY), so a transaction lock cannot
            # hold it. A session lock on the direct DSN does (ADR-0083).
            async with keyed_lock_async("langgraph-setup:checkpointer"):
                await checkpointer.setup()
            logger.info("Postgres checkpointer initialized via async pool.")
        else:
            conn = await _lazy("aiosqlite").connect(checkpoint_db)
            checkpointer = _lazy("AsyncSqliteSaver")(conn, serde=_build_checkpointer_serde())
            await checkpointer.setup()
            logger.info("SQLite checkpointer initialized: %s", checkpoint_db)

        _checkpointers[checkpoint_db] = checkpointer
        return checkpointer
