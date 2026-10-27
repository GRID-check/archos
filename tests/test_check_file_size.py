"""The size ratchet refuses a new giant, refuses growth, and makes the baseline follow every shrink.

`scripts/check_file_size.py` holds source files to 600 lines and Python
functions to 60, with `ci/size_baseline.json` recording what was over when the
check arrived. These run it on a scratch repository, so the real tree's
baseline is not what they depend on.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def checker():
    spec = importlib.util.spec_from_file_location("check_file_size", ROOT / "scripts" / "check_file_size.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # A dataclass resolves its annotations through sys.modules, so register before running the module.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def repo(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "ci").mkdir()
    monkeypatch.chdir(tmp_path)
    return tmp_path


def add(repo: Path, path: str, text: str) -> None:
    """Write ``path`` and stage it: the check reads `git ls-files`, as a commit would."""
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", path], cwd=repo, check=True)


def lines(count: int) -> str:
    return "".join(f"x{n} = {n}\n" for n in range(count))


def function(name: str, body_lines: int) -> str:
    return f"def {name}():\n" + "".join(f"    y{n} = {n}\n" for n in range(body_lines - 1))


def test_a_new_file_over_the_limit_fails(checker, repo, capsys):
    add(repo, "src/small.py", lines(10))
    add(repo, "src/giant.tsx", "const a = 1;\n" * 601)

    assert checker.main([]) == 1
    assert "src/giant.tsx: 601 lines, over the 600-line file limit" in capsys.readouterr().err


def test_a_new_function_over_the_limit_fails_with_its_qualified_name(checker, repo, capsys):
    add(repo, "src/svc.py", "class Service:\n" + "\n".join("    " + line for line in function("run", 61).splitlines()))

    assert checker.main([]) == 1
    assert "src/svc.py::Service.run: 61 lines, over the 60-line function limit" in capsys.readouterr().err


def test_a_baselined_file_may_stay_but_not_grow(checker, repo, capsys):
    add(repo, "src/big.py", lines(700))
    checker.main(["--rebaseline"])
    assert checker.main([]) == 0

    add(repo, "src/big.py", lines(701))

    assert checker.main([]) == 1
    assert "src/big.py: grew from 700 to 701 lines" in capsys.readouterr().err


def test_a_baselined_function_may_not_grow(checker, repo, capsys):
    add(repo, "src/job.py", function("run_job", 100))
    checker.main(["--rebaseline"])

    add(repo, "src/job.py", function("run_job", 101))

    assert checker.main([]) == 1
    assert "src/job.py::run_job: grew from 100 to 101 lines" in capsys.readouterr().err


def test_a_shrink_asks_for_the_baseline_to_follow_and_update_only_lowers_it(checker, repo, capsys):
    add(repo, "src/big.py", lines(700))
    add(repo, "src/split.py", lines(650))
    checker.main(["--rebaseline"])
    add(repo, "src/big.py", lines(680))
    add(repo, "src/split.py", lines(100))
    add(repo, "src/new.py", lines(601))

    assert checker.main([]) == 1
    err = capsys.readouterr().err
    assert "src/big.py: down from 700 to 680 lines, so lower its baseline entry" in err
    assert "src/split.py: under the limit or gone, so remove its baseline entry" in err

    # --update tightens what is recorded and still refuses the new giant: it never adds an entry.
    assert checker.main(["--update"]) == 1
    assert json.loads((repo / "ci" / "size_baseline.json").read_text())["files"] == {"src/big.py": 680}


def test_generated_test_and_copy_files_are_not_checked(checker):
    for path in (
        "frontends/ui/src/shared/cards/generated.ts",
        "frontends/ui/src/adapters/api/wire-v2.generated.ts",
        "frontends/ui/src/features/chat/ChatArea.spec.tsx",
        "tests/aiq_agent/test_runner.py",
        "frontends/ui/src/app/dev/_fixtures/stream-frames.ts",
        "frontends/ui/src/i18n/dictionaries/de/chat.ts",
        "frontends/ui/src/lib/db/migrations/0001.ts",
        "README.md",
    ):
        assert not checker.is_checked(path), path
    for path in ("frontends/ui/src/features/layout/components/InputArea.tsx", "src/aiq_agent/common/x.py"):
        assert checker.is_checked(path), path


def test_the_real_tree_holds_at_its_baseline(checker, monkeypatch, capsys):
    monkeypatch.chdir(ROOT)

    assert checker.main([]) == 0, capsys.readouterr().err
