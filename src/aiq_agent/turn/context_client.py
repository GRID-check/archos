"""Typed client of the BFF's authenticated per-turn prompt-context API.

Requester identity comes only from the original signed capsule, echoed without
re-signing. An unavailable or refused context is an error, not an empty brief:
answering without the office's current instructions would silently drop policy.
"""

from __future__ import annotations

from dataclasses import dataclass

from aiq_agent.common import bff_http
from aiq_agent.project_context import MEMORY_HEADER_MAX_CHARS
from aiq_agent.project_context import GridRequestContext
from aiq_agent.project_context import normalize_org_instructions
from aiq_agent.project_context import normalize_project_context

INTERNAL_TURN_CONTEXT_PATH = "/api/internal/turn-context"
REQUEST_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class ContextBlocks:
    """The three prompt blocks, independently nullable and bounded at intake."""

    project_context: str | None
    project_memory: str | None
    org_instructions: str | None
    #: The conversation drew on another project through a cross-project lookup
    #: (ADR-0094). Absent from an older BFF's answer, which reads as False: the
    #: BFF refuses every door such a conversation may not use on its own.
    drew_on_other_projects: bool = False
    #: The office's reference projects, one line each (the closed projects most
    #: like this one), so the agent can look there unasked. None from an older
    #: BFF, or when the office has none.
    reference_projects: str | None = None
    #: The WORKSPACE block (ADR-0123): who asks, where, and what is open now,
    #: this conversation's proposals included. None from an older BFF.
    workspace: str | None = None


#: The catalog is a dozen short lines; anything longer is cut at a line.
REFERENCE_PROJECTS_MAX_CHARS = 4000

#: The block is a few header lines, at most eight proposals of a summary and an
#: outcome of ~200 chars each (``MAX_WORKSPACE_PROPOSALS`` in
#: ``lib/turn-context/workspace-block.ts``), and, last, at most seven lines of
#: the office's conventions (``lib/office-conventions/render.ts``, ADR-0129),
#: which a cut at a line drops first.
WORKSPACE_MAX_CHARS = 6500

#: The line that opens the office's conventions in the WORKSPACE block
#: (``officeConventionsHeader`` in ``lib/office-conventions/render.ts``).
OFFICE_CONVENTIONS_HEADER = "office conventions ("


def office_convention_lines(workspace: str | None) -> int:
    """How many convention lines the WORKSPACE block carries under its header; 0 without one. Pure.

    Counts every ``- `` line after the header, which is right only while the BFF
    renders the conventions LAST in the block (``renderWorkspaceBlock``); a
    section added after them would be counted as conventions.
    """
    if not workspace:
        return 0
    lines = workspace.splitlines()
    starts = [index for index, line in enumerate(lines) if line.startswith(OFFICE_CONVENTIONS_HEADER)]
    if not starts:
        return 0
    return sum(1 for line in lines[starts[0] + 1 :] if line.startswith("- "))


def _bounded_lines(value: str | None, max_chars: int) -> str | None:
    """``value`` cut to whole lines within ``max_chars``; None when nothing is left."""
    if not value or not value.strip():
        return None
    kept: list[str] = []
    used = 0
    for line in value.strip().splitlines():
        if used + len(line) + 1 > max_chars:
            break
        kept.append(line)
        used += len(line) + 1
    return "\n".join(kept) or None


class TurnContextError(bff_http.BffError):
    """Required context could not be loaded; the turn must not answer without it."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message, status=status)


def _nullable_text(data: dict[str, object], field: str) -> str | None:
    if field not in data:
        raise TurnContextError(f"the turn-context API omitted {field}")
    value = data[field]
    if value is not None and not isinstance(value, str):
        raise TurnContextError(f"the turn-context API returned an invalid {field}")
    return value


def _parse_blocks(body: object) -> ContextBlocks:
    if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        raise TurnContextError("the turn-context API returned an invalid data envelope")
    data = body["data"]
    return ContextBlocks(
        project_context=normalize_project_context(_nullable_text(data, "projectContext")),
        project_memory=normalize_project_context(
            _nullable_text(data, "projectMemory"), max_chars=MEMORY_HEADER_MAX_CHARS
        ),
        org_instructions=normalize_org_instructions(_nullable_text(data, "orgInstructions")),
        drew_on_other_projects=data.get("drewOnOtherProjects") is True,
        reference_projects=_bounded_lines(
            data.get("referenceProjects") if isinstance(data.get("referenceProjects"), str) else None,
            REFERENCE_PROJECTS_MAX_CHARS,
        ),
        workspace=_bounded_lines(
            data.get("workspace") if isinstance(data.get("workspace"), str) else None,
            WORKSPACE_MAX_CHARS,
        ),
    )


def fetch_turn_context(request: GridRequestContext, *, query: str | None = None) -> ContextBlocks:
    """Read fresh context for this signed requester. Blocking; use ``to_thread``."""
    if not bff_http.internal_token():
        raise TurnContextError("GRID_INTERNAL_API_TOKEN is not configured for turn context")
    if not request.envelope_header or not request.envelope_signature:
        raise TurnContextError("signed requester credentials are required for turn context")
    payload: dict[str, str] = {}
    if query and query.strip():
        payload["query"] = query.strip()[:2000]
    envelope = bff_http.SignedEnvelope(header=request.envelope_header, signature=request.envelope_signature)
    try:
        body = bff_http.post_json(
            INTERNAL_TURN_CONTEXT_PATH, payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=envelope.headers()
        )
    except bff_http.BffNotConfiguredError as exc:
        raise TurnContextError("GRID_INTERNAL_API_TOKEN is not configured for turn context") from exc
    except bff_http.BffRefusedError as exc:
        raise TurnContextError(f"the turn-context API refused the call ({exc.status})", status=exc.status) from exc
    except bff_http.BffMalformedResponseError as exc:
        raise TurnContextError("the turn-context API returned malformed JSON") from exc
    except bff_http.BffError as exc:
        raise TurnContextError("the turn-context API could not be reached") from exc
    return _parse_blocks(body)
