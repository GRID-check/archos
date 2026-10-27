"""Package re-exports that load on first use (PEP 562).

Importing ``aiq_agent.common.turn_status`` executes ``aiq_agent/__init__.py``
and ``aiq_agent/common/__init__.py`` first. A package that re-exports its
submodules eagerly therefore makes every import of any one of them pay for all
of them, and makes every test that imports one re-run when any of them changes
at module level. A package that wants the short import path gives
:func:`lazy_exports` the map instead (docs/audit/blast-radius-2026-10.md);
``tests/test_import_weight.py`` holds the packages to it.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Callable
from collections.abc import Mapping
from typing import Any


def lazy_exports(package: str, exports: Mapping[str, str]) -> Callable[[str], Any]:
    """A module ``__getattr__`` that imports ``exports[name]`` the first time ``name`` is read.

    A source starting with ``.`` is relative to ``package``. A source equal to
    ``name`` exports the module itself (``"aiosqlite": "aiosqlite"``); any other
    exports the attribute of that name, so ``".read_passage"`` for
    ``read_passage`` is the function, as an eager ``from .read_passage import
    read_passage`` made it. The value is then stored on
    the package, so the hook runs once per name, and a test that patches the
    name replaces what every later read sees.
    """

    def __getattr__(name: str) -> Any:
        source = exports.get(name)
        if source is None:
            raise AttributeError(f"module {package!r} has no attribute {name!r}")
        module = importlib.import_module(source, package)
        value = module if source == name else getattr(module, name)
        setattr(sys.modules[package], name, value)
        return value

    return __getattr__
