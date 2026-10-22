"""Generate the contract of the agent's read tools that other agents reach over MCP.

``aiq_agent.common.backend_tools`` lists the tools; the workflow config
(``configs/config_oib_openrouter.yml``) binds them; the functions themselves say
what the model sees. This script builds exactly those functions, with nothing
else of the workflow, and writes each one's name, description, input JSON Schema
and annotations to ``frontends/ui/tests/fixtures/backend-tools.schema.json``.
The BFF's ``lib/agent-api/backend-operations.ts`` reads that file, so an MCP
client sees the description the chat model sees, and a change to a tool without
this file regenerated fails ``tests/aiq_agent/common/test_backend_tools_schema.py``.

Run with::

    uv run python scripts/generate_backend_tools_schema.py
"""

import argparse
import asyncio
import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from unittest import mock

from aiq_agent.common.backend_tools import BACKEND_READ_TOOLS
from aiq_agent.common.backend_tools import describe_backend_tool

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "configs" / "config_oib_openrouter.yml"
SCHEMA_PATH = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "backend-tools.schema.json"

#: Building a function constructs its clients but calls nothing. Its model
#: clients want a key present, and this one is never sent anywhere.
_BUILD_ONLY_ENV = {"OPENROUTER_API_KEY": "schema-generation-only"}  # pragma: allowlist secret


async def _describe_all() -> list[dict[str, Any]]:
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.data_models.config import Config
    from nat.runtime.loader import PluginTypes
    from nat.runtime.loader import discover_and_register_plugins
    from nat.utils.io.yaml_tools import yaml_load

    discover_and_register_plugins(PluginTypes.ALL)
    raw = yaml_load(CONFIG_PATH)
    missing = [name for name in BACKEND_READ_TOOLS if name not in raw["functions"]]
    if missing:
        raise SystemExit(f"{CONFIG_PATH.name} does not bind {', '.join(missing)}")
    # The tools and what they are built from (the retrieval tool's models), in
    # the order the config declares them: the tools refer to each other.
    config = Config(
        llms=raw.get("llms", {}),
        embedders=raw.get("embedders", {}),
        functions={name: raw["functions"][name] for name in raw["functions"] if name in BACKEND_READ_TOOLS},
    )
    described: list[dict[str, Any]] = []
    async with WorkflowBuilder() as builder:
        for llm_name, llm_config in config.llms.items():
            await builder.add_llm(llm_name, llm_config)
        for embedder_name, embedder_config in config.embedders.items():
            await builder.add_embedder(embedder_name, embedder_config)
        for name, function_config in config.functions.items():
            function = await builder.add_function(name, function_config)
            described.append(describe_backend_tool(name, function.description, function.input_schema))
    return sorted(described, key=lambda tool: BACKEND_READ_TOOLS.index(tool["name"]))


def render() -> str:
    """The fixture's contents: deterministic, LF, sorted keys, tools in the allowlist's order."""
    with mock.patch.dict(os.environ, {k: os.environ.get(k) or v for k, v in _BUILD_ONLY_ENV.items()}):
        tools = asyncio.run(_describe_all())
    return json.dumps({"version": 1, "tools": tools}, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: Sequence[str] | None = None) -> None:
    """Write the fixture. Takes no arguments; anything else is refused."""
    parser = argparse.ArgumentParser(
        description=f"Regenerate {SCHEMA_PATH.relative_to(ROOT)} from the read tools' own definitions.",
    )
    parser.parse_args(argv)
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"Wrote {len(BACKEND_READ_TOOLS)} tools to {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
