"""Which tool a shared hint names, per binding (ADR-0133 slice 6).

The knowledge layer's results are read by three agents: Piloti's chat, deep
research and project intake. A result that names the next call ("open a Punkt
with …", "for every mention use …") must name a tool the caller HAS: Piloti
reads with ``read_file``, lists with ``ls`` and finds wording with ``grep``;
deep research and intake still read with ``read_passage``, list with
``list_files`` and find wording with ``knowledge_search(match="exact")``.
Telling deep research to call ``read_file`` would send it to a tool it does not
have, and telling Piloti to call ``read_passage`` to one it no longer has.

So a hint asks this module for the spelling, and the spelling follows the
binding: :func:`vocabulary_for` decides from the bound tool names (the way the
door's ``door-text.ts`` rewrites names for outside agents), and the turn sets
it once, around its graph run (:func:`use_vocabulary`), so every node and every
parallel tool call of the turn inherits it. Unset, it is the legacy spelling:
every caller that predates the filesystem verbs reads exactly what it read.

Every name is written in backticks, which is what lets the door rename a bare
``ls``, ``glob`` or ``grep`` for an outside agent (its bare-name pattern needs an
underscore).
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

#: The verbs a binding must hold for its hints to name the filesystem tools.
FILESYSTEM_VERBS = frozenset({"ls", "glob", "grep", "read_file"})


def _call(name: str, args: dict[str, str | None]) -> str:
    """``name(k=v, …)`` in backticks, the values verbatim (a placeholder ``…`` or a quoted literal)."""
    rendered = ", ".join(f"{key}={value}" for key, value in args.items() if value is not None)
    return f"`{name}({rendered})`"


@dataclass(frozen=True)
class Vocabulary:
    """The tool spellings one binding's hints use. ``filesystem``: the binding reads the estate by path."""

    filesystem: bool

    @property
    def read_name(self) -> str:
        """The verb that opens a document: ``read_file`` or ``read_passage``, backticked."""
        return "`read_file`" if self.filesystem else "`read_passage`"

    @property
    def literal_name(self) -> str:
        """The call that finds every literal occurrence."""
        return "`grep`" if self.filesystem else '`knowledge_search(match="exact")`'

    @property
    def list_name(self) -> str:
        """The verb that lists which files exist."""
        return "`ls`" if self.filesystem else "`list_files`"

    def read(
        self,
        *,
        document: str = "…",
        path: str | None = None,
        page: str | None = None,
        clause: str | None = None,
    ) -> str:
        """The call that opens ``document`` (legacy) or ``path`` (filesystem) at a page or a Punkt.

        Values are written verbatim: pass ``"…"`` for a placeholder, a ``json.dumps`` for a literal.
        A filesystem read without a known path names the hit's ``Path:`` line as where it comes from.
        """
        if self.filesystem:
            return _call("read_file", {"file_path": path or "…", "pages": page, "clause": clause})
        return _call("read_passage", {"document": document, "page": page, "clause": clause})

    def list_folder(self, *, folder: str | None = None, path: str | None = None, tree: bool = False) -> str:
        """The call that lists one folder (``folder`` as a listing prints it; ``path`` its estate path)."""
        if self.filesystem:
            return _call("ls", {"path": path or "…", "depth": "2" if tree else None})
        return _call("list_files", {"folder": folder, "view": '"tree"' if tree else None})


#: The spelling of every caller that predates the filesystem verbs: deep research, intake, the door.
LEGACY = Vocabulary(filesystem=False)
#: Piloti's chat, which reads the estate by path.
FILESYSTEM = Vocabulary(filesystem=True)

_CURRENT: ContextVar[Vocabulary] = ContextVar("tool_vocabulary", default=LEGACY)


def vocabulary_for(tool_names: Iterable[str]) -> Vocabulary:
    """The vocabulary of a binding: the filesystem's when it holds all four estate verbs, else the legacy one."""
    return FILESYSTEM if FILESYSTEM_VERBS <= frozenset(tool_names) else LEGACY


def current_vocabulary() -> Vocabulary:
    """The vocabulary of the turn in context; :data:`LEGACY` outside one that set it."""
    return _CURRENT.get()


@contextmanager
def use_vocabulary(vocabulary: Vocabulary) -> Iterator[Vocabulary]:
    """Set the turn's vocabulary for the block; every task started inside inherits it."""
    token = _CURRENT.set(vocabulary)
    try:
        yield vocabulary
    finally:
        _CURRENT.reset(token)
