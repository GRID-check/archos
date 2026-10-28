"""The shared knowledge tools are rebound only for an agent that reads the estate (ADR-0133 slice 6).

A config without ``filesystem`` (the compliance benchmark, an eval arm) has no ``grep``, so it must
keep ``knowledge_search``'s literal modes: rebinding it there took literal search away in silence.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from agent.agents.piloti.register import ResearchAgentConfig
from agent.agents.piloti.register import _chat_bound


class _Search(BaseModel):
    query: str
    match: str = "meaning"


async def _noop(**_kwargs) -> str:
    return ""


def _search() -> StructuredTool:
    return StructuredTool.from_function(coroutine=_noop, name="knowledge_search", description="x", args_schema=_Search)


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config.return_value = SimpleNamespace(top_k=16, max_chunks_per_document=5)
    return builder


def test_without_the_estate_the_full_contract_stays():
    tools = [_search()]
    assert _chat_bound(tools, ResearchAgentConfig(llm="x"), _builder()) == tools
    assert "match" in tools[0].tool_call_schema.model_json_schema()["properties"]


def test_with_the_estate_the_search_is_rebound_ranked_only():
    (bound,) = _chat_bound([_search()], ResearchAgentConfig(llm="x", filesystem="knowledge_search"), _builder())
    assert "match" not in bound.tool_call_schema.model_json_schema()["properties"]
    assert "Returns up to 16 excerpts" in bound.description
