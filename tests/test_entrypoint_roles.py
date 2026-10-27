"""``deploy/entrypoint.py`` starts the four roles of the image and refuses every other name (ADR-0082).

``GRID_ROLE`` has no default and ``web`` is not a value: a container that does
not say which job it does stops at once, with the names it may take, instead of
serving a route set nobody sized it for. Run as a subprocess because ``main()``
replaces the process (``execvp``) for the roles that start one.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "deploy" / "entrypoint.py"


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    clean = {k: v for k, v in os.environ.items() if k != "GRID_ROLE"}
    return subprocess.run(
        [sys.executable, str(ENTRYPOINT)], env={**clean, **env}, capture_output=True, text=True, timeout=60, check=False
    )


@pytest.mark.parametrize("env", [{}, {"GRID_ROLE": ""}, {"GRID_ROLE": "web"}, {"GRID_ROLE": "researcher"}])
def test_a_missing_or_unknown_role_exits_non_zero_and_names_the_roles(env):
    result = _run(env)

    assert result.returncode != 0
    assert "GRID_ROLE" in result.stderr
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
    spec = importlib.util.spec_from_file_location("grid_entrypoint", ENTRYPOINT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_an_old_name_is_adopted_under_the_house_prefix_and_warns(capsys):
    environ = {"AIQ_QDRANT_URL": "http://qdrant:6333", "AIQ_SUMMARY_DB": "old", "GRID_SUMMARY_DB": "new"}

    adopted = _entrypoint_module().adopt_legacy_names(environ)

    assert adopted == ["GRID_QDRANT_URL"]
    assert environ["GRID_QDRANT_URL"] == "http://qdrant:6333"
    assert environ["GRID_SUMMARY_DB"] == "new"
    warnings = capsys.readouterr().err
    assert "AIQ_QDRANT_URL is deprecated; rename it to GRID_QDRANT_URL" in warnings
    assert "AIQ_SUMMARY_DB is deprecated and ignored, GRID_SUMMARY_DB is set" in warnings


def test_a_process_the_entrypoint_starts_reads_the_new_name():
    result = subprocess.run(
        [sys.executable, str(ENTRYPOINT), sys.executable, "-c", "import os; print(os.environ['GRID_VERBOSE'])"],
        env={**{k: v for k, v in os.environ.items() if not k.startswith(("AIQ_", "GRID_"))}, "AIQ_VERBOSE": "1"},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.stdout.strip() == "1"
    assert "AIQ_VERBOSE is deprecated" in result.stderr
