"""A cross-language fixture exists once, under ``frontends/ui/tests/fixtures/``.

Four contracts (the request-context envelope, the job fire headers, the
reasoning-effort and retrieval-settings catalogs) used to live twice, a
repo-root copy for pytest and a byte-identical twin for the UI's Docker
typecheck context, which cannot reach outside ``frontends/ui``. Nothing but a
person remembering kept the pair equal. Both suites now read the one copy, and
this test fails a second one appearing under the repo-root ``tests/`` tree.
See ``docs/contributing/testing-and-verification.md``.
"""

import hashlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FRONTEND_FIXTURES = REPO / "frontends" / "ui" / "tests" / "fixtures"
PYTHON_TESTS = REPO / "tests"


def _digests(root: Path) -> dict[str, Path]:
    return {
        hashlib.sha256(path.read_bytes()).hexdigest(): path
        for path in sorted(root.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts
    }


def test_no_python_test_file_twins_a_frontend_fixture() -> None:
    frontend = _digests(FRONTEND_FIXTURES)
    twins = [
        f"{path.relative_to(REPO)} == {frontend[digest].relative_to(REPO)}"
        for digest, path in _digests(PYTHON_TESTS).items()
        if digest in frontend and path.stat().st_size > 0
    ]
    assert not twins, (
        "These files duplicate a frontend fixture byte for byte. Delete the copy and read "
        f"frontends/ui/tests/fixtures/ from the Python test instead: {twins}"
    )
