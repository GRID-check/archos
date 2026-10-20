"""The OpenRouter seam: the pin, the org policy (fail closed) and each adapter."""

from __future__ import annotations

import contextvars
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import pytest

from aiq_agent.common import openrouter
from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.common.openrouter import NO_RETENTION_LIMITS
from aiq_agent.common.openrouter import ZERO_DATA_RETENTION
from aiq_agent.common.openrouter import DataPolicy
from aiq_agent.common.openrouter import ZdrRoutingError
from aiq_agent.common.openrouter import data_policy_for
from aiq_agent.common.openrouter import data_policy_scope
from aiq_agent.common.openrouter import pin_chat_model
from aiq_agent.common.openrouter import pinned_http_client
from aiq_agent.common.openrouter import scoped_data_policy
from aiq_agent.common.openrouter import targets_openrouter


class TestTargetsOpenRouter:
    @pytest.mark.parametrize(
        "url",
        ["https://openrouter.ai/api/v1", "https://eu.openrouter.ai/api/v1", "https://openrouter.ai/api/v1/rerank"],
    )
    def test_openrouter_hosts(self, url):
        assert targets_openrouter(url)

    @pytest.mark.parametrize("url", ["https://api.openai.com/v1", "", None, "https://evil.test/openrouter.ai"])
    def test_other_hosts(self, url):
        assert not targets_openrouter(url)


class TestThePin:
    def test_zdr_and_no_data_collection(self):
        provider = ZERO_DATA_RETENTION.apply({"model": "m"})["provider"]
        assert provider["zdr"] is True and provider["data_collection"] == "deny"

    def test_eu_endpoints_are_preferred_not_required(self, monkeypatch):
        monkeypatch.delenv(openrouter.PREFERRED_PROVIDERS_ENV, raising=False)
        provider = ZERO_DATA_RETENTION.apply({})["provider"]
        assert provider["order"][0] == "azure/eu"
        assert provider["allow_fallbacks"] is True

    def test_the_preference_is_configurable_and_can_be_switched_off(self, monkeypatch):
        monkeypatch.setenv(openrouter.PREFERRED_PROVIDERS_ENV, " mistral/eu , azure/eu ")
        assert ZERO_DATA_RETENTION.apply({})["provider"]["order"] == ["mistral/eu", "azure/eu"]
        monkeypatch.setenv(openrouter.PREFERRED_PROVIDERS_ENV, "")
        assert "order" not in ZERO_DATA_RETENTION.apply({})["provider"]

    def test_an_explicit_order_and_other_fields_survive(self):
        body = {"model": "m", "provider": {"order": ["x"], "sort": "price"}, "plugins": [1]}
        merged = ZERO_DATA_RETENTION.apply(body)
        assert merged["provider"]["order"] == ["x"] and merged["provider"]["sort"] == "price"
        assert merged["plugins"] == [1]
        assert body == {"model": "m", "provider": {"order": ["x"], "sort": "price"}, "plugins": [1]}, "never mutated"

    def test_no_zdr_is_a_plain_copy(self):
        body = {"model": "m"}
        assert NO_RETENTION_LIMITS.apply(body) == body


class TestTheOrganizationsPolicy:
    def test_no_organization_is_no_restriction(self):
        assert data_policy_for(None) == NO_RETENTION_LIMITS

    @pytest.mark.parametrize("zdr", [True, False])
    def test_the_setting_decides(self, zdr):
        with patch("aiq_agent.common.model_overrides.resolve_org_zdr_only", return_value=zdr):
            assert data_policy_for("org_1") == DataPolicy(zdr=zdr)

    def test_an_unreadable_setting_is_zdr(self):
        with patch("aiq_agent.common.model_overrides.resolve_org_zdr_only", side_effect=RuntimeError("boom")):
            assert data_policy_for("org_1") == ZERO_DATA_RETENTION


class _OpenRouterModel:
    """Duck-typed chat model: OpenRouter base URL, ``extra_body``, ``model_copy``."""

    openai_api_base = "https://openrouter.ai/api/v1"

    def __init__(self, extra_body=None, *, copy_fails=False):
        self.extra_body = extra_body
        self._copy_fails = copy_fails

    def model_copy(self, update):
        if self._copy_fails:
            raise TypeError("frozen")
        return _OpenRouterModel(update["extra_body"])


class TestPinChatModel:
    def test_a_copy_carries_the_pin(self):
        llm = _OpenRouterModel({"plugins": []})
        pinned = pin_chat_model(llm, ZERO_DATA_RETENTION)
        assert pinned is not llm and pinned.extra_body["provider"]["zdr"] is True
        assert llm.extra_body == {"plugins": []}

    def test_a_model_that_cannot_carry_it_raises_rather_than_sends(self):
        with pytest.raises(ZdrRoutingError):
            pin_chat_model(_OpenRouterModel(copy_fails=True), ZERO_DATA_RETENTION)

    def test_nothing_to_do_returns_the_model_itself(self):
        llm = _OpenRouterModel()
        assert pin_chat_model(llm, NO_RETENTION_LIMITS) is llm


class TestThePinnedHttpClient:
    def _send(self, url, content, policy=ZERO_DATA_RETENTION):
        seen: list[httpx.Request] = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={})

        client = pinned_http_client(policy)
        client._transport._inner = httpx.MockTransport(handler)
        client.post(url, content=content, headers={"content-type": "application/json"})
        return seen[0]

    def test_an_openrouter_post_is_pinned(self):
        sent = self._send("https://openrouter.ai/api/v1/embeddings", json.dumps({"input": ["x"], "extra": 1}))
        body = json.loads(sent.content)
        assert body["provider"]["zdr"] is True and body["extra"] == 1
        assert int(sent.headers["content-length"]) == len(sent.content)

    def test_another_host_is_untouched(self):
        sent = self._send("https://api.openai.com/v1/embeddings", json.dumps({"input": ["x"]}))
        assert "provider" not in json.loads(sent.content)

    def test_a_body_it_cannot_pin_is_refused(self):
        with pytest.raises(ZdrRoutingError):
            self._send("https://openrouter.ai/api/v1/embeddings", b"not json")


@contextmanager
def _booked_to(**identity):
    """Run the block inside a cost tracker naming ``identity``, as a turn or an ingest job does."""
    from aiq_agent.common.cost_tracking import GridCostTracker
    from aiq_agent.common.cost_tracking import grid_cost_tracker_var

    token = grid_cost_tracker_var.set(
        GridCostTracker(organization_id=identity.pop("organization_id", None), **identity)
    )
    try:
        yield
    finally:
        grid_cost_tracker_var.reset(token)


class TestAttribution:
    def _send(self, url, body, policy=NO_RETENTION_LIMITS):
        return TestThePinnedHttpClient()._send(url, json.dumps(body), policy)

    def test_a_chat_call_names_its_organization_person_and_project(self):
        with _booked_to(organization_id="org_1", user_id="user_2", project_id="p_3", activity="ingest"):
            body = json.loads(self._send("https://openrouter.ai/api/v1/chat/completions", {"model": "m"}).content)
        assert body["user"] == "org_1/user_2"
        assert body["metadata"] == {
            "organization_id": "org_1",
            "user_id": "user_2",
            "project_id": "p_3",
            "activity": "ingest",
        }

    def test_an_embedding_call_carries_user_but_no_metadata(self):
        # OpenRouter's embeddings schema declares `user` and not `metadata`.
        with _booked_to(organization_id="org_1"):
            body = json.loads(self._send("https://openrouter.ai/api/v1/embeddings", {"input": ["x"]}).content)
        assert body["user"] == "org_1" and "metadata" not in body

    def test_attribution_rides_along_with_the_pin(self):
        with _booked_to(organization_id="org_1", user_id="user_2"):
            body = json.loads(
                self._send("https://openrouter.ai/api/v1/responses", {"model": "m"}, ZERO_DATA_RETENTION).content
            )
        assert body["provider"]["zdr"] is True and body["user"] == "org_1/user_2"

    def test_what_the_caller_set_wins(self):
        with _booked_to(organization_id="org_1", user_id="user_2"):
            body = json.loads(
                self._send(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {"user": "mine", "metadata": {"organization_id": "kept", "x": "y"}},
                ).content
            )
        assert body["user"] == "mine"
        assert body["metadata"] == {"organization_id": "kept", "user_id": "user_2", "x": "y"}

    def test_outside_a_tracker_nothing_is_added(self):
        sent = self._send("https://openrouter.ai/api/v1/chat/completions", {"model": "m"})
        assert json.loads(sent.content) == {"model": "m"}

    def test_another_host_never_learns_who_asked(self):
        with _booked_to(organization_id="org_1", user_id="user_2"):
            body = json.loads(self._send("https://api.openai.com/v1/chat/completions", {"model": "m"}).content)
        assert "user" not in body and "metadata" not in body

    def test_an_unparseable_body_is_sent_as_is_when_nothing_must_be_pinned(self):
        with _booked_to(organization_id="org_1"):
            sent = TestThePinnedHttpClient()._send(
                "https://openrouter.ai/api/v1/chat/completions", b"not json", NO_RETENTION_LIMITS
            )
        assert sent.content == b"not json"


class TestAttributionNeverFailsACall:
    def test_ids_that_are_not_strings_are_written_as_strings(self):
        with _booked_to(organization_id=uuid.UUID(int=1), user_id=7):
            assert openrouter.attribution_fields()["user"] == f"{uuid.UUID(int=1)}/7"

    def test_an_unread_body_passes_through_when_nothing_must_be_pinned(self):
        request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions", files={"f": ("a", b"x")})
        with _booked_to(organization_id="org_1"):
            assert openrouter._shaped_request(request, NO_RETENTION_LIMITS) is request

    def test_an_endpoint_whose_schema_has_no_user_gets_nothing(self):
        with _booked_to(organization_id="org_1", user_id="user_2"):
            sent = TestAttribution()._send("https://openrouter.ai/api/alpha/decisions", {"model": "m"})
        assert json.loads(sent.content) == {"model": "m"}

    def test_metadata_stops_at_sixteen_pairs_and_the_callers_keys_come_first(self):
        theirs = {f"k{i}": "v" for i in range(14)}
        with _booked_to(organization_id="org_1", user_id="user_2", project_id="p_3"):
            body = json.loads(
                TestAttribution()._send("https://openrouter.ai/api/v1/chat/completions", {"metadata": theirs}).content
            )
        assert len(body["metadata"]) == 16
        assert theirs.items() <= body["metadata"].items()
        assert body["metadata"]["organization_id"] == "org_1" and "project_id" not in body["metadata"]


class TestTheIngestScope:
    def test_no_scope_is_pinned(self):
        assert scoped_data_policy() == ZERO_DATA_RETENTION

    def test_the_scope_reaches_a_pool_thread_that_copies_the_context(self):
        with data_policy_scope(NO_RETENTION_LIMITS), ThreadPoolExecutor(1) as pool:
            copied = pool.submit(contextvars.copy_context().run, scoped_data_policy).result()
            bare = pool.submit(scoped_data_policy).result()
        assert copied == NO_RETENTION_LIMITS
        assert bare == ZERO_DATA_RETENTION, "a thread that lost the context pins"


class TestTheRefusal:
    def test_openrouters_data_policy_404_is_recognised_through_a_wrapper(self):
        from aiq_agent.common.openrouter import is_data_policy_refusal

        refusal = "Error code: 404 - No endpoints found matching your data policy (Zero data retention)"
        try:
            try:
                raise RuntimeError(refusal)
            except RuntimeError as inner:
                raise ValueError("retry exhausted") from inner
        except ValueError as outer:
            assert is_data_policy_refusal(outer)

    def test_other_404s_are_not(self):
        from aiq_agent.common.openrouter import is_data_policy_refusal

        other = RuntimeError("404 No endpoints found that can handle the requested parameters")
        assert not is_data_policy_refusal(other)


class TestResolvedCredentialBody:
    def _cred(self, base_url, policy):
        return ResolvedCredential(api_key="k", base_url=base_url, model="m", source="env", data_policy=policy)

    def test_openrouter_carries_the_policy(self):
        body = self._cred("https://openrouter.ai/api/v1", ZERO_DATA_RETENTION).request_body({"model": "m"})
        assert body["provider"]["zdr"] is True

    def test_a_byok_host_is_sent_what_it_understands(self):
        body = self._cred("https://api.openai.com/v1", ZERO_DATA_RETENTION).request_body({"model": "m"})
        assert "provider" not in body

    def test_the_resolver_attaches_the_organizations_policy(self, monkeypatch):
        from aiq_agent.common.credential_resolution import resolve_llm_credential

        monkeypatch.setenv("TEST_KEY", "k")
        with (
            patch("aiq_agent.common.model_overrides.resolve_org_zdr_only", return_value=True),
            patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=None),
        ):
            cred = resolve_llm_credential(
                primary_env="TEST_KEY",
                default_base_url="https://openrouter.ai/api/v1",
                default_model="m",
                organization_id="org_1",
            )
        assert cred.data_policy == ZERO_DATA_RETENTION
