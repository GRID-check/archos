#!/usr/bin/env python3

"""A merge commit carries release notes from its parents and never writes one.

reno reads the branch's whole history. A merge commit that adds or edits a
note makes that note differ from every parent at once, which reno reads as an
add and a modify (or two adds) of one note in one commit, and `task
release:lint` fails with ``Unrecognized changes`` or ``found several files in
one commit``. No later commit clears it: the only way out is rewriting the
merge, which on a shared branch means a force-push or a new pull request. It
cost PR #926, #1305 and #1342 a round each (``docs/contributing/gotchas.md``).

This runs while a merge is being committed (``MERGE_HEAD`` exists) and fails
when a staged note matches none of the merge's parents. A note the merge
brings in unchanged from one side passes. Outside a merge it does nothing.

Usage: python scripts/check_merge_release_notes.py. Exit code 0 when the merge
writes no note.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

NOTES = "releasenotes/notes/"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()


def blob(rev: str, path: str) -> str | None:
    """The blob id of ``path`` at ``rev`` (``""`` is the index), or None when it is absent there."""
    found = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{rev}:{path}"], check=False, capture_output=True, text=True
    )
    return found.stdout.strip() or None


def merge_parents() -> list[str]:
    """HEAD and every MERGE_HEAD while a merge is in progress, else nothing."""
    merge_head = Path(git("rev-parse", "--git-path", "MERGE_HEAD"))
    if not merge_head.is_file():
        return []
    return ["HEAD", *merge_head.read_text(encoding="utf-8").split()]


def written_notes(parents: list[str]) -> list[str]:
    """The staged notes that match no parent: the ones the merge itself wrote."""
    staged = git("diff", "--cached", "--name-only", "--diff-filter=AM", "HEAD", "--", NOTES).splitlines()
    return [path for path in staged if blob("", path) not in {blob(parent, path) for parent in parents}]


def main() -> int:
    parents = merge_parents()
    if not parents:
        return 0
    notes = written_notes(parents)
    if not notes:
        return 0
    print("This merge commit writes release notes, which reno cannot read:", file=sys.stderr)
    for path in notes:
        print(f"  - {path}", file=sys.stderr)
    print(
        "Take each note as one parent has it (git checkout HEAD -- <note>), commit the merge, "
        "then make the edit in a commit of its own. Why: docs/contributing/gotchas.md (release:lint).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
