"""
AI-Q API - Unified Knowledge API and Async Job API.

This package combines:
- Knowledge API: Collection and document management
- Async Job API: Agent job submission and SSE streaming

``AgentHostConfig`` and ``AgentHostWorker`` load on first use. Importing ``.plugin``
here pulled the routes, the job runner and the agents in with ANY submodule
(``agent_host.auth.errors`` included). The agent runtime registers through ``agent_host.register``.
"""

from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from .plugin import AgentHostConfig
    from .plugin import AgentHostWorker

__all__ = ["AgentHostConfig", "AgentHostWorker"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import plugin

        return getattr(plugin, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
