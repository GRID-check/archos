"""Every canvas tool and ``look`` has an entry in the surface parity registry (ADR-0128).

``frontends/ui/src/lib/surface-parity/parity.config.ts`` lists each capability
of the review canvas with its form on the canvas and in the chat: a rendering,
an exemption with a reason, or a gap that names the slice closing it. The
TypeScript spec holds it against the annotation ops and the catalog; this file
holds the Python side: the tools Piloti binds. The registry reaches Python as
``frontends/ui/tests/fixtures/surface-parity.json``, written and drift-checked
by ``parity.config.spec.ts``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
PARITY = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "surface-parity.json"
#: Tools outside the canvas group that are the same capability family.
STANDALONE_TOOLS = ("look",)


def piloti_tool_names() -> set[str]:
    """Piloti's bound tool names, read by the exposure test's own reader (one reader, not two)."""
    path = Path(__file__).with_name("test_exposure_config.py")
    spec = importlib.util.spec_from_file_location("_exposure_config_reader", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.piloti_tool_names()


@pytest.fixture(scope="module")
def capabilities() -> dict[str, dict]:
    return json.loads(PARITY.read_text(encoding="utf-8"))["capabilities"]


def _canvas_tools() -> set[str]:
    from aiq_agent.tools.canvas.register import DESCRIPTIONS
    from aiq_agent.tools.canvas.register import GROUP

    return {f"{GROUP}__{member}" for member in DESCRIPTIONS} | set(STANDALONE_TOOLS)


def test_every_canvas_tool_has_a_parity_entry(capabilities: dict[str, dict]) -> None:
    covered = {entry["tool"] for entry in capabilities.values() if entry["tool"]}
    missing = sorted(_canvas_tools() - covered)
    assert missing == [], f"add an entry to parity.config.ts for: {missing}"


def test_every_entry_tool_is_one_piloti_has(capabilities: dict[str, dict]) -> None:
    bound = piloti_tool_names()
    unknown = sorted({e["tool"] for e in capabilities.values() if e["tool"]} - bound)
    assert unknown == [], f"not bound to the chat agent in the config: {unknown}"


def test_every_side_has_a_mirror_or_a_reason(capabilities: dict[str, dict]) -> None:
    for name, entry in capabilities.items():
        for side in ("canvas", "chat"):
            form = entry[side]
            if form["kind"] == "rendering":
                assert form["component"] or form["card"] or form["step"], f"{name}.{side} shows nothing"
            else:
                assert len(form["reason"]) > 30, f"{name}.{side}: say why"


def test_a_named_step_kind_exists_on_the_wire(capabilities: dict[str, dict]) -> None:
    """A rendering's step is a real Herleitung step kind; a gap's is the one its slice will add."""
    from pydantic import TypeAdapter

    from aiq_agent.common.wire_v2 import Step

    schema = TypeAdapter(Step).json_schema()
    wire_kinds = set(schema["discriminator"]["mapping"])
    shown = {
        entry[side]["step"]
        for entry in capabilities.values()
        for side in ("canvas", "chat")
        if entry[side]["kind"] == "rendering" and entry[side]["step"]
    }
    assert sorted(shown - wire_kinds) == []
