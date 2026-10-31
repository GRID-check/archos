"""The two credentials an internal call from the BFF carries, checked in one place for every service.

Lifted out of ``agent_host`` (``routes/internal_auth.py`` and ``routes/internal_tools.py``) when the
geometry service became a second process that the BFF calls the same way (ADR-0149): a copy of
either check is a second definition of who may call, and the two would drift.

* :func:`internal_token_refusal`: the shared ``INTERNAL_API_TOKEN`` says the caller is the BFF.
  Both header spellings are accepted, compared in constant time, and the well-known dev default
  is refused outside a dev environment.
* :func:`verified_envelope_context`: the signed request-context envelope says WHO asked: signed
  with the same secret, naming a user and an organization, and inside the BFF verifier's window
  (:data:`REQUEST_CONTEXT_MAX_AGE_MS`) in both directions. Anything less is ``None``.

Framework-free on purpose: each service turns a refusal into its own HTTP error.
"""

from __future__ import annotations

import hmac
import logging
import os
import time
from collections.abc import Callable

from agent.project_context import RequestContext

logger = logging.getLogger(__name__)

#: How long a signed envelope authorizes a request, in milliseconds: the BFF verifier's window,
#: ``REQUEST_CONTEXT_MAX_AGE_MS`` in ``apps/workspace/bff/request-context.ts``. The two must stay equal.
REQUEST_CONTEXT_MAX_AGE_MS = 6 * 60 * 60 * 1000

#: Well-known default shipped in docker-compose for local development; it never authenticates elsewhere.
DEV_DEFAULT_TOKEN = "grid-internal-dev-token"  # noqa: S105 - a refused value, not a credential
_DEV_APP_ENVS = {"development", "dev", "local"}

#: Both spellings of the internal-token header, in the order they are tried.
TOKEN_HEADERS: tuple[str, ...] = ("x-grid-internal-token", "x-internal-token")


def internal_token_refusal(header: Callable[[str], str | None]) -> tuple[int, str] | None:
    """``None`` when the request carries the internal token, else the ``(status, detail)`` to refuse with.

    ``header`` reads one request header by name. Every candidate header is compared even after one
    matches, so the number of comparisons does not depend on which spelling the caller used.
    """
    token = os.environ.get("INTERNAL_API_TOKEN")
    if not token:
        return 403, "Forbidden"
    app_env = os.environ.get("APP_ENV", "production").lower()
    if token == DEV_DEFAULT_TOKEN and app_env not in _DEV_APP_ENVS:
        logger.error(
            "INTERNAL_API_TOKEN is the well-known dev default ('%s') but APP_ENV=%s is not a dev "
            "environment - refusing to serve internal requests. Set a real token in the deployment environment.",
            DEV_DEFAULT_TOKEN,
            app_env,
        )
        return 503, "Internal API disabled"
    matched = False
    for name in TOKEN_HEADERS:
        matched |= hmac.compare_digest(header(name) or "", token)
    return None if matched else (403, "Forbidden")


def verified_envelope_context(
    envelope: str | None,
    signature: str | None,
    *,
    now_ms: int | None = None,
) -> RequestContext | None:
    """The envelope's context when it is signed, current and names a user and an organization; else None."""
    secret = os.environ.get("INTERNAL_API_TOKEN")
    if not secret:
        return None
    context = RequestContext.from_envelope(envelope, signature, secret)
    if context is None or context.issued_at is None:
        return None
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if abs(now - context.issued_at) > REQUEST_CONTEXT_MAX_AGE_MS:
        return None
    if not context.user_id or not context.organization_id:
        return None
    return context


__all__ = [
    "DEV_DEFAULT_TOKEN",
    "REQUEST_CONTEXT_MAX_AGE_MS",
    "TOKEN_HEADERS",
    "internal_token_refusal",
    "verified_envelope_context",
]
