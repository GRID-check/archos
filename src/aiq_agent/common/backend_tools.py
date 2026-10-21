"""The read tools Piloti's agent has that the BFF does not, served to other agents (ADR-0121).

The BFF's operation catalog (``frontends/ui/src/lib/agent-api/catalog``) covers what
the BFF's routes do. Piloti's best READ tools live only here, in the Python agent:
they read the office's documents, the building-law corpus, the BIM models and
RIS. An outside agent that reaches Piloti over MCP must get them too, so the
``api`` role serves each of them at ``POST /v1/internal/tools/{name}``
(``aiq_api/routes/internal_tools.py``) and the BFF's MCP server calls it.

This module is the one list of which tools those are, and the one place that says
what a tool looks like from outside: its name, the description the model sees,
its input JSON Schema and its annotations. The BFF reads the result from
``frontends/ui/tests/fixtures/backend-tools.schema.json``, which
``scripts/generate_backend_tools_schema.py`` writes from these functions, so the
tool contract is written once and a stale copy fails a test.

The names are the NAT function names the workflow config binds, which are what
the chat model sees. Only reads belong here. A write stays a BFF route, because
the BFF is the single writer of ``grid_app`` (ADR-0003) and a person gates it.
"""

from __future__ import annotations

from typing import Any
from typing import Final

#: The tools served beside the chat. Adding one is a statement that it only
#: reads, and that everything it reads is scoped by the signed envelope.
BACKEND_READ_TOOLS: Final[tuple[str, ...]] = (
    "knowledge_search",
    "read_passage",
    "list_files",
    "view_knowledge_image",
    "ifc_query",
    "ifc_measure",
    "ris_lookup_tool",
)

#: MCP ``ToolAnnotations`` of every tool here. They all read, change nothing,
#: repeat to the same answer, and stay inside the office's own data and RIS.
READ_ONLY_ANNOTATIONS: Final[dict[str, bool]] = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
}


def is_backend_read_tool(name: str) -> bool:
    """True when ``name`` is one of the tools served to other agents."""
    return name in BACKEND_READ_TOOLS


def describe_backend_tool(name: str, description: str, input_schema: type[Any]) -> dict[str, Any]:
    """One tool as the contract fixture records it.

    ``input_schema`` is the pydantic model NAT built from the function's
    signature, the same one it hands LangChain as the tool's ``args_schema``.
    """
    return {
        "name": name,
        "description": description,
        "inputSchema": input_schema.model_json_schema(),
        "annotations": dict(READ_ONLY_ANNOTATIONS),
    }
