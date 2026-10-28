"""How much of a PDF the ingest read, and why the rest was not read.

A page can need more than its text layer: a drawing is read by the vision model,
a scan or a garbled text layer is transcribed. Each of those can fail, be cut
off at a cap, or not happen because no vision model is configured, and until
now each such page was skipped with a warning in the log. The person saw a
complete-looking document. This record makes it a number on the document
("38 von 40 Seiten vollständig gelesen") and says what kept the rest out.

``not_read`` counts pages that needed a vision read (a drawing or a scan) and did
not get one. Such a page may still have its text layer in the index, so it is
"not fully read", not "missing".

Shape: ``docs/architecture/document-dossier.md`` (``coverage``).
"""

from __future__ import annotations

from collections.abc import Collection
from collections.abc import Sequence
from typing import Any

REASONS = ("render_cap", "vision_failed", "transcription_failed", "transcription_cap", "no_vision")


def reading_coverage(
    *,
    page_count: int,
    text_pages: Sequence[dict[str, Any]],
    drawing_pages: Collection[int] | None,
    rendered: int,
    read: int,
    transcribed: int,
    transcription_failed: int,
    transcription_over_cap: int,
    not_transcribed: int,
    vision_configured: bool,
) -> dict[str, Any] | None:
    """The coverage record of one PDF. Pure; ``None`` for a document without pages.

    ``drawing_pages`` is what the triage called a drawing (``None`` when it could
    not measure the PDF, and then only what was rendered is known); ``rendered``
    and ``read`` are the drawing pages rendered and the ones the vision model
    returned an analysis for. The transcription counts come from the triage's
    :class:`~knowledge_layer.llamaindex.transcription.TranscriptionOutcome`;
    ``not_transcribed`` are the scans left untranscribed for want of a vision model.
    """
    if page_count <= 0:
        return None
    drawings = len(drawing_pages) if drawing_pages is not None else rendered
    reasons = {
        "render_cap": max(0, drawings - rendered) if vision_configured else 0,
        "vision_failed": max(0, rendered - read),
        "transcription_failed": transcription_failed,
        "transcription_cap": transcription_over_cap,
        "no_vision": not_transcribed + (drawings if not vision_configured else 0),
    }
    reasons = {key: count for key, count in reasons.items() if count > 0}
    with_text = sum(1 for page in text_pages if str(page.get("text") or "").strip())
    return {
        "pages": page_count,
        "text": max(0, with_text - transcribed),
        "transcribed": transcribed,
        "drawings": drawings,
        "drawings_read": read,
        "not_read": min(page_count, sum(reasons.values())),
        "reasons": reasons,
    }
