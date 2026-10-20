"""A pull request runs only the Python tests its change reaches, unless testmon cannot see the change.

`ci/py_selection.py` is the one place that decides. A wrong "select" is a
change that merges with the tests it broke never run, so every rule that forces
the full suite is pinned here.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TESTS = {
    "tests/aiq_agent/test_prompt.py": "PROMPT = 'agents/piloti/prompts/piloti_static.md'",
    "tests/test_config.py": "load('configs/config_oib_openrouter.yml')",
    "sources/knowledge_layer/tests/test_schema.py": "read('schemas.json')",
}


@pytest.fixture(scope="module")
def mod():
    sys.path.insert(0, str(ROOT / "ci"))
    spec = importlib.util.spec_from_file_location("py_selection", ROOT / "ci" / "py_selection.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_a_change_to_tested_python_selects(mod):
    mode, extra, _ = mod.decide(["src/aiq_agent/common/llm_factory.py", "tests/test_x.py"], TESTS, recorded=True)

    assert (mode, extra) == ("select", [])


def test_without_a_recorded_database_everything_runs(mod):
    assert mod.decide(["src/aiq_agent/a.py"], TESTS, recorded=False)[0] == "full"


@pytest.mark.parametrize(
    "path",
    [
        "conftest.py",
        "tests/conftest.py",
        "sources/knowledge_layer/tests/conftest.py",
        "tests/fixtures/oib/sample.json",
        "uv.lock",
        "pyproject.toml",
        "frontends/aiq_api/pyproject.toml",
        "Taskfile.yml",
        "taskfiles/backend.yml",
        ".github/workflows/ci.yml",
        ".github/actions/setup-python-env/action.yml",
        "ci/py_selection.py",
        "scripts/rls-test-db.sh",
    ],
)
def test_what_changes_how_every_test_runs_forces_the_full_suite(mod, path):
    assert mod.decide([path], TESTS, recorded=True)[0] == "full"


@pytest.mark.parametrize(
    "path", ["scripts/release_notes.py", "frontends/benchmarks/x/run.py", "deploy/migration/chroma_export.py"]
)
def test_python_outside_the_tested_packages_forces_the_full_suite(mod, path):
    # Tests load these by path or in a subprocess, where testmon records nothing.
    assert mod.decide([path], TESTS, recorded=True)[0] == "full"


def test_a_non_python_input_adds_every_test_that_names_it(mod):
    mode, extra, _ = mod.decide(["configs/config_oib_openrouter.yml"], TESTS, recorded=True)

    assert (mode, extra) == ("select", ["tests/test_config.py"])


def test_a_file_named_only_by_its_basename_still_counts(mod):
    changed = ["sources/knowledge_layer/src/qdrant/schemas.json"]

    assert mod.decide(changed, TESTS, recorded=True)[1] == ["sources/knowledge_layer/tests/test_schema.py"]


def test_package_data_no_test_names_forces_the_full_suite(mod):
    assert mod.decide(["src/aiq_agent/agents/piloti/prompts/unnamed.md"], TESTS, recorded=True)[0] == "full"


def test_a_lookup_failure_answers_no_database(mod):
    def broken(_path):
        raise OSError("network")

    assert mod.recorded_database(broken) is False
    assert mod.recorded_database(lambda _path: {"actions_caches": []}) is False
    assert mod.recorded_database(lambda _path: {"actions_caches": [{"key": "testmon-x"}]}) is True
