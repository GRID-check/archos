"""The top level says what the repository holds, and a finished move stays finished (ADR-0145).

Two ratchets on the layout ADR-0145 sets out:

- Every top-level tracked directory is a target name or a legacy name still
  waiting for its move. A new directory fails here until someone adds it, which
  is the moment to ask whether its name says its job. A legacy name leaves the
  list in the PR that empties it, and a listed name that is gone fails too, so
  the list cannot keep a stale entry.
- A path a finished move left behind is never tracked again, and nothing but
  history names it. History is the ADRs, `releasenotes/` and `docs/audit/`,
  which say what was true then. A one-segment old path (`plans/`) only gets
  the first half: as a word it turns up in prose and test data.

A move adds its old path to `MOVED` and removes its legacy name in the same PR.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: The layout ADR-0145 aims at, with the dot-directories the tools need.
TARGET = frozenset(
    {
        ".claude",
        ".devcontainer",
        ".github",
        "apps",
        "ci",
        "configs",
        "contracts",
        "data",
        "deploy",
        "docs",
        "evals",
        "packages",
        "releasenotes",
        "scripts",
        "skills",
        "taskfiles",
        "tests",
    }
)

#: Still waiting for their move, and the ADR-0145 row that empties each.
LEGACY = {
    "frontends": "row 9 (ui)",
}

#: Finished moves: the old path, and where its contents went.
MOVED = {
    "plans/": "docs/plans, then deleted (#1250, #1252)",
    "docs/superpowers/": "docs/specs, then deleted (#1250, #1252)",
    "frontends/benchmarks/": "evals/ (row 2)",
    "tests/benchmarks/": "evals/ (row 2)",
    "frontends/web/": "apps/site (row 3)",
    "shared/brand/": "packages/brand (row 3)",
    "shared/cards/": "contracts/cards (row 4)",
    "shared/wire/": "contracts/wire (row 4)",
    "sources/": "packages/<distribution> (row 6)",
    "sources/knowledge_layer/": "packages/knowledge-layer (row 6)",
    "sources/ris_adapter/": "packages/ris-adapter (row 6)",
    "sources/tavily_web_search/": "packages/tavily-web-search (row 6)",
    "src/aiq_agent/": "packages/agent/src/aiq_agent (row 8)",
    "tests/aiq_agent/": "packages/agent/tests (row 8)",
    "frontends/aiq_api/": "apps/backend (row 7)",
    "deploy/entrypoint.py": "apps/backend/entrypoint.py (row 7)",
    "deploy/start_web.py": "apps/backend/start_web.py (row 7)",
}

#: Where an old path may still be named: the record of what was true then.
HISTORY = (":!docs/adr/", ":!releasenotes/", ":!docs/audit/", ":!frontends/ui/drizzle/")


def _at_path_start(path: str) -> str:
    """An extended regex for `path` where a path starts: `plans/`, not the end of `floor-plans/`."""
    return r"(^|[^[:alnum:]_./-])" + re.escape(path).replace("/", "/")


def _tracked_top_level() -> set[str]:
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True, text=True)
    return {path.split("/", 1)[0] for path in listed.stdout.split("\0") if "/" in path}


def test_every_top_level_directory_is_a_target_or_waiting_for_its_move():
    unknown = sorted(_tracked_top_level() - TARGET - set(LEGACY))

    assert unknown == [], (
        f"new top-level directories {unknown}: add each to TARGET in tests/test_repo_layout.py "
        "if its name says its job (ADR-0145, naming rules), or put it under one that does"
    )


def test_a_legacy_name_leaves_the_list_with_its_move():
    gone = sorted(set(LEGACY) - _tracked_top_level())

    assert gone == [], f"{gone} no longer exist: remove them from LEGACY in tests/test_repo_layout.py"


def test_the_target_and_the_legacy_names_do_not_overlap():
    assert TARGET.isdisjoint(LEGACY)


def test_a_finished_move_leaves_nothing_behind():
    for old, went in MOVED.items():
        tracked = subprocess.run(["git", "ls-files", old], cwd=ROOT, check=True, capture_output=True, text=True)
        assert tracked.stdout == "", f"{old} is tracked again; its contents moved to {went}"


def test_nothing_but_history_names_a_moved_path():
    named = {}
    # A one-segment name (`plans/`) is also a word in prose and test data; the
    # tracked-path check above covers it.
    for old in (path for path in MOVED if path.count("/") > 1):
        found = subprocess.run(
            ["git", "grep", "-l", "-E", _at_path_start(old), "--", ".", *HISTORY, ":!tests/test_repo_layout.py"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if files := found.stdout.split():
            named[old] = files

    assert named == {}, f"these still name a moved path; point them at where it went: {named}"


def test_a_moved_path_is_matched_only_where_a_path_starts():
    pattern = re.compile(_at_path_start("tests/benchmarks/").replace("[:alnum:]", "a-zA-Z0-9"))

    assert pattern.search("see tests/benchmarks/test_x.py")
    assert pattern.search("`tests/benchmarks/`")
    assert not pattern.search("sources/knowledge_layer/tests/benchmarks/")
    assert not pattern.search("frontends/ui/tests/benchmarks/")
