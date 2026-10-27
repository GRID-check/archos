"""The API tier's token failures, each an :class:`AuthError` the agent tier owns and catches."""

from aiq_agent.auth.errors import AuthError

__all__ = ["AuthError", "TokenExpiredError", "TokenInvalidError"]


class TokenExpiredError(AuthError):
    """Token signature is valid but the ``exp`` claim has passed."""

    error_code = "token_expired"


class TokenInvalidError(AuthError):
    """Token is malformed, has an invalid signature, or fails claim checks."""

    error_code = "token_invalid"
