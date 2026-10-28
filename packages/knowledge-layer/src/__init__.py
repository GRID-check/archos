"""
Knowledge Layer - Pluggable document ingestion and retrieval.

This package provides agent-runtime tool registrations for knowledge retrieval that can be used
across multiple applications.

Backend: llamaindex (LlamaIndex readers and chunking, vectors in Qdrant,
ADR-0115), the one production backend (ADR-0072). The retriever/ingestor factory stays pluggable so tests can
register fakes.

Note: agent-runtime tool registrations require the agent runtime to be installed.
The adapter modules can be used standalone without the agent runtime.

Importing the package loads nothing: the agent runtime registers the three tools through
their entry points (`pyproject.toml`), which name the modules themselves.
Re-exporting them here made every `knowledge_layer.qdrant.*` import pay for
the registrations and their LlamaIndex and agent-runtime imports
(docs/audit/blast-radius-2026-10.md); import from the module that defines a
name.
"""
