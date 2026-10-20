"""Tests for per-org LLM keys: BYOK (ADR-0022) and the platform's per-org key (ADR-0121)."""

from unittest.mock import patch

import pytest
from pydantic import BaseModel

from aiq_agent.common import llm_credentials
from aiq_agent.common.llm_credentials import NO_ORG_KEYS
from aiq_agent.common.llm_credentials import OrgCredentialUnavailable
from aiq_agent.common.llm_credentials import OrgKeys
from aiq_agent.common.llm_credentials import OrgLLMCredential
from aiq_agent.common.llm_credentials import apply_org_credential
from aiq_agent.common.llm_credentials import reset_credential_cache
from aiq_agent.common.llm_credentials import resolve_org_keys
from aiq_agent.common.llm_credentials import resolve_org_llm_credential
from aiq_agent.common.llm_provider import LLMProvider
from aiq_agent.common.llm_provider import LLMRole

CREDENTIAL = OrgLLMCredential(
    credential_id="cred-1",
    provider="openrouter",
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-tenant-key",
    key_fingerprint="deadbeef",
)


class FakeChatModel(BaseModel):
    """Mimics a langchain ChatOpenAI: credential fields + client state.

    ``client`` simulates the bound HTTP client langchain builds at
    construction — a correct credential swap must NOT carry it over.
    """

    model_name: str = "vendor/model"
    openai_api_key: str | None = "sk-platform"
    openai_api_base: str | None = None
    temperature: float = 0.2
    client: object | None = None


@pytest.fixture(autouse=True)
def _fresh_cache():
    reset_credential_cache()
    yield
    reset_credential_cache()


class TestApplyOrgCredential:
    def test_rebuilds_with_tenant_credential(self):
        llm = FakeChatModel(client=object())
        swapped = apply_org_credential(llm, CREDENTIAL)
        assert swapped is not llm
        assert swapped.openai_api_key == "sk-tenant-key"
        assert swapped.openai_api_base == "https://openrouter.ai/api/v1"
        # Non-credential settings ride along; stale clients do not.
        assert swapped.model_name == "vendor/model"
        assert swapped.temperature == 0.2
        assert swapped.client is None
        # The original stays on the platform credential.
        assert llm.openai_api_key == "sk-platform"

    def test_none_credential_is_identity(self):
        llm = FakeChatModel()
        with patch.object(llm_credentials, "get_org_llm_credential_from_context", return_value=None):
            assert apply_org_credential(llm) is llm

    def test_non_pydantic_fails_closed(self):
        # Returning the model unchanged would send the call on the shared key (ADR-0121).
        with pytest.raises(OrgCredentialUnavailable):
            apply_org_credential(object(), CREDENTIAL)

    def test_model_without_credential_fields_fails_closed(self):
        class NoCredentialModel(BaseModel):
            model_name: str = "vendor/model"

        with pytest.raises(OrgCredentialUnavailable):
            apply_org_credential(NoCredentialModel(), CREDENTIAL)


class TestProviderWithCredential:
    def test_applies_to_all_roles_and_default(self):
        provider = LLMProvider()
        default = FakeChatModel()
        writer = FakeChatModel(model_name="vendor/writer")
        provider.set_default(default)
        provider.configure(LLMRole.REPORT_WRITER, writer)

        derived = provider.with_credential(CREDENTIAL)
        assert derived is not provider
        assert derived.get(LLMRole.ROUTER).openai_api_key == "sk-tenant-key"
        assert derived.get(LLMRole.REPORT_WRITER).openai_api_key == "sk-tenant-key"
        assert derived.get(LLMRole.REPORT_WRITER).model_name == "vendor/writer"
        # Original untouched.
        assert provider.get(LLMRole.ROUTER).openai_api_key == "sk-platform"

    def test_shared_llm_instances_stay_shared(self):
        provider = LLMProvider()
        shared = FakeChatModel()
        provider.set_default(shared)
        provider.configure(LLMRole.ROUTER, shared)
        provider.configure(LLMRole.PLANNER, shared)

        derived = provider.with_credential(CREDENTIAL)
        assert derived.get(LLMRole.ROUTER) is derived.get(LLMRole.PLANNER)

    def test_none_credential_returns_self(self):
        provider = LLMProvider()
        provider.set_default(FakeChatModel())
        assert provider.with_credential(None) is provider


class TestResolveOrgLlmCredential:
    def test_no_org_short_circuits(self):
        assert resolve_org_llm_credential(None) is None
        assert resolve_org_llm_credential("") is None

    def test_caches_positive_results(self):
        keys = OrgKeys(byok=CREDENTIAL)
        with patch.object(llm_credentials, "_fetch_org_keys", return_value=keys) as fetch:
            assert resolve_org_llm_credential("org_1") is CREDENTIAL
            assert resolve_org_llm_credential("org_1") is CREDENTIAL
            assert fetch.call_count == 1

    def test_a_fetch_error_fails_closed_and_is_remembered_briefly(self):
        with patch.object(llm_credentials, "_fetch_org_keys", side_effect=RuntimeError("boom")) as fetch:
            with pytest.raises(OrgCredentialUnavailable):
                resolve_org_llm_credential("org_1")
            with pytest.raises(OrgCredentialUnavailable):
                resolve_org_llm_credential("org_1")
            assert fetch.call_count == 1

    def test_without_the_internal_channel_there_are_no_per_org_keys(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert llm_credentials._fetch_org_keys("org_1") == NO_ORG_KEYS


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class TestTheKeyEndpointContract:
    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")

    def _fetch(self, payload):
        with patch("httpx.get", return_value=_Response(payload)):
            return llm_credentials._fetch_org_keys("org_1")

    def test_the_platform_key_and_byok_are_both_read(self):
        keys = self._fetch(
            {
                "credential": {
                    "id": "c",
                    "provider": "openrouter",
                    "baseUrl": "https://openrouter.ai/api/v1",
                    "apiKey": "sk-byok",
                },
                "platformKey": {"id": "k", "apiKey": "sk-or-org", "keyFingerprint": "fp"},
                "perOrgKeys": True,
            }
        )
        assert keys.per_org_keys and keys.platform_key == "sk-or-org" and keys.byok.api_key == "sk-byok"
        assert "sk-or-org" not in repr(keys)

    def test_per_org_keys_on_without_a_key_is_a_refusal(self):
        with pytest.raises(OrgCredentialUnavailable):
            self._fetch({"credential": None, "platformKey": None, "perOrgKeys": True})

    def test_a_deployment_without_per_org_keys_says_so(self):
        keys = self._fetch({"credential": None, "platformKey": None, "perOrgKeys": False})
        assert not keys.per_org_keys and keys.platform_key is None


class TestResolveOrgKeys:
    def test_a_cached_failure_raises_without_another_round_trip(self):
        with patch.object(llm_credentials, "_fetch_org_keys", side_effect=RuntimeError("boom")):
            with pytest.raises(OrgCredentialUnavailable):
                resolve_org_keys("org_2")
        with pytest.raises(OrgCredentialUnavailable):
            llm_credentials.cached_org_keys("org_2")
