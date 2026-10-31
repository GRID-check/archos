"""The already-authorized sources the BFF hands over, and the check that they are the ones it handed.

This service decides no access: it knows nothing about people, projects or folders (ADR-0149). The
BFF decides all of it and then hands over each model's presigned internal URL and store
identity in ``x-model-sources``: HMAC-signed over the raw JSON with a key derived from the internal
token (:func:`sources_key`), of kind ``model-sources``, naming the envelope's organization, user and
``issuedAt``, this request's model and operation, and expiring a minute after it was issued (``exp``).
The signature is input integrity, not a permission check: it makes sure this service fetches only
what the BFF handed over, for this request. The service
fetches no URL it did not receive this way, and never re-resolves a model with a scope narrower than
the person's (ADR-0149). The cache key is unchanged: the model id and the source identity (the ETag,
else the model's ``updatedAt``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from agent.project_context import RequestContext

SOURCES_HEADER = "x-model-sources"
SOURCES_SIG_HEADER = "x-model-sources-sig"


def _decode(header: str) -> bytes | None:
    try:
        return base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
    except ValueError:
        return None


def _source(model_id: str, entry: Any) -> dict[str, Any] | None:
    """One entry in the shape ``ifc_spatial_client`` resolves to, or None when it is not one."""
    if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
        return None
    return {
        "resolved": True,
        "model": {"modelId": model_id, "updatedAt": entry.get("updatedAt")},
        "source": {"url": entry["url"], "etag": entry.get("etag"), "bytes": entry.get("bytes")},
    }


#: The payload's kind: a request-context envelope never carries it, so neither verifies as the other.
SOURCES_KIND = "model-sources"
#: The label the sources key is derived under from the internal token; the envelope is signed with
#: the token itself, so a signature for one is never a signature for the other.
SOURCES_KEY_LABEL = b"geometry-sources/v1"
#: A grace for clock skew between the BFF's and this pod's clocks on ``exp``.
CLOCK_SKEW_MS = 5_000


def sources_key(secret: str) -> bytes:
    """``HMAC(INTERNAL_API_TOKEN, "geometry-sources/v1")``: the key the sources are signed with."""
    return hmac.new(secret.encode("utf-8"), SOURCES_KEY_LABEL, hashlib.sha256).digest()


def _signed_payload(header: str | None, signature: str | None) -> dict[str, Any] | None:
    secret = os.environ.get("INTERNAL_API_TOKEN")
    raw = _decode(header) if header else None
    if not secret or raw is None or not signature:
        return None
    expected = hmac.new(sources_key(secret), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("kind") == SOURCES_KIND else None


def verified_sources(
    header: str | None,
    signature: str | None,
    context: RequestContext,
    *,
    model_id: str,
    op: str,
    now_ms: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Each signed model's source body by model id; empty unless the pair is genuine and is for this request.

    For this request means: the envelope's organization, user and ``issuedAt``; not past ``exp``;
    this model and this operation. A replay of a pair for another model or another op, or after
    its minute, fetches nothing.
    """
    data = _signed_payload(header, signature)
    if data is None:
        return {}
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    exp = data.get("exp")
    bound = (
        data.get("organizationId") == context.organization_id
        and data.get("userId") == context.user_id
        and isinstance(context.issued_at, int)
        and data.get("issuedAt") == context.issued_at
        and isinstance(exp, int)
        and now <= exp + CLOCK_SKEW_MS
        and data.get("modelId") == model_id
        and data.get("op") == op
    )
    if not bound or not isinstance(data.get("sources"), dict):
        return {}
    sources = {str(mid): _source(str(mid), entry) for mid, entry in data["sources"].items()}
    return {mid: body for mid, body in sources.items() if body is not None}


__all__ = [
    "SOURCES_HEADER",
    "SOURCES_KIND",
    "SOURCES_SIG_HEADER",
    "sources_key",
    "verified_sources",
]
