"""A job's artifacts read back from its events: tool calls, outputs and the sources they found."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _extract_event_metadata(event: dict) -> tuple[dict, dict]:
    """Extract data and metadata from an event dict."""
    data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
    metadata = event.get("metadata", {}) if isinstance(event.get("metadata"), dict) else {}
    if not metadata and isinstance(data, dict):
        metadata = data.get("metadata", {}) or {}
    return data, metadata


def _process_tool_start(event: dict, data: dict, metadata: dict, tool_call_map: dict[str, dict]) -> None:
    """Process a tool.start event and add to tool_call_map.

    Stored events (IntermediateStepEvent.to_sse_dict) carry ``id``/``name`` at
    the top level and the tool input directly under ``data`` — not nested one
    level deeper.
    """
    tool_id = event.get("id", "")
    tool_call_map[tool_id] = {
        "id": tool_id,
        "name": event.get("name", ""),
        "input": data.get("input"),
        "output": None,
        "status": "running",
        "workflow": metadata.get("workflow"),
        "timestamp": event.get("timestamp"),
    }


def _process_tool_end(event: dict, data: dict, metadata: dict, tool_call_map: dict[str, dict]) -> None:
    """Process a tool.end event and update tool_call_map.

    tool.start and tool.end are separate events with distinct ``id``s, so the
    running entry is matched by tool name (the emitter resolves the name from
    the run_id on both sides).
    """
    tool_output = data.get("output")
    tool_name = event.get("name", "")

    running = next(
        (entry for entry in tool_call_map.values() if entry["name"] == tool_name and entry["status"] == "running"),
        None,
    )
    if running is not None:
        running["output"] = tool_output
        running["status"] = "completed"
    else:
        tool_id = event.get("id", "")
        tool_call_map[tool_id] = {
            "id": tool_id,
            "name": tool_name,
            "input": None,
            "output": tool_output,
            "status": "completed",
            "workflow": metadata.get("workflow"),
            "timestamp": event.get("timestamp"),
        }


def _normalize_url(url: str) -> str:
    """Normalize URL for consistent deduplication."""
    from urllib.parse import urlparse
    from urllib.parse import urlunparse

    try:
        parsed = urlparse(url)
        normalized_path = parsed.path.rstrip("/") if parsed.path != "/" else "/"
        return urlunparse(
            (
                parsed.scheme.lower(),
                parsed.netloc.lower(),
                normalized_path,
                parsed.params,
                parsed.query,
                "",
            )
        )
    except Exception:
        return url


def _is_valid_url(url: str) -> bool:
    """Check if string is a valid HTTP/HTTPS URL."""
    return bool(url and url.lower().startswith(("http://", "https://")))


def _process_artifact_update(
    event: dict,
    data: dict,
    metadata: dict,
    outputs: list[dict],
    sources_found: set[str],
    sources_cited: set[str],
) -> None:
    """Process an artifact.update event and add to outputs."""
    artifact_type = data.get("type")
    content = data.get("content")

    # Track citation sources and uses for accurate counts (with validation)
    if artifact_type == "citation_source":
        url = data.get("url") or content
        if _is_valid_url(url):
            sources_found.add(_normalize_url(url))
    elif artifact_type == "citation_use":
        url = data.get("url") or content
        if _is_valid_url(url):
            sources_cited.add(_normalize_url(url))

    if content:
        outputs.append(
            {
                "type": artifact_type,
                "content": content,
                "name": event.get("name"),
                "workflow": metadata.get("workflow"),
                "timestamp": event.get("timestamp"),
                **{k: v for k, v in data.items() if k not in ("type", "content")},
            }
        )


async def get_job_artifacts(db_url: str, job_id: str) -> dict | None:
    """
    Extract artifacts from stored events.

    Returns a simplified structure with all tool calls, outputs, and source counts.
    Frontend categorizes tools by name (task=subagent, write_todos=middleware, etc.).

    Args:
        db_url: Database URL for event store.
        job_id: Job ID to fetch artifacts for.

    Returns:
        Dict with 'tools', 'outputs', and 'sources' (counts), or None if no artifacts found.
    """
    from ..jobs.event_store import EventStore

    try:
        events = await EventStore.get_events_async(db_url, job_id, 0, 10000)
        if not events:
            return None

        tool_call_map: dict[str, dict] = {}
        outputs: list[dict] = []
        sources_found: set[str] = set()
        sources_cited: set[str] = set()

        for event in events:
            event_type = event.get("type", "")
            data, metadata = _extract_event_metadata(event)

            if event_type == "tool.start":
                _process_tool_start(event, data, metadata, tool_call_map)
            elif event_type == "tool.end":
                _process_tool_end(event, data, metadata, tool_call_map)
            elif event_type == "artifact.update":
                _process_artifact_update(event, data, metadata, outputs, sources_found, sources_cited)

        tools = list(tool_call_map.values())
        result = {
            "tools": tools,
            "outputs": outputs,
            "sources": {
                "found": len(sources_found),
                "cited": len(sources_cited),
                "found_urls": list(sources_found),
                "cited_urls": list(sources_cited),
            },
        }
        return result if tools or outputs or sources_found else None

    except (KeyError, TypeError) as e:
        logger.warning("Failed to parse artifacts for job %s: %s", job_id, e)
        return None
    except Exception as e:
        logger.warning("Failed to get artifacts for job %s: %s", job_id, e)
        return None
