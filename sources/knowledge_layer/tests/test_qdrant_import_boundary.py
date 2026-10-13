"""Only ``knowledge_layer/qdrant/`` talks to Qdrant (ADR-0103, ADR-0104).

The scope filter is the boundary between offices' documents. It holds by
construction only while every read goes through ``knowledge_layer.qdrant``,
whose filters cannot be built without a scope; a second client elsewhere
would be a read path that never asked for one. Tests may import the client to
drive and inspect the server.
"""

from __future__ import annotations

import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[3]
ALLOWED = REPO / "sources" / "knowledge_layer" / "src" / "qdrant"
SEARCHED = ("src", "sources", "frontends/aiq_api/src", "scripts")
IMPORT = re.compile(r"^\s*(from\s+qdrant_client\b|import\s+qdrant_client\b)", re.MULTILINE)


def _offenders() -> list[str]:
    offenders: list[str] = []
    for root in SEARCHED:
        for path in (REPO / root).rglob("*.py"):
            if ALLOWED in path.parents or "tests" in path.relative_to(REPO).parts:
                continue
            if IMPORT.search(path.read_text(encoding="utf-8", errors="ignore")):
                offenders.append(str(path.relative_to(REPO)))
    return offenders


def test_only_the_qdrant_package_imports_qdrant_client():
    assert _offenders() == []


def test_the_boundary_check_would_see_an_offender():
    """The check is not vacuous: a planted import outside the package is found."""
    planted = REPO / "scripts" / "_planted_qdrant_import_check.py"
    planted.write_text("from qdrant_client import QdrantClient\n", encoding="utf-8")
    try:
        assert "scripts/_planted_qdrant_import_check.py" in _offenders()
    finally:
        planted.unlink()
