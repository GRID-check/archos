"""The office-file eval's fixture project, and how it is seeded where the real tools read (ADR-0127).

``tests/fixtures/files_eval/project.yaml`` extends the intake eval's project, so its loader is the
intake fixture's own (``scripts/intake_eval/fixture.py``: ``load_fixture``, ``FixtureFile``); this
adds only what the extension needs (``refile``, ``tags``). Unlike the intake eval, which fakes the
three file tools over the fixture, the ``files`` set runs the REAL ``list_files``,
``knowledge_search`` and ``read_passage``, so the project has to exist where they read:

- the vector store (``AIQ_QDRANT_URL``): one chunk per page through the adapter's own write path
  (``knowledge_layer.qdrant.writes.write_chunks``), embedded by the deployment's embedder, with
  ``page_label``, ``folder_path`` and ``grid_document_id`` as an ingest job writes them;
- the metadata store (``AIQ_SUMMARY_DB``): each document registered, filed, typed and given its
  Fassung facts through ``DocumentMetadataStore``, which is what ``list_files`` reads.

Seeding is idempotent: a file whose chunks already carry this content's hash is not embedded again.
``FilesWorkspace`` is the fixture BFF's side: the turn context of a chat in this project.
Chunking is not under test here, the tools are.
"""

from __future__ import annotations

import hashlib
import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from fixture_bff import ROOT

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.intake_eval.fixture import FixtureFile  # noqa: E402  (the intake fixture's own record)
from scripts.intake_eval.fixture import load_fixture  # noqa: E402

PROJECT = ROOT / "tests" / "fixtures" / "files_eval" / "project.yaml"
ORGANIZATION_ID = "org-files-eval"
USER_ID = "user-files-eval"
PROJECT_ID = "project-files-eval"


@dataclass(frozen=True)
class FilesProject:
    collection: str
    description: str
    files: tuple[FixtureFile, ...]
    tags: dict[str, list[str]]

    @property
    def names(self) -> list[str]:
        return [file.name for file in self.files]


def load_project(path: Path = PROJECT) -> FilesProject:
    """The project: its base's files, refiled, then its own."""
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    base = load_fixture((path.parent / raw["extends"]).resolve())
    refile: dict[str, str] = raw.get("refile") or {}
    unknown = sorted(set(refile) - set(base.names))
    if unknown:
        raise ValueError(f"refile names files the base does not hold: {', '.join(unknown)}")
    files = [
        FixtureFile(f.name, refile.get(f.name, f.folder), f.added_at, f.revision_facts, f.pages) for f in base.files
    ]
    tags: dict[str, list[str]] = {}
    for item in raw.get("files") or []:
        files.append(
            FixtureFile(
                name=item["name"],
                folder=item.get("folder") or "",
                added_at=item.get("added_at"),
                revision_facts=item.get("revision_facts"),
                pages=tuple(page.strip() for page in item["pages"]),
            )
        )
        tags[item["name"]] = list(item.get("tags") or [])
    project = raw["project"]
    return FilesProject(project["collection"], project["description"], tuple(files), tags)


def document_id(project: FilesProject, name: str) -> str:
    """A stable BFF-style document id for a file: the seeding is repeatable."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"files-eval/{project.collection}/{name}"))


def content_hash(file: FixtureFile) -> str:
    return hashlib.sha256("\n\f\n".join(file.pages).encode("utf-8")).hexdigest()[:16]


def chunk_specs(project: FilesProject, file: FixtureFile) -> list[dict[str, Any]]:
    """One chunk per page: ``{chunk_id, text, metadata, ordinal}``, before any embedding."""
    digest = content_hash(file)
    return [
        {
            "chunk_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{project.collection}/{file.name}/{number}/{digest}")),
            "text": text,
            "ordinal": number - 1,
            "metadata": {
                "file_name": file.name,
                "page_label": str(number),
                "content_type": "text",
                "file_size": len(text.encode("utf-8")),
                "fixture_hash": digest,
            },
        }
        for number, text in enumerate(file.pages, start=1)
    ]


def seed_problem() -> str | None:
    """Why the suite cannot seed or read the project (nothing runs then), or None."""
    if not os.environ.get("AIQ_QDRANT_URL"):
        return "AIQ_QDRANT_URL is not set: the files set seeds its project into a Qdrant and its runs read it."
    summary_db = os.environ.get("AIQ_SUMMARY_DB", "")
    if "://" not in summary_db:
        return "AIQ_SUMMARY_DB must be a database URL (sqlite+aiosqlite:////absolute/path/summaries.db)."
    return None


def seed(project: FilesProject | None = None, *, embed: Any = None) -> dict[str, int]:
    """Write the project where the tools read; ``{file name: chunks written}`` (0 when it was already there).

    ``embed`` is texts -> vectors (default: the deployment's embedder, as ``production_embedder`` builds it).
    """
    from fixture_bff import production_embedder
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from knowledge_layer.llamaindex.adapter import embed_fingerprint_metadata
    from knowledge_layer.qdrant.payload import ChunkRecord
    from knowledge_layer.qdrant.store import get_store
    from knowledge_layer.qdrant.writes import write_chunks

    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    project = project or load_project()
    embed = embed or production_embedder()
    if embed is None:
        raise RuntimeError("No embedding key: the files set needs the deployment's embedder to seed its project.")
    identity = embed_fingerprint_metadata(
        LlamaIndexRetriever.DEFAULT_EMBED_MODEL, LlamaIndexRetriever.DEFAULT_EMBED_BASE_URL
    )
    store = get_store(identity)
    metadata = DocumentMetadataStore(os.environ["AIQ_SUMMARY_DB"])
    written: dict[str, int] = {}
    for file in project.files:
        specs = chunk_specs(project, file)
        have = (
            store.scroll(project.collection, {"file_name": file.name}, fields=["fixture_hash"])
            if store.exists(project.collection)
            else []
        )
        if {(r.payload or {}).get("fixture_hash") for r in have} == {content_hash(file)} and len(list(have)) == len(
            specs
        ):
            written[file.name] = 0
        else:
            vectors = embed([spec["text"] for spec in specs])
            if vectors is None:
                raise RuntimeError(f"The embedder did not answer for {file.name}.")
            records = [
                ChunkRecord(s["chunk_id"], s["text"], list(v), s["metadata"], ordinal=s["ordinal"])
                for s, v in zip(specs, vectors, strict=True)
            ]
            config = {
                "organization_id": ORGANIZATION_ID,
                "project_id": PROJECT_ID,
                "document_id": document_id(project, file.name),
                "folder_path": file.folder or None,
            }
            written[file.name] = write_chunks(project.collection, file.name, records, identity=identity, config=config)
        register_metadata(metadata, project, file)
    return written


def register_metadata(store: Any, project: FilesProject, file: FixtureFile) -> None:
    """The file's row in the metadata store, as ingest and the Files pane leave it."""
    summary = file.pages[0].splitlines()[0][:200]
    store.register(project.collection, file.name, summary, project.tags.get(file.name) or None)
    if file.folder:
        store.set_folder_path(project.collection, file.name, file.folder)
    if file.revision_facts:
        store.set_revision_facts(project.collection, file.name, file.revision_facts)


class FilesWorkspace:
    """What the fixture BFF serves a chat in the files project: its turn context, and no MCP door."""

    office = {"organizationId": ORGANIZATION_ID, "userId": USER_ID}
    project_id = PROJECT_ID

    def __init__(self, project: FilesProject | None = None) -> None:
        self.project = project or load_project()

    @property
    def envelope_fields(self) -> dict[str, Any]:
        """The signed envelope's ``collectionScope``: the project's own collection, on the project shelf."""
        return {"collectionScope": [{"collection": self.project.collection, "shelf": "project"}]}

    def turn_context(self, conversation: str | None) -> dict[str, Any]:
        return {
            "data": {
                "projectContext": f"Projekt: {self.project.description}",
                "projectMemory": None,
                "orgInstructions": None,
                "drewOnOtherProjects": False,
                "referenceProjects": None,
            }
        }

    def handle(self, body: dict[str, Any], conversation: str | None) -> dict[str, Any]:
        """The set measures the file tools: the office door offers nothing here."""
        return {"jsonrpc": "2.0", "id": body.get("id"), "error": {"code": -32601, "message": "No MCP door in this set"}}
