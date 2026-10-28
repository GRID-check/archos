"""The UI and the agent name the product with the same string.

The UI's copy reads ``PRODUCT_NAME`` from ``apps/workspace/bff/brand.ts``
(through ``{productName}`` in the dictionaries); the agent's prompts read it
from ``agent.common.brand`` (through ``{{ product_name }}``). A rename that
reaches one and not the other would have the agent introduce itself by a name
the screen around it no longer uses.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent.common import render_prompt_template
from agent.common.brand import PRODUCT_NAME

ROOT = Path(__file__).resolve().parents[1]
UI_BRAND = ROOT / "apps" / "workspace" / "bff" / "brand.ts"


def test_the_ui_and_the_agent_carry_the_same_product_name() -> None:
    match = re.search(r"export const PRODUCT_NAME = '([^']+)'", UI_BRAND.read_text(encoding="utf-8"))
    assert match, "PRODUCT_NAME not found in apps/workspace/bff/brand.ts"
    assert match.group(1) == PRODUCT_NAME


def test_a_prompt_names_the_agent_with_the_product_name() -> None:
    rendered = render_prompt_template("You are {{ product_name }}.", document_inventory="", answer_envelope_schema="")
    assert rendered == f"You are {PRODUCT_NAME}."
