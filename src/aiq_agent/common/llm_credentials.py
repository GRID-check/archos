"""Per-organization LLM keys: BYOK (ADR-0022) and the platform's per-org OpenRouter key (ADR-0121).

Enterprise organizations can bring their own LLM provider key, and every
organization has an OpenRouter key the platform provisioned for it. Both live
in WorkOS Vault (or the local encrypted store) behind the BFF; this module
pulls them **just in time** from the internal endpoint::

    GET {FRONTEND_INTERNAL_URL}/api/internal/llm-credential?organizationId=…
    x-grid-internal-token: {GRID_INTERNAL_API_TOKEN}

Design constraints (why pull, not push): the plaintext key must never ride
WebSocket-upgrade headers, the research job payload (persisted in the job store), or
any shared cache. The org id — which already flows on every request
(``x-grid-organization-id``) and inside worker ``usage_context`` — is all the
backend needs.

Resolution is cached in-process for 60 s and FAILS CLOSED (ADR-0121): when the
keys of an organization cannot be read, :class:`OrgCredentialUnavailable` is
raised, and the call is refused rather than sent on the deployment's shared
key. A failure is remembered for :data:`FAILURE_TTL_SECONDS`, so a BFF outage
costs one round-trip per organization per window rather than one per call.

A deployment with per-organization keys switched off (no OpenRouter management
key on the BFF, or no ``GRID_INTERNAL_API_TOKEN`` channel to ask through: local
development, CI, evals) resolves to :attr:`OrgKeys.per_org_keys` ``False``, and
calls run on the shared key as before ADR-0121.

Key material is never logged; log lines carry only the fingerprint the BFF
computed.
"""

import logging
import os
import threading
import time
from dataclasses import dataclass
from dataclasses import field

logger = logging.getLogger(__name__)

POSITIVE_TTL_SECONDS = 60.0
FAILURE_TTL_SECONDS = 5.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Pydantic field names langchain chat models use for the credential pair.
# Checked in order; the first present on the model wins.
_API_KEY_FIELDS = ("openai_api_key", "api_key")
_BASE_URL_FIELDS = ("openai_api_base", "base_url")

# Client objects are rebuilt by the constructor's validators — carrying them
# into the new instance would keep traffic on the OLD credential.
_CLIENT_FIELDS = {"client", "root_client", "async_client", "root_async_client", "http_client", "http_async_client"}


@dataclass(frozen=True)
class OrgLLMCredential:
    """A resolved tenant credential. ``api_key`` must never be logged."""

    credential_id: str
    provider: str
    base_url: str
    api_key: str = field(repr=False)
    key_fingerprint: str = ""


class OrgCredentialUnavailable(RuntimeError):
    """An organization's keys could not be resolved, so its model call is refused (ADR-0121)."""


@dataclass(frozen=True)
class OrgKeys:
    """Every key one organization's model calls may carry.

    ``byok`` is the organization's own credential in use, or None.
    ``platform_key`` is the OpenRouter key the platform provisioned for it; None
    only when ``per_org_keys`` is False, i.e. this deployment has none.
    """

    byok: OrgLLMCredential | None = None
    platform_key: str | None = field(default=None, repr=False)
    platform_key_fingerprint: str = ""
    per_org_keys: bool = False


NO_ORG_KEYS = OrgKeys()


class _CacheEntry:
    __slots__ = ("keys", "error", "expires_at")

    def __init__(self, keys: OrgKeys | None, error: Exception | None, ttl: float) -> None:
        self.keys = keys
        self.error = error
        self.expires_at = time.monotonic() + ttl


_cache: dict[str, _CacheEntry] = {}
_cache_lock = threading.Lock()


def reset_credential_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    with _cache_lock:
        _cache.clear()


def _internal_base_url() -> str:
    return (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")


def _fetch_org_keys(organization_id: str) -> OrgKeys:
    """One HTTP round-trip to the BFF's internal resolution endpoint. Raises on any failure."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel: neither BYOK nor a per-org key can be
        # resolved, and nothing in this deployment provisions one.
        return NO_ORG_KEYS

    import httpx

    response = httpx.get(
        f"{_internal_base_url()}/api/internal/llm-credential",
        params={"organizationId": organization_id},
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise OrgCredentialUnavailable("the key endpoint answered something that is not an object")
    per_org_keys = payload.get("perOrgKeys") is True
    platform = payload.get("platformKey")
    platform_key = platform.get("apiKey") if isinstance(platform, dict) else None
    if per_org_keys and not (isinstance(platform_key, str) and platform_key):
        raise OrgCredentialUnavailable("per-organization keys are on, but the organization's key was not served")
    return OrgKeys(
        byok=_byok_from(payload.get("credential")),
        platform_key=platform_key if per_org_keys else None,
        platform_key_fingerprint=str(platform.get("keyFingerprint") or "") if isinstance(platform, dict) else "",
        per_org_keys=per_org_keys,
    )


def _byok_from(data: object) -> OrgLLMCredential | None:
    if not isinstance(data, dict):
        return None
    api_key = data.get("apiKey")
    base_url = data.get("baseUrl")
    if not isinstance(api_key, str) or not api_key or not isinstance(base_url, str) or not base_url:
        return None
    return OrgLLMCredential(
        credential_id=str(data.get("id") or ""),
        provider=str(data.get("provider") or "custom"),
        base_url=base_url,
        api_key=api_key,
        key_fingerprint=str(data.get("keyFingerprint") or ""),
    )


def cached_org_keys(organization_id: str) -> OrgKeys | None:
    """The organization's keys when this process holds a fresh answer, else None. Never blocks.

    Raises the remembered :class:`OrgCredentialUnavailable` inside its failure
    window, as :func:`resolve_org_keys` would.
    """
    with _cache_lock:
        entry = _cache.get(organization_id)
    if entry is None or entry.expires_at <= time.monotonic():
        return None
    if entry.error is not None:
        raise OrgCredentialUnavailable(str(entry.error)) from entry.error
    return entry.keys


def resolve_org_keys(organization_id: str) -> OrgKeys:
    """Every key the organization's calls may carry. Blocking on a cold cache; FAILS CLOSED.

    Raises :class:`OrgCredentialUnavailable` when the keys cannot be resolved:
    the caller's model call must not go out (ADR-0121).
    """
    cached = cached_org_keys(organization_id)
    if cached is not None:
        return cached
    try:
        keys = _fetch_org_keys(organization_id)
    except Exception as exc:  # noqa: BLE001 - every failure is the same refusal
        logger.error("LLM key resolution failed for org %s: %s", organization_id, type(exc).__name__)
        _remember(organization_id, _CacheEntry(None, exc, FAILURE_TTL_SECONDS))
        raise OrgCredentialUnavailable(f"the LLM keys of organization {organization_id} could not be resolved") from exc
    _remember(organization_id, _CacheEntry(keys, None, POSITIVE_TTL_SECONDS))
    if keys.byok is not None:
        logger.info(
            "BYOK active for org %s (provider=%s, fingerprint=%s)",
            organization_id,
            keys.byok.provider,
            keys.byok.key_fingerprint,
        )
    return keys


def _remember(organization_id: str, entry: _CacheEntry) -> None:
    now = time.monotonic()
    with _cache_lock:
        _cache[organization_id] = entry
        # Bounded: one entry per org this process has served recently.
        if len(_cache) > 512:
            expired = [key for key, value in _cache.items() if value.expires_at <= now]
            for key in expired:
                _cache.pop(key, None)


def resolve_org_llm_credential(organization_id: str | None) -> OrgLLMCredential | None:
    """The org's BYOK credential in use, or None when it runs on its platform key.

    Raises :class:`OrgCredentialUnavailable` when the organization's keys cannot
    be resolved: there is no fallback to the shared key (ADR-0121).
    """
    if not organization_id:
        return None
    return resolve_org_keys(organization_id).byok


def get_org_llm_credential_from_context() -> OrgLLMCredential | None:
    """Resolve the BYOK credential for the current request's organization."""
    from aiq_agent.project_context import get_organization_id_from_context

    return resolve_org_llm_credential(get_organization_id_from_context())


def apply_org_credential(llm: object, credential: OrgLLMCredential | None = None) -> object:
    """Return ``llm`` re-pointed at the tenant's provider + key.

    Unlike the model-id override (``override_model``), a credential swap
    cannot use ``model_copy``: langchain chat models bind their HTTP clients
    at construction, so a copied model would silently keep calling with the
    OLD key. The model is therefore reconstructed through its constructor
    (client fields dropped, credential fields replaced), which re-runs the
    validators that build the clients. A credential that cannot be applied
    raises :class:`OrgCredentialUnavailable`: returning the original ``llm``
    would send the organization's call on the shared key (ADR-0121).
    """
    if credential is None:
        credential = get_org_llm_credential_from_context()
    if credential is None:
        return llm

    fields = getattr(type(llm), "model_fields", None)
    if not fields:
        raise OrgCredentialUnavailable(f"cannot apply a BYOK credential to {type(llm).__name__}: not a pydantic model")

    key_field = next((name for name in _API_KEY_FIELDS if name in fields), None)
    base_field = next((name for name in _BASE_URL_FIELDS if name in fields), None)
    if key_field is None or base_field is None:
        raise OrgCredentialUnavailable(f"cannot apply a BYOK credential to {type(llm).__name__}: no credential fields")

    try:
        data = {}
        for name in fields:
            if name in _CLIENT_FIELDS:
                continue
            try:
                data[name] = getattr(llm, name)
            except AttributeError:
                continue
        data[key_field] = credential.api_key
        data[base_field] = credential.base_url
        return type(llm)(**data)
    except Exception as exc:
        raise OrgCredentialUnavailable(
            f"failed to apply BYOK credential (fingerprint={credential.key_fingerprint}) to {type(llm).__name__}"
        ) from exc
