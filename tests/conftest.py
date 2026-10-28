"""Shared fixtures for the backend test suite.

Every test loads this file, so it imports only what every test needs. A fixture
that needs a heavy package imports it in its body, and the model doubles live in
``tests/provider_doubles.py``: loading LangChain, NAT and the Qdrant client here
cost every test, a one-line harness test included, about 4.6 s of a 5.7 s run
(docs/audit/blast-radius-2026-10.md). ``tests/test_import_weight.py`` holds it.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest
from knowledge_layer_testing.qdrant_fixtures import fresh_qdrant_store  # noqa: F401 - a store of its own
from knowledge_layer_testing.qdrant_fixtures import qdrant_store  # noqa: F401 - the shared store fixture


def _reset_shared_cache() -> None:
    # Only a cache some import already loaded holds anything to reset.
    cache = sys.modules.get("aiq_agent.common.cache")
    if cache is not None:
        cache.reset_local_store()


@pytest.fixture(autouse=True)
def _isolate_shared_cache():
    """Reset the shared cache around every test.

    The ingest pipeline reads/writes the fail-open shared cache
    (``aiq_agent.common.cache``, ADR-0020) — notably the content-hash VLM
    caption cache. Its in-process fallback store (``REDIS_URL`` unset, which is
    how the suite runs) is a module global, so without this a caption produced
    by one test is served to the next whenever the two feed the VLM identical
    image bytes: the second test's stubbed VLM is never called and it asserts
    against the first test's caption. Mirrors
    ``packages/ris-adapter/testing/ris_adapter_testing/lookup.py``. No-op on a real Redis backend.
    """
    _reset_shared_cache()
    yield
    _reset_shared_cache()


@pytest.fixture
def strict_provider_llm():
    """A contract-enforcing chat model wired exactly as production wires one.

    Returns a factory so a test can queue the replies it needs. The model is
    passed through :func:`enforce_chat_request_contract` — the same call
    ``get_langchain_llm`` makes for every model in the fleet — so tests exercise
    the production configuration rather than a bare model that would fail on
    inputs production never sees.
    """

    from aiq_agent.common.llm_factory import enforce_chat_request_contract
    from tests.provider_doubles import StrictProviderChatModel

    def _make(responses: list[Any] | None = None, *, with_contract: bool = True) -> Any:
        model = StrictProviderChatModel(responses=list(responses or []))
        return enforce_chat_request_contract(model) if with_contract else model

    return _make


@pytest.fixture(autouse=True)
def _no_live_decisions(monkeypatch):
    """The decision model (ADR-0064) is off unless a test turns it on.

    Ingestion tags, memory reflection, the turn start and every search now ask
    it, and its key is the OpenRouter key a developer's shell already holds:
    without this a test that never mentions decisions calls the live endpoint,
    passes or fails on its latency, and spends money. A test of a decision
    deletes the variable and stubs the endpoint (``test_decisions.py``).
    """
    monkeypatch.setenv("DECISIONS_ENABLED", "false")


class Emitted(list):
    """Every wire body a producer wrote, in order, and the steps among them."""

    @property
    def steps(self) -> list[Any]:
        return [body.step for body in self if getattr(body, "type", "").startswith("STEP_")]

    def step(self, step_id: str) -> Any:
        """The newest step with this id: what the reader's row shows."""
        matches = [step for step in self.steps if step.id == step_id]
        assert matches, f"no step {step_id!r} in {[step.id for step in self.steps]}"
        return matches[-1]


@pytest.fixture
def emitted(monkeypatch) -> Emitted:
    """What producers write through ``turn_status.emit``, captured at LangGraph's writer seam.

    For a unit test of one producer. A test that the writer REACHES a producer
    runs it in a compiled graph instead (:func:`stream_custom`).
    """
    bodies = Emitted()
    monkeypatch.setattr("aiq_agent.common.turn_status.get_stream_writer", lambda: bodies.append)
    return bodies


async def stream_custom(work: Any) -> Emitted:
    """Await ``work()`` as the one node of a compiled graph under ``astream(stream_mode=["custom"])``.

    Returns every body the node wrote, exactly as the chat socket's stream would
    carry them.
    """
    from typing import TypedDict

    from langgraph.graph import END
    from langgraph.graph import START
    from langgraph.graph import StateGraph

    class _State(TypedDict, total=False):
        done: bool

    async def node(_state: _State) -> _State:
        await work()
        return {"done": True}

    builder = StateGraph(_State)
    builder.add_node("producer", node)
    builder.add_edge(START, "producer")
    builder.add_edge("producer", END)
    graph = builder.compile()
    return Emitted([chunk async for _mode, chunk in graph.astream({}, stream_mode=["custom"])])
