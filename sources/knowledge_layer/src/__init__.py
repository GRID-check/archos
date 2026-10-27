"""
Knowledge Layer - Pluggable document ingestion and retrieval.

This package provides NAT tool registrations for knowledge retrieval that can be used
across multiple applications.

Backend: llamaindex (LlamaIndex readers and chunking, vectors in Qdrant,
ADR-0115), the one production backend (ADR-0072). The retriever/ingestor factory stays pluggable so tests can
register fakes.

Note: NAT tool registrations require NAT to be installed.
The adapter modules can be used standalone without NAT.
"""

from aiq_agent.lazy_exports import lazy_exports

# Loaded on first use (PEP 562). NAT registers the tools through their entry
# points (`pyproject.toml`), which name the modules themselves; importing them here made
# every `knowledge_layer.qdrant.*` import pay for the registrations and their
# LlamaIndex and NAT imports (docs/audit/blast-radius-2026-10.md).
_LAZY = {
    "ListFilesConfig": ".browse",
    "list_files": ".browse",
    "ReadPassageConfig": ".read_passage",
    "read_passage": ".read_passage",
    "KnowledgeRetrievalConfig": ".register",
    "knowledge_retrieval": ".register",
}

__all__ = list(_LAZY)

__getattr__ = lazy_exports(__name__, _LAZY)
