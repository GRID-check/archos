"""Piloti's chat binding of the shared knowledge tools, through ``PilotiAgent.run`` (ADR-0133 slice 6).

Through the compiled graph, because the claim is about what the model is offered and what RUNS: the
rebound schema is what ``bind_tools`` sends, a retired argument is an error that names its replacement
and runs nothing, an unbound name is answered by the ``ToolNode``, and a hidden scope argument still
reaches the function.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from knowledge_layer.chat_binding import chat_tools
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from agent.agents.piloti.agent import PilotiAgent
from agent.agents.piloti.models import ResearchAgentState
from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry
from agent.common import LLMProvider

RAN: list[dict] = []


class _SearchInput(BaseModel):
    """The NAT function's own arguments, as the shared binding has them."""

    query: str
    match: str = "meaning"
    folder: str | None = None
    path: str | None = None
    conclusion: str = ""


async def _search(**kwargs) -> str:
    RAN.append(kwargs)
    return f"Treffer zu: {kwargs['query']}"


@pytest.fixture(autouse=True)
def _quiet_pipeline():
    RAN.clear()
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


def _agent(*rounds: AIMessage) -> tuple[PilotiAgent, MagicMock]:
    shared = StructuredTool.from_function(
        coroutine=_search, name="knowledge_search", description="shared", args_schema=_SearchInput
    )
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(rounds))
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    tools = chat_tools([shared], top_k=16, max_per_document=5)
    return PilotiAgent(llm_provider=provider, tools=tools, system_prompt="Du bist Piloti.", max_tool_iterations=7), llm


def _answer(result, call_id: str) -> ToolMessage:
    (message,) = [m for m in result.messages if isinstance(m, ToolMessage) and m.tool_call_id == call_id]
    return message


async def test_the_chat_binding_offers_ranked_search_refuses_retired_arguments_and_keeps_hidden_scope():
    agent, llm = _agent(
        AIMessage(
            content="",
            tool_calls=[
                {"name": "knowledge_search", "args": {"query": "T30", "match": "exact"}, "id": "lit"},
                {"name": "read_passage", "args": {"document": "a.pdf", "clause": "3.5.2"}, "id": "old"},
                {"name": "knowledge_search", "args": {"query": "Fluchtweg", "folder": "Brandschutz"}, "id": "hid"},
            ],
        ),
        AIMessage(content="Die Antwort."),
    )

    result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wo steht T30?")]))

    (bound,) = [call.args[0] for call in llm.bind_tools.call_args_list]
    offered = bound[0].tool_call_schema.model_json_schema()["properties"]
    assert "match" not in offered and "folder" not in offered and "path" in offered
    literal = _answer(result, "lit")
    assert literal.status == "error" and "match" in str(literal.content) and "`grep(" in str(literal.content)
    assert "not a valid tool" in str(_answer(result, "old").content)
    assert [call["query"] for call in RAN] == ["Fluchtweg"]
    assert RAN[0]["folder"] == "Brandschutz"
