"""The turn's chat model reaches its tools, through the compiled graph (`common/model_vision.py`).

An image tool asks whether the model can see before it sends a page. The answer
is bound in the tools node, because a ContextVar set beside the LLM call dies at
the node boundary (`agents/piloti/AGENTS.md`); only a test through the compiled
graph that reads the var inside a tool can fail on that.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from agent.agents.piloti.agent import PilotiAgent
from agent.agents.piloti.models import ResearchAgentState
from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry
from agent.common import LLMProvider
from agent.common.model_vision import current_chat_model

SEEN: list[str | None] = []


@tool
def look(page: int) -> str:
    """Look at a page."""
    SEEN.append(current_chat_model())
    return f"Seite {page}"


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    SEEN.clear()
    with (
        patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
        patch("agent.agents.piloti.answer_pipeline.verify_citations") as verify,
        patch("agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


async def test_the_tool_reads_the_model_the_turn_answers_with():
    llm = MagicMock()
    llm.model_name = "deepseek/deepseek-v4-pro"
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(
        side_effect=[
            AIMessage(content="", tool_calls=[{"name": "look", "args": {"page": 2}, "id": "l1"}]),
            AIMessage(content="Die Antwort [1]."),
        ]
    )
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    agent = PilotiAgent(llm_provider=provider, tools=[look], max_tool_iterations=4)

    await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was ist auf Seite 2?")]))

    assert SEEN == ["deepseek/deepseek-v4-pro"], f"the tool saw {SEEN}"
    assert current_chat_model() is None
