"""The env reference check (scripts/check_env_docs.py): a variable a queue worker reads has a row."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_env_docs.py"

DOC = "| Variable | Required | Default | Description |\n|---|---|---|---|\n| `GRID_KNOWN` | No | `3` | Known. |\n"


@pytest.fixture
def checker():
    spec = importlib.util.spec_from_file_location("check_env_docs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("path", "source"),
    [
        ("w.py", 'os.environ.get("GRID_NEW", "1")'),
        ("w.py", 'os.environ["GRID_NEW"]'),
        ("w.py", 'lease_policy.int_env("GRID_NEW", 3, floor=1)'),
        ("w.py", '_flag("GRID_NEW", True)'),
        ("w.py", '_CAP_ENV = "GRID_NEW"'),
        ("w.js", "toInt(env.GRID_NEW, 60)"),
        ("w.js", "process.env.GRID_NEW || '60000'"),
        ("w.ts", "env['GRID_NEW']"),
    ],
)
def test_a_read_without_a_row_is_reported_with_its_file(checker, path, source):
    assert checker.undocumented({path: source}, DOC) == {"GRID_NEW": [path]}


def test_a_documented_name_and_a_constant_that_is_no_env_var_pass(checker):
    sources = {
        "w.py": 'int_env("GRID_KNOWN", 3)\nPOISON_CLAIM_MARKER = "poison"\nts = "DATETIME DEFAULT CURRENT_TIMESTAMP"',
        "w.js": "workerPrefix: `bff-jobs-${env.HOSTNAME}`",
    }

    assert checker.undocumented(sources, DOC) == {}


def test_the_queue_workers_read_nothing_the_reference_leaves_out(checker, monkeypatch):
    monkeypatch.chdir(ROOT)

    assert checker.main() == 0
