"""Which document a canvas tool acts on.

Every canvas tool takes an optional ``document``: the person may say „Mach eine
Anmerkung im Grundriss EG beim Treppenhaus“ in a project chat that is about no
document at all. Without the argument the default is, in order:

1. the turn's ``focus_document_id``, which the review canvas sends with every
   question asked on it;
2. the conversation's SUBJECT document, which the BFF resolves from the signed
   envelope (no ``documentId`` is sent at all);
3. nothing, and the BFF's ``no-document-subject`` refusal comes back as a
   sentence asking the model to name the file.

A named document is resolved the way the workspace verbs resolve one
(``tools/files/resolve.py``): against the turn's inventory rows only, exact
name first, then the name without its extension, then a substring, and an
ambiguity is a question rather than a pick. The rows know a file by
``(collection, file_name)`` and never by the BFF's id, so the id is then asked of
``GET /api/internal/document-file`` with the turn's envelope echoed: the BFF
answers only inside the scope that envelope signs, so the model cannot reach a
document by typing its name that it could not already search. A restricted
folder's file is never in the inventory (listing is not use, ADR-0088), so it
cannot be named here either; it stays reachable as the canvas's own document.
A string shaped like a UUID is taken as the id itself, and the BFF checks it
the same way.

``look`` needs more than the id: the file name and the collection the bytes
are fetched from. Those come from the same inventory row, or for the canvas's
own document from the focus the composer sent; the collection of a file the
inventory does not list (a restricted folder's) is found by asking the lookup
in each collection the turn may read.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.focus_file import get_focused_document_id
from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import parse_shelf
from aiq_agent.knowledge.inventory import get_turn_documents

from ..documents.filing import SignedEnvelope
from .client import lookup_document_id

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

#: How many candidates an ambiguity names before it stops.
_MAX_NAMED = 8
#: How many collections a file the inventory does not list is looked for in.
_MAX_PROBED_COLLECTIONS = 8

#: The shelves a person's document sits on. The platform corpus (`base`) is
#: nobody's to mark.
_DOCUMENT_SHELVES = frozenset({Shelf.PROJECT, Shelf.ARCHIV, Shelf.SESSION})


def is_uuid(value: str) -> bool:
    return bool(_UUID.match(value.strip()))


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value or "").strip()


def _key(value: str) -> str:
    return _nfc(value).casefold()


def _attr(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


@dataclass(frozen=True)
class Target:
    """The document a call acts on. ``document_id`` None: the conversation's subject, resolved by the BFF."""

    document_id: str | None = None
    file_name: str | None = None
    collection: str | None = None

    def body(self) -> dict[str, str]:
        """The ``documentId`` field a request carries, or nothing for the subject."""
        return {"documentId": self.document_id} if self.document_id else {}


@dataclass(frozen=True)
class Unresolved:
    """Why no document could be addressed, in the words the model gets back."""

    message: str


@dataclass(frozen=True)
class _Row:
    file_name: str
    collection: str


def _rows() -> list[_Row]:
    rows: list[_Row] = []
    for row in get_turn_documents():
        file_name = _nfc(str(_attr(row, "file_name") or ""))
        collection = str(_attr(row, "collection") or "")
        if file_name and collection and parse_shelf(_attr(row, "shelf")) in _DOCUMENT_SHELVES:
            rows.append(_Row(file_name, collection))
    return rows


def _named(rows: list[_Row]) -> str:
    shown = [f"`{row.file_name}`" for row in rows[:_MAX_NAMED]]
    rest = len(rows) - len(shown)
    return ", ".join(shown) + (f" (und {rest} weitere)" if rest > 0 else "")


def match_document(name: str) -> _Row | Unresolved:
    """The one inventory row ``name`` means, or why there is none. Exact, then stem, then substring."""
    wanted = _key(name)
    rows = _rows()
    for candidates in (
        [row for row in rows if _key(row.file_name) == wanted],
        [row for row in rows if _key(row.file_name.rsplit(".", 1)[0]) == wanted],
        [row for row in rows if wanted in _key(row.file_name)],
    ):
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            return Unresolved(
                f"Mehrdeutig: „{_nfc(name)}“ passt auf {_named(candidates)}. Frage, welches Dokument gemeint ist, "
                "und rufe das Werkzeug mit dem genauen Dateinamen in `document` erneut auf."
            )
    return Unresolved(
        f"Nicht gefunden: „{_nfc(name)}“ steht nicht in der Dateiübersicht dieser Unterhaltung. Nenne den genauen "
        "Dateinamen in `document` oder frage danach; rate nicht."
    )


_CANNOT_NAME = (
    "Dieses Dokument lässt sich gerade nicht über seinen Namen ansprechen (der Dokumentdienst kennt es nicht "
    "oder ist nicht erreichbar). Bitte die Person, das Dokument zu öffnen und dich dort zu fragen."
)


async def resolve_target(document: str, envelope: SignedEnvelope) -> Target | Unresolved:
    """The document a call acts on: the one named, the canvas's own, or the conversation's subject."""
    named = (document or "").strip()
    if not named:
        return Target(get_focused_document_id(), get_focused_file_name())
    if is_uuid(named):
        focus_id = get_focused_document_id()
        return Target(named, get_focused_file_name() if focus_id == named else None)
    row = match_document(named)
    if isinstance(row, Unresolved):
        return row
    document_id = await asyncio.to_thread(lookup_document_id, row.collection, row.file_name, envelope)
    if document_id is None:
        return Unresolved(_CANNOT_NAME)
    return Target(document_id, row.file_name, row.collection)


def collection_of(file_name: str) -> str | None:
    """The inventory's collection for exactly ``file_name``, when one row has it."""
    wanted = _key(file_name)
    found = {row.collection for row in _rows() if _key(row.file_name) == wanted}
    return found.pop() if len(found) == 1 else None


def probe_collections() -> list[str]:
    """The non-base collections this turn may read, for a file the inventory does not list. Bounded."""
    from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

    try:
        entries = get_scoped_collections_from_context() or []
    except Exception:  # noqa: BLE001 - an unreadable scope reads nothing
        return []
    collections = [
        entry.collection
        for entry in entries
        if getattr(entry, "collection", None) and parse_shelf(getattr(entry, "shelf", None)) in _DOCUMENT_SHELVES
    ]
    return list(dict.fromkeys(collections))[:_MAX_PROBED_COLLECTIONS]
