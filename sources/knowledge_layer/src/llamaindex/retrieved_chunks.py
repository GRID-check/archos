"""A retrieved LlamaIndex node as the universal ``Chunk``: its score, its content type and its citation."""

import logging
import math
import uuid
from typing import Any

from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType

logger = logging.getLogger(__name__)


def unit_score(score: Any) -> float:
    """A hit's cosine as ``Chunk.score`` holds it: within ``[0, 1]``, total on every input.

    Anti-correlated results floor at ``0.0`` rather than going negative:
    ``Chunk.score`` is contractually ``[0, 1]``, and "worse than unrelated" and
    "unrelated" are the same decision for every consumer. ``None``, ``NaN`` and
    garbage return ``0.0`` and never raise: ``normalize``'s except-branch does
    not drop a bad chunk, it substitutes one whose content is
    ``str(raw_result)``, which then occupies a top-k slot and can be cited.
    """
    try:
        value = float(score)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


#: ``content_type`` metadata values with a content type of their own; anything else is text.
_CONTENT_TYPES = {
    "table": ContentType.TABLE,
    "image": ContentType.IMAGE,
    "chart": ContentType.CHART,
    "drawing": ContentType.DRAWING,
}


def chunk_from_node(raw_result: Any) -> Chunk:
    """A LlamaIndex ``NodeWithScore`` as the universal ``Chunk``, with the citation a reader sees.

    Total: a result it cannot read becomes a placeholder chunk scored 0, never an exception.
    """
    try:
        if raw_result is None:
            raise ValueError("raw_result is None")
        # LlamaIndex returns NodeWithScore objects
        node = getattr(raw_result, "node", None)
        if node is None:
            raise ValueError("raw_result.node is None")
        score = raw_result.score if hasattr(raw_result, "score") else 0.0

        # Extract metadata (node.metadata can be None or non-dict for some nodes)
        _meta = getattr(node, "metadata", None)
        metadata = _meta if isinstance(_meta, dict) else {}
        file_name = metadata.get("file_name", "unknown")
        page_number = _page_number(metadata.get("page_label"))
        content_type = _CONTENT_TYPES.get(str(metadata.get("content_type", "text")), ContentType.TEXT)
        content = node.get_content() if hasattr(node, "get_content") else str(node)

        return Chunk(
            chunk_id=node.node_id if hasattr(node, "node_id") else str(uuid.uuid4()),
            content=content,
            score=unit_score(score),
            file_name=file_name,
            page_number=page_number,
            display_citation=_display_citation(content_type, metadata, file_name, page_number, content),
            content_type=content_type,
            metadata=metadata,
        )

    except Exception as e:
        logger.error(f"Error normalizing LlamaIndex result: {e}")
        return Chunk(
            chunk_id=str(uuid.uuid4()),
            content=str(raw_result),
            score=0.0,
            file_name="unknown",
            display_citation="Unknown Result",
            content_type=ContentType.TEXT,
        )


def _page_number(label: Any) -> int | None:
    """The page label as an int, or ``None`` when there is none or it is not a number."""
    if label is None:
        return None
    try:
        return int(label)
    except (ValueError, TypeError):
        return None


def _display_citation(
    content_type: ContentType, metadata: dict[str, Any], file_name: str, page_number: int | None, content: str
) -> str:
    """The citation a reader sees for a hit: the page, and what on it (a table, an image, a drawing, a text anchor)."""
    if content_type == ContentType.TABLE and "table_index" not in metadata:
        # A captioned table (``captioned_tables``) is addressed by its
        # ``clause_id`` („Tabelle 3"), not by an index on the page, and
        # is cited by the page key every other hit renders under.
        return f"{file_name}, p.{page_number}" if page_number else file_name
    if content_type == ContentType.TABLE:
        table_idx = metadata.get("table_index", 0)
        return f"{file_name}, p.{page_number}, Table {table_idx + 1}"
    if content_type == ContentType.IMAGE:
        img_idx = metadata.get("image_index", 0)
        return f"{file_name}, p.{page_number}, Image {img_idx + 1}"
    if content_type == ContentType.DRAWING:
        drawing_type = metadata.get("drawing_type", "Zeichnung")
        return f"{file_name}, p.{page_number}, {drawing_type}"
    if not page_number:
        return file_name
    # Add text anchor for easier verification (Ctrl+F in source)
    text_preview = content[:40].replace("\n", " ").strip()
    if text_preview:
        return f"{file_name}, p.{page_number} ('{text_preview}...')"
    return f"{file_name}, p.{page_number}"
