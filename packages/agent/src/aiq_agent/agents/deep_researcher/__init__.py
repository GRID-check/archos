"""The deep researcher: a multi-round research agent run as a subagent of a chat turn."""

from aiq_agent.lazy_exports import lazy_exports

# Loaded on first use (PEP 562): importing any submodule of this package
# executes this file first, and the registrations pull in the whole agent
# graph. NAT finds them through the entry points in `pyproject.toml`, which
# name the register modules themselves (docs/audit/blast-radius-2026-10.md).
_LAZY = {
    "deep_research_agent": ".register",
}

__all__ = [
    "deep_research_agent",
]


__getattr__ = lazy_exports(__name__, _LAZY)
