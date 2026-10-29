"""The brand-name ratchet refuses a new brand in a name, and makes the baseline follow every cleanup.

`scripts/check_brand_names.py` keeps `aiq`, `archos`, `grid` and `piloti` out of new code
and infrastructure identifiers, with `ci/brand_names_baseline.json` recording
the hits when the check arrived. These run it on a scratch repository, so the
real tree's baseline is not what they depend on.
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
    spec = importlib.util.spec_from_file_location("check_brand_names", ROOT / "scripts" / "check_brand_names.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def repo(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "ci").mkdir()
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _add(repo: Path, path: str, text: str) -> None:
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", path], cwd=repo, check=True)


@pytest.mark.parametrize(
    ("token", "hits"),
    [
        ("piloti_wakes", ["piloti"]),
        ("pilotiWakes", ["piloti"]),
        ("GRID_MAX_ACTIVE_JOBS_PER_ORG", ["GRID"]),
        ("x-grid-request-context", ["grid"]),
        ("GridCard", ["Grid"]),
        ("aiq_agent", ["aiq"]),
        ("AIQAPIWorker", ["AIQAPI"]),
        ("piloti-ask", ["piloti"]),
        ("ARCHOS_MAX_JOBS", ["ARCHOS"]),
        ("archosWakes", ["archos"]),
    ],
)
def test_a_brand_word_in_a_name_is_a_hit(checker, token, hits):
    assert checker.brand_words(token) == hits


@pytest.mark.parametrize(
    "token",
    ["Piloti", "Grid", "grid", "grid-cols-2", "inline-grid", "gridTemplateColumns", "FileGrid", "document_grid",
     "subgrid", "gridSize", "gridModeEnabled", "app.piloti.at"],
)  # fmt: skip
def test_prose_css_the_layout_noun_and_host_names_are_not(checker, token):
    assert checker.brand_words(token) == []


def test_urls_and_the_repository_name_are_not_counted(checker):
    text = "see https://github.com/GRID-check/grid-oib-agent/issues and grid-check/grid-oib-agent, not GRID_ROLE"
    assert checker.count_text(text) == 1


def test_the_archos_repository_and_org_are_not_counted_but_an_image_name_under_them_is(checker):
    text = "github.com/archos-at/archos ghcr.io/archos-at/archos:latest archos-at/archos"
    assert checker.count_text(text) == 0
    assert checker.count_text("ghcr.io/archos-at/grid-oib-backend:latest") == 1
    assert checker.count_text("ARCHOS_MAX_JOBS") == 1


def test_a_new_hit_fails_and_the_baseline_only_moves_down(checker, repo, capsys):
    _add(repo, "src/jobs.py", "LIMIT = os.environ['GRID_MAX_JOBS']\n")
    assert checker.main(["--rebaseline"]) == 0
    assert json.loads((repo / "ci" / "brand_names_baseline.json").read_text()) == {"src/jobs.py": 1}

    _add(repo, "src/jobs.py", "LIMIT = os.environ['GRID_MAX_JOBS']\nX = 'piloti_wakes'\n")
    assert checker.main([]) == 1
    assert "src/jobs.py: 2 brand hit(s), baseline 1" in capsys.readouterr().err

    _add(repo, "src/jobs.py", "LIMIT = os.environ['MAX_JOBS']\n")
    assert checker.main([]) == 1
    assert checker.main(["--update"]) == 0
    assert json.loads((repo / "ci" / "brand_names_baseline.json").read_text()) == {}


def test_a_new_directory_is_a_hit_and_a_new_file_in_an_old_one_is_not(checker, repo):
    _add(repo, "packages/agent/src/agent/old.py", "x = 1\n")
    assert checker.main(["--rebaseline"]) == 0
    _add(repo, "packages/agent/src/agent/new.py", "y = 2\n")
    assert checker.main([]) == 0
    _add(repo, "src/piloti_tools/new.py", "y = 2\n")
    assert checker.main([]) == 1


def test_history_and_copy_are_not_checked(checker, repo):
    _add(repo, "docs/adr/0001-piloti.md", "piloti_wakes\n")
    _add(repo, "releasenotes/notes/piloti-x.yaml", "piloti_wakes\n")
    _add(repo, "apps/workspace/i18n/dictionaries/en/chat.ts", "pilotiWakes: 'Piloti'\n")
    _add(repo, "apps/workspace/migrations/0001_piloti.sql", "CREATE TABLE piloti_wakes ();\n")
    assert checker.main([]) == 0


def test_the_tier_names_pending_the_deploy_rename_are_not_counted(checker):
    assert checker.count_text("http://aiq-agent:8000 and aiq-api") == 0
    assert checker.count_text("from aiq_agent.common.cards import Card") == 1
    assert checker.count_text("from agent.agents.piloti import run") == 1


def test_a_file_split_inside_a_package_directory_is_not_a_new_hit(checker, repo):
    _add(repo, "packages/agent/src/agent/big.py", "from agent.common import x\n")
    assert checker.main(["--rebaseline"]) == 0
    _add(repo, "packages/agent/src/agent/split/part.py", "from agent.common import x\n")
    assert checker.main([]) == 0
