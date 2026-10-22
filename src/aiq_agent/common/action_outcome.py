"""What one tool call found, held while it runs so its Herleitung row can settle (ADR-0131).

A tool that emits an :class:`~aiq_agent.common.turn_status.ActionRow` fills one
of these from the typed values it already holds (the chunks it ranked, the
groups it counted, the rows it listed) and calls :meth:`ActionOutcome.settle`
once, on every path out. It never reads the text the tool returns.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from typing import Literal

from aiq_agent.common.turn_status import ActionRow

SettledStatus = Literal["ok", "empty", "error"]


@dataclass
class ActionOutcome:
    """Counts and verdict of one call. ``None`` means the call does not count it."""

    hits: int | None = None
    documents: int | None = None
    searched: int | None = None
    files: int | None = None
    folders: int | None = None
    failed: bool = False
    #: The call reached its answer (a listing, a chain), whatever it counted.
    completed: bool = False
    #: The target the call resolved, when it is clearer than the one asked for.
    target: str | None = None

    def record_chunks(self, chunks: Iterable[Any]) -> None:
        """Hits are the chunks returned; documents are the distinct files they come from."""
        listed = list(chunks)
        self.hits = len(listed)
        self.documents = len({(getattr(c, "file_name", None) or "", _collection(c)) for c in listed})

    def status(self, *, default: SettledStatus = "ok") -> SettledStatus:
        """``error`` when failed, ``empty`` when something was counted and it was zero, else ``default``."""
        if self.failed:
            return "error"
        counted = [n for n in (self.hits, self.files, self.folders) if n is not None]
        if not counted:
            return default
        return "empty" if not any(counted) else "ok"

    def settle(self, row: ActionRow, *, default: SettledStatus = "ok", **fields: Any) -> None:
        """Finish the row with this outcome. ``default`` is the status of a call that counted nothing."""
        counts = {
            "hits": self.hits,
            "documents": self.documents,
            "searched": self.searched,
            "files": self.files,
            "folders": self.folders,
        }
        row.finish(self.status(default=default), counts=counts, **fields)


def _collection(chunk: Any) -> str:
    metadata = getattr(chunk, "metadata", None) or {}
    return str(metadata.get("collection") or "")
