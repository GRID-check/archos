"""Where the estate is read, knowledge_search and list_files are rebound; the agent-runtime function is shared."""

from __future__ import annotations

import pytest
from knowledge_layer.chat_binding import chat_tools
from knowledge_layer.register import SCOPE_PARAGRAPH
from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import ValidationError


class _Search(BaseModel):
    query: str
    match: str = "meaning"
    stemmed: bool = False
    context: int | None = None
    filters: dict | None = None
    folder: str | None = None
    shelf: str | None = None
    file_name: str | None = None
    path: str | None = None
    doc_class: str | None = None
    conclusion: str = ""


class _List(BaseModel):
    folder: str | None = None
    added_since: str | None = None
    offset: int | None = None
    revisions_of: str | None = None
    view: str | None = None
    depth: int | None = None


async def _echo(**kwargs):
    return kwargs


def _tools() -> list[StructuredTool]:
    return [
        StructuredTool.from_function(coroutine=_echo, name="knowledge_search", description="x", args_schema=_Search),
        StructuredTool.from_function(coroutine=_echo, name="list_files", description="x", args_schema=_List),
        StructuredTool.from_function(coroutine=_echo, name="look", description="look", args_schema=_List),
    ]


def _bound() -> list:
    return chat_tools(_tools(), top_k=16, max_per_document=5)


def test_the_search_is_ranked_only_and_its_text_is_the_shared_one_scoped_by_path():
    search = _bound()[0]
    schema = search.tool_call_schema.model_json_schema()
    assert set(schema["properties"]) == {"query", "path", "doc_class", "conclusion"}
    assert schema["properties"]["conclusion"]["description"]
    assert SCOPE_PARAGRAPH not in search.description and "`path=`" in search.description
    assert '`match="exact"`' not in search.description and "Returns up to 16 excerpts" in search.description


async def test_a_hidden_scope_argument_reaches_the_function_and_a_retired_one_is_an_error():
    search = _bound()[0]
    assert (await search.ainvoke({"query": "Fluchtweg", "folder": "Gutachten"}))["folder"] == "Gutachten"
    with pytest.raises(ValidationError, match="match"):
        await search.ainvoke({"query": "T30", "match": "exact"})


def test_list_files_keeps_paging_and_dates_and_loses_its_tree():
    listing, look = _bound()[1:]
    assert set(listing.tool_call_schema.model_json_schema()["properties"]) == {
        "folder",
        "added_since",
        "offset",
        "revisions_of",
    }
    assert 'view="tree"' not in listing.description and "added_since" in listing.description
    assert look.description == "look"
