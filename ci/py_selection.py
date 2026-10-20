#!/usr/bin/env python3
"""Decide whether a pull request runs the whole Python suite or only what its change reaches.

The selected run is pytest-testmon: every green push to develop records which
test executed which function (`backend-testmon`, saved in the Actions cache),
and a pull request runs the tests whose recorded functions it changed. The
whole suite, sharded and coverage-gated, still runs on every push to develop,
so anything a selection misses turns develop red before it reaches staging
(deploy.yml follows only a green push run).

A selection is only as good as what testmon can see, so the run is FULL when
the change touches something testmon does not track:

- a conftest, a fixture directory, the lockfile or any pyproject.toml;
- how the backend jobs run (ci.yml, its setup action, the backend task file,
  the root Taskfile, the filters, this script);
- Python outside the tested packages (scripts/, deploy/, frontends/benchmarks/,
  ...), which tests load by path or in a subprocess;
- a non-Python file under a package's src/ that no test names;
- the recorded database is missing (first run, evicted cache).

A non-Python input (a config, a prompt, a skill, a JSON schema) is invisible to
coverage, so every test file that names it, by path or by file name, is added
to the selection.

Usage: py_selection.py BASE
Writes `mode=full|select`, `extra=<json list of test files>` and `reason=...`
to $GITHUB_OUTPUT. GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_API_URL, when
present, are used to check that a recorded database exists; without them the
answer is full.
"""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import sys
import urllib.parse
from collections.abc import Callable
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The cache key prefix the develop push saves under (ci.yml `backend-testmon`).
CACHE_PREFIX = "testmon-"

FORCE_FULL = (
    "**/conftest.py",
    "conftest.py",
    "tests/fixtures/**",
    "tests/__init__.py",
    "uv.lock",
    "pyproject.toml",
    "**/pyproject.toml",
    "Taskfile.yml",
    "taskfiles/backend.yml",
    ".github/workflows/ci.yml",
    ".github/filters.yml",
    ".github/actions/setup-python-env/**",
    "ci/py_selection.py",
    # The claim-queue suites run on a throwaway Postgres this script builds.
    "scripts/rls-test-db.sh",
)

# Where testmon sees Python: the packages under test and the tests themselves.
TRACKED_PY = (
    "src/**",
    "tests/**",
    "frontends/aiq_api/src/**",
    "frontends/aiq_api/tests/**",
    "sources/*/src/**",
    "sources/*/tests/**",
)

# Where a test reads a non-Python file it does not import.
TEST_ROOTS = ("tests", "frontends/aiq_api/tests", "sources")

# A non-Python file under these that no test names is code testmon cannot see
# (package data read at runtime), so it forces a full run rather than none.
PACKAGE_SRC = ("src/**", "frontends/aiq_api/src/**", "sources/*/src/**")


def _matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def decide(changed: list[str], test_files: dict[str, str], recorded: bool) -> tuple[str, list[str], str]:
    """`(mode, extra test files, reason)` for these changed paths.

    `test_files` maps each test file's repo-relative path to its text; `recorded`
    says whether a testmon database from develop exists.
    """
    if not recorded:
        return "full", [], "no recorded testmon database to select from"
    forced = [path for path in changed if _matches(path, FORCE_FULL)]
    if forced:
        return "full", [], f"{forced[0]} changes how every test runs"
    untracked = [path for path in changed if path.endswith(".py") and not _matches(path, TRACKED_PY)]
    if untracked:
        return "full", [], f"{untracked[0]} is Python outside the tested packages"
    extra: set[str] = set()
    for path in changed:
        if path.endswith(".py"):
            continue
        name = Path(path).name
        named = {test for test, text in test_files.items() if path in text or name in text}
        if not named and _matches(path, PACKAGE_SRC):
            return "full", [], f"{path} is package data no test names"
        extra |= named
    reason = f"{len(changed)} changed files; testmon selects, plus {len(extra)} test files naming a non-Python change"
    return "select", sorted(extra), reason


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def _test_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for root in TEST_ROOTS:
        for path in (ROOT / root).rglob("test_*.py"):
            relative = path.relative_to(ROOT).as_posix()
            if root == "sources" and "/tests/" not in f"/{relative}":
                continue
            files[relative] = path.read_text(encoding="utf-8", errors="ignore")
    return files


def recorded_database(get: Callable[[str], dict]) -> bool:
    """Whether develop has saved a testmon database. Any failure answers no."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    query = urllib.parse.urlencode({"key": CACHE_PREFIX, "ref": "refs/heads/develop", "per_page": "1"})
    try:
        return bool(get(f"/repos/{repo}/actions/caches?{query}").get("actions_caches"))
    except Exception as error:  # noqa: BLE001 - a lookup failure means a full run, never a red Plan
        print(f"cache lookup failed ({error}); running the full suite", file=sys.stderr)
        return False


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    merge_base = _git("merge-base", argv[1], "HEAD").strip()
    changed = [line for line in _git("diff", "--name-only", "--no-renames", merge_base, "HEAD").splitlines() if line]
    token = os.environ.get("GITHUB_TOKEN", "")
    recorded = False
    if token:
        from reuse_green_run import github_get

        recorded = recorded_database(github_get(os.environ.get("GITHUB_API_URL", "https://api.github.com"), token))
    mode, extra, reason = decide(changed, _test_files(), recorded)
    print(f"{mode}: {reason}")
    for test in extra:
        print(f"  + {test}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"mode={mode}\nextra={json.dumps(extra)}\nreason={reason}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
