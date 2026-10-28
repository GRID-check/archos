"""Which data sources a job may ask for: the agent's tools, checked against the registry before a job is submitted."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from fastapi import HTTPException

from agent.common.data_source_registry import get_all_sources
from agent.common.data_source_registry import get_all_tool_refs
from agent.common.data_source_registry import get_source_id_for_tool
from nat.plugin_api import LLMFrameworkEnum

if TYPE_CHECKING:
    from nat.builder.workflow_builder import WorkflowBuilder

logger = logging.getLogger(__name__)


def _source_ids_by_lowercase() -> tuple[list[str], dict[str, str]]:
    """Return known source IDs and a lower-case lookup preserving canonical IDs.

    Assumes registry IDs are unique under ``.lower()``. The data source registry
    convention is snake_case (e.g. ``web_search``, ``knowledge_layer``); two IDs
    differing only by case would collapse here.
    """
    known_ids = sorted(source.id for source in get_all_sources())
    return known_ids, {source_id.lower(): source_id for source_id in known_ids}


async def _get_agent_available_source_ids(builder: WorkflowBuilder, agent_config_name: str) -> list[str]:
    """Return mapped source IDs with at least one effective tool for an agent config.

    This mirrors the async job runner's effective tool resolution: explicit
    `tools` wins and overrides registry refs, otherwise inherit all registry
    refs, resolve LangChain wrappers through the builder, then apply exact
    tool-name `exclude_tools`.

    A source is reported as available if at least one of its tools survives
    ``exclude_tools``; partial exclusion does not hide the source.

    Assumes agent configs registered for async submission expose typed
    ``tools`` and ``exclude_tools`` fields (see ``agent.agents.*.register``).
    A registered agent without these fields is a registration-time bug, not a
    runtime concern.
    """
    fn_config = builder.get_function_config(agent_config_name)
    tool_refs = fn_config.tools if fn_config.tools is not None else get_all_tool_refs()
    tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

    excluded = set(fn_config.exclude_tools or [])
    if excluded:
        tools = [tool for tool in tools if getattr(tool, "name", "") not in excluded]

    source_ids: set[str] = set()
    for tool in tools:
        name = getattr(tool, "name", "")
        if not name:
            continue
        sid = get_source_id_for_tool(name)
        if sid is not None:
            source_ids.add(sid)
    return sorted(source_ids)


async def validate_data_sources_for_agent(
    *,
    builder: WorkflowBuilder,
    agent_type: str,
    agent_config_name: str,
    data_sources: list[str] | None,
) -> None:
    """Raise HTTP 422 if requested sources are unknown or unavailable to the selected agent."""
    # Semantic fast path: omit/null/empty means "use all data-source tools available
    # to the chosen agent" (or, for empty list, "use no data-source tools"). In both
    # cases there is nothing for the caller to validate against, so we skip.
    #
    # Bonus: this also avoids a builder.get_tools() round-trip on the default code
    # path -- pinned by test_submit_job_forwards_omitted_data_sources_without_resolving_tools.
    if not data_sources:
        return

    known_ids, known_by_lower = _source_ids_by_lowercase()

    try:
        available_ids = await _get_agent_available_source_ids(builder, agent_config_name)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception(
            "Failed to validate data sources for agent %s using config %s",
            agent_type,
            agent_config_name,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to validate data sources for selected agent",
        ) from exc

    available_by_lower = {source_id.lower(): source_id for source_id in available_ids}

    # Single-pass partition: walk requested IDs once, deduping case-insensitively
    # and routing each unique ID into either "unknown to system" or "known but
    # unavailable to this agent." Preserves first-seen casing and request order.
    seen: set[str] = set()
    invalid_ids: list[str] = []
    unavailable_for_agent: list[str] = []
    for source_id in data_sources:
        key = source_id.lower()
        if key in seen:
            continue
        seen.add(key)
        if key not in known_by_lower:
            invalid_ids.append(source_id)
        elif key not in available_by_lower:
            unavailable_for_agent.append(source_id)

    if not invalid_ids and not unavailable_for_agent:
        return

    parts: list[str] = []
    if invalid_ids:
        parts.append(f"Unknown data source(s): {', '.join(invalid_ids)}")
    if unavailable_for_agent:
        parts.append(f"Data source(s) are not available for agent '{agent_type}': {', '.join(unavailable_for_agent)}")
    message = ". ".join(parts)

    # Echo back the caller's request annotated with which IDs were unknown vs
    # unavailable, plus the global registry list (which is also discoverable via
    # /v1/data_sources). The per-agent capability list is intentionally NOT
    # returned -- it's not exposed anywhere else and would reveal agent
    # capability boundaries.
    raise HTTPException(
        status_code=422,
        detail={
            "message": message,
            "invalid_ids": invalid_ids,
            "unavailable_for_agent": unavailable_for_agent,
            "known_ids": known_ids,
        },
    )
