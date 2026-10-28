"""The listing as text: one line per row, the change marks it carries, and the folder's listing block."""

from __future__ import annotations

from collections.abc import Sequence

from aiq_agent.knowledge.title_block import title_block_label

from .browse_rows import _SHELF_LABELS
from .browse_rows import MAX_FOLDER_LINES
from .browse_rows import MAX_SUMMARY_CHARS
from .browse_rows import MAX_TOPIC_COUNTS
from .browse_rows import MAX_TYPE_COUNTS
from .browse_rows import FileRow
from .browse_rows import Listing
from .browse_text import fold

#: What a row says of a file's change: a glance, so the model reads the files themselves for more.
MAX_CHANGE_CHARS = 160

#: The same line when the question IS the change (``revisions_of``): what „was hat sich geändert“ is answered from.
MAX_CHAIN_CHANGE_CHARS = 700


def _change_text(row: FileRow, limit: int) -> str:
    """The stored change line as one sentence of at most ``limit`` characters; empty when none is stored."""
    if not row.change_summary:
        return ""
    lines = [line.lstrip("-•* ").strip() for line in row.change_summary.splitlines()]
    text = "; ".join(line for line in lines if line)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _compared_with_own_upload(row: FileRow) -> bool:
    return row.change_basis is not None and fold(row.change_basis) == fold(row.file_name)


def _change_bit(row: FileRow) -> str:
    """``changed: …`` for what changed against the Fassung this file replaced, bounded; empty when none is stored.

    A change line against the file's own previous upload (``change_basis`` is its
    own name) says so, because the previous upload is not another file.
    """
    text = _change_text(row, MAX_CHANGE_CHARS)
    if not text:
        return ""
    return f"changed (previous Fassung): {text}" if _compared_with_own_upload(row) else f"changed: {text}"


def _row_line(row: FileRow, *, show_shelf: bool, mark: str | None = None) -> str:
    bits: list[str] = []
    if row.display_title and fold(row.display_title) != fold(row.file_name):
        bits.append(f'"{row.display_title}"')
    bits.append(f"Folder: {row.folder}" if row.folder else "Folder: (top level)")
    if row.doc_class:
        bits.append(f"Dokumentart: {row.doc_class}")
    if row.document_type and row.document_type != "other":
        bits.append(f"Type: {row.document_type.replace('_', ' ')}")
    if row.page_count:
        bits.append(f"{row.page_count} page{'' if row.page_count == 1 else 's'}")
    if row.pages_not_read:
        bits.append(f"{row.pages_not_read} page(s) not fully read: content there may be missing from search")
    if row.tags:
        bits.append(f"Tags: {', '.join(row.tags)}")
    if row.topics:
        bits.append(f"Topics: {', '.join(row.topics)}")
    if row.captured_at:
        camera = f" (camera: {row.camera})" if row.camera else ""
        bits.append(f"taken {row.captured_at[:10]}{camera}")
    elif row.camera:
        bits.append(f"camera: {row.camera}")
    title_block = title_block_label(row.revision_facts)
    if title_block:
        bits.append(f"Plankopf: {title_block}")
    if row.facts:
        bits.append(f"States: {'; '.join(row.facts)}")
    if row.references:
        bits.append(f"Refers to: {', '.join(row.references)}")
    if row.fact_changes:
        bits.append(f"Facts changed against the previous Fassung: {'; '.join(row.fact_changes)}")
    if mark:
        bits.append(mark)
    change = _change_bit(row)
    if change:
        bits.append(change)
    if row.added_at:
        bits.append(f"uploaded {row.added_at}")
    if show_shelf and row.shelf:
        bits.append(_SHELF_LABELS.get(row.shelf, row.shelf))
    summary = row.summary
    if len(summary) > MAX_SUMMARY_CHARS:
        summary = summary[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"
    tail = f" — {summary}" if summary else ""
    return f"- {row.file_name} · {' · '.join(bits)}{tail}"


def _scope_of(listing: Listing) -> str:
    """Where a listing looked: the shelves, and the folder when one was asked for."""
    where = " and ".join(_SHELF_LABELS.get(shelf, shelf) for shelf in listing.shelves)
    return f'{where}, folder "{listing.folder}" with subfolders' if listing.folder else where


def _in_flight_line(in_flight: Sequence[str]) -> str:
    return (
        "Still processing (uploaded but not yet readable, so neither listed here nor searchable): "
        + ", ".join(in_flight[:10])
        + (f" and {len(in_flight) - 10} more" if len(in_flight) > 10 else "")
    )


def _profile_lines(listing: Listing) -> list[str]:
    """The lines that say what the listed files are: their Dokumentart, topics and Fassungen."""
    lines: list[str] = []
    if listing.types:
        profile = " · ".join(f"{tag} {count}" for tag, count in listing.types[:MAX_TYPE_COUNTS])
        untyped = f"; without Dokumentart: {listing.untyped}" if listing.untyped else ""
        lines.append(f"Dokumentart (assigned by Piloti): {profile}{untyped}.")
    elif listing.untyped:
        # Said rather than left out: no line would read the same as "no profile".
        lines.append("Dokumentart: Piloti has assigned none of these files a Dokumentart.")
    if listing.topics:
        profile = " · ".join(f"{topic} {count}" for topic, count in listing.topics[:MAX_TOPIC_COUNTS])
        lines.append(f"Topics (recognised by Piloti): {profile}.")
    if listing.confirmed_replacements:
        lines.append(
            f"Fassungen (confirmed): a person replaced {listing.confirmed_replacements} file(s) with a "
            "newer one; the rows say which. Rely on the newer one and name the older one only when asked or "
            "when comparing. The older one stays readable with file_name=."
        )
    if listing.title_block_series:
        lines.append(
            f"Fassungen (Plankopf): {listing.title_block_series} document(s) carry the same document number in "
            "their Plankopf in several states (Index, date); the rows are marked. Rely on the current Fassung "
            "and name an older one only when asked or when comparing. It is a reading of the Plankopf, not a "
            'confirmation: say "by Plankopf".'
        )
    if listing.revision_series:
        lines.append(
            f"Fassungen: {listing.revision_series} document(s) exist in several Fassungen by file name (Index, "
            "date); the rows are marked. Rely on the current Fassung and name an older one only when asked or "
            "when comparing. It is a reading of the names, not a confirmation: "
            'say "by file name".'
        )
    return lines


def render_listing(listing: Listing, *, in_flight: Sequence[str] = ()) -> str:
    """The listing as the model reads it: counts first, then folders, then files."""
    scope = _scope_of(listing)
    lines: list[str] = [*listing.notes]
    if listing.notes and not listing.total:
        return "\n".join(lines)
    if not listing.total:
        lines.append(f"No file on {scope} matches these filters.")
    else:
        first = listing.offset + 1
        last = listing.offset + len(listing.rows)
        shown = f"{first}–{last}" if listing.rows else "none (offset is past the end)"
        lines.append(f"{listing.total} file(s) on {scope}; showing {shown}.")
        lines.extend(_profile_lines(listing))

    if listing.subfolders:
        lines.append("")
        lines.append("Subfolders (files in the whole subtree):")
        for path, count in listing.subfolders[:MAX_FOLDER_LINES]:
            lines.append(f"- {path}/ ({count})")
        rest = len(listing.subfolders) - MAX_FOLDER_LINES
        if rest > 0:
            lines.append(f"- … and {rest} more folders")
        if listing.here:
            lines.append(f"Directly in this folder: {listing.here} file(s).")

    if listing.rows:
        lines.append("")
        lines.append("Files:")
        show_shelf = len(listing.shelves) > 1
        lines.extend(
            _row_line(row, show_shelf=show_shelf, mark=listing.revision_marks.get((row.collection, row.file_name)))
            for row in listing.rows
        )
        remaining = listing.total - (listing.offset + len(listing.rows))
        if remaining > 0:
            lines.append(
                f"… {remaining} more. Next page: the same call with `offset={listing.offset + len(listing.rows)}`."
            )

    if in_flight:
        lines.append("")
        lines.append(_in_flight_line(in_flight))

    lines.append("")
    lines.append(
        "An index, not a source: a row proves the file exists, not what it says. It shows only what Piloti could "
        "read; a file whose reading failed is not here but under `documents_unreadable:` in the project context, "
        "and a file missing here is no proof it does not exist. Write file names exactly as they appear here: the "
        "reader sees each as a link that opens the file. Read: `read_passage(document=…)`; search inside: "
        '`knowledge_search(file_name=…)`, literally with `match="exact"`; see a page: `look`.'
    )
    return "\n".join(lines)
