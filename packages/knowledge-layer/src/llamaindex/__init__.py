"""
LlamaIndex Knowledge Adapter.

LlamaIndex readers and chunking, an OpenAI-compatible embedder, vectors in
Qdrant (ADR-0115). Supports multimodal extraction (text, tables, charts, images).
"""

from .adapter import LlamaIndexIngestor
from .adapter import resolve_vlm_api_key
from .adapter import vlm_configured
from .retriever import LlamaIndexRetriever

__all__ = [
    "LlamaIndexIngestor",
    "LlamaIndexRetriever",
    "resolve_vlm_api_key",
    "vlm_configured",
]
