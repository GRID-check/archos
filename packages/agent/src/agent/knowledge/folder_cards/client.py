"""The folder cards route's Python client: ``/api/internal/folder-cards`` (ADR-0127, ADR-0055).

The BFF is the card's one writer (ADR-0003): the builder ``PUT``s a card, reads a
collection's cards back with ``GET`` (with each folder's person-written
description), and ``DELETE``s the card of a folder that no longer deserves one.
The contract is ``apps/workspace/bff/folder-cards/types.ts``, exported as
``apps/workspace/tests/fixtures/folder-cards.schema.json``;
``packages/agent/tests/knowledge/folder_cards/test_client.py`` validates the bodies built
here against that file. There is no Pydantic twin.

Service to service: the internal token only, and the organization in the body or
query, since the builder works for the organization whose documents it read. Every
call is blocking; call it off the event loop.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from agent.common import bff_http

logger = logging.getLogger(__name__)

FOLDER_CARDS_PATH = "/api/internal/folder-cards"
REQUEST_TIMEOUT_SECONDS = 15
#: A listing waits this long for the cards before it renders tier 0 alone.
READ_TIMEOUT_SECONDS = 3


class FolderCardsError(bff_http.BffError):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message, status=status)


def put_request(
    *,
    organization_id: str,
    collection: str,
    folder_path: str,
    abstract: str | None,
    key_facts: Iterable[dict[str, Any]],
    input_hash: str,
    abstract_hash: str | None,
    model: str | None,
    prompt_version: str | None,
    status: str,
) -> dict[str, Any]:
    """The ``PUT`` body. Pure."""
    return {
        "organization_id": organization_id,
        "collection": collection,
        "folder_path": folder_path,
        "abstract": abstract,
        "key_facts": list(key_facts),
        "input_hash": input_hash,
        "abstract_hash": abstract_hash,
        "model": model,
        "prompt_version": prompt_version,
        "status": status,
    }


def _call(method: str, query: dict[str, str] | None = None, body: dict[str, Any] | None = None, timeout: float = 0):
    try:
        parsed = bff_http.request_json(
            method, FOLDER_CARDS_PATH, timeout=timeout or REQUEST_TIMEOUT_SECONDS, body=body, query=query
        )
    except bff_http.BffNotConfiguredError as exc:
        raise FolderCardsError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        raise FolderCardsError(f"the folder cards route refused ({exc.status})", status=exc.status) from exc
    except bff_http.BffError as exc:
        raise FolderCardsError("the folder cards route could not be reached") from exc
    if not isinstance(parsed, dict):
        raise FolderCardsError("the folder cards route answered with something that is not an object")
    return parsed


def put_card(body: dict[str, Any]) -> bool:
    """Write one card; ``False`` when the BFF has no living folder at that path (a 404)."""
    try:
        _call("PUT", body=body)
    except FolderCardsError as exc:
        if exc.status == 404:
            return False
        raise
    return True


def get_cards(organization_id: str, collection: str, *, timeout: float = 0) -> dict[str, dict[str, Any]]:
    """A collection's cards by folder path. Raises :class:`FolderCardsError`."""
    return read_collection(organization_id, collection, timeout=timeout)[0]


def read_collection(
    organization_id: str, collection: str, *, timeout: float = 0
) -> tuple[dict[str, dict[str, Any]], dict[str, str], set[str] | None]:
    """A collection's cards by folder path, every described folder's description, and the folders it owns.

    The descriptions cover folders that have no card yet, so a folder's first build
    already reads what a person wrote about it. The third value is the path of every
    living folder whose documents live in this collection, described or not: a card
    for any other path is refused by the BFF, so the builder must not build it.
    ``None`` when the reply carries no ``folders`` list (nothing is known, nothing is
    filtered). Raises :class:`FolderCardsError`.
    """
    reply = _call("GET", query={"organization_id": organization_id, "collection": collection}, timeout=timeout)
    cards = reply.get("cards")
    by_path = (
        {
            str(card["folder_path"]).strip("/"): card
            for card in cards
            if isinstance(card, dict) and card.get("folder_path")
        }
        if isinstance(cards, list)
        else {}
    )
    folders = reply.get("folders")
    descriptions = (
        {
            str(folder["folder_path"]).strip("/"): str(folder["folder_description"])
            for folder in folders
            if isinstance(folder, dict) and folder.get("folder_path") and folder.get("folder_description")
        }
        if isinstance(folders, list)
        else {}
    )
    owned = (
        {
            str(folder["folder_path"]).strip("/")
            for folder in folders
            if isinstance(folder, dict) and folder.get("folder_path")
        }
        if isinstance(folders, list)
        else None
    )
    return by_path, descriptions, owned


def delete_card(organization_id: str, collection: str, folder_path: str) -> bool:
    """Remove a folder's card; ``False`` when it had none or the folder is gone."""
    query = {"organization_id": organization_id, "collection": collection, "folder_path": folder_path}
    try:
        reply = _call("DELETE", query=query)
    except FolderCardsError as exc:
        if exc.status == 404:
            return False
        raise
    return bool(reply.get("deleted"))
