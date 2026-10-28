"""Which file a look reads, from which collection, and whether the room sees it.

The model names a document the way a person would; the collection the bytes
live in is resolved here and never asked of the model (ADR-0128: the old tool's
``collection`` argument made the model copy an internal id). In order:

1. An exact base-corpus (Basiswissen) file, from this replica's cache of the
   corpus. No envelope is needed, so a CLI run or an eval looks at a Richtlinie
   as a chat turn does.
2. A workspace document, the way the canvas tools find one
   (``tools/canvas/target.py``): empty means the document open on the canvas,
   then the conversation's subject; a name is matched against the turn's
   inventory rows; an id is taken as it is. The BFF answers for it only inside
   the scope the echoed envelope signs.
3. A file the inventory does not list (a restricted folder's, admitted once a
   hit of this turn drew on it) is found by asking the lookup in each
   collection the turn may read, bounded.

A workspace document carries its :class:`Target`, so ``look`` can make the box
glow for everyone who has the document open (``canvas/presence.show_reading``).
A base-corpus file glows nowhere: it is nobody's document.
"""

from __future__ import annotations

import asyncio
import unicodedata
from dataclasses import dataclass

from agent import project_context
from agent.common.bff_http import SignedEnvelope
from agent.common.focus_file import get_focused_document_id
from agent.common.focus_file import get_focused_file_name

from ..canvas import target as canvas_target
from ..canvas.calls import call
from ..canvas.calls import envelope
from ..canvas.target import Target
from ..canvas.target import Unresolved
from ..canvas.target import collection_of
from ..canvas.target import is_uuid
from ..canvas.target import match_document
from ..canvas.target import probe_collections
from ..canvas.target import resolve_target

NO_FILE = "I do not know which file this document is. Name it in `document` (the file name from the inventory)."
NOT_FOUND = (
    "Not found: '{name}' is neither a base-corpus document nor a file of this conversation. Name it exactly as the "
    "inventory or a hit's `Citation:` line lists it, or ask which document is meant; do not guess."
)


@dataclass(frozen=True)
class Resolved:
    """The file a look renders. ``target`` is the workspace document (None for the base corpus)."""

    file_name: str
    collection: str = ""
    target: Target | None = None
    signed: SignedEnvelope | None = None
    #: The BFF already answered for the document while it was resolved (its ``list``, for the name),
    #: so a caller that only needs to know the person may read it need not ask again.
    read_by_bff: bool = False


def _key(value: str | None) -> str:
    return unicodedata.normalize("NFC", value or "").strip().casefold()


def _signed_or_none() -> SignedEnvelope | None:
    header, signature = project_context.get_request_envelope_from_context()
    return SignedEnvelope(header=header, signature=signature) if header and signature else None


async def _is_base_corpus(name: str) -> bool:
    from knowledge_layer.view_image import _find_pdf

    return await asyncio.to_thread(_find_pdf, name) is not None


async def _probe(file_name: str) -> str:
    """The first collection of the turn whose lookup knows ``file_name``; empty when none does."""
    from knowledge_layer.view_image import _resolve_storage_location

    for collection in probe_collections():
        if await _resolve_storage_location(collection, file_name) is not None:
            return collection
    return ""


async def _collection(file_name: str, known: str | None) -> str:
    """The collection the file's bytes are fetched from: known, the inventory's, or the first that has it."""
    if known:
        return known
    if (listed := collection_of(file_name)) is not None:
        return listed
    return await _probe(file_name)


async def _file_name(target: Target, signed: SignedEnvelope) -> str | None:
    """The target's file name: known already, or read off the BFF's answer about the document."""
    if target.file_name:
        return target.file_name
    body = await call({"op": "list"}, target, signed)
    name = body.get("documentName")
    return name if isinstance(name, str) and name else None


async def _named(name: str, signed: SignedEnvelope | None) -> Resolved | str:
    """A document named by the model: an inventory row, or a file found in one of the turn's collections."""
    row = match_document(name)
    if isinstance(row, Unresolved):
        if row.ambiguous:
            return row.message
        file_name, collection = name, await _probe(name)
        if not collection:
            return NOT_FOUND.format(name=name)
    else:
        file_name, collection = row.file_name, row.collection
    if signed is None:
        return Resolved(file_name, collection)
    document_id = await asyncio.to_thread(canvas_target.lookup_document_id, collection, file_name, signed)
    # No id costs the glow, never the look: the bytes are still the turn's to read.
    target = Target(document_id, file_name, collection) if document_id else None
    return Resolved(file_name, collection, target, signed if target else None)


async def _open(document: str) -> Resolved | str:
    """The canvas's own document or the conversation's subject (empty), or a document id. Needs the envelope."""
    signed = envelope()
    target = await resolve_target(document, signed)
    if isinstance(target, Unresolved):
        return target.message
    read_by_bff = not target.file_name
    file_name = await _file_name(target, signed)
    if not file_name:
        return NO_FILE
    return Resolved(file_name, await _collection(file_name, target.collection), target, signed, read_by_bff)


async def resolve_document(document: str) -> Resolved | str:
    """The file ``document`` means, or the sentence the model reads. Raises ``Refused`` from the BFF."""
    named = (document or "").strip()
    focus_id = get_focused_document_id()
    if named and focus_id and _key(named) == _key(get_focused_file_name()):
        return await _open(focus_id)
    if not named or is_uuid(named):
        return await _open(named)
    if await _is_base_corpus(named):
        return Resolved(named)
    return await _named(named, _signed_or_none())
