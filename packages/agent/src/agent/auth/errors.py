"""The authentication error the agent tier catches, owned here so the API tier can raise it.

Agent nodes catch :class:`AuthError` before the generic ``Exception`` handler
and return ``str(e)`` to the user. The API tier's token failures
(``backend.auth.errors``) subclass it: the dependency runs from the API tier
to this one, never back.
"""

from __future__ import annotations


class AuthError(Exception):
    """Raised when a request fails due to authentication or authorization issues.

    Subclass it for a specific failure mode (a missing token, an expired one,
    insufficient permissions) so an actionable message reaches the caller
    rather than a generic fallback.
    """

    error_code: str = "auth_error"
