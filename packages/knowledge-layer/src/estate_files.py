"""The estate's file records: what a path resolves to, the tool outputs, and the content types a read can open."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.common.estate_paths import SHELF_MOUNTS
from aiq_agent.common.estate_paths import TEXT_EXTENSIONS
from aiq_agent.common.estate_paths import Mount
from aiq_agent.common.estate_paths import estate_path

from . import stored_pages
from .browse import FileRow
from .estate_constants import IMAGE_EXTENSIONS
from .estate_constants import MAX_SUGGESTIONS
from .estate_constants import MODEL_EXTENSIONS


@dataclass(frozen=True)
class EstateFile:
    """One document as the estate serves it: its row, its mount and its path."""

    row: FileRow
    mount: Mount
    path: str
    #: A restricted folder's document; resolvable only once its collection may be named.
    restricted: bool = False

    @property
    def leaf(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    @property
    def paged(self) -> bool:
        """Whether the document has pages to address; a text file has lines, an image has neither."""
        name = self.row.file_name.lower()
        return not name.endswith((*TEXT_EXTENSIONS, *IMAGE_EXTENSIONS, *MODEL_EXTENSIONS))


def estate_file(row: FileRow, *, restricted: bool = False) -> EstateFile | None:
    """``row`` placed in the namespace, or ``None`` when its shelf has no mount."""
    shelf = row.shelf or ""
    mount = SHELF_MOUNTS.get(shelf)
    path = estate_path(shelf, row.folder, row.file_name)
    if mount is None or path is None:
        return None
    return EstateFile(row=row, mount=mount, path=path, restricted=restricted)


@dataclass
class Resolution:
    """What a path resolved to: one file, or a miss with the names to suggest."""

    file: EstateFile | None
    #: A line the read says ahead of the text (the file has moved to another folder).
    note: str = ""
    suggestions: list[str] = field(default_factory=list)


@dataclass
class ToolOutput:
    """The text the model reads, and the passages in it."""

    text: str
    hits: tuple[Any, ...] = ()
    #: ``ok`` | ``empty`` | ``error``: the call's Herleitung outcome and whether the result is an error.
    status: str = "ok"


def no_such_file(path: str, suggestions: Sequence[str] = ()) -> str:
    """The one answer for a path that names nothing the turn may see: a miss and a restricted guess alike."""
    text = f'No file "{path}".'
    if suggestions:
        text += " Did you mean:\n" + "\n".join(f"- {name}" for name in suggestions[:MAX_SUGGESTIONS])
    return (
        text + "\n`ls` a folder or `glob` by name to see what exists; `grep` finds wording, `knowledge_search` meaning."
    )


def _content_type(page: stored_pages.Page) -> str:
    if page.is_drawing:
        return "drawing"
    for kind in ("table", "image", "chart"):
        if page.content_types and set(page.content_types) == {kind}:
            return kind
    return "text"
