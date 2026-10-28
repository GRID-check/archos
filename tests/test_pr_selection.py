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
    "packages/agent/tests/test_prompt.py": "PROMPT = 'agents/piloti/prompts/piloti_static.md'",
    "tests/test_grounding.py": "FIXTURE = ROOT / 'tests/fixtures/citation_pipeline/grounding_block.txt'",
    "tests/test_decisions_eval.py": "CASES = sorted((ROOT / 'tests' / 'fixtures' / 'decisions').rglob('*.json'))",
    "tests/test_visual_eval.py": "SHAPES = list((ROOT / 'tests' / 'fixtures' / 'visual').iterdir())",
    "tests/test_project_yaml.py": "load('project.yaml')",
    # A helper, not a test file: its docstring cites a document, and it reads a fixture.
    "packages/agent/tests/judge_stub.py": (
        '"""Imported by path, as ``packages/AGENTS.md`` asks."""\n'
        "STORED = ROOT / 'fixtures' / 'answers' / 'stored.json'"
    ),
    "tests/test_config.py": "load('configs/config_oib_openrouter.yml')",
    "packages/knowledge-layer/tests/test_schema.py": "read('schemas.json')",
}
READERS = {"bff/authz/authz-coverage.spec.ts": None}
#: One reader that declares its inputs, one that does not.
DECLARED = {
    "app/api/authz-coverage.spec.ts": ("apps/workspace/app/api/**",),
    "bff/skills/legacy-names.spec.ts": ("packages/agent/src/agent/skills/builtin.py",),
    "tests/english-names.spec.ts": None,
}


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
    mode, extra, _ = mod.decide_python(
        ["packages/agent/src/agent/common/llm_factory.py", "tests/test_x.py"], TESTS, recorded=True
    )

    assert (mode, extra) == ("select", [])


def test_without_a_recorded_database_everything_runs(mod):
    assert mod.decide_python(["packages/agent/src/agent/a.py"], TESTS, recorded=False)[0] == "full"


@pytest.mark.parametrize(
    "path",
    [
        "conftest.py",
        "tests/conftest.py",
        "packages/knowledge-layer/tests/conftest.py",
        "tests/fixtures/drafting_turns.py",
        "uv.lock",
        "pyproject.toml",
        "apps/backend/pyproject.toml",
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
    changed = ["packages/knowledge-layer/src/qdrant/schemas.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[1] == ["packages/knowledge-layer/tests/test_schema.py"]


def test_package_data_no_test_names_forces_the_full_suite(mod):
    assert (
        mod.decide_python(["packages/agent/src/agent/agents/piloti/prompts/unnamed.md"], TESTS, recorded=True)[0]
        == "full"
    )


def test_a_fixture_selects_the_tests_that_read_it(mod):
    changed = ["tests/fixtures/citation_pipeline/grounding_block.txt"]

    assert mod.decide_python(changed, TESTS, recorded=True)[:2] == ("select", ["tests/test_grounding.py"])


def test_a_fixture_read_through_its_directory_selects_that_test(mod):
    changed = ["tests/fixtures/decisions/holdout/case_7.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[:2] == ("select", ["tests/test_decisions_eval.py"])


def test_a_fixture_selects_the_directory_reader_even_when_its_name_matches_another_test(mod):
    # `project.yaml` is a common name; the test that reads the whole `visual`
    # directory must still run.
    selected = mod.decide_python(["tests/fixtures/visual/project.yaml"], TESTS, recorded=True)[1]

    assert {"tests/test_visual_eval.py", "tests/test_project_yaml.py"} <= set(selected)


def test_a_file_only_a_helper_reads_forces_the_full_suite(mod):
    # Nothing says which tests load the helper.
    changed = ["tests/fixtures/answers/stored.json"]

    assert mod.decide_python(changed, TESTS, recorded=True)[0] == "full"


def test_a_file_a_support_package_reads_selects_the_tests_that_import_it(mod):
    # ADR-0145 row 5: a `<package>_testing` module has one importable name, so
    # its importers are known, and a full run is not needed.
    tests = {
        "packages/agent/tests/testing/agent_testing/exposure.py": "EXPOSURE = ROOT / 'tests/fixtures/exposure.json'",
        "packages/agent/tests/tools/test_exposure_config.py": "from agent_testing.exposure import EXPOSURE",
        "packages/agent/tests/test_framing.py": "from agent_testing import exposure, langfuse",
        "packages/agent/tests/test_other.py": "from agent_testing.langfuse import trace",
    }

    mode, selected, _ = mod.decide_python(["tests/fixtures/exposure.json"], tests, recorded=True)

    assert (mode, selected) == (
        "select",
        ["packages/agent/tests/test_framing.py", "packages/agent/tests/tools/test_exposure_config.py"],
    )


def test_a_support_package_no_test_imports_still_forces_the_full_suite(mod):
    tests = {"packages/knowledge-layer/testing/knowledge_layer_testing/pdfs.py": "PDF = 'fixtures/scan.pdf'"}

    assert mod.decide_python(["tests/fixtures/scan.pdf"], tests, recorded=True)[0] == "full"


def test_python_in_a_support_package_is_python_testmon_sees(mod):
    changed = ["packages/knowledge-layer/testing/knowledge_layer_testing/qdrant.py"]

    assert mod.decide_python(changed, TESTS, recorded=True)[0] == "select"


def test_a_document_a_helper_only_cites_selects_nothing_extra(mod):
    assert mod.decide_python(["packages/AGENTS.md"], TESTS, recorded=True)[:2] == ("select", [])


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
    mode, files, _ = mod.decide_ui(["apps/workspace/ui/features/chat/x.tsx"], READERS)

    assert mode == "select"
    assert files == ["bff/authz/authz-coverage.spec.ts", "ui/features/chat/x.tsx"]


@pytest.mark.parametrize(
    "path",
    [
        "apps/workspace/package.json",
        "apps/workspace/bun.lock",
        "apps/workspace/tsconfig.json",
        "apps/workspace/vitest.config.ts",
        "apps/workspace/config/vitest/vitest.setup.ts",
        "apps/workspace/tests/mocks/handlers.ts",
        "apps/workspace/ui/features/documents/types.ts",
        "taskfiles/workspace.yml",
        ".github/actions/setup-bun/action.yml",
        "ci/pr_selection.py",
    ],
)
def test_what_every_spec_loads_forces_the_full_ui_suite(mod, path):
    assert mod.decide_ui([path], READERS)[0] == "full"


def test_a_config_the_bff_reads_still_runs_the_disk_readers(mod):
    mode, files, _ = mod.decide_ui(["configs/config_oib_openrouter.yml"], READERS)

    assert (mode, files) == ("select", list(READERS))


def test_a_backend_fixture_runs_the_ui_specs_that_read_it(mod):
    # `skills/resolve-payload-contract.spec.ts` reads one from disk.
    changed = ["tests/fixtures/skills_resolve/resolve_payload.json"]

    assert mod.decide_ui(changed, READERS)[:2] == ("select", list(READERS))


def test_a_change_no_ui_spec_reads_runs_no_ui_spec(mod):
    assert mod.decide_ui(["packages/agent/src/agent/common/llm_factory.py"], READERS)[0] == "none"


def test_the_disk_readers_are_found_by_what_they_do(mod):
    readers = mod._disk_readers()

    assert readers, "no UI spec reads from disk any more? then the rule is stale"
    assert all(not path.startswith("node_modules/") for path in readers)
    for path in list(readers)[:20]:
        assert mod.READS_DISK.search((ROOT / mod.UI / path).read_text(encoding="utf-8"))
    # Top-level specs too: fnmatch's `**/` needs a directory, vitest's does not.
    assert "tests/english-names.spec.ts" in readers


def test_a_declaring_reader_runs_only_when_its_inputs_change(mod):
    mode, files, _ = mod.decide_ui(["apps/workspace/ui/features/chat/x.tsx"], DECLARED)

    assert mode == "select"
    assert files == ["tests/english-names.spec.ts", "ui/features/chat/x.tsx"]

    _, files, _ = mod.decide_ui(["apps/workspace/app/api/projects/route.ts"], DECLARED)
    assert "app/api/authz-coverage.spec.ts" in files


def test_a_declared_input_outside_the_ui_selects_its_reader(mod):
    """Before declarations, a change to a Python file a UI spec reads ran no UI spec at all."""
    mode, files, _ = mod.decide_ui(["packages/agent/src/agent/skills/builtin.py"], DECLARED)

    assert mode == "select"
    assert files == ["bff/skills/legacy-names.spec.ts", "tests/english-names.spec.ts"]


def test_the_declaration_is_read_relative_to_the_ui(mod):
    source = "// @disk-inputs: app/api/**, ../../contracts/wire/v2/**\nimport x from 'y'\n"

    assert mod.declared_inputs(source) == ("apps/workspace/app/api/**", "contracts/wire/v2/**")
    assert mod.declared_inputs("import x from 'y'\n") is None
    # A Next route's brackets are literal, not an fnmatch character class.
    (route,) = mod.declared_inputs("// @disk-inputs: app/api/v1/[...path]/route.ts\n")
    assert mod._matches("apps/workspace/app/api/v1/[...path]/route.ts", [route])
    assert not mod._matches("apps/workspace/app/api/v1/p/route.ts", [route])
    # What a child process reads, no recorder sees: such a spec never counts as declared.
    spawning = "// @disk-inputs: app/**\nimport { execFileSync } from 'node:child_process'\n"
    assert mod.declared_inputs(spawning) is None


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
    whole = (
        ["packages/agent/src/agent/a.py", "packages/agent/src/agent/b.py", "packages/agent/src/agent/c.py"],
        "the base",
        "base",
    )
    since_green = (
        ["packages/agent/src/agent/a.py", "pyproject.toml"],
        "the last green run",
        "green",
    )  # develop moved

    def full_suites(paths):
        return mod.decide_python(paths, TESTS, recorded=True)[0] == "full"

    assert mod.cheaper([whole, since_green], full_suites) == whole


def test_with_equal_cost_the_smaller_reference_wins(mod):
    whole = (["packages/agent/src/agent/a.py", "packages/agent/src/agent/b.py"], "the base", "base")
    since_green = (
        ["packages/agent/src/agent/b.py"],
        "the last green run",
        "green",
    )  # a push that answered a review

    assert mod.cheaper([whole, since_green], lambda _paths: 0) == since_green
