"""The request identity and the auth error the agent tier owns, and the API tier writes and raises.

Module under test: ``agent.auth.request_identity`` and ``agent.auth.errors``.
That ``agent`` never imports ``backend`` is the ``agent-api-seam`` contract in
``pyproject.toml``'s ``[tool.importlinter]``; these pin that the two tiers share
one ContextVar and one exception class.
"""

from __future__ import annotations

from agent.auth.errors import AuthError
from agent.auth.request_identity import get_current_user
from agent.auth.request_identity import headless_turn_requested
from agent.auth.request_identity import skip_clarifier_requested
from agent.auth.request_identity import user_context


def test_outside_a_request_nobody_asked_to_skip_the_clarifier_or_run_headless():
    assert skip_clarifier_requested() is False
    assert headless_turn_requested() is False
    assert get_current_user()["type"] == "internal"


def test_a_bound_caller_is_read_back_and_unbound_after():
    with user_context({"type": "internal", "skip_clarifier": True, "headless": True}):
        assert skip_clarifier_requested() is True
        assert headless_turn_requested() is True
    assert skip_clarifier_requested() is False


def test_the_api_tier_reads_the_same_context_the_agent_tier_does():
    """The middleware binds through ``user_context``; a second ContextVar would make every read the default."""
    from backend.auth import get_current_user as api_get_current_user
    from backend.auth.middleware import user_context as middleware_user_context

    with middleware_user_context({"type": "jwt", "sub": "user-1"}):
        assert get_current_user() == {"type": "jwt", "sub": "user-1"}
        assert api_get_current_user() == {"type": "jwt", "sub": "user-1"}


def test_the_api_tiers_token_errors_are_the_agent_tiers_auth_error():
    """Agent nodes ``except AuthError``: the API tier's failures must be caught by that clause."""
    from backend.auth import AuthError as ApiAuthError
    from backend.auth.errors import TokenExpiredError
    from backend.auth.errors import TokenInvalidError

    assert ApiAuthError is AuthError
    assert issubclass(TokenExpiredError, AuthError) and issubclass(TokenInvalidError, AuthError)
