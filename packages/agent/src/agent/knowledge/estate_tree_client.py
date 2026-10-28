"""The estate tree's client: ``POST /api/internal/estate-tree`` (ADR-0133 slice 7).

One shelf of the turn's estate (``project``, ``office_shelf``, ``session``) as
the conversation's whole audience may LIST it: every folder, empty ones too,
with its description and whether it has a card, and a page of documents with
what ingestion read of each. The estate backend's ``ls`` and ``glob`` read it
(``docs/architecture/agent-filesystem.md`` §5); nothing calls it yet.

Nothing here decides access. The BFF reads the acting person out of the signed
request-context envelope this module forwards byte for byte, takes the project
and the conversation from it, and answers with the search's audience reach:
restricted folders and held uploads are absent, not marked. Echo, never sign
(``packages/agent/src/agent/tools/AGENTS.md``).

The contract is ``apps/workspace/tests/fixtures/estate-tree.schema.json``,
exported from ``apps/workspace/bff/estate-tree/types.ts``; the tests validate
the bodies built here and the answers parsed here against it. There is no
Pydantic twin.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any
from typing import Literal

from agent.common import bff_http
from agent.common.bff_http import SignedEnvelope

logger = logging.getLogger(__name__)

ESTATE_TREE_PATH = "/api/internal/estate-tree"

#: Two indexed reads and a reach the BFF already computes for the search.
REQUEST_TIMEOUT_SECONDS = 10

#: The BFF's bound on one page (``ESTATE_TREE_PAGE_MAX``).
PAGE_MAX = 500

Shelf = Literal["project", "office_shelf", "session"]


class EstateTreeError(bff_http.BffError):
    """The route refused, or could not be reached. ``status`` and ``code`` say which."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message, status=status, code=code)

    @property
    def not_found(self) -> bool:
        """No such shelf in this turn, or no folder at that path: the one answer a missing and a hidden path share."""
        return self.status == 404


@dataclass(frozen=True)
class FolderCardMark:
    """That a folder has a card (ADR-0127); its text is the folder cards route's."""

    status: str
    generated_at: str | None


@dataclass(frozen=True)
class EstateFolder:
    id: str
    parent_id: str | None
    name: str
    #: Slash-separated from the shelf's root (``Einreichung/Pläne``).
    path: str
    description: str | None
    card: FolderCardMark | None


@dataclass(frozen=True)
class EstateDocument:
    id: str
    #: ``documents.filename``, the path's leaf; ``piloti/<name>`` for an agent-filed one.
    filename: str
    display_name: str | None
    folder_id: str | None
    folder_path: str | None
    collection: str
    content_type: str | None
    file_size: int | None
    status: str
    authored_by: str
    #: What the dossier read, from the search's projection. Not ``doc_class``, which is human-set and wins.
    document_type: str | None
    page_count: int | None
    superseded: bool
    plan_number: str | None
    plan_index: str | None
    plan_date: str | None
    published_version: int | None
    version_count: int
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class EstateTree:
    shelf: Shelf
    collection: str
    folders: tuple[EstateFolder, ...]
    #: More folders than the BFF lists in one answer (``ESTATE_TREE_FOLDERS_MAX``).
    folders_truncated: bool
    documents: tuple[EstateDocument, ...]
    #: Pass back as ``cursor`` for the next page of documents; None on the last.
    next_cursor: str | None


def tree_request(
    shelf: Shelf, *, folder_path: str | None = None, cursor: str | None = None, limit: int | None = None
) -> dict[str, Any]:
    """The request body, with absent fields left out (the BFF's schema is strict). Pure."""
    body: dict[str, Any] = {"shelf": shelf}
    if folder_path:
        body["folder_path"] = folder_path
    if cursor:
        body["cursor"] = cursor
    if limit is not None:
        body["limit"] = max(1, min(PAGE_MAX, limit))
    return body


def _folder(raw: dict[str, Any]) -> EstateFolder:
    card = raw.get("card")
    return EstateFolder(
        id=raw["id"],
        parent_id=raw.get("parent_id"),
        name=raw["name"],
        path=raw["path"],
        description=raw.get("description"),
        card=FolderCardMark(status=card["status"], generated_at=card.get("generated_at")) if card else None,
    )


def _document(raw: dict[str, Any]) -> EstateDocument:
    return EstateDocument(
        id=raw["id"],
        filename=raw["filename"],
        display_name=raw.get("display_name"),
        folder_id=raw.get("folder_id"),
        folder_path=raw.get("folder_path"),
        collection=raw["collection"],
        content_type=raw.get("content_type"),
        file_size=raw.get("file_size"),
        status=raw["status"],
        authored_by=raw["authored_by"],
        document_type=raw.get("document_type"),
        page_count=raw.get("page_count"),
        superseded=bool(raw.get("superseded", False)),
        plan_number=raw.get("plan_number"),
        plan_index=raw.get("plan_index"),
        plan_date=raw.get("plan_date"),
        published_version=raw.get("published_version"),
        version_count=int(raw.get("version_count", 0)),
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
    )


def parse_tree(body: dict[str, Any]) -> EstateTree:
    """The answer as typed records; an answer that breaks the contract is an :class:`EstateTreeError`. Pure."""
    try:
        return EstateTree(
            shelf=body["shelf"],
            collection=body["collection"],
            folders=tuple(_folder(folder) for folder in body["folders"]),
            folders_truncated=bool(body["folders_truncated"]),
            documents=tuple(_document(document) for document in body["documents"]),
            next_cursor=body.get("next_cursor"),
        )
    except (KeyError, TypeError) as exc:
        raise EstateTreeError("the estate tree answered outside its contract") from exc


def post_tree(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one request and return the parsed body. Blocking; :func:`read_estate_tree` runs it in a thread."""
    try:
        body = bff_http.post_json(
            ESTATE_TREE_PATH, payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=envelope.headers()
        )
    except bff_http.BffNotConfiguredError as exc:
        raise EstateTreeError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        raise EstateTreeError(
            exc.error_text or f"the estate tree was refused ({exc.status})", status=exc.status, code=exc.code
        ) from exc
    except bff_http.BffError as exc:
        logger.warning("Estate tree request failed", exc_info=True)
        raise EstateTreeError("the estate tree could not be reached") from exc
    if not isinstance(body, dict):
        raise EstateTreeError("the estate tree answered with something that is not an object")
    return body


async def read_estate_tree(
    shelf: Shelf,
    envelope: SignedEnvelope,
    *,
    folder_path: str | None = None,
    cursor: str | None = None,
    limit: int | None = None,
) -> EstateTree:
    """One page of one shelf's tree, as the conversation's audience may list it.

    Raises :class:`EstateTreeError` for every refusal and failure; ``not_found``
    is the answer for a shelf the turn does not hold and for a path with no
    listable folder alike, so the caller answers both with the same "No file".
    """
    body = await asyncio.to_thread(
        post_tree, tree_request(shelf, folder_path=folder_path, cursor=cursor, limit=limit), envelope
    )
    return parse_tree(body)
