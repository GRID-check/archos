"""``apps/backend/entrypoint.py`` starts the four roles of the image and refuses every other name (ADR-0082).

``PROCESS_ROLE`` has no default and ``web`` is not a value: a container that does
not say which job it does stops at once, with the names it may take, instead of
serving a route set nobody sized it for. Run as a subprocess because ``main()``
replaces the process (``execvp``) for the roles that start one.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "apps" / "backend" / "entrypoint.py"


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    clean = {k: v for k, v in os.environ.items() if k not in ("PROCESS_ROLE", "GRID_ROLE", "AIQ_ROLE")}
    return subprocess.run(
        [sys.executable, str(ENTRYPOINT)], env={**clean, **env}, capture_output=True, text=True, timeout=60, check=False
    )


@pytest.mark.parametrize("env", [{}, {"PROCESS_ROLE": ""}, {"PROCESS_ROLE": "web"}, {"GRID_ROLE": "researcher"}])
def test_a_missing_or_unknown_role_exits_non_zero_and_names_the_roles(env):
    result = _run(env)

    assert result.returncode != 0
    assert "PROCESS_ROLE" in result.stderr
    for role in ("chat", "api", "worker", "ingest-worker"):
        assert role in result.stderr


def test_the_roles_the_entrypoint_accepts_are_the_four_of_the_image():
    tree = ast.parse(ENTRYPOINT.read_text())
    roles = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "ROLES" for t in node.targets)
    )

    assert roles == ("chat", "api", "worker", "ingest-worker")


def _entrypoint_module():
    spec = importlib.util.spec_from_file_location("image_entrypoint", ENTRYPOINT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_an_old_name_is_adopted_without_its_prefix_and_warns(capsys):
    environ = {
        "GRID_QDRANT_URL": "http://qdrant:6333",
        "AIQ_SUMMARY_DB": "oldest",
        "GRID_SUMMARY_DB": "old",
        "AIQ_LOCK_DB_URL": "aiq",
        "CHECKPOINT_DB": "new",
        "GRID_CHECKPOINT_DB": "old",
    }

    adopted = _entrypoint_module().adopt_legacy_names(environ)

    assert adopted == ["QDRANT_URL", "SUMMARY_DB", "LOCK_DB_URL"]
    assert environ["QDRANT_URL"] == "http://qdrant:6333"
    assert environ["SUMMARY_DB"] == "old"
    assert environ["LOCK_DB_URL"] == "aiq"
    assert environ["CHECKPOINT_DB"] == "new"
    warnings = capsys.readouterr().err
    assert "GRID_QDRANT_URL is deprecated; rename it to QDRANT_URL" in warnings
    assert "AIQ_SUMMARY_DB is deprecated and ignored, SUMMARY_DB is set" in warnings
    assert "GRID_CHECKPOINT_DB is deprecated and ignored, CHECKPOINT_DB is set" in warnings


@pytest.mark.parametrize(
    ("legacy", "current"),
    [
        ("GRID_MAX_ACTIVE_JOBS_PER_ORG", "MAX_ACTIVE_JOBS_PER_ORG"),
        ("AIQ_VLM_MODEL", "VLM_MODEL"),
        ("GRID_ROLE", "PROCESS_ROLE"),
        ("AIQ_VERBOSE", "AGENT_VERBOSE"),
        ("GRID_LANGFUSE_TRACE_RETENTION_DAYS", "TRACE_RETENTION_DAYS"),
        ("GRID_PILOTI_ASK_MAX_SECONDS", "AGENT_ASK_MAX_SECONDS"),
        ("GRID_", None),
        ("PATH", None),
    ],
)
def test_a_colliding_bare_name_takes_a_name_of_its_own(legacy, current):
    assert _entrypoint_module().current_name(legacy) == current


def test_the_ui_image_adopts_the_same_names():
    """``legacy-env-names.cjs`` is the same table for the UI image's Node processes."""
    module = _entrypoint_module()
    script = (
        "const m = require(process.argv[1]);"
        "process.stdout.write(JSON.stringify({prefixes: m.LEGACY_PREFIXES, renamed: m.RENAMED}))"
    )
    shim = ENTRYPOINT.parents[2] / "apps" / "workspace" / "scripts" / "legacy-env-names.cjs"
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    result = subprocess.run([node, "-e", script, str(shim)], capture_output=True, text=True, timeout=30, check=True)

    assert json.loads(result.stdout) == {"prefixes": list(module.LEGACY_PREFIXES), "renamed": module.RENAMED}


def test_a_process_the_entrypoint_starts_reads_the_new_name():
    result = subprocess.run(
        [sys.executable, str(ENTRYPOINT), sys.executable, "-c", "import os; print(os.environ['AGENT_VERBOSE'])"],
        env={
            **{k: v for k, v in os.environ.items() if not k.startswith(("AIQ_", "GRID_", "AGENT_VERBOSE"))},
            "GRID_VERBOSE": "1",
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.stdout.strip() == "1"
    assert "GRID_VERBOSE is deprecated; rename it to AGENT_VERBOSE" in result.stderr
