"""
Agent-runtime plugin registration for unified AI-Q API.

This module is the entry point for agent-runtime plugin discovery.
Import the plugin registration to make it discoverable.
"""

# Import the plugin registration - this makes it discoverable by the agent runtime
from .plugin import register_agent_host

__all__ = ["register_agent_host"]
