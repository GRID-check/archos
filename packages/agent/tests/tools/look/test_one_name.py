"""One name for one act (ADR-0128): nothing an agent reads names a retired look tool.

``view_knowledge_image`` and ``canvas__look`` were one function under two names;
``look`` replaced both, and the door's ``knowledge-image-view`` became
``document-look``. A retired name that comes back in a config, a prompt, a tool
description or the agent door teaches the model a tool it cannot call. The one
place that keeps an old name is the UI's step labels, as a read-side alias for
stored turns, and it says so in a comment.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agent.common.backend_tools import BACKEND_READ_TOOLS
from agent.tools.canvas.register import DESCRIPTIONS
from agent.tools.look.register import DESCRIPTION

ROOT = Path(__file__).resolve().parents[5]
RETIRED = re.compile(r"view_knowledge_image|canvas__look|knowledge-image-view")

#: Files an agent reads, whole: what is bound, what it is told, and what the door offers.
AGENT_FACING = [
    ROOT / "configs" / "config_oib_openrouter.yml",
    ROOT / "apps" / "workspace" / "bff" / "agent-api" / "backend-operations.ts",
    ROOT / "apps" / "workspace" / "bff" / "agent-api" / "exposure.config.ts",
    ROOT / "apps" / "workspace" / "tests" / "fixtures" / "exposure.json",
    *sorted((ROOT / "packages" / "agent" / "src" / "agent" / "agents").glob("*/prompts/**/*.*")),
]

EXECUTED_STEPS = ROOT / "apps" / "workspace" / "ui" / "features" / "chat" / "lib" / "executed-steps.ts"


@pytest.mark.parametrize("path", AGENT_FACING, ids=lambda path: str(path.relative_to(ROOT)))
def test_no_agent_facing_file_names_a_retired_look(path: Path) -> None:
    hits = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if RETIRED.search(line)]
    assert hits == [], f"{path.relative_to(ROOT)} names a retired look tool; the tool is `look`: {hits}"


def test_no_tool_description_names_a_retired_look() -> None:
    for name, text in {"look": DESCRIPTION, **{f"canvas__{k}": v for k, v in DESCRIPTIONS.items()}}.items():
        assert not RETIRED.search(text), f"{name}'s description names a retired look tool"


def test_the_canvas_group_has_no_look_of_its_own() -> None:
    assert "look" not in DESCRIPTIONS


def test_the_door_serves_look() -> None:
    assert "look" in BACKEND_READ_TOOLS and "view_knowledge_image" not in BACKEND_READ_TOOLS


def test_the_step_labels_keep_the_old_name_only_as_a_commented_alias() -> None:
    lines = EXECUTED_STEPS.read_text(encoding="utf-8").splitlines()
    hits = [index for index, line in enumerate(lines) if RETIRED.search(line)]
    assert len(hits) == 1, "executed-steps.ts keeps exactly one retired name, the stored turns' alias"
    assert "stored turns" in lines[hits[0] - 1], "say above the alias that it is there for stored turns"
