"""What one tool call found, held while it runs so its Herleitung row can settle (ADR-0131).

A tool that emits an :class:`~aiq_agent.common.turn_status.ActionRow` fills one
of these from the typed values it already holds (the chunks it ranked, the
groups it counted, the rows it listed) and calls :meth:`ActionOutcome.settle`
once, on every path out. It never reads the text the tool returns.

A row is settled before the tool round's results are admitted
(``restricted_use.admit_tool_results``), so it may carry nothing the model
itself could be refused: a count of hits from a restricted folder this turn has
not admitted yet is left out, because listing is not use (ADR-0088). The row
then says only that the call came back, which the model learns too, as content
or as the withholding notice.
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
    #: The call returned something from a restricted folder not admitted yet: counted as found, never counted.
    unnamed: bool = False

    def record_chunks(self, chunks: Iterable[Any]) -> None:
        """Hits are the chunks returned; documents are the distinct files they come from."""
        listed = list(chunks)
        documents = len({(getattr(c, "file_name", None) or "", _collection(c)) for c in listed})
        self.record(len(listed), documents=documents, collections=[_collection(c) for c in listed])

    def record(self, hits: int, *, documents: int | None = None, collections: Iterable[str | None] = ()) -> None:
        """Count ``hits`` (and ``documents``) found in ``collections``, unless one may not be named yet.

        A count is something the model may be refused (:func:`may_name`): when
        any of ``collections`` is a restricted folder this turn has not admitted,
        nothing is counted and the call is only marked as having found something.
        """
        from aiq_agent.knowledge.restricted_use import may_name

        if all(may_name(collection) for collection in collections):
            self.hits, self.documents = hits, documents
            return
        self.hits = self.documents = None
        self.unnamed = True

    def status(self, *, default: SettledStatus = "ok") -> SettledStatus:
        """``error`` when failed, ``empty`` when something was counted and it was zero, else ``default``.

        A call that found only what it may not count yet (``unnamed``) is ``ok``.
        """
        if self.failed:
            return "error"
        counted = [n for n in (self.hits, self.files, self.folders) if n is not None]
        if not counted:
            return "ok" if self.unnamed else default
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
