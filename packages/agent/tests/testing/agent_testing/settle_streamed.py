"""A registry and a streamed source list for the citation-settling suites."""

from __future__ import annotations

from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    for page in (12, 13):
        registry.add(
            SourceEntry(
                citation_key=f"oib-rl_2_ausgabe_mai_2023.pdf, p.{page}",
                source_type="knowledge_layer",
                collection="oib_knowledge",
                tool_name="knowledge_search",
            )
        )
    return registry


SOURCES = (
    "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] erfunden.pdf, p.1\n"
    "- [3] oib-rl_2_ausgabe_mai_2023.pdf, p.13"
)
