"""Piloti's chat tools as the model binds them, read from the shipped config, for the
exposure and workspace-eval suites.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import yaml

ROOT = next(path for path in Path(__file__).resolve().parents if (path / "Taskfile.yml").is_file())
CONFIG = ROOT / "configs" / "config_oib_openrouter.yml"
EXPOSURE = ROOT / "apps" / "workspace" / "tests" / "fixtures" / "exposure.json"
#: Piloti in chat: the agent whose tool list the door's `native:` names point at.
PILOTI_AGENT = "shallow_research_agent"


def _canvas_members() -> set[str]:
    from aiq_agent.tools.canvas.register import DESCRIPTIONS

    return set(DESCRIPTIONS)


#: The functions each function group type adds, by its `_type`. A group the
#: config's `native:` names reach must be listed here.
GROUP_MEMBERS: dict[str, Callable[[], set[str]]] = {"document_canvas": _canvas_members}


def piloti_tool_names() -> set[str]:
    """Piloti's chat tools as the model binds them: functions by name, a group's as ``<group>__<function>``."""
    config = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    groups = config.get("function_groups") or {}
    names: set[str] = set()
    agent = config["functions"][PILOTI_AGENT]
    if agent.get("filesystem"):
        # Built per turn, not listed: the estate's readers (ADR-0133).
        from aiq_agent.tools.documents.tools import ESTATE_TOOL_NAMES

        names.update(ESTATE_TOOL_NAMES)
    for tool in agent["tools"]:
        group = groups.get(tool)
        if group is None:
            names.add(tool)
            continue
        members = GROUP_MEMBERS.get(group["_type"])
        if members is not None:
            names.update(f"{tool}__{member}" for member in members())
    return names
