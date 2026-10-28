"""
AI-Q API - Unified Knowledge API and Async Job API.

This package combines:
- Knowledge API: Collection and document management
- Async Job API: Agent job submission and SSE streaming

``BackendConfig`` and ``BackendWorker`` load on first use. Importing ``.plugin``
here pulled the routes, the job runner and the agents in with ANY submodule
(``backend.auth.errors`` included). NAT registers through ``backend.register``.
"""

from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from .plugin import BackendConfig
    from .plugin import BackendWorker

__all__ = ["BackendConfig", "BackendWorker"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import plugin

        return getattr(plugin, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
