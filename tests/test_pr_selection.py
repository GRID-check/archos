"""A pull request runs only the tests its change reaches, unless the selection cannot see the change.

`ci/pr_selection.py` is the one place that decides, for the Python suites and
the UI suite. A wrong "select" is a change that merges with the tests it broke
never run, so every rule that forces the full suite is pinned here.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TESTS = {
    "tests/aiq_agent/test_prompt.py": "PROMPT = 'agents/piloti/prompts/piloti_static.md'",
    "tests/test_grounding.py": "FIXTURE = ROOT / 'tests/fixtures/citation_pipeline/grounding_block.txt'",
    "tests/test_decisions_eval.py": "CASES = sorted((ROOT / 'tests' / 'fixtures' / 'decisions').rglob('*.json'))",
    "tests/test_config.py": "load('configs/config_oib_openrouter.yml')",
    "sources/knowledge_layer/tests/test_schema.py": "read('schemas.json')",
}
READERS = ["src/lib/authz/authz-coverage.spec.ts"]


@pytest.fixture(scope="module")
def mod():
    sys.path.insert(0, str(ROOT / "ci"))
    spec = importlib.util.spec_from_file_location("pr_selection", ROOT / "ci" / "pr_selection.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# --- Python ------------------------------------------------------------------------


def test_a_change_to_tested_python_selects(mod):
    mode, extra, _ = mod.decide_python(["src/aiq_agent/common/llm_factory.py", "tests/test_x.py"], TESTS, recorded=True)

    assert (mode, extra) == ("select", [])


def test_without_a_recorded_database_everything_runs(mod):
    assert mod.decide_python(["src/aiq_agent/a.py"], TESTS, recorded=False)[0] == "full"


@pytest.mark.parametrize(
    "path",
    [
        "conftest.py",
        "tests/conftest.py",
        "sources/knowledge_layer/tests/conftest.py",
        "tests/fixtures/drafting_turns.py",
        "uv.lock",
        "pyproject.toml",
        "frontends/aiq_api/pyproject.toml",
        "Taskfile.yml",
        "taskfiles/backend.yml",
        ".github/workflows/ci.yml",
        ".github/actions/setup-python-env/action.yml",
        "ci/pr_selection.py",
        "scripts/rls-test-db.sh",
    ],
)
def test_what_changes_how_every_python_test_runs_forces_the_full_suite(mod, path):
    assert mod.decide_python([path], TESTS, recorded=True)[0] == "full"


@pytest.mark.parametrize(
    "path",
    ["scripts/release_notes.py", "packages/ifc-spatial-py/x.py", "deploy/migration/chroma_export.py"],
)
def test_python_outside_the_tested_packages_forces_the_full_suite(mod, path):
    # Tests load these by path or in a subprocess, where testmon records nothing.
    assert mod.decide_python([path], TESTS, recorded=True)[0] == "full"


def test_an_eval_harness_is_python_testmon_sees(mod):
    # evals/ runs in the core suite with its harnesses installed editable.
    changed = ["evals/oib-retrieval/src/oib_retrieval/metrics.py", "evals/oib-retrieval/tests/test_x.py"]

    assert mod.decide_python(changed, TESTS, recorded=True)[0] == "select"


def test_a_non_python_input_adds_every_test_that_names_it(mod):
    mode, extra, _ = mod.decide_python(["configs/config_oib_openrouter.yml"], TESTS, recorded=True)

    assert (mode, extra) == ("select", ["tests/test_config.py"])


def test_a_file_named_only_by_its_basename_still_counts(mod):
    changed = ["sources/knowledge_layer/src/qdrant/schemas.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[1] == ["sources/knowledge_layer/tests/test_schema.py"]


def test_package_data_no_test_names_forces_the_full_suite(mod):
    assert mod.decide_python(["src/aiq_agent/agents/piloti/prompts/unnamed.md"], TESTS, recorded=True)[0] == "full"


def test_a_fixture_selects_the_tests_that_read_it(mod):
    changed = ["tests/fixtures/citation_pipeline/grounding_block.txt"]

    assert mod.decide_python(changed, TESTS, recorded=True)[:2] == ("select", ["tests/test_grounding.py"])


def test_a_fixture_read_through_its_directory_selects_that_test(mod):
    changed = ["tests/fixtures/decisions/holdout/case_7.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[:2] == ("select", ["tests/test_decisions_eval.py"])


def test_a_fixture_no_test_names_forces_the_full_suite(mod):
    assert mod.decide_python(["tests/fixtures/orphan/data.json"], TESTS, recorded=True)[0] == "full"


def test_an_eval_fixture_no_test_names_forces_the_full_suite(mod):
    # The harness reads its recordings through its own code, not by a name a test spells out.
    changed = ["evals/oib-retrieval/fixtures/vector_channel_recorded.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[0] == "full"


def test_a_lookup_failure_answers_no_database(mod):
    def broken(_path):
        raise OSError("network")

    assert mod.recorded_database(broken) is False
    assert mod.recorded_database(lambda _path: {"actions_caches": []}) is False
    assert mod.recorded_database(lambda _path: {"actions_caches": [{"key": "testmon-x"}]}) is True


# --- UI ----------------------------------------------------------------------------


def test_a_ui_change_selects_its_files_and_every_disk_reader(mod):
    mode, files, _ = mod.decide_ui(["frontends/ui/src/features/chat/x.tsx"], READERS)

    assert mode == "select"
    assert files == ["src/features/chat/x.tsx", "src/lib/authz/authz-coverage.spec.ts"]


@pytest.mark.parametrize(
    "path",
    [
        "frontends/ui/package.json",
        "frontends/ui/bun.lock",
        "frontends/ui/tsconfig.json",
        "frontends/ui/vitest.config.ts",
        "frontends/ui/config/vitest/vitest.setup.ts",
        "frontends/ui/src/mocks/handlers.ts",
        "frontends/ui/src/features/documents/types.ts",
        "taskfiles/frontend.yml",
        ".github/actions/setup-bun/action.yml",
        "ci/pr_selection.py",
    ],
)
def test_what_every_spec_loads_forces_the_full_ui_suite(mod, path):
    assert mod.decide_ui([path], READERS)[0] == "full"


def test_a_config_the_bff_reads_still_runs_the_disk_readers(mod):
    mode, files, _ = mod.decide_ui(["configs/config_oib_openrouter.yml"], READERS)

    assert (mode, files) == ("select", READERS)


def test_a_change_no_ui_spec_reads_runs_no_ui_spec(mod):
    assert mod.decide_ui(["src/aiq_agent/common/llm_factory.py"], READERS)[0] == "none"


def test_the_disk_readers_are_found_by_what_they_do(mod):
    readers = mod._disk_readers()

    assert readers, "no UI spec reads from disk any more? then the rule is stale"
    assert all(not path.startswith("node_modules/") for path in readers)
    for path in readers[:20]:
        assert mod.READS_DISK.search((ROOT / mod.UI / path).read_text(encoding="utf-8"))


# --- The reference ------------------------------------------------------------------


def test_the_newest_green_run_on_an_ancestor_is_the_reference(mod):
    runs = {
        "workflow_runs": [
            {"head_sha": "c" * 40, "created_at": "2026-10-20T09:00:00Z"},  # not an ancestor (force-pushed away)
            {"head_sha": "b" * 40, "created_at": "2026-10-20T08:00:00Z"},
            {"head_sha": "a" * 40, "created_at": "2026-10-20T07:00:00Z"},
        ]
    }

    found = mod.previous_green(lambda _path: runs, "o/r", "branch", "h" * 40, lambda sha: sha != "c" * 40)

    assert found["head_sha"] == "b" * 40


def test_no_green_run_means_the_whole_pull_request(mod):
    assert mod.previous_green(lambda _path: {"workflow_runs": []}, "o/r", "b", "h" * 40, lambda _sha: True) is None


def test_the_reference_that_forces_fewer_full_suites_wins(mod):
    whole = (["src/aiq_agent/a.py", "src/aiq_agent/b.py", "src/aiq_agent/c.py"], "the base")
    since_green = (["src/aiq_agent/a.py", "pyproject.toml"], "the last green run")  # develop moved

    def full_suites(paths):
        return mod.decide_python(paths, TESTS, recorded=True)[0] == "full"

    assert mod.cheaper([whole, since_green], full_suites) == whole


def test_with_equal_cost_the_smaller_reference_wins(mod):
    whole = (["src/aiq_agent/a.py", "src/aiq_agent/b.py"], "the base")
    since_green = (["src/aiq_agent/b.py"], "the last green run")  # a push that answered a review

    assert mod.cheaper([whole, since_green], lambda _paths: 0) == since_green
