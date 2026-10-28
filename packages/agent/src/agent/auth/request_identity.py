"""Who is calling, for the length of one request: the identity the API tier's middleware resolved.

An agent-runtime workflow function never sees the ASGI request, so the middleware
(``agent_host.auth.middleware``) binds the resolved caller here, with
:func:`user_context`, and the agent reads it back with
:func:`get_current_user`. The ContextVar lives in the agent tier so that the
API tier writes it and the agent reads it with the dependency pointing one way
(API tier to agent tier). Outside a request the default says an internal
caller who asked for nothing.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_current_user: ContextVar[dict[str, Any]] = ContextVar(
    "_current_user",
    default={"type": "internal", "skip_clarifier": False},
)


def get_current_user() -> dict[str, Any]:
    """The caller identity bound for this request: ``{"type": "jwt"|"internal"|"anonymous"|..., ...}``."""
    return _current_user.get()


@contextmanager
def user_context(user: dict[str, Any]) -> Iterator[None]:
    """Bind ``user`` as the caller for the block."""
    token = _current_user.set(user)
    try:
        yield
    finally:
        _current_user.reset(token)


def skip_clarifier_requested() -> bool:
    """Whether the middleware marked this request as headless.

    Covers ``X-Chat-Mode: headless``, anonymous callers and unauthenticated
    internal callers. Outside a request the default identity says ``False``.
    """
    return bool(get_current_user().get("skip_clarifier"))


def headless_turn_requested() -> bool:
    """Whether the caller said ``X-AIQ-Mode: headless``: a job holds the socket, and no person watches it.

    Narrower than :func:`skip_clarifier_requested`, which an anonymous caller
    also sets: a question put to a headless turn's asker (``ask_user``) would
    wait out its timeout on a socket nobody reads.
    """
    return bool(get_current_user().get("headless"))
