#!/usr/bin/env python3
"""Decide which tests a pull request runs: the whole suite, or only what its change can reach.

Two questions, answered once in the Plan job for both test tiers.

**What changed?** Against the pull request's last green CI run when it has
one, not against its base: the tests that run passed, so a push that only
answers a review comment re-runs only what that push reaches. The set is the
pull request's own diff since that run's head, plus every file `develop` (the
base) changed since shortly before that run, because the merge commit CI tests
carries both. With no green run yet, it is the whole pull request against its
base. Each run's selection was sound against its own reference, so chaining
them is sound too.

**Python** (pytest-testmon). Every green push to develop records which test
executed which function (`backend-testmon`); a pull request's own runs keep
their database per pull request, so the next push starts from it. The run is
FULL when the change touches what testmon cannot see:

- a conftest, a fixture directory, the lockfile or any pyproject.toml;
- how the backend jobs run (ci.yml, its setup action, the task files, the
  filters, this script);
- Python outside the tested packages (scripts/, deploy/, ...), which tests
  load by path or in a subprocess;
- a non-Python file under a package's src/ that no test names;
- no recorded database (first run, evicted cache).
A non-Python input (a config, a prompt, a skill, a JSON schema) is invisible
to coverage, so every test file that names it is added.

**UI** (`vitest related`). The specs whose import graph reaches a changed file,
plus every spec that reads files from disk instead of importing them (route
walkers, schema and migration checks), which no import graph can connect to a
change. FULL when the change reaches what every spec loads: the package
manifest, the vitest config and setup, the mocks the setup installs, the
tsconfig, or how the frontend jobs run.

The whole suite, sharded and coverage-gated, still runs on every push to
develop, which the deploy waits for (deploy.yml), so anything a selection
misses turns develop red before it reaches staging.

Usage: pr_selection.py BASE
Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_HEAD_REF
(all optional: without them there is no previous green run and no recorded
database, so the answer is the whole PR, and full for Python).
Writes `since`, `py_mode`, `py_extra`, `ui_mode` and `ui_files` to
$GITHUB_OUTPUT.
"""

from __future__ import annotations

import datetime
import fnmatch
import json
import os
import re
import subprocess
import sys
import urllib.parse
from collections.abc import Callable
from collections.abc import Iterable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
UI = "frontends/ui/"

Get = Callable[[str], Any]

# The cache key prefix the develop push saves the testmon databases under.
CACHE_PREFIX = "testmon-"
# How far before a green run's start a base commit still counts as possibly
# unseen by it: the run checked out the base when it started, and a merge's
# commit date is when it landed. Generous on purpose; it only widens the set.
BASE_SLACK = datetime.timedelta(hours=1)

PY_FULL = (
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
    "ci/pr_selection.py",
    # The claim-queue suites run on a throwaway Postgres this script builds.
    "scripts/rls-test-db.sh",
)

# Where testmon sees Python: the packages under test and the tests themselves.
PY_TRACKED = (
    "src/**",
    "tests/**",
    "frontends/aiq_api/src/**",
    "frontends/aiq_api/tests/**",
    "sources/*/src/**",
    "sources/*/tests/**",
    "evals/**",
)

# Where a test reads a non-Python file it does not import.
PY_TEST_ROOTS = ("tests", "frontends/aiq_api/tests", "sources", "evals")

# A non-Python file under these that no test names is code testmon cannot see
# (package data read at runtime), so it forces a full run rather than none.
PY_PACKAGE_SRC = ("src/**", "frontends/aiq_api/src/**", "sources/*/src/**", "evals/*/src/**", "evals/*/fixtures/**")

# What every UI spec loads before its own imports, so no graph sees it.
UI_FULL = (
    UI + "package.json",
    UI + "bun.lock",
    UI + "tsconfig*.json",
    UI + "vitest.config.*",
    UI + "next.config.ts",
    UI + "config/vitest/**",
    UI + "src/mocks/**",
    # Imported by the mock handlers the setup file installs.
    UI + "src/adapters/api/documents-schemas.ts",
    UI + "src/features/documents/types.ts",
    UI + "src/lib/upload-screening/policy.ts",
    "Taskfile.yml",
    "taskfiles/frontend.yml",
    ".github/workflows/ci.yml",
    ".github/filters.yml",
    ".github/actions/setup-bun/**",
    "ci/pr_selection.py",
)

# What a UI spec can read at all: its own tree, the configs and shared schemas
# the BFF loads, and the root scripts its walkers check. A change to none of
# these since the last green run leaves every UI result standing.
UI_INPUTS = (UI + "**", "configs/**", "shared/**", "scripts/**", "src/aiq_agent/cards/**")

# The spec files vitest collects (vitest.config.ts `include`).
UI_SPECS = (
    "src/**/*.spec.ts",
    "src/**/*.spec.tsx",
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "tests/**/*.test.ts",
    "tests/**/*.test.tsx",
    "purger/**/*.spec.mjs",
    "scheduler/**/*.spec.mjs",
    "observability/**/*.spec.mjs",
    "workers/**/*.spec.mjs",
    "scripts/**/*.spec.mjs",
    "eslint-rules/**/*.spec.mjs",
)

# A spec that reads the tree from disk: route and key walkers, migration and
# schema checks. Their inputs are not imports, so they run on every selection.
READS_DISK = re.compile(
    r"""from ['"](?:node:)?fs(?:/promises)?['"]|require\(['"](?:node:)?fs|readdirSync|readFileSync|globSync"""
)


def _matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def decide_python(changed: list[str], test_files: dict[str, str], recorded: bool) -> tuple[str, list[str], str]:
    """`(mode, extra test files, reason)` for the Python suites.

    `test_files` maps each test file's repo-relative path to its text; `recorded`
    says whether a testmon database from develop exists.
    """
    if not recorded:
        return "full", [], "no recorded testmon database to select from"
    forced = [path for path in changed if _matches(path, PY_FULL)]
    if forced:
        return "full", [], f"{forced[0]} changes how every test runs"
    untracked = [path for path in changed if path.endswith(".py") and not _matches(path, PY_TRACKED)]
    if untracked:
        return "full", [], f"{untracked[0]} is Python outside the tested packages"
    extra: set[str] = set()
    for path in changed:
        if path.endswith(".py"):
            continue
        name = Path(path).name
        named = {test for test, text in test_files.items() if path in text or name in text}
        if not named and _matches(path, PY_PACKAGE_SRC):
            return "full", [], f"{path} is package data no test names"
        extra |= named
    reason = f"{len(changed)} changed files; testmon selects, plus {len(extra)} test files naming a non-Python change"
    return "select", sorted(extra), reason


def decide_ui(changed: list[str], disk_readers: list[str]) -> tuple[str, list[str], str]:
    """`(mode, files for vitest related, reason)`; paths in the files list are relative to frontends/ui.

    `none` means no UI spec can have changed outcome, so none runs.
    """
    forced = [path for path in changed if _matches(path, UI_FULL)]
    if forced:
        return "full", [], f"{forced[0]} reaches every spec"
    if not any(_matches(path, UI_INPUTS) for path in changed):
        return "none", [], "nothing a UI spec reads changed"
    mine = sorted(path.removeprefix(UI) for path in changed if path.startswith(UI))
    files = sorted(set(mine) | set(disk_readers))
    return "select", files, f"{len(mine)} changed UI files, plus {len(disk_readers)} specs that read the tree from disk"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def _names(*args: str) -> list[str]:
    return [line for line in _git(*args).splitlines() if line]


def _python_test_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for root in PY_TEST_ROOTS:
        for path in (ROOT / root).rglob("test_*.py"):
            relative = path.relative_to(ROOT).as_posix()
            if root == "sources" and "/tests/" not in f"/{relative}":
                continue
            files[relative] = path.read_text(encoding="utf-8", errors="ignore")
    return files


def _disk_readers() -> list[str]:
    ui = ROOT / UI
    readers = []
    for directory, subdirs, names in os.walk(ui):
        subdirs[:] = [name for name in subdirs if name not in ("node_modules", ".next", "coverage")]
        for name in names:
            path = Path(directory, name)
            relative = path.relative_to(ui).as_posix()
            if _matches(relative, UI_SPECS) and READS_DISK.search(path.read_text(encoding="utf-8", errors="ignore")):
                readers.append(relative)
    return sorted(readers)


def previous_green(get: Get, repo: str, branch: str, head: str, is_ancestor: Callable[[str], bool]) -> dict | None:
    """The newest successful CI run of this pull request's branch at an ancestor of `head` (or `head` itself)."""
    query = urllib.parse.urlencode({"branch": branch, "event": "pull_request", "status": "success", "per_page": 30})
    for run in get(f"/repos/{repo}/actions/workflows/ci.yml/runs?{query}").get("workflow_runs", []):
        sha = run.get("head_sha", "")
        if re.fullmatch(r"[0-9a-f]{40}", sha) and (sha == head or is_ancestor(sha)):
            return run
    return None


def changed_paths(base: str, previous: dict | None) -> tuple[list[str], str]:
    """The paths the tests have not yet seen, and a description of the reference."""
    merge_base = _git("merge-base", base, "HEAD").strip()
    if previous is None:
        return _names("diff", "--name-only", "--no-renames", merge_base, "HEAD"), f"the base {merge_base[:12]}"
    own = _names("diff", "--name-only", "--no-renames", previous["head_sha"], "HEAD")
    started = datetime.datetime.fromisoformat(previous["created_at"].replace("Z", "+00:00"))
    since = (started - BASE_SLACK).isoformat()
    from_base = _names("log", "--format=", "--name-only", f"--since={since}", base)
    return sorted(set(own) | set(from_base)), f"the last green run at {previous['head_sha'][:12]}"


def recorded_database(get: Get) -> bool:
    """Whether develop has saved a testmon database. Any failure answers no."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    query = urllib.parse.urlencode({"key": CACHE_PREFIX, "ref": "refs/heads/develop", "per_page": "1"})
    try:
        return bool(get(f"/repos/{repo}/actions/caches?{query}").get("actions_caches"))
    except Exception as error:  # noqa: BLE001 - a lookup failure means a full run, never a red Plan
        print(f"cache lookup failed ({error}); running the full Python suite", file=sys.stderr)
        return False


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    token = os.environ.get("GITHUB_TOKEN", "")
    previous, recorded = None, False
    if token:
        from reuse_green_run import github_get

        get = github_get(os.environ.get("GITHUB_API_URL", "https://api.github.com"), token)
        recorded = recorded_database(get)
        head = _git("rev-parse", "HEAD").strip()

        def is_ancestor(sha: str) -> bool:
            return (
                subprocess.run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], cwd=ROOT, check=False).returncode
                == 0
            )

        try:
            previous = previous_green(
                get, os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_HEAD_REF", ""), head, is_ancestor
            )
        except Exception as error:  # noqa: BLE001 - no previous run only widens the set
            print(f"previous-run lookup failed ({error}); diffing against the base", file=sys.stderr)
    changed, since = changed_paths(argv[1], previous)
    py_mode, py_extra, py_reason = decide_python(changed, _python_test_files(), recorded)
    ui_mode, ui_files, ui_reason = decide_ui(changed, _disk_readers())
    print(f"changes since {since}: {len(changed)} files")
    print(f"python: {py_mode} ({py_reason})")
    print(f"ui: {ui_mode} ({ui_reason})")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"since={since}\n")
            handle.write(f"py_mode={py_mode}\npy_extra={json.dumps(py_extra)}\n")
            handle.write(f"ui_mode={ui_mode}\nui_files={json.dumps(ui_files)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
