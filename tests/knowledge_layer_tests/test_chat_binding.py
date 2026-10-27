"""Piloti's chat binds knowledge_search and list_files with its own contracts; the NAT function is shared."""

from __future__ import annotations

from knowledge_layer.chat_binding import chat_tools
from langchain_core.tools import StructuredTool
from pydantic import BaseModel


class _Search(BaseModel):
    query: str
    match: str = "meaning"
    folder: str | None = None
    path: str | None = None
    filters: dict | None = None


class _List(BaseModel):
    folder: str | None = None
    revisions_of: str | None = None
    compare_to: str | None = None


async def _echo(**kwargs):
    return kwargs


def _tools() -> list[StructuredTool]:
    return [
        StructuredTool.from_function(
            coroutine=_echo, name="knowledge_search", description="shared", args_schema=_Search
        ),
        StructuredTool.from_function(coroutine=_echo, name="list_files", description="shared", args_schema=_List),
        StructuredTool.from_function(coroutine=_echo, name="look", description="look", args_schema=_List),
    ]


def test_the_search_is_ranked_only_and_states_its_budget():
    search = chat_tools(_tools(), top_k=16, max_per_document=5)[0]
    properties = search.tool_call_schema.model_json_schema()["properties"]
    assert set(properties) == {
        "query",
        "path",
        "doc_class",
        "title_contains",
        "document_type",
        "refers_to",
        "group_by",
        "conclusion",
    }
    assert "up to 16, at most 5 from one document" in search.description
    assert "match" not in search.description.replace("matches", "")


async def test_a_hidden_scope_argument_still_reaches_the_function():
    search = chat_tools(_tools(), top_k=16, max_per_document=5)[0]
    args = await search.ainvoke({"query": "Fluchtweg", "folder": "Gutachten"})
    assert args["folder"] == "Gutachten"
    assert "match" not in args


def test_list_files_is_the_revisions_of_one_document_and_the_rest_is_untouched():
    tools = chat_tools(_tools(), top_k=16, max_per_document=5)
    listing = tools[1]
    assert set(listing.tool_call_schema.model_json_schema()["properties"]) == {"revisions_of", "compare_to"}
    assert "ls or glob" in listing.description
    assert tools[2].description == "look"
    assert _tools()[0].description == "shared"
