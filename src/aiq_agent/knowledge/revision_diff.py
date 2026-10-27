"""What changed between two Fassungen, read from what the index already holds (ADR-0104).

The cheap layers of the compare: no model call, nothing read again. Both
Fassungen were read at ingestion, and their chunks carry two kinds of content
that compare honestly, each labelled as what it is:

* **Printed text** (``content_type == "text"``): the words on the page as the
  reader extracted them. Pages are aligned by their text, so a sheet inserted in
  the middle shifts nothing after it; a changed page reports the lines that went
  and came, and the values that moved inside a line that otherwise stayed
  („Fluchtweglänge 38 m → 42 m“).
* **Piloti's reading of a drawing** (``drawing_data`` on a visual chunk): the
  quantities the drawing analysis recorded (object, property, value, unit) and
  the dimension strings it copied verbatim (``annotations``). Compared as sets
  per page, never as prose: two readings of one sheet word their summaries
  differently, and a diff of prose would report a model rewording as a change.

The title block (``revision_facts``) says which Index and date each side is.

Pure: the caller loads the chunks (``load_fassung_chunks``) and the rows; this
module decides and renders. What it does NOT do is look at pixels. The visual
marks (``revision_compare``) are the check on the drawing itself, and the report
says so.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from difflib import SequenceMatcher
from typing import Any
from typing import Literal

#: Title-block fields in the order the report names them, with their German labels.
TITLE_BLOCK_LABELS: tuple[tuple[str, str], ...] = (
    ("document_number", "Nummer"),
    ("revision", "Index"),
    ("revision_date", "Stand"),
    ("scale", "Maßstab"),
    ("title", "Inhalt"),
)

#: Bounds of the rendered report. The model reads it on every call; a drawing set
#: of sixty sheets must not become sixty paragraphs.
MAX_PAGES_SHOWN = 10
MAX_LINES_PER_PAGE = 4
MAX_VALUES_PER_PAGE = 6
MAX_LINE_CHARS = 160

#: Two lines are one line that changed, rather than one removed and one added,
#: when this much of them agrees.
LINE_PAIR_RATIO = 0.5

#: A number with an optional unit, as plans and reports print them: „38 m“,
#: „2,50“, „1.250 mm“, „30 %“, „REI 90“ keeps its number.
_VALUE = re.compile(
    r"\d+(?:[.,]\d+)*(?:\s?(?:m²|m2|m³|m3|mm|cm|dm|km|m|%|‰|kN|kg|t|°C|°|dB|kW|W|h|min|s|l|lx))?(?![\w²³])"
)
_SPACE = re.compile(r"\s+")
_PAGE_MARKER = re.compile(r"^\[(?:TEXT|DRAWING|IMAGE|CHART|TABLE)[^\]]*\]\s*", re.IGNORECASE)


@dataclass(frozen=True)
class RevisionChunk:
    """One stored chunk of a Fassung: the page it belongs to, what kind of content, and its text or reading."""

    page: str
    content_type: str
    text: str = ""
    #: The parsed ``drawing_data`` of a visual chunk, or ``None``.
    structured: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class FieldChange:
    field: str
    label: str
    older: str | None
    newer: str | None


@dataclass(frozen=True)
class ValueChange:
    #: What the value is about: the words before it in the line, or the drawing's object and property.
    subject: str
    older: str
    newer: str


@dataclass(frozen=True)
class PageChange:
    kind: Literal["changed", "added", "removed"]
    older_page: str | None
    newer_page: str | None
    removed_lines: tuple[str, ...] = ()
    added_lines: tuple[str, ...] = ()
    values: tuple[ValueChange, ...] = ()
    #: From Piloti's reading of a drawing on this page.
    drawing_values: tuple[ValueChange, ...] = ()
    annotations_added: tuple[str, ...] = ()
    annotations_removed: tuple[str, ...] = ()


@dataclass(frozen=True)
class RevisionDiff:
    title_block: tuple[FieldChange, ...]
    pages: tuple[PageChange, ...]
    older_page_count: int
    newer_page_count: int
    unchanged_pages: int
    #: Whether either side carried printed text / a drawing reading at all. A
    #: report that found no change in a scan with no text must not read as "the
    #: same document".
    has_text: bool
    has_drawing: bool
    notes: tuple[str, ...] = field(default=())


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


@dataclass
class _Page:
    label: str
    lines: list[str] = field(default_factory=list)
    quantities: dict[tuple[str, str], str] = field(default_factory=dict)
    annotations: set[str] = field(default_factory=set)

    @property
    def text_key(self) -> str:
        return "\n".join(self.lines)

    @property
    def drawing_key(self) -> tuple[Any, ...]:
        return (tuple(sorted(self.quantities.items())), tuple(sorted(self.annotations)))


def _page_sort_key(label: str) -> tuple[int, str]:
    try:
        return (int(label), label)
    except ValueError:
        return (0, label)


def _clean_line(line: str) -> str:
    return _SPACE.sub(" ", _PAGE_MARKER.sub("", line)).strip()


def _text_lines(text: str) -> list[str]:
    return [cleaned for raw in text.splitlines() if (cleaned := _clean_line(raw))]


def _fold(value: Any) -> str:
    return _SPACE.sub(" ", str(value or "")).strip()


def _quantity_entries(structured: Mapping[str, Any]) -> Iterable[tuple[tuple[str, str], str]]:
    segment = structured.get("segment") if isinstance(structured.get("segment"), Mapping) else structured
    for quantity in segment.get("quantities") or ():
        if not isinstance(quantity, Mapping):
            continue
        subject = _fold(quantity.get("object"))
        prop = _fold(quantity.get("property"))
        value = _fold(quantity.get("value"))
        if not subject or not value:
            continue
        unit = _fold(quantity.get("unit"))
        yield (subject.casefold(), prop.casefold()), f"{value} {unit}".strip() if unit else value


def _annotations(structured: Mapping[str, Any]) -> Iterable[str]:
    segment = structured.get("segment") if isinstance(structured.get("segment"), Mapping) else structured
    for annotation in segment.get("annotations") or ():
        if text := _fold(annotation):
            yield text


def _pages(chunks: Sequence[RevisionChunk]) -> list[_Page]:
    """The Fassung's pages in reading order, each with its printed lines and its drawing reading."""
    pages: dict[str, _Page] = {}
    for chunk in chunks:
        page = pages.setdefault(chunk.page, _Page(label=chunk.page))
        if chunk.content_type == "text":
            for line in _text_lines(chunk.text):
                # Chunks of one page overlap; a line read twice is one line.
                if not page.lines or page.lines[-1] != line:
                    page.lines.append(line)
        if chunk.structured:
            for key, value in _quantity_entries(chunk.structured):
                page.quantities[key] = value
            page.annotations.update(_annotations(chunk.structured))
    return [pages[label] for label in sorted(pages, key=_page_sort_key)]


def _subject_before(line: str, start: int) -> str:
    """The words in front of a value: what the value is about, as the line says it."""
    head = line[:start].rstrip(" :=–-")
    words = head.split()
    return " ".join(words[-5:])


def _line_values(older: str, newer: str) -> list[ValueChange]:
    """Values that moved in a line that otherwise stayed the same."""
    old_values = list(_VALUE.finditer(older))
    new_values = list(_VALUE.finditer(newer))
    if not old_values or len(old_values) != len(new_values):
        return []
    changes: list[ValueChange] = []
    for old, new in zip(old_values, new_values, strict=True):
        if old.group(0) != new.group(0):
            subject = _subject_before(newer, new.start()) or _subject_before(older, old.start())
            changes.append(ValueChange(subject=subject, older=old.group(0), newer=new.group(0)))
    return changes


def _compare_text(older: _Page, newer: _Page) -> tuple[list[str], list[str], list[ValueChange]]:
    removed: list[str] = []
    added: list[str] = []
    values: list[ValueChange] = []
    matcher = SequenceMatcher(a=older.lines, b=newer.lines, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        old_block, new_block = older.lines[i1:i2], newer.lines[j1:j2]
        paired = 0
        if tag == "replace":
            for old_line, new_line in zip(old_block, new_block, strict=False):
                if SequenceMatcher(a=old_line, b=new_line, autojunk=False).ratio() < LINE_PAIR_RATIO:
                    break
                moved = _line_values(old_line, new_line)
                if moved:
                    values.extend(moved)
                else:
                    removed.append(old_line)
                    added.append(new_line)
                paired += 1
        removed.extend(old_block[paired:])
        added.extend(new_block[paired:])
    return removed, added, values


def _compare_drawing(older: _Page, newer: _Page) -> tuple[list[ValueChange], list[str], list[str]]:
    values = [
        ValueChange(subject=" ".join(part for part in key if part), older=older.quantities[key], newer=value)
        for key, value in newer.quantities.items()
        if key in older.quantities and older.quantities[key].casefold() != value.casefold()
    ]
    added = sorted(newer.annotations - older.annotations)
    removed = sorted(older.annotations - newer.annotations)
    return values, added, removed


def _page_change(older: _Page, newer: _Page) -> PageChange | None:
    removed, added, values = _compare_text(older, newer)
    drawing_values, annotations_added, annotations_removed = _compare_drawing(older, newer)
    if not (removed or added or values or drawing_values or annotations_added or annotations_removed):
        return None
    return PageChange(
        kind="changed",
        older_page=older.label,
        newer_page=newer.label,
        removed_lines=tuple(removed),
        added_lines=tuple(added),
        values=tuple(values),
        drawing_values=tuple(drawing_values),
        annotations_added=tuple(annotations_added),
        annotations_removed=tuple(annotations_removed),
    )


def _page_key(page: _Page) -> tuple[str, tuple[Any, ...]]:
    return (page.text_key, page.drawing_key)


def _align(older: list[_Page], newer: list[_Page]) -> tuple[list[PageChange], int]:
    """Pair the pages: identical ones first, wherever they moved to; the rest in order inside each gap."""
    matcher = SequenceMatcher(a=[_page_key(p) for p in older], b=[_page_key(p) for p in newer], autojunk=False)
    changes: list[PageChange] = []
    unchanged = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            unchanged += i2 - i1
            continue
        old_block, new_block = older[i1:i2], newer[j1:j2]
        for old_page, new_page in zip(old_block, new_block, strict=False):
            change = _page_change(old_page, new_page)
            if change is None:
                unchanged += 1
            else:
                changes.append(change)
        paired = min(len(old_block), len(new_block))
        changes.extend(
            PageChange(kind="removed", older_page=page.label, newer_page=None) for page in old_block[paired:]
        )
        changes.extend(PageChange(kind="added", older_page=None, newer_page=page.label) for page in new_block[paired:])
    return changes, unchanged


# ---------------------------------------------------------------------------
# Title block
# ---------------------------------------------------------------------------


def diff_title_blocks(older: Mapping[str, Any] | None, newer: Mapping[str, Any] | None) -> tuple[FieldChange, ...]:
    """The title-block fields that differ; a field only one side prints counts as a change."""
    older = older or {}
    newer = newer or {}
    changes: list[FieldChange] = []
    for key, label in TITLE_BLOCK_LABELS:
        old_value = _fold(older.get(key)) or None
        new_value = _fold(newer.get(key)) or None
        if old_value != new_value:
            changes.append(FieldChange(field=key, label=label, older=old_value, newer=new_value))
    return tuple(changes)


# ---------------------------------------------------------------------------
# The whole compare
# ---------------------------------------------------------------------------


def diff_revisions(
    older_chunks: Sequence[RevisionChunk],
    newer_chunks: Sequence[RevisionChunk],
    *,
    older_facts: Mapping[str, Any] | None = None,
    newer_facts: Mapping[str, Any] | None = None,
) -> RevisionDiff:
    """What changed from ``older`` to ``newer``, from their stored chunks and title blocks."""
    older_pages = _pages(older_chunks)
    newer_pages = _pages(newer_chunks)
    changes, unchanged = _align(older_pages, newer_pages)
    return RevisionDiff(
        title_block=diff_title_blocks(older_facts, newer_facts),
        pages=tuple(changes),
        older_page_count=len(older_pages),
        newer_page_count=len(newer_pages),
        unchanged_pages=unchanged,
        has_text=any(page.lines for page in (*older_pages, *newer_pages)),
        has_drawing=any(page.quantities or page.annotations for page in (*older_pages, *newer_pages)),
    )


def changed_pages(diff: RevisionDiff) -> tuple[int, ...]:
    """The pages of the NEWER Fassung that changed or came new, as 1-based numbers, in page order.

    What a look at the pictures is spent on (ADR-0130): a page the read content
    shows unchanged is not sent to a vision model. A page whose label is not a
    number (a roman preface, a sheet name) cannot be rendered by number and is
    left out; a removed page has nothing on the newer Fassung to mark.
    """
    numbers: set[int] = set()
    for change in diff.pages:
        if change.kind == "removed" or not change.newer_page:
            continue
        try:
            number = int(change.newer_page)
        except ValueError:
            continue
        if number >= 1:
            numbers.add(number)
    return tuple(sorted(numbers))


def chunk_from_store(text: str | None, metadata: Mapping[str, Any] | None) -> RevisionChunk | None:
    """One stored chunk as the compare reads it; ``None`` for a chunk that says nothing comparable."""
    metadata = metadata or {}
    content_type = str(metadata.get("content_type") or "text")
    structured = None
    raw = metadata.get("drawing_data")
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        structured = parsed if isinstance(parsed, Mapping) else None
    if content_type != "text" and structured is None:
        # A caption with no structure is prose a model wrote: not compared.
        return None
    page = str(metadata.get("page_label") or "")
    return RevisionChunk(page=page, content_type=content_type, text=text or "", structured=structured)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _clip(text: str) -> str:
    return text if len(text) <= MAX_LINE_CHARS else text[: MAX_LINE_CHARS - 1] + "…"


def _value_text(change: ValueChange) -> str:
    subject = f"{change.subject} " if change.subject else ""
    return f"{subject}{change.older} → {change.newer}"


def _page_name(change: PageChange) -> str:
    if change.kind == "added":
        return f"Page {change.newer_page} (new)"
    if change.kind == "removed":
        return f"Page {change.older_page} (removed)"
    if change.older_page and change.older_page != change.newer_page:
        return f"Page {change.newer_page} (previously {change.older_page})"
    return f"Page {change.newer_page}"


def _page_lines(change: PageChange) -> list[str]:
    if change.kind != "changed":
        return [f"- {_page_name(change)}."]
    parts: list[str] = []
    if change.values:
        parts.append("Values: " + "; ".join(_value_text(v) for v in change.values[:MAX_VALUES_PER_PAGE]))
    if change.removed_lines:
        quoted = " | ".join(f"„{_clip(line)}“" for line in change.removed_lines[:MAX_LINES_PER_PAGE])
        more = len(change.removed_lines) - MAX_LINES_PER_PAGE
        parts.append(f"removed: {quoted}" + (f" and {more} more lines" if more > 0 else ""))
    if change.added_lines:
        quoted = " | ".join(f"„{_clip(line)}“" for line in change.added_lines[:MAX_LINES_PER_PAGE])
        more = len(change.added_lines) - MAX_LINES_PER_PAGE
        parts.append(f"new: {quoted}" + (f" and {more} more lines" if more > 0 else ""))
    drawing: list[str] = []
    if change.drawing_values:
        drawing.append("; ".join(_value_text(v) for v in change.drawing_values[:MAX_VALUES_PER_PAGE]))
    if change.annotations_added:
        drawing.append("Dimensions/labels new: " + ", ".join(f"„{a}“" for a in change.annotations_added[:8]))
    if change.annotations_removed:
        drawing.append("removed: " + ", ".join(f"„{a}“" for a in change.annotations_removed[:8]))
    if drawing:
        parts.append("according to Piloti's reading of the drawing: " + "; ".join(drawing))
    return [f"- {_page_name(change)}: " + ". ".join(parts) + "."]


def render_diff(
    diff: RevisionDiff,
    older_name: str,
    newer_name: str,
    *,
    change_summary: str | None = None,
) -> str:
    """The compare as the model reads it: title block, then pages, then what it does not cover. Bounded."""
    lines = [f"Comparison „{older_name}“ (older) → „{newer_name}“ (newer), from the read content of both files."]
    if diff.title_block:
        moved = "; ".join(f"{c.label} {c.older or '—'} → {c.newer or '—'}" for c in diff.title_block)
        lines.append(f"Plankopf (title block): {moved}.")
    changed = [c for c in diff.pages if c.kind == "changed"]
    added = [c for c in diff.pages if c.kind == "added"]
    removed = [c for c in diff.pages if c.kind == "removed"]
    counts = [f"{diff.unchanged_pages} unchanged", f"{len(changed)} changed"]
    if added:
        counts.append(f"{len(added)} new")
    if removed:
        counts.append(f"{len(removed)} removed")
    lines.append(f"Pages: {diff.older_page_count} → {diff.newer_page_count}; {', '.join(counts)}.")
    for change in diff.pages[:MAX_PAGES_SHOWN]:
        lines.extend(_page_lines(change))
    if len(diff.pages) > MAX_PAGES_SHOWN:
        lines.append(f"… and {len(diff.pages) - MAX_PAGES_SHOWN} more changed pages.")
    if not diff.pages and not diff.title_block:
        if diff.has_text or diff.has_drawing:
            lines.append("In the read content the two files do not differ.")
        else:
            lines.append(
                "Neither file has read text or a reading of the drawing that could be compared; "
                "it does not follow that they are the same."
            )
    if change_summary:
        lines.append(f"Piloti's summary of the change (from the descriptions): {_clip(change_summary)}")
    lines.append(
        "What was compared is the printed text and Piloti's reading of the drawings, not the drawings themselves. "
        "Check a dimension by reading the document before stating it; marks on the page are shown by "
        "„Vergleichen“ in Dateien."
    )
    return "\n".join(lines)
