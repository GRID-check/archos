#!/usr/bin/env python3
"""Decide which tests a pull request runs: the whole suite, or only what its change can reach.

Two questions, answered once in the Plan job for both test tiers.

**What changed?** Two references are sound, and the cheaper one wins.

- The whole pull request against its base. A test that reaches none of its
  files gives on the merge commit what it gives on `develop`, whose own full
  run (the deploy gate) answers for it.
- Against the pull request's last green CI run, when it has one: the pull
  request's own diff since that run's head, plus every file `develop` changed
  since shortly before that run, because the merge commit CI tests carries
  both. The tests that ran passed, so a push that only answers a review
  comment re-runs only what that push reaches. Each run's selection was sound
  against its own reference, so chaining them is sound too.

The second is smaller when `develop` stood still, and usually larger when it
moved: an hour of `develop` was a median 83 files, and adding it forced the
full Python suite on 90 of 113 replayed re-runs, where the pull request's own
diff forces it on 27 (docs/audit/blast-radius-2026-10.md). So the plan takes
the one that forces fewer full suites, then the one with fewer files, and says
which (`reference`): the first holds only against `develop`'s testmon database,
so a suite that would restore this pull request's own database restores
`develop`'s instead (ci.yml, "Restore this pull request's test database").

**Python** (pytest-testmon). Every green push to develop records which test
executed which function (`backend-testmon`); a pull request's own runs keep
their database per pull request, so the next push starts from it. The run is
FULL when the change touches what testmon cannot see:

- a conftest, a Python fixture, the lockfile or any pyproject.toml;
- how the backend jobs run (ci.yml, its setup action, the task files, the
  filters, this script);
- Python outside the tested packages (scripts/, deploy/, frontends/benchmarks/,
  ...), which tests load by path or in a subprocess;
- a non-Python file under a package's src/ that no test names;
- no recorded database (first run, evicted cache).
A non-Python input (a config, a prompt, a skill, a JSON schema) is invisible
to coverage, so every test file that names it is added. A fixture under
tests/fixtures/ counts as named by a test that names its directory too, since
tests read whole fixture directories; one that no test names forces the full
run, and so does any input a helper or conftest reads, since nothing says
which tests load the helper.

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
Writes `since`, `reference`, `py_mode`, `py_extra`, `ui_mode` and `ui_files`
to $GITHUB_OUTPUT.
"""

from __future__ import annotations

import datetime
import fnmatch
import json
import os
import posixpath
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
    # A Python fixture is test data a parametrize reads at collection, before
    # testmon records anything. A data fixture is matched by name below.
    "tests/fixtures/*.py",
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
)

# Where a test reads a non-Python file it does not import.
PY_TEST_ROOTS = ("tests", "frontends/aiq_api/tests", "sources")

# Test data. A test reads a fixture by name or a whole directory of them, so one
# no test names, directly or by a directory, forces a full run.
PY_FIXTURES = "tests/fixtures/"

# A non-Python file under these that no test names is code testmon cannot see
# (package data read at runtime), so it forces a full run rather than none.
PY_PACKAGE_SRC = ("src/**", "frontends/aiq_api/src/**", "sources/*/src/**")

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
# the BFF loads, the root scripts its walkers check, and the backend fixtures a
# contract spec reads (`skills/resolve-payload-contract.spec.ts`). A change to none of
# these since the last green run leaves every UI result standing.
UI_INPUTS = (UI + "**", "configs/**", "shared/**", "scripts/**", "src/aiq_agent/cards/**", "tests/fixtures/**")

# The spec files vitest collects (vitest.config.ts `include`). Vitest's `**/`
# matches no directory too; fnmatch's needs one, so each glob also gets its
# top-level form. Without it `src/english-names.spec.ts`, which reads every
# tracked file, was never found and ran on no selection at all.
_VITEST_INCLUDE = (
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
UI_SPECS = _VITEST_INCLUDE + tuple(glob.replace("/**/", "/") for glob in _VITEST_INCLUDE)

# A spec that reads the tree from disk: route and key walkers, migration and
# schema checks. Their inputs are not imports, so no graph sees them. Each
# declares them in a `// @disk-inputs:` line (globs relative to frontends/ui),
# and runs only when a changed path matches one; one without the line runs on
# every selection. config/vitest/disk-inputs.ts fails a spec that reads a path
# its line does not declare, and scripts/declare-disk-inputs.mjs writes the line.
READS_DISK = re.compile(
    r"""from ['"](?:node:)?fs(?:/promises)?['"]|require\(['"](?:node:)?fs|readdirSync|readFileSync|globSync"""
)
DISK_INPUTS = re.compile(r"^\s*//\s*@disk-inputs:\s*(.+)$", re.MULTILINE)
# A spec that starts a process: what the child reads, no recorder sees, so it
# never counts as declared.
SPAWNS = re.compile(r"""['"](?:node:)?child_process['"]""")

#: A disk reader's inputs, repo-relative, or None when it declares none.
DiskReaders = dict[str, tuple[str, ...] | None]


def declared_inputs(source: str) -> tuple[str, ...] | None:
    """The repo-relative globs a spec's `@disk-inputs` line names, or None without one."""
    found = DISK_INPUTS.search(source)
    if not found or SPAWNS.search(source):
        return None
    globs = (glob.strip() for glob in found.group(1).split(","))
    # `*` is the only wildcard a declaration has; a Next route's `[...path]`
    # is literal, and fnmatch would read it as a character class.
    return tuple(posixpath.normpath(posixpath.join(UI, glob)).replace("[", "[[]") for glob in globs if glob)


def _matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def _reads(path: str, file: str, text: str) -> bool:
    """Whether `text`, the source of `file` under a test root, names the non-Python `path`.

    A test file names it by its path or file name anywhere. A helper or conftest
    names it only as code reads a file, in a string literal that ends in its
    name (`"…/folder-cards.schema.json"`, `"stored_answers.json"`). Prose in a
    docstring (``sources/AGENTS.md``) is not a read, and counting it would run
    every test for each edit of a document. A fixture is named by its
    directories too, since tests read whole fixture directories (`rglob`).
    """
    name = Path(path).name
    if Path(file).name.startswith("test_") and (path in text or name in text):
        return True
    if any(f"{lead}{name}{quote}" in text for lead in ("/", '"', "'") for quote in ('"', "'")):
        return True
    if not path.startswith(PY_FIXTURES):
        return False
    parts = Path(path).parent.relative_to(PY_FIXTURES).parts
    return any(form in text for part in parts for form in (f"fixtures/{part}", f"/{part}/", f"'{part}'", f'"{part}"'))


def _readers(path: str, test_files: dict[str, str]) -> set[str]:
    """The files under the test roots that name `path` (:func:`_reads`)."""
    # Every spelling holds the file name or, for a fixture, a directory name,
    # so one search per file rules most of them out before the spellings are
    # tried: a re-run can bring hundreds of paths, and the Plan job, which
    # every job waits for, would otherwise spend seconds on each.
    words = [Path(path).name]
    if path.startswith(PY_FIXTURES):
        words += Path(path).parent.relative_to(PY_FIXTURES).parts
    return {
        file for file, text in test_files.items() if any(word in text for word in words) and _reads(path, file, text)
    }


def decide_python(changed: list[str], test_files: dict[str, str], recorded: bool) -> tuple[str, list[str], str]:
    """`(mode, extra test files, reason)` for the Python suites.

    `test_files` maps every Python file under the test roots (test files and
    the helpers and conftests they load) to its text; `recorded` says whether a
    testmon database from develop exists. A non-Python input that only a
    helper names forces the full run: nothing says which tests load the helper.
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
        named = _readers(path, test_files)
        helpers = sorted(name for name in named if not Path(name).name.startswith("test_"))
        if helpers:
            return "full", [], f"{path} is read by {helpers[0]}, which no test file connects to it"
        if not named and path.startswith(PY_FIXTURES):
            return "full", [], f"{path} is a fixture no test names"
        if not named and _matches(path, PY_PACKAGE_SRC):
            return "full", [], f"{path} is package data no test names"
        extra |= named
    reason = f"{len(changed)} changed files; testmon selects, plus {len(extra)} test files naming a non-Python change"
    return "select", sorted(extra), reason


def decide_ui(changed: list[str], disk_readers: DiskReaders) -> tuple[str, list[str], str]:
    """`(mode, files for vitest related, reason)`; paths in the files list are relative to frontends/ui.

    `none` means no UI spec can have changed outcome, so none runs. A disk reader
    runs when a changed path matches its declared inputs, or always without them.
    """
    forced = [path for path in changed if _matches(path, UI_FULL)]
    if forced:
        return "full", [], f"{forced[0]} reaches every spec"
    declared = {glob for inputs in disk_readers.values() if inputs for glob in inputs}
    if not any(_matches(path, UI_INPUTS) or _matches(path, declared) for path in changed):
        return "none", [], "nothing a UI spec reads changed"
    mine = sorted(path.removeprefix(UI) for path in changed if path.startswith(UI))
    undeclared = {spec for spec, inputs in disk_readers.items() if inputs is None}
    reached = {spec for spec, inputs in disk_readers.items() if inputs and any(_matches(p, inputs) for p in changed)}
    files = sorted(set(mine) | undeclared | reached)
    reason = (
        f"{len(mine)} changed UI files, plus {len(reached)} of {len(disk_readers) - len(undeclared)} "
        f"tree-reading specs whose declared inputs changed and {len(undeclared)} that declare none"
    )
    return "select", files, reason


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def _names(*args: str) -> list[str]:
    return [line for line in _git(*args).splitlines() if line]


def _python_test_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for root in PY_TEST_ROOTS:
        for path in (ROOT / root).rglob("*.py"):
            relative = path.relative_to(ROOT).as_posix()
            if root == "sources" and "/tests/" not in f"/{relative}":
                continue
            files[relative] = path.read_text(encoding="utf-8", errors="ignore")
    return files


def _disk_readers() -> DiskReaders:
    ui = ROOT / UI
    readers: DiskReaders = {}
    for directory, subdirs, names in os.walk(ui):
        subdirs[:] = [name for name in subdirs if name not in ("node_modules", ".next", "coverage")]
        for name in names:
            path = Path(directory, name)
            relative = path.relative_to(ui).as_posix()
            if not _matches(relative, UI_SPECS):
                continue
            source = path.read_text(encoding="utf-8", errors="ignore")
            if READS_DISK.search(source):
                readers[relative] = declared_inputs(source)
    return dict(sorted(readers.items()))


def previous_green(get: Get, repo: str, branch: str, head: str, is_ancestor: Callable[[str], bool]) -> dict | None:
    """The newest successful CI run of this pull request's branch at an ancestor of `head` (or `head` itself)."""
    query = urllib.parse.urlencode({"branch": branch, "event": "pull_request", "status": "success", "per_page": 30})
    for run in get(f"/repos/{repo}/actions/workflows/ci.yml/runs?{query}").get("workflow_runs", []):
        sha = run.get("head_sha", "")
        if re.fullmatch(r"[0-9a-f]{40}", sha) and (sha == head or is_ancestor(sha)):
            return run
    return None


# A reference: the changed paths, a description for the log, and which it is
# ("base": the whole pull request; "green": since its last green run).
Reference = tuple[list[str], str, str]


def changed_paths(base: str, previous: dict | None) -> list[Reference]:
    """Each sound reference for the paths the tests have not yet seen."""
    merge_base = _git("merge-base", base, "HEAD").strip()
    whole = (_names("diff", "--name-only", "--no-renames", merge_base, "HEAD"), f"the base {merge_base[:12]}", "base")
    if previous is None:
        return [whole]
    own = _names("diff", "--name-only", "--no-renames", previous["head_sha"], "HEAD")
    started = datetime.datetime.fromisoformat(previous["created_at"].replace("Z", "+00:00"))
    since = (started - BASE_SLACK).isoformat()
    from_base = _names("log", "--format=", "--name-only", f"--since={since}", base)
    since_green = sorted(set(own) | set(from_base))
    return [whole, (since_green, f"the last green run at {previous['head_sha'][:12]}", "green")]


def cheaper(candidates: list[Reference], cost: Callable[[list[str]], int]) -> Reference:
    """The candidate that forces the fewest full suites, then has the fewest paths; the first on a tie."""
    return min(candidates, key=lambda candidate: (cost(candidate[0]), len(candidate[0])))


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
    test_files, disk_readers = _python_test_files(), _disk_readers()

    def full_suites(paths: list[str]) -> int:
        return (decide_python(paths, test_files, recorded)[0] == "full") + (decide_ui(paths, disk_readers)[0] == "full")

    changed, since, reference = cheaper(changed_paths(argv[1], previous), full_suites)
    py_mode, py_extra, py_reason = decide_python(changed, test_files, recorded)
    ui_mode, ui_files, ui_reason = decide_ui(changed, disk_readers)
    print(f"changes since {since}: {len(changed)} files")
    print(f"python: {py_mode} ({py_reason})")
    print(f"ui: {ui_mode} ({ui_reason})")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"since={since}\nreference={reference}\n")
            handle.write(f"py_mode={py_mode}\npy_extra={json.dumps(py_extra)}\n")
            handle.write(f"ui_mode={ui_mode}\nui_files={json.dumps(ui_files)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
