"""The contract of the read tools other agents reach over MCP is the one the tools generate (ADR-0122).

``apps/workspace/tests/fixtures/backend-tools.schema.json`` is what the BFF's MCP
server shows an outside agent: each tool's name, the description the chat model
reads, its input JSON Schema and its annotations. It is written from the
functions themselves, so a changed description or argument that leaves it
unregenerated would show the outside agent a tool that no longer exists.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from agent.common.backend_tools import BACKEND_READ_TOOLS
from scripts.generate_backend_tools_schema import SCHEMA_PATH

ROOT = Path(__file__).resolve().parents[4]


def _render_in_a_clean_interpreter() -> str:
    """The fixture as the generator writes it, from a process of its own.

    NAT's function registry is process-global. Tests elsewhere in a shard used to
    import the knowledge layer by its source path (`sources.knowledge_layer.src…`,
    until ADR-0145 row 5), which registered each tool a second time under another
    module name, and the config then refused the short type as ambiguous. Which tests share a process depends
    on how pytest-split groups them, so in-process rendering passed locally and
    failed in CI. A fresh interpreter is how the generator itself runs.
    """
    return subprocess.run(
        [sys.executable, "-c", "from scripts.generate_backend_tools_schema import render; print(render(), end='')"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def test_the_committed_contract_is_the_one_the_tools_generate() -> None:
    assert SCHEMA_PATH.read_text(encoding="utf-8") == _render_in_a_clean_interpreter(), (
        "apps/workspace/tests/fixtures/backend-tools.schema.json is stale: run "
        "`uv run python scripts/generate_backend_tools_schema.py` and commit it."
    )


def test_every_allowed_tool_is_in_the_contract_as_a_read() -> None:
    tools = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["tools"]

    assert [tool["name"] for tool in tools] == list(BACKEND_READ_TOOLS)
    for tool in tools:
        assert len(tool["description"]) >= 40, tool["name"]
        assert tool["inputSchema"]["type"] == "object", tool["name"]
        assert tool["annotations"] == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        }


def test_the_door_gets_the_shelf_argument_the_chat_model_gets() -> None:
    tools = {tool["name"]: tool for tool in json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["tools"]}
    search = tools["knowledge_search"]

    assert "shelf" in search["inputSchema"]["properties"]
    assert "`shelf=`" in search["description"]
