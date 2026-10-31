"""The inbound checks every service shares (ADR-0149): the internal token and the signed envelope."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from agent.common import envelope_auth

SECRET = "test-secret"  # pragma: allowlist secret


def _envelope(payload: dict, secret: str = SECRET) -> tuple[str, str]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return header, hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("APP_ENV", "production")


def _now() -> int:
    return int(time.time() * 1000)


def test_a_signed_current_envelope_naming_user_and_organization_verifies():
    header, sig = _envelope({"organizationId": "org", "userId": "u", "projectId": "p", "issuedAt": _now()})
    context = envelope_auth.verified_envelope_context(header, sig)
    assert context is not None
    assert (context.organization_id, context.user_id, context.project_id) == ("org", "u", "p")


@pytest.mark.parametrize(
    "payload, secret",
    [
        ({"organizationId": "org", "userId": "u", "issuedAt": 0}, SECRET),
        ({"organizationId": "org", "issuedAt": None}, SECRET),
        ({"userId": "u", "issuedAt": None}, SECRET),
        ({"organizationId": "org", "userId": "u", "issuedAt": None}, "another-secret"),
    ],
    ids=["stale", "no-user", "no-organization", "bad-signature"],
)
def test_anything_less_is_none(payload, secret):
    if payload.get("issuedAt") is None:
        payload["issuedAt"] = _now()
    header, sig = _envelope(payload, secret)
    assert envelope_auth.verified_envelope_context(header, sig) is None


def test_no_envelope_is_none():
    assert envelope_auth.verified_envelope_context(None, None) is None


def test_the_token_is_read_under_either_header_name():
    for name in envelope_auth.TOKEN_HEADERS:
        assert envelope_auth.internal_token_refusal({name: SECRET}.get) is None
    assert envelope_auth.internal_token_refusal({}.get) == (403, "Forbidden")


def test_the_dev_default_token_is_refused_outside_dev(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", envelope_auth.DEV_DEFAULT_TOKEN)
    header = {envelope_auth.TOKEN_HEADERS[0]: envelope_auth.DEV_DEFAULT_TOKEN}
    assert envelope_auth.internal_token_refusal(header.get) == (503, "Internal API disabled")
    monkeypatch.setenv("APP_ENV", "development")
    assert envelope_auth.internal_token_refusal(header.get) is None
