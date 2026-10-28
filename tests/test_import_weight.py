"""What an import loads stays what it needs.

Importing ``agent.common.turn_status`` executes ``agent/__init__.py`` and
``agent/common/__init__.py`` first, and the root conftest loads before every
test. When those imported their whole package, a one-line harness test spent
4.6 s of its 5.7 s loading LangChain, NAT, LangGraph's checkpointers and the
Qdrant client, and every test importing one ``agent.common`` module loaded
all sixty (docs/audit/blast-radius-2026-10.md). Each import check runs in a
fresh interpreter, because this one has long since imported everything.
"""

from __future__ import annotations

import importlib
import json
import os
import pkgutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# Packages whose ``__init__`` was an eager barrel and now loads nothing of its
# own but ``agent.lazy_exports``, nothing heavy, and re-exports no name that
# is also a submodule's: the import system binds a submodule's name to the
# module whenever it is imported, so such an export reads the function or the
# module depending on import order.
LAZY_PACKAGES = [
    "agent",
    "agent.agents",
    "agent.agents.piloti",
    "agent.agents.deep_researcher",
    "agent.common",
    "knowledge_layer",
]

# What a package ``__init__`` or a conftest every test loads may not load: each
# is a second or more, and most tests never touch it. A fixture that needs one
# imports it in its body.
HEAVY = ["langchain_core", "langgraph", "nat", "qdrant_client", "llama_index", "openai", "agent.common"]


def _loaded_by(statement: str) -> list[str]:
    """The modules that running ``statement`` adds to a fresh interpreter's ``sys.modules``."""
    script = (
        "import json, sys\n"
        "before = set(sys.modules)\n"
        f"{statement}\n"
        "print(json.dumps(sorted(set(sys.modules) - before)))\n"
    )
    # This interpreter's path, so the child resolves what the suite resolves:
    # pytest's `pythonpath` (the test-support packages) never reaches a child.
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(entry for entry in sys.path if entry)}
    done = subprocess.run(
        [sys.executable, "-c", script], cwd=ROOT, env=env, capture_output=True, text=True, check=True, timeout=120
    )
    return json.loads(done.stdout.strip().splitlines()[-1])


def _heavy(loaded: list[str]) -> list[str]:
    return sorted({top for top in HEAVY for name in loaded if name == top or name.startswith(f"{top}.")})


@pytest.mark.parametrize("package", LAZY_PACKAGES)
def test_a_lazy_package_loads_none_of_its_submodules(package):
    loaded = _loaded_by(f"import {package}")
    own = [name for name in loaded if name.startswith(f"{package}.")]

    assert own in ([], ["agent.lazy_exports"]), f"{package}/__init__.py imports {own}"
    assert _heavy([name for name in loaded if not name.startswith(package)]) == []


@pytest.mark.parametrize("package", LAZY_PACKAGES)
def test_a_lazy_package_exports_no_name_a_submodule_has(package):
    module = importlib.import_module(package)
    submodules = {info.name for info in pkgutil.iter_modules(module.__path__)}

    assert set(getattr(module, "__all__", ())) & submodules == set()


@pytest.mark.parametrize("conftest", ["tests/conftest.py", "apps/backend/tests/conftest.py"], ids=["core", "api"])
def test_a_conftest_every_test_loads_loads_nothing_heavy(conftest):
    loaded = _loaded_by(
        "import importlib.util\n"
        f"spec = importlib.util.spec_from_file_location('conftest_under_test', {conftest!r})\n"
        "spec.loader.exec_module(importlib.util.module_from_spec(spec))"
    )

    assert _heavy(loaded) == [], f"{conftest} loads {_heavy(loaded)}: import it inside the fixture that needs it"


def test_every_knowledge_layer_tool_module_is_an_entry_point():
    # The package `__init__` used to import `browse` and `read_passage`, which is
    # how NAT saw their tools; each has its own entry point now. A stale venv
    # fails here: `uv sync --group dev` installs the new entry points.
    from importlib.metadata import entry_points

    plugins = {entry.value for entry in entry_points(group="nat.plugins")}

    assert {"knowledge_layer.register", "knowledge_layer.browse", "knowledge_layer.read_passage"} <= plugins
