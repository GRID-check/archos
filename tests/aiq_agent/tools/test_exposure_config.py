"""Every ``native:<tool>`` in the exposure config is a tool Piloti really has (ADR-0122).

``frontends/ui/src/lib/agent-api/exposure.config.ts`` decides who sees each
operation of the agent door. ``piloti: 'native:<tool>'`` hides an operation from
Piloti's door because Piloti does that work with its own tool. A name that is
not in Piloti's tool list would hide the operation and leave Piloti with no way
to do the work at all, so each one is checked against the chat agent's
``tools:`` in ``configs/config_oib_openrouter.yml``, a function group's member as
``<group>__<function>``, the name the model binds.

The TypeScript config reaches Python as ``frontends/ui/tests/fixtures/exposure.json``,
written and drift-checked by ``exposure.config.spec.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "configs" / "config_oib_openrouter.yml"
EXPOSURE = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "exposure.json"
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


@pytest.fixture(scope="module")
def exposure() -> dict[str, dict]:
    return json.loads(EXPOSURE.read_text(encoding="utf-8"))["operations"]


def test_every_native_tool_the_config_names_is_one_piloti_has(exposure: dict[str, dict]) -> None:
    tools = piloti_tool_names()
    natives = {
        name: entry["piloti"].removeprefix("native:")
        for name, entry in exposure.items()
        if isinstance(entry["piloti"], str)
    }
    assert natives, "the config names no native tool: the fixture is not the one this test reads"
    unknown = {name: tool for name, tool in natives.items() if tool not in tools}
    assert unknown == {}, f"not in {PILOTI_AGENT}'s tools of {CONFIG.name}: {unknown}"


def test_the_consultants_steps_hide_these_from_piloti_behind_its_own_tools(exposure: dict[str, dict]) -> None:
    """The approved mappings (2026-10-21): visibility on Piloti's door only, the outside agent keeps each."""
    expected = {
        "project-memory-create": "native:remember",
        "organization-memory-create": "native:remember",
        "bim-model-query": "native:ifc_query",
        "task-create": "native:create_task",
        "task-run-commission": "native:create_task",
        "annotation-create": "native:canvas__mark",
        "annotation-update": "native:canvas__update",
        "annotation-delete": "native:canvas__delete",
        "annotation-reply-create": "native:canvas__reply",
    }
    assert {name: exposure[name]["piloti"] for name in expected} == expected
    assert all(exposure[name]["external"] for name in expected)


def test_the_tool_list_reader_sees_the_canvas_group() -> None:
    """The reader itself: a group's members come through under the bound name, or every canvas name looks unknown."""
    assert {"canvas__mark", "canvas__reply", "remember", "create_task"} <= piloti_tool_names()


def test_the_door_looks_with_the_tool_piloti_looks_with(exposure: dict[str, dict]) -> None:
    """ADR-0128: one name for one act. The door's ``document-look`` is Piloti's own ``look``, offered outside."""
    assert exposure["document-look"]["piloti"] == "native:look"
    assert exposure["document-look"]["external"] is True
    assert "knowledge-image-view" not in exposure
    assert "look" in piloti_tool_names()
