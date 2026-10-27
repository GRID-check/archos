"""Agents for the AI-Q Blueprint.

Everything here owns a graph and a model call. Tools live in
``aiq_agent.tools``, the per-turn harness in ``aiq_agent.turn``, and the
project-memory surface in ``aiq_agent.memory``.

The three agents load on first use (PEP 562), not with the package: importing
``aiq_agent.agents.piloti.ledger`` executes this file first, and loading both
agent graphs here made every such import pay for all of them
(docs/audit/blast-radius-2026-10.md).
"""

from aiq_agent.lazy_exports import lazy_exports

_LAZY = {
    "deep_research_agent": ".deep_researcher",
    "chat_deepresearcher_agent": ".piloti",
    "research_agent": ".piloti",
}

__all__ = [
    "chat_deepresearcher_agent",
    "research_agent",
    "deep_research_agent",
]


__getattr__ = lazy_exports(__name__, _LAZY)
