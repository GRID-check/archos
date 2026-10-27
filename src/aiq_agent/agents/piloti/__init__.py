"""The research agent: the general answering agent for a chat turn.

Two NAT registrations, because a chat turn is two things. ``register`` is the
answering agent itself; ``conversation_register`` is the workflow NAT calls per
turn, which wires this agent and the deep researcher into the conversation
graph in :mod:`aiq_agent.agents.piloti.conversation`.
"""

from aiq_agent.lazy_exports import lazy_exports

# Loaded on first use (PEP 562): importing any submodule of this package
# executes this file first, and the registrations pull in the whole agent
# graph. NAT finds them through the entry points in `pyproject.toml`, which
# name the register modules themselves (docs/audit/blast-radius-2026-10.md).
_LAZY = {
    "chat_deepresearcher_agent": ".conversation_register",
    "research_agent": ".register",
    "research_workflow": ".register",
}

__all__ = [
    "chat_deepresearcher_agent",
    "research_agent",
    "research_workflow",
]


__getattr__ = lazy_exports(__name__, _LAZY)
