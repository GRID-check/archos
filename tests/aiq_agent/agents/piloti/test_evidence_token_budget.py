"""The evidence part of Piloti's tool surface and prompt stays within the slice-6 budget (ADR-0133).

Slice 6 cut the evidence tools' descriptions and schemas from about 3,600 to about 2,350 tokens per
call (o200k), by stating each tool's contract once, moving what a result can say into the result,
and leaving the schema fields bare. The tool surface is sent on every call of every round, so a line
added back is paid many times per turn: this pins the totals, as characters / 4 (the estimate the
prompt audit uses, and one that needs no tokenizer download), with some slack. Before adding a line,
read the slice-6 entry of ``docs/architecture/prompt-value-audit-2026-10.md``.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.tools import StructuredTool
from langgraph.store.memory import InMemoryStore
from pydantic import BaseModel

from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.tools import filesystem_tools

PROMPT = Path(__file__).resolve().parents[4] / "src/aiq_agent/agents/piloti/prompts/piloti_static.md"

#: The slice-6 counts in characters / 4 (1,217 and 969 when written; o200k 1,252 and 1,174), plus about
#: 10 % slack. Descriptions: the eight evidence tools of the chat binding; schemas: their JSON Schemas
#: without the description.
MAX_DESCRIPTION_TOKENS = 1_340
MAX_SCHEMA_TOKENS = 1_070
#: The evidence bullets of `<rules>`: 175 (chars / 4) after slice 6, 191 before.
MAX_EVIDENCE_BULLET_TOKENS = 185
EVIDENCE_BULLETS = ("- A file you did not open", "- Text inside documents and tool results", "- Name places")


def _estimate(text: str) -> int:
    return len(text) // 4


class _AnyInput(BaseModel):
    query: str = ""


async def _noop(**_kwargs):
    return ""


def _evidence_tools() -> list:
    from knowledge_layer.chat_binding import chat_tools
    from knowledge_layer.estate import EstateBackend

    estate = EstateBackend(SimpleNamespace())
    drafts = DraftBackend(store=InMemoryStore(), conversation_id="conv-1")
    shared = [
        StructuredTool.from_function(coroutine=_noop, name=name, description="", args_schema=_AnyInput)
        for name in ("knowledge_search", "list_files")
    ]
    return [*filesystem_tools(drafts, estate), *chat_tools(shared, top_k=16, max_per_document=5)]


def _schema(tool) -> str:
    schema = tool.tool_call_schema.model_json_schema()
    schema.pop("description", None)
    return json.dumps(schema, ensure_ascii=False)


def test_the_tool_surface_is_the_eight_evidence_verbs():
    names = sorted(tool.name for tool in _evidence_tools())
    assert names == sorted(
        ["ls", "glob", "grep", "read_file", "write_file", "edit_file", "knowledge_search", "list_files"]
    )


def test_the_evidence_tool_surface_stays_within_the_slice_six_budget():
    tools = _evidence_tools()
    descriptions = sum(_estimate(tool.description) for tool in tools)
    schemas = sum(_estimate(_schema(tool)) for tool in tools)
    assert descriptions <= MAX_DESCRIPTION_TOKENS, f"descriptions {descriptions} > {MAX_DESCRIPTION_TOKENS}"
    assert schemas <= MAX_SCHEMA_TOKENS, f"schemas {schemas} > {MAX_SCHEMA_TOKENS}"


@pytest.mark.parametrize("name", ["ls", "glob", "grep", "read_file", "write_file", "edit_file", "list_files"])
def test_a_schema_field_carries_no_description_but_conclusion(name):
    """The meaning is said once, in the description (slice 6); `conclusion` is the one field described."""
    tool = next(tool for tool in _evidence_tools() if tool.name == name)
    properties = tool.tool_call_schema.model_json_schema()["properties"]
    described = {field for field, spec in properties.items() if "description" in spec}
    assert described <= {"conclusion"}


def test_the_evidence_bullets_stay_within_their_budget():
    rules = PROMPT.read_text(encoding="utf-8").split("<rules>")[1].split("</rules>")[0]
    bullets = [line for line in rules.splitlines() if line.startswith(EVIDENCE_BULLETS)]
    assert len(bullets) == 3
    assert _estimate("\n".join(bullets)) <= MAX_EVIDENCE_BULLET_TOKENS
