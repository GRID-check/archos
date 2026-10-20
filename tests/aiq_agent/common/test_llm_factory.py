"""Tests for fleet-wide OpenRouter structured-output defaults."""

from types import SimpleNamespace

import pytest

from aiq_agent.common.llm_factory import apply_openrouter_structured_defaults
from aiq_agent.common.llm_factory import get_langchain_llm


class FakeLLM:
    """Minimal stand-in for a LangChain ChatOpenAI (mutable extra_body)."""

    def __init__(self, base_url="https://openrouter.ai/api/v1", extra_body=None):
        self.openai_api_base = base_url
        self.extra_body = extra_body


def test_openrouter_llm_gets_response_healing():
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


def test_require_parameters_is_not_set():
    # require_parameters is deliberately omitted: it 404s ("No endpoints found
    # that can handle the requested parameters") when a group is overridden to a
    # model whose endpoints don't support every param we send.
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    assert "provider" not in llm.extra_body


def test_is_idempotent():
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    apply_openrouter_structured_defaults(llm)
    healing = [p for p in llm.extra_body["plugins"] if p.get("id") == "response-healing"]
    assert len(healing) == 1


def test_preserves_existing_extra_body():
    llm = FakeLLM(extra_body={"provider": {"order": ["A"]}, "plugins": [{"id": "web"}]})
    apply_openrouter_structured_defaults(llm)
    # Pre-existing provider prefs are left untouched (we neither add nor remove).
    assert llm.extra_body["provider"] == {"order": ["A"]}
    ids = {p["id"] for p in llm.extra_body["plugins"]}
    assert ids == {"web", "response-healing"}


def test_non_openrouter_llm_is_untouched():
    llm = FakeLLM(base_url="https://llm.example.test/v1")
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body is None


def test_llm_without_extra_body_field_is_untouched():
    llm = SimpleNamespace(openai_api_base="https://openrouter.ai/api/v1")
    # No extra_body attribute at all -> returned unchanged, no crash.
    assert apply_openrouter_structured_defaults(llm) is llm
    assert not hasattr(llm, "extra_body")


def test_base_url_falls_back_to_client():
    llm = SimpleNamespace(
        openai_api_base=None,
        base_url=None,
        async_client=SimpleNamespace(base_url="https://openrouter.ai/api/v1"),
        extra_body=None,
    )
    apply_openrouter_structured_defaults(llm)
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


async def _resolved_through_nat(**llm_config):
    """`get_langchain_llm` on a client NAT itself builds from an `_type: openai` block."""
    import nat.plugins.langchain.llm  # noqa: F401 - registers NAT's LangChain clients
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.llm.openai_llm import OpenAIModelConfig

    config = OpenAIModelConfig(
        model_name="openai/gpt-5.6-luna",
        api_key="test-key",  # pragma: allowlist secret
        **llm_config,
    )
    async with WorkflowBuilder() as builder:
        await builder.add_llm("llm", config)
        return await get_langchain_llm(builder, "llm")


@pytest.mark.asyncio
async def test_get_langchain_llm_resolves_and_hardens_the_chat_model_itself():
    """NAT 1.9 hands back a `RunnableConfigurableFields` wrapper. Hardening that
    lands on the wrapper fails or no-ops, and a per-request `model_copy` of it
    keeps sending the original model, so the seam must return the chat model,
    still retry-patched the way NAT patched the wrapper."""
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.model_overrides import override_model

    llm = await _resolved_through_nat(base_url="https://openrouter.ai/api/v1")

    assert isinstance(llm, ChatOpenAI)
    assert llm.extra_body["plugins"] == [{"id": "response-healing"}]
    assert "invoke" in vars(llm), "NAT's retry patch did not survive the unwrap"
    assert override_model(llm, "x-ai/grok-4.5").model_name == "x-ai/grok-4.5"


# -- prompt-cache affinity on the outgoing request ----------------------------
#
# The seam these pin is `prepare_request`, which both the chat-completions and
# the Responses payload builders pass through. Asserting on the PAYLOAD rather
# than on the helper is the point: the fields have to survive langchain's
# per-API payload construction, and on the Responses path they ride in
# `extra_body` precisely because that is the one bag both builders forward.


def _openrouter_chat_model(**kwargs):
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    llm = ChatOpenAI(
        model="openai/gpt-5.6-luna",
        api_key="test-key",  # pragma: allowlist secret
        base_url="https://openrouter.ai/api/v1",
        **kwargs,
    )
    return enforce_chat_request_contract(apply_openrouter_structured_defaults(llm))


def _sent_payload(llm, messages, **bind_kwargs):
    """The request body one `invoke` would put on the wire, without the network."""
    captured = {}
    base = type(llm).__mro__[1]
    original = base._generate

    def _capture(self, msgs, stop=None, run_manager=None, **kwargs):
        captured["payload"] = self._get_request_payload(msgs, stop=stop, **kwargs)
        raise _Captured

    base._generate = _capture
    try:
        (llm.bind(**bind_kwargs) if bind_kwargs else llm).invoke(messages)
    except _Captured:
        pass
    finally:
        base._generate = original
    return captured["payload"]


class _Captured(Exception):
    """Stop the call once the payload exists; nothing should reach the network."""


def _messages(system="You are Piloti."):
    from langchain_core.messages import HumanMessage
    from langchain_core.messages import SystemMessage

    return [SystemMessage(content=system), HumanMessage(content="Wie hoch darf die Brüstung sein?")]


DEFERRED_TOOLS = [
    {"type": "tool_search"},
    {"type": "namespace", "name": "piloti", "tools": [{"type": "function", "name": "knowledge_search"}]},
]


def test_chat_completions_payload_carries_the_cache_routing_fields():
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    extra_body = payload["extra_body"]
    assert extra_body["session_id"] == extra_body["prompt_cache_key"]
    assert extra_body["session_id"].startswith("grid-")


def test_responses_payload_carries_the_cache_routing_fields():
    llm = _openrouter_chat_model(use_responses_api=True)
    payload = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    assert "input" in payload  # the Responses shape, not chat completions
    assert payload["extra_body"]["session_id"].startswith("grid-")


def test_cache_routing_does_not_displace_the_response_healing_plugin():
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert payload["extra_body"]["plugins"] == [{"id": "response-healing"}]


def test_usage_include_is_not_sent():
    # OpenRouter: "The `usage: { include: true }` … parameters are deprecated
    # and have no effect." Sending one would be cargo cult, not configuration.
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert "usage" not in payload
    assert "usage" not in payload["extra_body"]


def test_provider_order_is_not_pinned():
    # A manual provider order DISABLES OpenRouter's sticky routing, which is
    # the mechanism the cache key exists to drive.
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert "provider" not in payload["extra_body"]


def _booked_to(**identity):
    from aiq_agent.common.cost_tracking import GridCostTracker
    from aiq_agent.common.cost_tracking import grid_cost_tracker_var

    return grid_cost_tracker_var.set(GridCostTracker(**identity))


@pytest.mark.parametrize("responses_api", [False, True])
def test_the_payload_names_whose_work_the_call_is(responses_api):
    from aiq_agent.common.cost_tracking import grid_cost_tracker_var

    token = _booked_to(organization_id="org_1", user_id="user_2", conversation_id="c_3")
    try:
        payload = _sent_payload(_openrouter_chat_model(use_responses_api=responses_api), _messages())
    finally:
        grid_cost_tracker_var.reset(token)
    extra_body = payload["extra_body"]
    assert extra_body["user"] == "org_1/user_2"
    assert extra_body["metadata"] == {"organization_id": "org_1", "user_id": "user_2", "conversation_id": "c_3"}
    assert extra_body["plugins"] == [{"id": "response-healing"}], "attribution displaced the instance's extra_body"


def test_attribution_keeps_the_instance_extra_body_without_a_cache_key():
    # No system message means no cache key; the attribution must still layer
    # over the instance's extra_body rather than replace it.
    from langchain_core.messages import HumanMessage

    from aiq_agent.common.cost_tracking import grid_cost_tracker_var

    token = _booked_to(organization_id="org_1")
    try:
        payload = _sent_payload(_openrouter_chat_model(), [HumanMessage(content="Hallo")])
    finally:
        grid_cost_tracker_var.reset(token)
    assert payload["extra_body"]["user"] == "org_1"
    assert payload["extra_body"]["plugins"] == [{"id": "response-healing"}]


def test_a_bound_extra_body_does_not_displace_the_instances_without_a_cache_key():
    # A per-call extra_body REPLACES the instance's in langchain's payload, so
    # with no cache key and no tracker the healing plugin (and, on a pinned
    # model, the ZDR routing) used to be dropped.
    from langchain_core.messages import HumanMessage

    payload = _sent_payload(_openrouter_chat_model(), [HumanMessage(content="Hallo")], extra_body={"x": 1})
    assert payload["extra_body"]["x"] == 1
    assert payload["extra_body"]["plugins"] == [{"id": "response-healing"}]


@pytest.mark.parametrize("responses_api", [False, True])
def test_a_chat_call_for_an_organization_goes_out_on_its_key(responses_api):
    # Asserted on the WIRE: the per-call header has to survive langchain's
    # payload builders and the OpenAI SDK's header merge on both APIs.
    from unittest.mock import patch

    import httpx
    from langchain_core.messages import HumanMessage
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.cost_tracking import grid_cost_tracker_var
    from aiq_agent.common.llm_credentials import OrgKeys
    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(500, json={"error": {"message": "stop"}})

    llm = enforce_chat_request_contract(
        ChatOpenAI(
            model="openai/gpt-5.6-luna",
            api_key="sk-shared",  # pragma: allowlist secret
            base_url="https://openrouter.ai/api/v1",
            use_responses_api=responses_api,
            max_retries=0,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
    )
    token = _booked_to(organization_id="org_1")
    try:
        with (
            patch(
                "aiq_agent.common.llm_credentials.resolve_org_keys",
                return_value=OrgKeys(per_org_keys=True, platform_key="sk-or-org"),
            ),
            pytest.raises(Exception),
        ):
            llm.invoke([HumanMessage(content="Hallo")])
    finally:
        grid_cost_tracker_var.reset(token)
    assert seen and seen[0].headers["authorization"] == "Bearer sk-or-org"


def test_a_turns_iterations_share_one_key():
    from langchain_core.messages import AIMessage
    from langchain_core.messages import ToolMessage

    llm = _openrouter_chat_model(use_responses_api=True)
    first = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    later = _sent_payload(
        llm,
        [
            *_messages(),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {}, "id": "call_1"}]),
            ToolMessage(content="a passage", tool_call_id="call_1"),
        ],
        tools=DEFERRED_TOOLS,
    )
    assert first["extra_body"]["session_id"] == later["extra_body"]["session_id"]


def test_a_different_system_prompt_gets_a_different_key():
    llm = _openrouter_chat_model()
    first = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    other = _sent_payload(llm, _messages(system="Du bist Piloti."), tools=DEFERRED_TOOLS)
    assert first["extra_body"]["session_id"] != other["extra_body"]["session_id"]


def test_a_non_openrouter_model_sends_no_cache_routing():
    # `session_id` is OpenRouter's own field; a direct OpenAI-compatible
    # endpoint would be handed a parameter it never declared.
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    llm = enforce_chat_request_contract(
        ChatOpenAI(
            model="gpt-5.6",
            api_key="test-key",  # pragma: allowlist secret
            base_url="https://api.openai.test/v1",
        )
    )
    payload = _sent_payload(llm, _messages())
    assert "extra_body" not in payload


def test_cache_routing_composes_with_zdr_provider_routing():
    # The other extra_body writer is the per-request ZDR seam
    # (`model_overrides.apply_zdr_routing`), which sets `provider.zdr`. The two
    # must compose: a tenant on ZDR still gets a cache key, and the key must not
    # displace the routing policy that keeps its data out of training sets.
    from aiq_agent.common.model_overrides import apply_zdr_routing

    llm = apply_zdr_routing(_openrouter_chat_model())
    payload = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    extra_body = payload["extra_body"]
    assert extra_body["provider"]["zdr"] is True
    assert extra_body["provider"]["data_collection"] == "deny"
    assert extra_body["provider"]["order"][0] == "azure/eu"
    assert extra_body["session_id"].startswith("grid-")
    assert extra_body["plugins"] == [{"id": "response-healing"}]


def test_a_model_override_changes_the_key():
    # A re-pointed group (ADR-0014) is a different cache, so it must not be
    # pinned to the previous model's shard.
    from aiq_agent.common.model_overrides import override_model

    llm = _openrouter_chat_model()
    before = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    after = _sent_payload(override_model(llm, "anthropic/claude-sonnet-5"), _messages(), tools=DEFERRED_TOOLS)
    assert before["extra_body"]["session_id"] != after["extra_body"]["session_id"]


# -- previous_response_id on the OpenRouter Responses path ---------------------
#
# NAT hands every `api_type: responses` client `use_previous_response_id=True`,
# which langchain-openai fills from the last `resp_…` AIMessage id. OpenRouter
# rejects the field outright, so `get_langchain_llm` must turn it off — and only
# for OpenRouter, where a direct OpenAI endpoint keeps the feature it supports.


async def _resolved_responses_client(base_url):
    """An `api_type: responses` client, built by NAT."""
    return await _resolved_through_nat(base_url=base_url, api_type="responses")


def _turn_after_a_resp_id_answer():
    from langchain_core.messages import AIMessage
    from langchain_core.messages import HumanMessage

    return [
        *_messages(),
        AIMessage(content="Einen Meter.", response_metadata={"id": "resp_abc"}),
        HumanMessage(content="Und im Dachgeschoss?"),
    ]


@pytest.mark.asyncio
async def test_openrouter_responses_client_never_sends_previous_response_id():
    llm = await _resolved_responses_client("https://openrouter.ai/api/v1")
    assert llm.use_previous_response_id is False

    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    assert "input" in payload  # still the Responses shape, not chat completions
    assert "previous_response_id" not in payload
    assert "previous_response_id" not in payload.get("extra_body", {})


@pytest.mark.asyncio
async def test_the_whole_conversation_still_goes_without_the_server_side_handle():
    # Dropping the handle is only safe because the payload stops being truncated
    # to the messages *after* the resp_ id: OpenRouter is stateless, so the
    # history has to travel with every request.
    llm = await _resolved_responses_client("https://openrouter.ai/api/v1")
    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    sent = str(payload["input"])
    assert "Brüstung" in sent
    assert "Dachgeschoss" in sent


@pytest.mark.asyncio
async def test_a_non_openrouter_responses_client_is_untouched():
    llm = await _resolved_responses_client("https://api.openai.test/v1")
    assert llm.use_previous_response_id is True

    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    assert payload["previous_response_id"] == "resp_abc"


# -- a rate limit that arrives inside the stream ------------------------------
#
# OpenRouter reports an upstream rate limit on the Responses path as an `error`
# event mid-stream; langchain-openai turns it into a bare ValueError with no
# status code and no "429" in it. NAT's default filters missed it, so the turn
# ended on the generic error instead of waiting a moment (#826).

_STREAMED_RATE_LIMIT = (
    "ResponseError(code='rate_limit_exceeded', message='openai/gpt-6.1-sol is temporarily "
    "rate-limited upstream. Please retry shortly')"
)


@pytest.mark.asyncio
async def test_a_rate_limit_raised_inside_the_stream_is_retried():
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration
    from langchain_core.outputs import ChatResult

    llm = await _resolved_through_nat(base_url="https://openrouter.ai/api/v1", num_retries=2)
    base = type(llm).__mro__[1]
    original = base._agenerate
    calls = []

    async def _rate_limited_once(self, messages, stop=None, run_manager=None, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise ValueError(_STREAMED_RATE_LIMIT)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Einen Meter."))])

    base._agenerate = _rate_limited_once
    try:
        result = await llm.ainvoke(_messages())
    finally:
        base._agenerate = original

    assert result.content == "Einen Meter."
    assert len(calls) == 2


def test_the_configured_retry_messages_survive_the_merge():
    from aiq_agent.common.llm_factory import retry_messages

    assert retry_messages(["Too Many Requests", "429"]) == ["Too Many Requests", "429", "rate_limit_exceeded"]
    assert retry_messages(None) == ["rate_limit_exceeded"]
    assert retry_messages(["rate_limit_exceeded"]) == ["rate_limit_exceeded"]


async def test_an_async_chat_call_resolves_the_organizations_key_off_the_event_loop():
    # A cold cache is a blocking BFF round-trip (3 s timeout); on the loop it
    # would stall every conversation on the replica.
    import threading
    from unittest.mock import patch

    import httpx
    from langchain_core.messages import HumanMessage
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.cost_tracking import grid_cost_tracker_var
    from aiq_agent.common.llm_credentials import OrgKeys
    from aiq_agent.common.llm_credentials import reset_credential_cache
    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    seen: list[httpx.Request] = []
    resolved_on: list[str] = []

    async def handler(request):
        seen.append(request)
        return httpx.Response(500, json={"error": {"message": "stop"}})

    def resolve(organization_id):
        resolved_on.append(threading.current_thread().name)
        return OrgKeys(per_org_keys=True, platform_key="sk-or-org")

    llm = enforce_chat_request_contract(
        ChatOpenAI(
            model="openai/gpt-5.6-luna",
            api_key="sk-shared",  # pragma: allowlist secret
            base_url="https://openrouter.ai/api/v1",
            max_retries=0,
            http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
    )
    reset_credential_cache()
    token = _booked_to(organization_id="org_async")
    try:
        with patch("aiq_agent.common.llm_credentials.resolve_org_keys", side_effect=resolve), pytest.raises(Exception):
            await llm.ainvoke([HumanMessage(content="Hallo")])
    finally:
        grid_cost_tracker_var.reset(token)
        reset_credential_cache()
    assert seen and seen[0].headers["authorization"] == "Bearer sk-or-org"
    assert resolved_on and resolved_on[0] != threading.main_thread().name
