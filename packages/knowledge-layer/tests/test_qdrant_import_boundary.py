"""Only ``knowledge_layer/qdrant/`` talks to Qdrant, and nothing talks to Chroma (ADR-0115, ADR-0116).

The scope filter is the boundary between offices' documents. It holds by
construction only while every read goes through ``knowledge_layer.qdrant``,
whose filters cannot be built without a scope; a second client elsewhere
would be a read path that never asked for one. Tests may import the client to
drive and inspect the server.

Chroma is gone: Qdrant is the one vector store. The only code that may still
read a Chroma store is the one-off migration that exports it
(:data:`CHROMA_ALLOWED`), which carries its own dependencies; a ``chromadb``
import anywhere else would be a second store creeping back in.
"""

from __future__ import annotations

import functools
import os
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[3]
ALLOWED = REPO / "packages" / "knowledge-layer" / "src" / "qdrant"
SEARCHED = ("src", "packages", "apps/backend/src", "scripts")
IMPORT = re.compile(r"^\s*(from\s+qdrant_client\b|import\s+qdrant_client\b)", re.MULTILINE)

#: The migration tool that exports an old Chroma store (``docs/deployment/qdrant-runbook.md``).
CHROMA_ALLOWED = ("deploy/migration",)
#: Trees that are not this repo's code.
NOT_OURS = frozenset({".venv", "node_modules", ".git", ".claude", ".agents"})
#: An import, or a test's ``pytest.importorskip("chromadb")``: the second one
#: skipped quietly once ``chromadb`` left the environment, and took its
#: assertions with it (``test_browse.py``'s exact-mode store tests did).
CHROMA_IMPORT = re.compile(
    r"^\s*(from\s+(chromadb|llama_index\.vector_stores\.chroma)\b"
    r"|import\s+(chromadb|llama_index\.vector_stores\.chroma)\b)"
    r"|importorskip\(\s*[\"'](chromadb|llama_index\.vector_stores\.chroma)\b",
    re.MULTILINE,
)
#: Chroma's client reached without importing it: looked up by name on the
#: retriever (``getattr(retriever, "_get_chroma_client", None)``) or called by
#: its collection API. A develop merge brought the first one in after Chroma
#: was gone; the Fassung compare then read nothing and said the file was not
#: in the index, with every test green against a faked client.
CHROMA_CLIENT_USE = re.compile(
    r"_get_chroma_client|\bchroma_client\b|\.get_collection\(\s*name=|include=\[\s*[\"']documents[\"']"
)


def _python_files(repo: pathlib.Path) -> list[pathlib.Path]:
    """Every ``.py`` under ``repo`` outside :data:`NOT_OURS`, without descending into those trees."""
    found: list[pathlib.Path] = []
    for directory, subdirs, names in os.walk(repo):
        subdirs[:] = [name for name in subdirs if name not in NOT_OURS]
        found.extend(pathlib.Path(directory, name) for name in names if name.endswith(".py"))
    return found


@functools.cache
def _real_python_files() -> tuple[pathlib.Path, ...]:
    return tuple(_python_files(REPO))


def _offenders(repo: pathlib.Path = REPO) -> list[str]:
    offenders: list[str] = []
    files = _real_python_files() if repo == REPO else _python_files(repo)
    roots = tuple(repo / root for root in SEARCHED)
    allowed = repo / "packages" / "knowledge-layer" / "src" / "qdrant"
    for path in files:
        relative = path.relative_to(repo)
        # Tests and their support packages (`testing/`) may reach the client.
        test_code = {"tests", "testing"} & set(relative.parts)
        if not any(root in path.parents for root in roots) or allowed in path.parents or test_code:
            continue
        if IMPORT.search(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(str(relative))
    return offenders


def _chroma_users(pattern: re.Pattern[str], repo: pathlib.Path = REPO) -> list[str]:
    offenders: list[str] = []
    files = _real_python_files() if repo == REPO else _python_files(repo)
    for path in files:
        relative = path.relative_to(repo)
        if str(relative).startswith(CHROMA_ALLOWED):
            continue
        if path == pathlib.Path(__file__).resolve():  # this file plants the strings it looks for
            continue
        if pattern.search(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(str(relative))
    return offenders


def _chroma_importers(repo: pathlib.Path = REPO) -> list[str]:
    return _chroma_users(CHROMA_IMPORT, repo)


def test_only_the_qdrant_package_imports_qdrant_client():
    assert _offenders() == []


def _plant(root: pathlib.Path, relative: str, text: str) -> pathlib.Path:
    """Write a file under a scratch repo, never the real one: parallel workers scan that tree."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_the_boundary_check_would_see_an_offender(tmp_path):
    """The check is not vacuous: a planted import outside the package is found."""
    _plant(tmp_path, "scripts/_planted_qdrant_import_check.py", "from qdrant_client import QdrantClient\n")
    assert "scripts/_planted_qdrant_import_check.py" in _offenders(tmp_path)


def test_nothing_but_the_migration_imports_chromadb():
    assert _chroma_importers() == []


def test_the_chroma_check_sees_an_offender_in_code_and_tests_alike(tmp_path):
    planted = [
        _plant(tmp_path, "src/_planted_chroma_check.py", "import chromadb\n"),
        _plant(
            tmp_path,
            "tests/_planted_chroma_check.py",
            "from llama_index.vector_stores.chroma import ChromaVectorStore\n",
        ),
        _plant(tmp_path, "tests/_planted_chroma_skip_check.py", '    chromadb = pytest.importorskip("chromadb")\n'),
    ]
    found = _chroma_importers(tmp_path)
    assert {str(path.relative_to(tmp_path)) for path in planted} <= set(found)


def test_nothing_reaches_for_a_chroma_client_by_name():
    """No code, test fakes included, asks for Chroma's client or calls its collection API."""
    assert _chroma_users(CHROMA_CLIENT_USE) == []


def test_the_client_check_would_see_a_lookup_by_name(tmp_path):
    _plant(
        tmp_path,
        "scripts/_planted_chroma_client_check.py",
        'client_of = getattr(retriever, "_get_chroma_client", None)\n',
    )
    assert "scripts/_planted_chroma_client_check.py" in _chroma_users(CHROMA_CLIENT_USE, tmp_path)
