"""Update a card from what changed instead of rewriting it (ADR-0127).

Every card the builder writes leaves a :class:`Manifest` in the agent database
(``queue.put_manifest``): a fingerprint per direct child document (title,
Dokumentart, tags, summary, Fassung, superseded_by), the ``abstract_hash`` per
child folder (or its document names when it has no card), the description's
fingerprint, the prompt version, and how many incremental updates followed the
last full build. The next build diffs the folder's current inputs against it.

:func:`plan` picks one of three ways, each cheaper than the next is safe:

* ``prune``: only documents went away and no child folder changed. The key facts
  citing a removed document are dropped and the abstract is kept; no model call.
* ``incremental``: the model gets the old abstract, the key facts that survived the
  prune, and the diff alone (full detail for added and changed documents, names for
  removed ones), and returns the updated card.
* ``full``: the card is written from all the folder's inputs, as for a new card.
  Always when there is no prior card or manifest, the prompt version or the
  person's description changed, the diff touches more than half the current
  children, or :data:`MAX_INCREMENTS` incremental updates happened since the last
  full build: a card edited forever from diffs drifts from what the folder holds,
  and the safety rebuild bounds that drift.

All of it is pure; the worker does the I/O.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from collections.abc import Mapping
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from agent.knowledge.folder_cards.inputs import PROMPT_VERSION
from agent.knowledge.folder_cards.inputs import ChildDocument
from agent.knowledge.folder_cards.inputs import ChildFolder
from agent.knowledge.folder_cards.inputs import FolderInputs

#: Incremental updates after which the next build is a full one.
MAX_INCREMENTS = 10
#: Share of the current children a diff may touch before the next build is a full one.
MAX_CHANGED_SHARE = 0.5

Mode = Literal["prune", "incremental", "full"]


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:32]


def document_fingerprint(document: ChildDocument) -> str:
    """What the card reads of one document, as one value: any change to it is a ``changed`` child. Pure."""
    return _digest(asdict(document))


def folder_fingerprint(folder: ChildFolder) -> str:
    """A child folder's card (its abstract hash), or its document names when it has none. Pure."""
    return folder.abstract_hash or _digest(list(folder.documents))


@dataclass(frozen=True)
class Manifest:
    """The inputs a stored card was written from."""

    documents: Mapping[str, str]
    folders: Mapping[str, str]
    description: str | None
    prompt_version: str = PROMPT_VERSION
    #: Incremental updates since the last full build.
    increments: int = 0

    def to_json(self) -> str:
        return json.dumps(
            {
                "documents": dict(self.documents),
                "folders": dict(self.folders),
                "description": self.description,
                "prompt_version": self.prompt_version,
                "increments": self.increments,
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    @classmethod
    def from_json(cls, text: str) -> Manifest:
        data = json.loads(text)
        return cls(
            documents=dict(data.get("documents") or {}),
            folders=dict(data.get("folders") or {}),
            description=data.get("description"),
            prompt_version=str(data.get("prompt_version") or ""),
            increments=int(data.get("increments") or 0),
        )


def manifest_of(inputs: FolderInputs, *, increments: int = 0) -> Manifest:
    """The manifest a card written from ``inputs`` leaves behind. Pure."""
    return Manifest(
        documents={document.file_name: document_fingerprint(document) for document in inputs.documents},
        folders={folder.name: folder_fingerprint(folder) for folder in inputs.folders},
        description=_digest(inputs.description) if inputs.description else None,
        increments=increments,
    )


def _split(before: Mapping[str, str], after: Mapping[str, str]) -> tuple[list[str], list[str], list[str]]:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(name for name in set(before) & set(after) if before[name] != after[name])
    return added, removed, changed


@dataclass(frozen=True)
class Diff:
    """Children by name: what entered, left, or changed since the card was written."""

    added: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    changed: tuple[str, ...] = ()
    folders_added: tuple[str, ...] = ()
    folders_removed: tuple[str, ...] = ()
    folders_changed: tuple[str, ...] = ()

    @property
    def size(self) -> int:
        return sum(len(part) for part in asdict(self).values())

    @property
    def only_removals(self) -> bool:
        return self.size == len(self.removed)

    def counts(self) -> dict[str, int]:
        """Diff sizes, as trace metadata."""
        return {
            "diff_added": len(self.added) + len(self.folders_added),
            "diff_removed": len(self.removed) + len(self.folders_removed),
            "diff_changed": len(self.changed) + len(self.folders_changed),
        }


def diff(before: Manifest, after: Manifest) -> Diff:
    """``after`` against ``before``. Pure."""
    documents = _split(before.documents, after.documents)
    folders = _split(before.folders, after.folders)
    return Diff(*(tuple(part) for part in (*documents, *folders)))


@dataclass(frozen=True)
class Plan:
    mode: Mode
    diff: Diff = field(default_factory=Diff)
    #: The manifest's counter after this build.
    increments: int = 0
    reason: str = ""


def plan(existing: Mapping[str, Any] | None, manifest: Manifest | None, inputs: FolderInputs) -> Plan:
    """How to bring the stored card up to ``inputs``. Pure."""
    if not existing or not existing.get("abstract") or manifest is None:
        return Plan("full", reason="no prior card")
    current = manifest_of(inputs)
    if manifest.prompt_version != PROMPT_VERSION:
        return Plan("full", reason="prompt version")
    if manifest.description != current.description:
        return Plan("full", reason="description")
    if manifest.increments >= MAX_INCREMENTS:
        return Plan("full", reason="increments")
    change = diff(manifest, current)
    children = len(current.documents) + len(current.folders)
    if change.size > MAX_CHANGED_SHARE * children:
        return Plan("full", change, reason="share")
    if change.only_removals:
        return Plan("prune", change, increments=manifest.increments)
    return Plan("incremental", change, increments=manifest.increments + 1)


def surviving_facts(key_facts: Iterable[Mapping[str, Any]], children: Iterable[str]) -> list[dict[str, Any]]:
    """The stored key facts whose every cited document is still a direct child. Pure."""
    current = set(children)
    kept = []
    for fact in key_facts:
        documents = [str(name) for name in fact.get("documents") or []]
        if documents and set(documents) <= current:
            kept.append(dict(fact))
    return kept
