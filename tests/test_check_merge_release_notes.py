"""The merge-commit release-note guard, against real git merges in a scratch repository."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_merge_release_notes.py"
NOTE = "releasenotes/notes/topic-0123456789abcdef.yaml"


def run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=False, cwd=repo, capture_output=True, text=True)


def git(repo: Path, *args: str) -> None:
    run(repo, "git", *args).check_returncode()


def write(repo: Path, path: str, text: str) -> None:
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text, encoding="utf-8")
    git(repo, "add", path)


def guard(repo: Path) -> subprocess.CompletedProcess[str]:
    return run(repo, sys.executable, str(SCRIPT))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A base commit, a `topic` branch that adds the note, and a `main` that moved on."""
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "test@example.com")
    git(tmp_path, "config", "user.name", "test")
    write(tmp_path, "base.txt", "base\n")
    git(tmp_path, "commit", "-q", "-m", "base")
    git(tmp_path, "checkout", "-q", "-b", "topic")
    write(tmp_path, NOTE, "features:\n  - One.\n")
    git(tmp_path, "commit", "-q", "-m", "note")
    git(tmp_path, "checkout", "-q", "main")
    write(tmp_path, "main.txt", "main\n")
    git(tmp_path, "commit", "-q", "-m", "main")
    git(tmp_path, "checkout", "-q", "topic")
    git(tmp_path, "merge", "-q", "--no-commit", "main")
    return tmp_path


def test_outside_a_merge_it_passes(tmp_path: Path) -> None:
    git(tmp_path, "init", "-q")
    write(tmp_path, NOTE, "features:\n  - One.\n")
    assert guard(tmp_path).returncode == 0


def test_a_merge_that_leaves_the_note_alone_passes(repo: Path) -> None:
    assert guard(repo).returncode == 0


def test_a_merge_that_edits_the_note_fails(repo: Path) -> None:
    write(repo, NOTE, "features:\n  - Two.\n")
    result = guard(repo)
    assert result.returncode == 1
    assert NOTE in result.stderr


def test_a_merge_that_adds_a_note_fails(repo: Path) -> None:
    added = "releasenotes/notes/other-fedcba9876543210.yaml"
    write(repo, added, "fixes:\n  - Three.\n")
    result = guard(repo)
    assert result.returncode == 1
    assert added in result.stderr


def test_a_note_the_other_side_brings_in_passes(repo: Path) -> None:
    git(repo, "merge", "--abort")
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--no-commit", "--no-ff", "topic")
    assert guard(repo).returncode == 0
