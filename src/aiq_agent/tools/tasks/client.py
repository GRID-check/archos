"""The one call this tier makes to the task API.

``POST /api/internal/tasks``, op ``create``. Nothing here writes a row: the BFF
is the single writer of ``grid_app`` (ADR-0003) and this module is a CLIENT of
the route (ADR-0055), exactly as ``tools/documents/filing.py`` is a client of the
document-versions route.

## Echo, never sign

Same rule, same reason, and it is worth restating rather than cross-referencing,
because the failure it prevents is invisible: the internal token and the signing
secret are the SAME secret, so a tier that built its own envelope would be
choosing the acting user id with a credential that only authenticates the
service. The envelope the BFF minted at the start of the turn is forwarded
byte-for-byte; the BFF verifies it, resolves that person's pinned session and
creates the task with them as the requester. A run with no envelope — a CLI call,
an eval, a background run that carries none (ADR-0108) — has no acting person,
and the tool refuses rather than falling back to the unsigned individual headers
a caller could have set.

## Why this is not ``tools/documents/filing.py``

It is the same shape and a different contract: a different path, a different body
and a different set of refusals to word for the model. Sharing the transport
would mean one function with a path parameter and two error vocabularies, which
is the fork this repo's own guidance warns about — a helper lifted for half its
callers. What IS shared and must stay shared is the RULE, and the rule is stated
in ``src/aiq_agent/tools/AGENTS.md``, not in a function.

``SignedEnvelope`` itself IS imported from there, because two frozen dataclasses
holding the same two strings would be two types the type checker keeps apart for
no reason. It is safe to import across the plugin boundary that the entry points
draw: that module is stdlib-only, so it drags in no optional dependency — which
is the whole of what the "own entry point" rule in ``src/aiq_agent/AGENTS.md``
protects against.
"""

from __future__ import annotations

import logging
from typing import Any

from aiq_agent.common import bff_http
from aiq_agent.common.bff_http import SignedEnvelope

logger = logging.getLogger(__name__)

#: The one route. Its op set is `create` and nothing else: a machine may ASK for
#: work, never judge it — reviewing a task is a session route, and a machine that
#: could accept its own output would close the loop ADR-0051 exists to open.
INTERNAL_TASKS_PATH = "/api/internal/tasks"

#: Generous, like the filing call and for the same reason one step further along:
#: creating a task RESOLVES a skill, builds the project's whole run context and
#: submits a job to the backend queue. A turn that gave up early would leave the
#: reader unsure whether the work was queued, which is worse than a refusal.
REQUEST_TIMEOUT_SECONDS = 20


class DelegationError(bff_http.BffError):
    """The route refused, or could not be reached. Carries what the model may be told."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message, status=status, code=code)


def _refusal_message(exc: bff_http.BffRefusedError) -> str:
    """What the model may be told about a refusal.

    The BFF words user-facing refusals as a sentence meant to reach the reader
    („Für wiederkehrende Aufträge fehlt die Berechtigung …"), so the envelope's
    ``error`` is relayed verbatim when it is there. A bare status code teaches
    nobody anything actionable.
    """
    base = f"the task API refused the call ({exc.status})"
    return f"{base}: {exc.error_text}" if exc.error_text else base


def post_task(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """One call to the internal tasks route; the parsed JSON body.

    Raises :class:`DelegationError` for every refusal and every transport
    failure, so the tool has exactly one thing to catch. Blocking — call it
    through ``asyncio.to_thread``.
    """
    try:
        body = bff_http.post_json(
            INTERNAL_TASKS_PATH, payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=envelope.headers()
        )
    except bff_http.BffNotConfiguredError as exc:
        raise DelegationError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        logger.warning("Delegation refused by the BFF (status=%s code=%s)", exc.status, exc.code)
        raise DelegationError(_refusal_message(exc), status=exc.status, code=exc.code) from exc
    except bff_http.BffError as exc:
        logger.warning("Delegation could not reach the BFF", exc_info=True)
        raise DelegationError("the task API could not be reached") from exc

    if not isinstance(body, dict):
        raise DelegationError("the task API answered with something that is not an object")
    return body
