"""The estate read as the model sees it: the settled row of each read or listing, the preamble and trailer, and
the rendering of each page or chunk hit.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.citation_collector import note_citations
from aiq_agent.common.estate_paths import action_place

from . import stored_pages
from .estate_files import EstateFile
from .estate_files import ToolOutput
from .estate_files import _content_type
from .estate_pages import pages_label

if TYPE_CHECKING:
    from .estate_listing import Listing


def _settle_listing(row: Any, listing: Listing) -> None:
    """A listing's Herleitung row: ``list`` with its file and folder counts (ADR-0132).

    A folder that is not there is ``empty`` and ``missing`` („nicht gefunden“), not
    a failure; a restricted folder answers exactly so (listing is not use,
    ADR-0088). A folder that is there and holds nothing (a new project, a chat
    without uploads) is ``ok`` with its zeros: it was found, and it is empty.
    """
    if listing.error:
        row.finish("empty", missing=True)
        return
    row.finish("ok", counts={"files": listing.files, "folders": listing.folders})


@dataclass(frozen=True)
class ReadRowFacts:
    """What a ``read_file`` row may say about the read, beside the blocks it served (ADR-0132, ADR-0088)."""

    #: The document by name: the resolved one only when ``may_name``; on a miss, the leaf the model asked for.
    target: str | None = None
    shelf: str | None = None
    #: The path resolved to nothing (or to a restricted file, which answers the same).
    missing: bool = False
    #: The ``pages`` value was refused: the model's mistake, never printed on the row.
    refused_pages: bool = False
    #: A folder card (``<folder>/README.md``): the folder, and the listing it answered with.
    card_folder: str | None = None
    card: Listing | None = None


def _settle_read(row: Any, output: ToolOutput, facts: ReadRowFacts, *, asked: str | None) -> None:
    """A read's Herleitung row (ADR-0132): the document it may name, the pages it SERVED, what it found.

    The pages are the ones the blocks hold, not the ones asked for: a read without
    ``pages`` serves the opening page, and one cut at the character budget serves
    fewer than it was asked. A Punkt stays a Punkt; a refused ``pages`` value is
    the model's mistake, never printed. A miss is ``empty`` („nicht gefunden“).
    """
    if facts.card is not None:
        # A folder card is the folder's listing, and its row says so.
        counts = {"files": facts.card.files, "folders": facts.card.folders}
        row.finish("ok", counts=counts, verb="list", **action_place(facts.card_folder))
        return
    if facts.missing:
        row.finish("empty", missing=True, target=facts.target)
        return
    fields: dict[str, Any] = {key: value for key, value in (("target", facts.target), ("shelf", facts.shelf)) if value}
    served = sorted({hit.page for hit in output.hits if getattr(hit, "page", None)})
    if asked and asked.startswith("Pkt."):
        fields["pages"] = asked
    elif served:
        fields["pages"] = pages_label(served)
    elif asked and not facts.refused_pages:
        fields["pages"] = asked
    counts = {"hits": len(output.hits), "documents": 1} if output.hits else None
    row.finish(output.status, counts=counts, **fields)


def _store_down(file: EstateFile) -> str:
    return f"Could not read {file.path} just now: the store did not answer. Try again; this is not a no."


def _pages_field(pages: Any, clause: Any) -> str | None:
    if clause is not None and str(clause).strip():
        return f"Pkt. {str(clause).strip()}"
    return str(pages).strip() or None if pages is not None else None


def _directory_message(path: str) -> str:
    return f'"{path}" is a folder, not a file: `ls("{path}")` lists it, `glob` finds files by name.'


def _model_message(file: EstateFile) -> str:
    return (
        f"{file.path} is a building model (IFC), not a text: its numbers are measured, not read. "
        f'`ifc_query` and `ifc_measure` answer from it (document="{file.row.file_name}").'
    )


def _empty_message(file: EstateFile) -> str:
    return (
        f"{file.path} holds no readable text yet: it may still be being read, or nothing could be read from it. "
        "Not readable here is not the same as not in the project; say it could not be read."
    )


def _rebuilt_line(text: stored_pages.PageText) -> str:
    if not text.rebuilt:
        return ""
    return "Rebuilt from the index; page breaks inside a passage are approximate."


def _read_preamble(file: EstateFile, text: stored_pages.PageText, served: Sequence[stored_pages.Page]) -> str:
    numbers = [page.number for page in served]
    what = f"page {numbers[0]}" if len(numbers) == 1 else f"pages {pages_label(numbers)}"
    count = f" of {text.page_count}" if text.page_count else ""
    lines = [f"{file.path}, {what}{count}. Each block is one citable passage; cite its Citation line."]
    if rebuilt := _rebuilt_line(text):
        lines.append(rebuilt)
    scans = [page.number for page in served if page.source == stored_pages.SOURCE_OCR]
    if scans:
        lines.append(f"Page(s) {pages_label(scans)} are a scan, transcribed by a vision model.")
    drawings = [page.number for page in served if page.is_drawing]
    if drawings:
        lines.append(
            f"Page(s) {pages_label(drawings)} are a drawing: the text is a vision model's reading of the sheet, "
            "not its printed text. Read off, not measured; "
            f'`look(document="{file.row.file_name}", page={drawings[0]})` shows it.'
        )
    return "\n".join(lines)


def _read_trailer(
    file: EstateFile,
    text: stored_pages.PageText,
    served: Sequence[stored_pages.Page],
    wanted: Sequence[int],
    missing: Sequence[int],
    stopped_at: int | None,
    outline: str,
) -> str:
    numbers = [page.number for page in served]
    lines = [f"Read {('page ' + str(numbers[0])) if len(numbers) == 1 else 'pages ' + pages_label(numbers)}."]
    if stopped_at is not None:
        rest = [number for number in wanted if number >= stopped_at]
        lines.append(f'Stopped at the read limit. Next: pages="{pages_label(rest)}".')
    elif text.page_count and numbers[-1] < text.page_count:
        following = numbers[-1] + 1
        lines.append(f'Next: pages="{following}-{min(text.page_count, following + 2)}".')
    empty = [number for number in missing if not text.page_count or number <= text.page_count]
    if empty:
        lines.append(f"Page(s) {pages_label(empty)} hold no text.")
    if outline:
        lines.append(outline)
    elif not text.rebuilt and len(numbers) == 1 and len(wanted) == 1 and file.paged:
        lines.append("pages= reads further; clause= reads one Punkt.")
    return "\n".join(lines)


def _older_revision_notice(file: EstateFile) -> str:
    from aiq_agent.knowledge.restricted_use import may_name

    from .read_passage import older_revision_line

    current = file.row.superseded_by
    if not current or not may_name(file.row.collection):
        return ""
    return older_revision_line(file.row.file_name, current).strip()


def _page_hit(file: EstateFile, page: stored_pages.Page, *, budget: int, paged: bool = True) -> Any:
    """One page as a grounding record: the page's text, the file's own row, the ``file, p.N`` key."""
    from aiq_agent.common.grounding_block import GroundingHit
    from aiq_agent.common.source_kinds import parse_shelf

    from .grounding_hits import _citation_key_for

    number = page.number if paged and page.number > 0 else None
    shelf = parse_shelf(file.row.shelf)
    body = page.text.strip()
    truncated = len(body) > budget
    return GroundingHit(
        citation_key=_citation_key_for(file.row.file_name, shelf, number, set()),
        file_name=file.row.file_name,
        page=number,
        shelf=shelf,
        collection=file.row.collection or None,
        doc_class=file.row.doc_class,
        display_title=file.row.display_title or file.row.file_name,
        folder_path=file.row.folder or None,
        clause=None,
        score=1.0,
        content_type=_content_type(page),
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=body[:budget] if truncated else body,
        body_truncated=truncated,
        path=file.path,
    )


def _chunk_hit(file: EstateFile, chunk: Any) -> Any:
    """A Punkt's chunk as a record, with the file's row and path."""
    from aiq_agent.common.grounding_block import GroundingHit
    from aiq_agent.common.source_kinds import parse_shelf

    from .grounding_hits import _CHUNK_TRUNCATE_CHARS
    from .grounding_hits import _citation_key_for
    from .grounding_hits import _hit_provenance

    shelf = parse_shelf(file.row.shelf)
    page = chunk.page_number if chunk.page_number and chunk.page_number > 0 else None
    content = chunk.content or ""
    truncated = len(content) > _CHUNK_TRUNCATE_CHARS
    clause = (chunk.metadata or {}).get("clause_id")
    return GroundingHit(
        citation_key=_citation_key_for(file.row.file_name, shelf, page, set()),
        file_name=file.row.file_name,
        page=page,
        shelf=shelf,
        collection=file.row.collection or None,
        doc_class=file.row.doc_class,
        display_title=file.row.display_title or file.row.file_name,
        folder_path=file.row.folder or None,
        clause=str(clause) if clause else None,
        score=1.0,
        content_type=getattr(chunk.content_type, "value", str(chunk.content_type)),
        provenance=_hit_provenance(chunk),
        stored_image_index=None,
        status_note=None,
        body=content[:_CHUNK_TRUNCATE_CHARS] if truncated else content,
        body_truncated=truncated,
        path=file.path,
    )


def _render(hits: tuple[Any, ...], *, preamble: str, notices: Sequence[str], trailer: str, tool: str) -> ToolOutput:
    """The block, rendered and filed (ADR-0061); the hits noted for the call's artifact."""
    from aiq_agent.common.grounding_block import GroundingBlock
    from aiq_agent.common.grounding_block import render_grounding_block

    from .trace_lanes import trace_lanes_for_hits

    banner = "".join(f"{line}\n\n" for line in notices if line)
    text = render_grounding_block(
        GroundingBlock(
            preamble=preamble,
            degraded_banner=banner,
            hits=hits,
            lanes=trace_lanes_for_hits(hits),
            tool=tool,
            trailer=trailer,
        )
    )
    note_citations(hits)
    return ToolOutput(text=text, hits=hits, status="ok")
