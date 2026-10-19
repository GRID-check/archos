"""The person a background run acts as: the signed envelope it carries (ADR-0108).

A run is commissioned by somebody, and the tools that act as a person
(``file_draft``, ``create_task``, ``project_lookup``, anything that echoes
``GridRequestContext.envelope_header``) need that somebody's signed
request-context envelope. A chat turn has one because the BFF minted it from a
live session. A background run had none, so every one of those tools refused in
it. This module is how a run gets one, in three steps, none of which signs.

**Carry.** When the job API accepts a submit, :func:`capture_request_envelope`
keeps the envelope the BFF sent with it, byte for byte, but only when it
verifies for the run's own requester (:func:`aiq_api.jobs.access.verified_envelope`).
It travels inside the job's encrypted payload as ``request_envelope``
(``jobs/payload_crypto.py``), next to the auth token it is as sensitive as.

**Inject.** At claim the worker hands the two strings to the run's request
metadata under the names a chat turn uses
(:func:`envelope_headers_for_run`), so ``GridRequestContext`` reads them exactly
as it does there.

**Renew.** An envelope lives six hours. One older than
:data:`RUN_ENVELOPE_RENEW_AFTER_MS` at claim is exchanged for a fresh one at
``POST /api/internal/runs/{runId}/envelope``, where the BFF re-derives it from
the ``task_runs`` row and the requester's CURRENT membership. The claim is the
only seam this needs: a run that resumes after a crash is claimed again and
renews again, and a run's own wall clock (deep research stops at 40 minutes)
ends long before an envelope renewed at claim could expire.

**Echo, never sign.** The internal token and the signing secret are one secret,
so this tier could mint an envelope that works. It must not: that would be the
service choosing whose permissions it runs under. Python here only VERIFIES
(the same HMAC check every reader does) and forwards what the BFF signed. Every
refusal leaves the run without an envelope, which is what every run was before
ADR-0108: the person-acting tools refuse, and nothing else changes. A failure to
ASK (the BFF unreachable) is no refusal: the run keeps the carried envelope
while it is inside its 6 h window.

Nothing here logs an envelope. Log lines name the run, the job and the reason.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext

from ..internal_api import internal_base_url
from ..internal_api import internal_headers
from ..internal_retry import send_with_retry
from .access import JOB_ENVELOPE_MAX_AGE_MS
from .access import verified_envelope

logger = logging.getLogger(__name__)

#: Renew a carried envelope once it is this old. The BFF's
#: ``RUN_ENVELOPE_RENEW_AFTER_MS`` (``frontends/ui/src/lib/runs/run-envelope-types.ts``);
#: the envelope itself lives ``JOB_ENVELOPE_MAX_AGE_MS`` (six hours).
RUN_ENVELOPE_RENEW_AFTER_MS = 60 * 60 * 1000

#: The renewal is one small read on the BFF; a slow answer costs the run its
#: envelope, not its start.
RENEW_TIMEOUT_SECONDS = 5.0

#: The refusals the route answers with (``RUN_ENVELOPE_REFUSALS``).
RUN_ENVELOPE_REFUSALS = frozenset({"unknown-run", "run-not-active", "requester-may-not-act"})


@dataclass(frozen=True)
class RunEnvelope:
    """The two header values, exactly as the BFF signed them."""

    header: str
    signature: str

    def to_payload(self) -> dict[str, str]:
        return {"header": self.header, "signature": self.signature}

    def to_headers(self) -> dict[str, str]:
        return {REQUEST_CONTEXT_ENVELOPE_HEADER: self.header, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: self.signature}

    @classmethod
    def from_payload(cls, value: Any) -> RunEnvelope | None:
        if not isinstance(value, Mapping):
            return None
        header, signature = value.get("header"), value.get("signature")
        if not isinstance(header, str) or not header or not isinstance(signature, str) or not signature:
            return None
        return cls(header=header, signature=signature)


def capture_request_envelope(
    headers: Mapping[str, str],
    *,
    user_id: str | None,
    organization_id: str | None = None,
) -> dict[str, str] | None:
    """The submit's envelope as the payload stores it, when it may speak for the run's requester.

    ``user_id`` (and ``organization_id`` when the caller names one) is who the
    run is FOR: the bearer token's subject on the public route, the body's
    requester on the internal one. An envelope for anybody else, unsigned, or
    out of its window is not carried; the run then acts as nobody.
    """
    context = verified_envelope(headers, user_id=user_id, organization_id=organization_id)
    if context is None or not context.envelope_header or not context.envelope_signature:
        return None
    return RunEnvelope(header=context.envelope_header, signature=context.envelope_signature).to_payload()


def _verify(envelope: RunEnvelope) -> GridRequestContext | None:
    """The envelope's verified payload, or None. Verifies; never signs."""
    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not secret:
        return None
    context = GridRequestContext.from_envelope(envelope.header, envelope.signature, secret)
    if context is None or context.issued_at is None or not context.user_id or not context.organization_id:
        return None
    return context


def _same_person(context: GridRequestContext, identity: Mapping[str, Any]) -> bool:
    """Whether the envelope speaks for the run's own requester, where the run names one."""
    for field in ("user_id", "organization_id"):
        expected = identity.get(field)
        if expected and getattr(context, field) != expected:
            return False
    return True


async def envelope_headers_for_run(
    request_envelope: Any,
    *,
    run_id: str | None,
    job_id: str,
    identity: Mapping[str, Any] | None = None,
    now_ms: int | None = None,
) -> dict[str, str]:
    """The envelope headers to inject into a run, or ``{}`` for a run that acts as nobody.

    ``request_envelope`` is the payload value (``None`` for a run submitted
    without one, or before ADR-0108). ``identity`` is the run's own
    (``usage_context["identity"]``): an envelope for anybody else is dropped.
    """
    carried = RunEnvelope.from_payload(request_envelope)
    if carried is None:
        return {}
    context = _verify(carried)
    if context is None:
        logger.warning("Job %s: the carried request envelope does not verify; running without one", job_id)
        return {}
    if not _same_person(context, identity or {}):
        logger.warning("Job %s: the carried request envelope names another person; running without one", job_id)
        return {}
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if abs(now - (context.issued_at or 0)) < RUN_ENVELOPE_RENEW_AFTER_MS:
        return carried.to_headers()
    fresh = await renew_run_envelope(run_id, job_id=job_id)
    if fresh is REFUSED:
        return {}
    if fresh is None:
        # The BFF could not be asked (unreachable, misconfigured, a malformed
        # answer): that is no verdict on the requester, so a carried envelope
        # still inside the BFF verifier's window keeps working. Every echoed
        # call is judged again by the BFF on the requester's current rights.
        if abs(now - (context.issued_at or 0)) >= JOB_ENVELOPE_MAX_AGE_MS:
            logger.warning("Job %s: request envelope not renewed and past its window; running without one", job_id)
            return {}
        logger.warning("Job %s: request envelope not renewed; running on the carried one", job_id)
        return carried.to_headers()
    return _accept_renewal(fresh, carried=context, job_id=job_id)


def _accept_renewal(fresh: RunEnvelope, *, carried: GridRequestContext, job_id: str) -> dict[str, str]:
    """The renewed envelope's headers, when it is a renewal of the carried one.

    The BFF is the authority on whether the requester may still act; these
    checks only refuse an answer that is not that authority's answer to THIS
    run. A fresh envelope must verify, speak for the same person in the same
    organization, and keep a collection scope when the carried one had one:
    ``GridRequestContext`` prefers the envelope to the worker's own headers
    wholesale, so an envelope without a scope would silently narrow the run's
    retrieval to the shared corpus.
    """
    context = _verify(fresh)
    if context is None:
        logger.warning("Job %s: the renewed request envelope does not verify; running without one", job_id)
        return {}
    if context.user_id != carried.user_id or context.organization_id != carried.organization_id:
        logger.warning("Job %s: the renewed request envelope names another person; running without one", job_id)
        return {}
    if carried.collection_scope is not None and context.collection_scope is None:
        logger.warning("Job %s: the renewed request envelope carries no collection scope; running without one", job_id)
        return {}
    return fresh.to_headers()


class _Refused:
    """The BFF's answer that the requester may not act for this run any more."""

    def __repr__(self) -> str:
        return "REFUSED"


#: ``renew_run_envelope``'s answer when the BFF refused: the run then acts as nobody.
REFUSED = _Refused()


async def renew_run_envelope(run_id: str | None, *, job_id: str) -> RunEnvelope | _Refused | None:
    """Ask the BFF for a fresh envelope for ``run_id``; never raises.

    A fresh envelope; ``REFUSED`` when the BFF answered with one of its
    refusals (the run is unknown, no longer active, or the requester may not
    act): a verdict, so the run drops its envelope; ``None`` when the BFF could
    not be asked or answered something else: no verdict, so the caller keeps
    the carried envelope while it is still inside its window.
    """
    if not run_id:
        logger.info("Job %s: its request envelope is due for renewal and it has no run to renew it for", job_id)
        return None
    base_url = internal_base_url()
    headers = internal_headers()
    if not base_url or headers is None:
        logger.warning("Run %s: internal BFF route not configured; its request envelope is not renewed", run_id)
        return None
    url = f"{base_url.rstrip('/')}/api/internal/runs/{quote(run_id, safe='')}/envelope"

    async def _send() -> httpx.Response:
        async with httpx.AsyncClient(timeout=RENEW_TIMEOUT_SECONDS) as client:
            return await client.post(url, json={}, headers=headers)

    response = await send_with_retry(_send, label=f"Run {run_id}: request envelope renewal")
    if response is None:
        return None
    if response.status_code == 200:
        fresh = parse_renewal(_json(response))
        if fresh is None:
            logger.warning("Run %s: the BFF answered the envelope renewal with a malformed body", run_id)
        return fresh
    reason = refusal_reason(_json(response))
    if reason is not None and response.status_code in (403, 404, 409):
        logger.warning("Run %s: request envelope renewal refused (HTTP %s, %s)", run_id, response.status_code, reason)
        return REFUSED
    logger.warning("Run %s: request envelope not renewed (HTTP %s)", run_id, response.status_code)
    return None


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:  # noqa: BLE001 — a body that is not JSON is a malformed answer, not a crash
        return None


def parse_renewal(body: Any) -> RunEnvelope | None:
    """A ``RunEnvelopeResponse`` (``{header, signature, issuedAt}``, nothing else), or None."""
    if not isinstance(body, Mapping) or set(body) != {"header", "signature", "issuedAt"}:
        return None
    issued_at = body["issuedAt"]
    if not isinstance(issued_at, int) or isinstance(issued_at, bool) or issued_at <= 0:
        return None
    return RunEnvelope.from_payload(body)


def refusal_reason(body: Any) -> str | None:
    """The ``RunEnvelopeError`` code a refusal names, or None for any other body."""
    if not isinstance(body, Mapping) or set(body) != {"error", "message"}:
        return None
    error = body.get("error")
    return error if error in RUN_ENVELOPE_REFUSALS and isinstance(body.get("message"), str) else None
