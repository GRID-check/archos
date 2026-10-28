"""What a folder's card is built from, and the hash that says whether it changed (ADR-0127).

A card reads one level down and no further: the documents directly in the folder
(name, title, Dokumentart, tags, the one-sentence summary ingestion already wrote,
the Fassung its title block or a person states), the child folders' own cards, and
the description a person wrote for the folder. Never the text of a grandchild, so
the input grows with the folder's fan-out, not with its subtree.

:func:`input_hash` is SHA-256 over a canonical JSON of exactly those inputs, children
in name order, so it is Merkle-like: a child card enters through its
``abstract_hash``, and a child whose abstract came out identical changes nothing
above it. Counts and dates are deliberately NOT hashed: tier 0 shows them live on
every listing (``browse.folder_cards``), the abstract is told not to state them,
and an upload that only moves a count therefore never costs a model call.

One collection only: a restricted folder is its own collection (ADR-0088), so its
documents never reach a card of the folder above it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import asdict
from dataclasses import dataclass
from typing import Any

#: Bumping it marks every card stale: the hash covers it.
PROMPT_VERSION = "folder-card-v1"

#: A folder with fewer documents than this and no child folder gets no card: its listing is the card.
MIN_DOCUMENTS = 3
#: Documents one prompt lists in full. Past it the rest are named by type only (bounded input, one call).
MAX_LISTED_DOCUMENTS = 60
#: Summary characters per document in the prompt.
MAX_SUMMARY_CHARS = 300
#: Document names shown for a child folder that has no card of its own.
MAX_CHILD_FOLDER_NAMES = 5


@dataclass(frozen=True)
class ChildDocument:
    file_name: str
    title: str | None
    doc_class: str | None
    tags: tuple[str, ...]
    summary: str
    #: ``Index B, 2026-02-03`` from the title block, when one was read.
    revision: str | None
    superseded_by: str | None


@dataclass(frozen=True)
class ChildFolder:
    name: str
    path: str
    abstract: str | None
    abstract_hash: str | None
    #: A few document names, only when the child has no card to stand for it.
    documents: tuple[str, ...]


@dataclass(frozen=True)
class FolderInputs:
    collection: str
    folder_path: str
    depth: int
    description: str | None
    documents: tuple[ChildDocument, ...]
    folders: tuple[ChildFolder, ...]
    #: Tier-0 lines the prompt shows for orientation. Not hashed (see the module docstring).
    overview: tuple[str, ...] = ()

    @property
    def child_names(self) -> frozenset[str]:
        return frozenset(document.file_name for document in self.documents)

    @property
    def empty(self) -> bool:
        return not self.documents and not self.folders

    @property
    def tiny(self) -> bool:
        """Too small to be worth a written card: the listing already says everything."""
        return not self.folders and len(self.documents) < MIN_DOCUMENTS


def _revision(facts: Mapping[str, Any] | None) -> str | None:
    if not facts:
        return None
    parts = [
        f"Index {facts['revision']}" if facts.get("revision") else "",
        str(facts.get("revision_date") or ""),
        str(facts.get("document_number") or ""),
    ]
    text = ", ".join(part for part in parts if part)
    return text or None


def _document(row: Any) -> ChildDocument:
    return ChildDocument(
        file_name=row.file_name,
        title=row.display_title,
        doc_class=row.doc_class,
        tags=tuple(sorted(row.tags)),
        summary=(row.summary or "")[:MAX_SUMMARY_CHARS],
        revision=_revision(row.revision_facts),
        superseded_by=row.superseded_by,
    )


def _overview(rows: Sequence[Any], folder_path: str) -> tuple[str, ...]:
    """Tier 0 for the prompt, from the same function the listing uses."""
    from knowledge_layer.browse import folder_cards

    cards = folder_cards(list(rows), root=folder_path, depth=0)
    if not cards:
        return ()
    card = cards[0]
    lines = [f"{card.total} documents in the subtree, {card.direct} directly here"]
    if card.types:
        lines.append("Dokumentart: " + ", ".join(f"{tag} {count}" for tag, count in card.types))
    lines.extend(f"Current Fassung: {line}" for line in card.current[:8])
    return tuple(lines)


def folder_inputs(
    collection: str,
    folder_path: str,
    rows: Sequence[Any],
    cards: Mapping[str, Mapping[str, Any]],
    descriptions: Mapping[str, str] | None = None,
) -> FolderInputs:
    """The inputs of one folder's card. Pure.

    ``rows`` are the collection's ``browse.FileRow`` (one collection, so never a
    restricted folder's documents above it); ``cards`` the collection's stored cards
    by folder path, as the BFF's ``GET`` returns them; ``descriptions`` every
    folder's description by path, a card or not.
    """
    path = folder_path.strip().strip("/")
    prefix = f"{path}/"
    subtree = [row for row in rows if row.folder == path or row.folder.startswith(prefix)]
    direct = sorted((row for row in subtree if row.folder == path), key=lambda row: row.file_name)
    below: dict[str, list[str]] = {}
    for row in subtree:
        if row.folder != path:
            child = row.folder[len(prefix) :].split("/", 1)[0]
            below.setdefault(child, []).append(row.file_name)
    folders = []
    for name in sorted(below):
        child_path = f"{prefix}{name}"
        card = cards.get(child_path) or {}
        abstract = card.get("abstract") or None
        folders.append(
            ChildFolder(
                name=name,
                path=child_path,
                abstract=abstract,
                abstract_hash=card.get("abstract_hash") if abstract else None,
                documents=() if abstract else tuple(sorted(below[name])[:MAX_CHILD_FOLDER_NAMES]),
            )
        )
    own = cards.get(path) or {}
    written = (descriptions or {}).get(path) or own.get("folder_description") or ""
    description = " ".join(str(written).split()) or None
    return FolderInputs(
        collection=collection,
        folder_path=path,
        depth=len(path.split("/")) if path else 0,
        description=description,
        documents=tuple(_document(row) for row in direct),
        folders=tuple(folders),
        overview=_overview(subtree, path) if subtree else (),
    )


def input_hash(inputs: FolderInputs) -> str:
    """SHA-256 over what the abstract is written from; stable under row order. Pure."""
    canonical = {
        "prompt_version": PROMPT_VERSION,
        "description": inputs.description,
        "documents": [asdict(document) for document in sorted(inputs.documents, key=lambda d: d.file_name)],
        "folders": [
            {"name": folder.name, "abstract_hash": folder.abstract_hash, "documents": list(folder.documents)}
            for folder in sorted(inputs.folders, key=lambda f: f.name)
        ],
    }
    encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
