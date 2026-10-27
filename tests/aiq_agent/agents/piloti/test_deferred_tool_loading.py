"""Deferred tool loading, as Piloti wires it.

The unit rules live in ``tests/aiq_agent/common/test_deferred_tool_loading.py``.
These tests are about the SEAM: that the agent's research bindings — the
construction-time one and every per-turn one — go
through it, that meta turns deliberately do not, and that the whole thing is
byte-identical to the old code path when nobody asked for it.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.common import LLMProvider
from aiq_agent.common.deferred_tool_loading import DeferredToolBinding
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import record_model_verdict
from aiq_agent.common.deferred_tool_loading import reset_model_capability_cache


@tool
def ifc_measure(operation: str) -> str:
    """Misst Bauteile am IFC-Modell: lichte Raumhöhe, Fläche, Brüstung, Fluchtweg."""
    return "2,42 m"


@tool
def ris_search(query: str) -> str:
    """Sucht österreichische Rechtsnormen im RIS: Bauordnung, OIB-Richtlinien."""
    return "OIB-RL 4"


@tool
def remember(fact: str) -> str:
    """Merkt sich eine dauerhafte Projekterkenntnis."""
    return "ok"


@tool
def emit_card(card: str) -> str:
    """Zeigt dem Nutzer eine strukturierte Karte an."""
    return "ok"


TOOLS = [ifc_measure, ris_search, remember, emit_card]


class FakeOpenRouterLLM:
    """ChatOpenAI stand-in on OpenRouter's Responses API."""

    def __init__(self, model_name="openai/gpt-5.6-luna"):
        self.openai_api_base = "https://openrouter.ai/api/v1"
        self.use_responses_api = True
        # A model id is not decoration: the per-model gate reads it, and a model
        # it cannot identify is treated as not cleared for deferral.
        self.model_name = model_name
        self.bind_calls: list[dict] = []

    def bind_tools(self, tools, **kwargs):
        return SimpleNamespace(kind="plain_binding", tools=list(tools))

    def bind(self, **kwargs):
        self.bind_calls.append(kwargs)
        return SimpleNamespace(kind="deferred_binding", **kwargs)

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        return {"model": "openai/gpt-5.6-luna", "input": "ping", **kwargs}


@pytest.fixture
def llm():
    # These tests are about how the agent binds a model that defers, so the
    # probe has measured this one's saving; the gate itself is tested in
    # tests/aiq_agent/common/test_deferred_tool_loading.py.
    reset_model_capability_cache()
    fake = FakeOpenRouterLLM()
    record_model_verdict(fake.model_name, True, source="test: probe measured the saving")
    yield fake
    reset_model_capability_cache()


@pytest.fixture
def provider(llm):
    p = MagicMock(spec=LLMProvider)
    p.get = MagicMock(return_value=llm)
    return p


def _deferred_names(bind_kwargs: dict) -> list[str]:
    namespace = next(t for t in bind_kwargs["tools"] if t["type"] == "namespace")
    return [f["name"] for f in namespace["tools"]]


def test_off_by_default_the_agent_binds_exactly_as_it_always_has(provider, llm):
    agent = PilotiAgent(llm_provider=provider, tools=TOOLS)
    assert agent.deferred_tool_loading is None
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_a_disabled_settings_object_is_the_same_as_none(provider, llm):
    agent = PilotiAgent(llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings())
    assert agent.deferred_tool_loading is None
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_enabled_the_construction_time_binding_defers_every_tool(provider, llm):
    agent = PilotiAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings(enabled=True)
    )
    assert isinstance(agent._llm_with_tools, DeferredToolBinding)
    assert len(llm.bind_calls) == 1
    payload = llm.bind_calls[0]["tools"]
    assert [t["type"] for t in payload] == ["tool_search", "namespace"]
    assert _deferred_names(llm.bind_calls[0]) == [t.name for t in TOOLS]


def test_the_namespace_description_is_the_only_tool_text_sent_up_front(provider, llm):
    settings = DeferredToolLoadingSettings(enabled=True, namespace="piloti", namespace_description="Werkzeuge.")
    PilotiAgent(llm_provider=provider, tools=TOOLS, deferred_tool_loading=settings)
    namespace = next(t for t in llm.bind_calls[0]["tools"] if t["type"] == "namespace")
    assert namespace["name"] == "piloti"
    assert namespace["description"] == "Werkzeuge."


def test_a_chat_completions_deployment_keeps_the_full_binding(provider, llm):
    # A Kimi deployment runs Chat Completions against api.kimi.com. Even with
    # the flag set, that deployment must fall back to sending schemas.
    llm.use_responses_api = False
    agent = PilotiAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings(enabled=True)
    )
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_the_config_defaults_to_off():
    from aiq_agent.agents.piloti.register import ResearchAgentConfig

    config = ResearchAgentConfig(llm="research_llm")
    assert config.deferred_tool_loading.enabled is False
