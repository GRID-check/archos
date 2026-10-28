"""Ranked chunks as `GroundingHit` records: provenance, citation keys, pages and image regions."""

import json
import logging
import math

from knowledge_layer.hit_metadata import hit_display_title
from knowledge_layer.hit_metadata import hit_doc_class
from knowledge_layer.hit_metadata import hit_folder_path
from knowledge_layer.hit_metadata import resolve_display_titles
from knowledge_layer.hit_metadata import resolve_doc_classes
from knowledge_layer.hit_metadata import resolve_folder_paths

from agent.common.estate_paths import estate_path

logger = logging.getLogger(__name__)

# Chunk content truncation. OIB tables routinely exceed 1500 chars and were cut
# mid-table, losing rows the LLM needs to quote. Set to 2500 to keep most table
# rows intact within one chunk. Value chosen as a named constant (#no-magic).
_CHUNK_TRUNCATE_CHARS = 2500


def _hit_provenance(chunk):
    """The agent provenance stated in a hit's chunk metadata, or ``None``.

    The keys are stamped at ingest by the publish path and read back by
    ``agent.common.provenance``; a human-authored document has none, and
    every line below that depends on this is simply not emitted for it. Chunk
    metadata is the only carrier — unlike doc_class and the display title there
    is no store-resolved override, because authorship is decided once, at
    publish, and cannot be edited afterwards.
    """
    from agent.common.provenance import parse_agent_provenance

    return parse_agent_provenance(chunk.metadata or {})


def _chunk_shelf(chunk):
    """The shelf a hit came from, as STATED in its metadata (ADR-0047).

    ``None`` when the producer stated none. It is not recovered from the
    collection id: an unknown shelf is unknown, and a citation for it stays
    unqualified rather than claiming a shelf the pipeline guessed.
    """
    from agent.common.source_kinds import parse_shelf

    return parse_shelf((chunk.metadata or {}).get("shelf"))


def _ambiguous_file_names(chunks) -> set[str]:
    """Filenames this result set holds on MORE THAN ONE shelf.

    A search fans out across the base corpus, the session collection and the
    project collections concurrently, so one result set can carry a project
    `Plan.pdf` and a Büroablage `Plan.pdf` — different documents that a bare
    filename cannot tell apart. Those names (and only those) get a shelf
    qualifier in their citation key, so the common case stays a plain filename.

    Shelf, not raw collection, is the grouping: it is all a citation key can
    express, so two collections on the same shelf are not a distinction the
    model could act on anyway.
    """
    shelves_by_name: dict[str, set] = {}
    for chunk in chunks:
        name = (chunk.file_name or "").strip()
        if not name:
            continue
        shelves_by_name.setdefault(name.lower(), set()).add(_chunk_shelf(chunk))
    return {name for name, shelves in shelves_by_name.items() if len(shelves) > 1}


def _citation_key_for(file_name: str, shelf, page: int | None, ambiguous: set[str]) -> str:
    """The key the model copies: ``"filename, p.X"``, or just ``"filename"``.

    It keeps the REAL filename, which is the document identity preview
    resolution and source dedup use; only the human ``Source:`` label is
    prettified. When the same filename arrived from two different shelves in
    this very result set the name alone no longer identifies a document, so it
    is qualified: ``Plan.pdf (Projektwissen), p.3``. The qualifier is
    rendering, not transport, and an unknown shelf gets none.
    """
    from agent.common.source_kinds import shelf_qualifier

    name = file_name
    qualifier = shelf_qualifier(shelf) if name and name.lower() in ambiguous else None
    if qualifier:
        name = f"{name} ({qualifier})"
    return f"{name}, p.{page}" if page is not None else name


def _stored_image_index(metadata: dict) -> int | None:
    """The index of a raster the ingest pipeline stored beside the document.

    ``None`` unless the chunk carries BOTH keys (``image_store.py``): the model
    reads the index off the rendered line and passes it to
    ``view_knowledge_image``, which then shows the embedded image itself rather
    than a render of the page around it, and an index with no stored key names
    nothing.
    """
    index = metadata.get("stored_image_index")
    if index is None or not metadata.get("image_key"):
        return None
    try:
        return int(index)
    except TypeError, ValueError:
        logger.warning("Ignoring unreadable stored_image_index %r", index)
        return None


#: Suffixes of a file that IS the image the visual analysis read. Anything else
#: carrying an ``image_index`` is a raster embedded in a document, whose box is
#: relative to the raster and not to the page the viewer shows.
_IMAGE_FILE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif")


#: A box covering at least this share of the frame marks nothing a reader does
#: not already see: the whole sheet is "the depiction", so it is left unmarked.
_WHOLE_FRAME_AREA = 0.9


def _hit_regions(chunk) -> tuple:
    """Where on the page a visual chunk's depiction sits, as the viewer draws it (issue #433).

    The visual analysis stores one ``bbox`` per segment inside the chunk's
    ``drawing_data`` (``visual_analysis.segment_payloads``), normalised 0-1 over
    the picture it read. That picture is the frame the viewer shows in two cases
    and not in the third:

    - a rendered PDF page (no ``image_index``): the whole page, uncropped;
    - an uploaded image (``image_index`` on an image file): the whole image;
    - a raster embedded in a PDF or office document: only the raster, and where
      the raster sits on the page was never stored. A box there would land in
      the wrong place with full confidence, so it gets none.

    Anything malformed yields nothing: a missing box leaves the viewer opening
    at the page, which is what it did before, while a wrong one points the
    reader at the wrong drawing.
    """
    from agent.common.grounding_block import SourceRegion

    metadata = chunk.metadata or {}
    raw = metadata.get("drawing_data")
    if not raw:
        return ()
    if metadata.get("image_index") is not None and not str(chunk.file_name).lower().endswith(_IMAGE_FILE_SUFFIXES):
        return ()
    try:
        segment = json.loads(raw).get("segment") or {}
        coords = [float(part) for part in segment.get("bbox") or ()]
    except TypeError, ValueError, AttributeError:
        return ()
    # Finite before clamped: ``min(1.0, max(0.0, nan))`` is 0.0 and an infinity
    # clamps to an edge, so either would pass the geometry checks below as a
    # plausible box around the wrong part of the sheet.
    if len(coords) != 4 or not all(math.isfinite(part) for part in coords):
        return ()
    x0, y0, x1, y1 = (min(1.0, max(0.0, part)) for part in coords)
    if x1 <= x0 or y1 <= y0 or (x1 - x0) * (y1 - y0) >= _WHOLE_FRAME_AREA:
        return ()
    title = segment.get("title")
    label = title.strip() if isinstance(title, str) and title.strip() else None
    return (SourceRegion(box=(x0, y0, x1, y1), label=label),)


def _metadata_text(value: object) -> str | None:
    """A chunk-metadata value as the string a grounding block states, or ``None``."""
    return str(value) if value else None


def grounding_hit(chunk, *, resolved, resolved_titles, resolved_folders, ambiguous: set[str]):
    """One retrieval chunk as the RECORD a grounding block is made of (ADR-0061).

    The single place a chunk becomes citable fields, so the header lines, the
    Trace-Lanes fan-out and the citation registry cannot disagree about a hit's
    shelf, Dokumentart or title. Three fields are resolved against the document
    metadata store rather than chunk metadata (``doc_class``, ``display_title``,
    ``folder_path``): the store is authoritative and a folder rename must take
    effect with no re-ingest (ADR-0049).
    """
    from agent.common.grounding_block import GroundingHit

    metadata = chunk.metadata or {}
    shelf = _chunk_shelf(chunk)
    page = chunk.page_number if chunk.page_number and chunk.page_number > 0 else None
    content = chunk.content
    truncated = len(content) > _CHUNK_TRUNCATE_CHARS
    folder_path = hit_folder_path(chunk, resolved_folders)
    return GroundingHit(
        citation_key=_citation_key_for(chunk.file_name, shelf, page, ambiguous),
        file_name=chunk.file_name,
        page=page,
        shelf=shelf,
        collection=_metadata_text(metadata.get("collection")),
        doc_class=hit_doc_class(chunk, resolved),
        display_title=hit_display_title(chunk, resolved_titles) or chunk.file_name,
        folder_path=folder_path,
        clause=_metadata_text(metadata.get("clause_id")),
        score=chunk.score,
        content_type=chunk.content_type.value,
        provenance=_hit_provenance(chunk),
        stored_image_index=_stored_image_index(metadata),
        status_note=None,
        body=content[:_CHUNK_TRUNCATE_CHARS] if truncated else content,
        body_truncated=truncated,
        regions=_hit_regions(chunk),
        page_end=_page_end(chunk, page),
        # Where `read_file` opens the page around this hit (ADR-0133); none for a shelf with no mount.
        path=estate_path(shelf, folder_path, chunk.file_name) if chunk.file_name else None,
    )


def _page_end(chunk, page: int | None) -> int | None:
    """The chunk's stored ``page_end`` when it is later than its start page, else None."""
    end = str((chunk.metadata or {}).get("page_end") or "")
    return int(end) if page is not None and end.isdigit() and int(end) > page else None


def grounding_hits(chunks) -> tuple:
    """Every chunk of one result set as a record.

    The three store reads are batched once per result set (one query per
    in-scope collection), and which filenames are ambiguous is a property of
    the whole set, so both belong here rather than in the per-chunk builder.
    """
    resolved = resolve_doc_classes(chunks)
    resolved_titles = resolve_display_titles(chunks)
    resolved_folders = resolve_folder_paths(chunks)
    ambiguous = _ambiguous_file_names(chunks)
    return tuple(
        grounding_hit(
            chunk,
            resolved=resolved,
            resolved_titles=resolved_titles,
            resolved_folders=resolved_folders,
            ambiguous=ambiguous,
        )
        for chunk in chunks
    )
