"""
Agent registry for async job system.

Maps agent type identifiers to their class paths and config names.
This allows the job runner to dynamically load and instantiate agents.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class AgentConfig:
    """Configuration for a registered agent."""

    class_path: str
    """Full module path to the agent class, e.g., 'agent.agents.deep_researcher.agent.DeepResearcherAgent'"""

    config_name: str
    """NAT config function name, e.g., 'deep_research_agent'"""

    description: str = ""
    """Human-readable description of the agent."""


# Global agent registry
AGENT_REGISTRY: dict[str, AgentConfig] = {}


def register_agent(
    agent_type: str,
    class_path: str,
    config_name: str,
    description: str = "",
) -> None:
    """
    Register an agent type for use with the async job system.

    Args:
        agent_type: Short identifier for the agent (e.g., 'deep_researcher').
        class_path: Full module path to the agent class.
        config_name: NAT config function name for this agent.
        description: Human-readable description.

    Example:
        register_agent(
            agent_type="deep_researcher",
            class_path="agent.agents.deep_researcher.agent.DeepResearcherAgent",
            config_name="deep_research_agent",
            description="Performs comprehensive multi-loop research",
        )
    """
    AGENT_REGISTRY[agent_type] = AgentConfig(
        class_path=class_path,
        config_name=config_name,
        description=description,
    )
    logger.debug("Registered agent: %s -> %s", agent_type, class_path)


def get_agent_config(agent_type: str) -> AgentConfig:
    """
    Get configuration for a registered agent.

    Args:
        agent_type: The agent type identifier.

    Returns:
        AgentConfig for the requested agent.

    Raises:
        KeyError: If agent_type is not registered.
    """
    if agent_type not in AGENT_REGISTRY:
        available = ", ".join(AGENT_REGISTRY.keys()) or "(none)"
        raise KeyError(f"Unknown agent type: '{agent_type}'. Available: {available}")
    return AGENT_REGISTRY[agent_type]


# Register default agents
register_agent(
    agent_type="deep_researcher",
    class_path="agent.agents.deep_researcher.agent.DeepResearcherAgent",
    config_name="deep_research_agent",
    description="Performs comprehensive multi-loop deep research",
)

# ``config_name`` is the NAT function NAME in the YAML, not its ``_type``
# (``research_agent``). The name is what NAT puts on the wire and what every
# stored turn keeps as ``functionName``, so it is a persisted identifier and is
# deliberately still ``shallow_research_agent`` — see the note on that block in
# ``configs/config_oib_openrouter.yml``.
register_agent(
    agent_type="researcher",
    class_path="agent.agents.piloti.agent.PilotiAgent",
    config_name="shallow_research_agent",
    description="Performs quick single-turn research",
)

# Reads a new project's documents and writes suggested profile values onto the
# project, not a report. The class is loaded by path at job time (never imported
# here) and declares ``produces_report = False``; ``config_name`` is the NAT
# function name in the YAML, whose ``_type`` is also ``project_intake_agent``.
register_agent(
    agent_type="project_intake",
    class_path="agent.agents.intake.agent.ProjectIntakeAgent",
    config_name="project_intake_agent",
    description="Reads a new project's documents and suggests its profile values (ADR-0111)",
)
