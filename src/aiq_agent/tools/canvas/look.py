"""``look``: a page of the document, or the box on it, as an image the model can see.

The same work as ``view_knowledge_image`` and the same function
(``knowledge_layer.view_image.view_image``), so the scope check, the per-turn
image budget, the vision gate and the restricted-folder report are the ones
that tool already has. What ``look`` adds is WHICH file: the document the canvas
tools act on (``target.py``), named by the model, open on the canvas, or the
conversation's subject, never a collection the model had to copy from a hit.
"""

from __future__ import annotations

from typing import Any

from .calls import call
from .target import Target
from .target import collection_of
from .target import probe_collections

NO_FILE = "Ich weiß nicht, welche Datei dieses Dokument ist. Nenne sie in `document` (der Dateiname aus der Übersicht)."


async def _file_name(target: Target, signed: Any) -> str | None:
    """The target's file name: known already, or read off the BFF's answer about the document."""
    if target.file_name:
        return target.file_name
    body = await call({"op": "list"}, target, signed)
    name = body.get("documentName")
    return name if isinstance(name, str) and name else None


async def _collection(file_name: str, known: str | None) -> str:
    """The collection the file's bytes are fetched from: known, the inventory's, or the first that has it."""
    if known:
        return known
    if (listed := collection_of(file_name)) is not None:
        return listed
    from knowledge_layer.view_image import _resolve_storage_location

    for collection in probe_collections():
        if await _resolve_storage_location(collection, file_name) is not None:
            return collection
    return ""


async def look_at(
    target: Target, signed: Any, *, page: int, region: list[float] | None, limits: Any
) -> list[dict] | str:
    """The page or the region as content blocks, or a sentence saying why not. Raises ``Refused`` from the BFF."""
    from knowledge_layer.view_image import view_image

    file_name = await _file_name(target, signed)
    if not file_name:
        return NO_FILE
    collection = await _collection(file_name, target.collection)
    return await view_image(file_name, page, collection, None, region, limits=limits, tool="look")
