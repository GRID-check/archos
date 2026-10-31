"""agent_host's internal-token guard is the shared check (ADR-0149), with the legacy header beside the new one."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from agent.common import envelope_auth
from agent_host.routes import internal_auth


def _request(headers: dict[str, str]) -> Request:
    raw = [(name.encode(), value.encode()) for name, value in headers.items()]
    return Request({"type": "http", "headers": raw})


def test_the_shared_check_knows_agent_host_s_dev_default_token() -> None:
    assert envelope_auth.is_dev_default_token(internal_auth._DEV_DEFAULT_TOKEN)


@pytest.mark.parametrize("name", internal_auth._TOKEN_HEADERS)
def test_either_header_name_passes(monkeypatch, name: str) -> None:
    monkeypatch.setenv("INTERNAL_API_TOKEN", "real-token")
    internal_auth._require_internal_token(_request({name: "real-token"}))


def test_the_dev_default_is_refused_outside_dev(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_API_TOKEN", internal_auth._DEV_DEFAULT_TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(HTTPException) as refused:
        internal_auth._require_internal_token(_request({envelope_auth.TOKEN_HEADER: internal_auth._DEV_DEFAULT_TOKEN}))
    assert refused.value.status_code == 503
