"""The visual eval's fixture project: drawings rendered from a spec, seeded and served where ``look`` reads (ADR-0128).

The project is the three sheets of ``tests/fixtures/visual/drawings.json``, drawn by
``render_fixture_drawings.py`` at suite start. Like the office-file set (``fixture_files.py``, whose
project record, seeding and turn context this reuses), the run is the REAL agent with the REAL tools,
so the project has to exist where they read:

- the vector store and metadata store: ``fixture_files.seed``, one chunk per page. The chunk is the
  page's caption (``index_text``) and nothing else, as an ingest of a scanned sheet leaves it, so a
  value on the drawing is not found by search and the turn has to look;
- the bytes: ``look`` asks the BFF's ``GET /api/internal/document-file`` for a storage key and then
  reads the object from an S3 endpoint (``view_image._fetch_seaweed_bytes``). The fixture BFF answers
  both: the lookup from :meth:`VisualWorkspace.document_file`, and a path-style
  ``GET /{bucket}/{key}`` from :meth:`VisualWorkspace.object_bytes`, so the run's
  ``SEAWEED_ENDPOINT`` is the fixture BFF itself and nothing is uploaded anywhere.
"""

from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

from fixture_files import FilesProject
from fixture_files import FilesWorkspace
from fixture_files import FixtureFile
from fixture_files import document_id
from render_fixture_drawings import SPEC
from render_fixture_drawings import load_spec
from render_fixture_drawings import render_all

COLLECTION = "proj_visual_eval"
DESCRIPTION = "Aufstockung des Wohnhauses in der Hubergasse, Einreichpläne"
BUCKET = "fixture-visual"
KEY_PREFIX = "drawings/"
#: The credentials the run's S3 client signs with. The fixture BFF never checks them.
S3_ENV = {
    "SEAWEED_ACCESS_KEY": "fixture",
    "SEAWEED_SECRET_KEY": "fixture",
    "SEAWEED_BUCKET": BUCKET,
}  # pragma: allowlist secret


def load_project(spec: dict[str, Any] | None = None, path: Path = SPEC) -> FilesProject:
    """The project record of the spec: one file per drawing, one chunk (the caption) per page."""
    spec = spec or load_spec(path)
    files = tuple(
        FixtureFile(
            name=drawing["file_name"],
            folder=drawing["folder"],
            added_at=None,
            revision_facts=None,
            pages=tuple(page["index_text"] for page in drawing["pages"]),
        )
        for drawing in spec["drawings"]
    )
    return FilesProject(COLLECTION, DESCRIPTION, files, {})


class VisualWorkspace(FilesWorkspace):
    """The files project's turn context, plus the document lookup and the object bytes of the rendered sheets."""

    def __init__(self, pdfs: dict[str, bytes], project: FilesProject | None = None) -> None:
        super().__init__(project or load_project())
        self.pdfs = pdfs

    @classmethod
    def rendered(cls, out: Path) -> VisualWorkspace:
        """The workspace over the spec's sheets, drawn into ``out`` (a directory of the run)."""
        written = render_all(out)
        return cls({name: path.read_bytes() for name, path in written.items()})

    def document_file(self, query: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """``GET /api/internal/document-file``: the id and storage location of a file of the project."""
        name = str(query.get("filename") or "")
        if query.get("collection") != self.project.collection or name not in self.pdfs:
            return 404, {"error": "Not found"}
        return 200, {
            "documentId": document_id(self.project, name),
            "storageKey": f"{KEY_PREFIX}{name}",
            "storageBucket": BUCKET,
        }

    def object_bytes(self, path: str) -> bytes | None:
        """A path-style S3 ``GET /{bucket}/{key}`` for one of the sheets, or None."""
        bucket, _, key = urllib.parse.unquote(path).lstrip("/").partition("/")
        if bucket != BUCKET or not key.startswith(KEY_PREFIX):
            return None
        return self.pdfs.get(key[len(KEY_PREFIX) :])

    def env(self, bff_url: str, look: bool) -> dict[str, str]:
        """What each run needs besides the envelope: the object store is the fixture BFF; looking is on or off."""
        return {
            **S3_ENV,
            "SEAWEED_ENDPOINT": bff_url,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "VIEW_IMAGES_ENABLED": "1" if look else "0",
        }
