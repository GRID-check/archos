"""The models' bytes, as the BFF states them after its read gate: signed, and bound to the envelope.

The BFF decides access on the model's document (the shelf rule, the project role, a restricted
folder's clearance) and then hands this service each model's presigned internal URL and store
identity in ``x-model-sources``, HMAC-signed with the internal token over the raw JSON, exactly as the
request-context envelope is, and naming the same organization, user and ``issuedAt``. The service
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
from typing import Any

from agent.common.envelope_auth import REQUEST_CONTEXT_MAX_AGE_MS
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


def verified_sources(header: str | None, signature: str | None, context: RequestContext) -> dict[str, dict[str, Any]]:
    """Each signed model's source body by model id; empty when the pair is missing, forged or not this envelope's."""
    secret = os.environ.get("INTERNAL_API_TOKEN")
    raw = _decode(header) if header else None
    if not secret or raw is None or not signature:
        return {}
    expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    bound = (
        isinstance(data, dict)
        and data.get("organizationId") == context.organization_id
        and data.get("userId") == context.user_id
        and data.get("issuedAt") == context.issued_at
        and isinstance(context.issued_at, int)
    )
    if not bound or not isinstance(data.get("sources"), dict):
        return {}
    sources = {str(mid): _source(str(mid), entry) for mid, entry in data["sources"].items()}
    return {mid: body for mid, body in sources.items() if body is not None}


__all__ = ["REQUEST_CONTEXT_MAX_AGE_MS", "SOURCES_HEADER", "SOURCES_SIG_HEADER", "verified_sources"]
