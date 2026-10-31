"""Shared guard for service-to-service internal endpoints.

The maintenance purge routes and the skills submit route are both reachable
only from inside the compose network (never on the AuthMiddleware external-path
allowlist) and are authenticated with the shared ``INTERNAL_API_TOKEN``.

Factored here so both route modules import one implementation rather than
copy-pasting the constant-time compare / dev-default-refusal logic. Behavior is
identical to the original ``routes.maintenance`` guard (which re-exports these
names for backwards compatibility).
"""

from fastapi import HTTPException
from fastapi import Request

from agent.common.envelope_auth import _DEV_APP_ENVS  # noqa: F401 - re-exported for maintenance.py
from agent.common.envelope_auth import TOKEN_HEADER
from agent.common.envelope_auth import internal_token_refusal

# Well-known default shipped in docker-compose for local development. It must
# never authenticate anything outside a dev environment (the shared check knows its digest).
_DEV_DEFAULT_TOKEN = "grid-internal-dev-token"

#: Both spellings of the internal-token header, legacy first, until the header rename's contract step.
_TOKEN_HEADERS: tuple[str, ...] = ("x-grid-internal-token", TOKEN_HEADER)

__all__ = ["_DEV_APP_ENVS", "_DEV_DEFAULT_TOKEN", "_TOKEN_HEADERS", "_require_internal_token"]


def _require_internal_token(request: Request) -> None:
    """Refuse a request without the internal token; the check itself is ``agent.common.envelope_auth``.

    Lifted there so the geometry service (ADR-0149) guards its route with the same code. Both
    header spellings are accepted: every caller in the repo sent the legacy spelling while this
    guard once read only the new one, and every real request got a 403.
    """
    refusal = internal_token_refusal(request.headers.get, _TOKEN_HEADERS)
    if refusal is not None:
        raise HTTPException(status_code=refusal[0], detail=refusal[1])
