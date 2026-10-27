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

import pytest
from aiq_agent_testing.exposure import CONFIG
from aiq_agent_testing.exposure import EXPOSURE
from aiq_agent_testing.exposure import PILOTI_AGENT
from aiq_agent_testing.exposure import piloti_tool_names


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
