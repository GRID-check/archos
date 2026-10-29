"""The product's name, for every prompt that says who the agent is.

The name is copy and will change again (`docs/contributing/code-conventions.md#no-brand-names`,
ADR-0148). Its one source is ``packages/brand/identity.json``; ``node packages/brand/sync.mjs``
copies that file beside this module, and the package ships it as package data, so the
agent reads the same file the UI and the website read. A prompt says ``{{ product_name }}``
and ``render_prompt_template`` puts this in. ``tests/test_product_name_parity.py`` holds
this, the UI's ``PRODUCT_NAME`` and every literal copy to ``identity.json``, and runs the
rename drill.
"""

from __future__ import annotations

import json
from pathlib import Path


def _identity_name() -> str:
    # Beside this file, not through importlib.resources: a script that loads this module
    # standalone under a stub package (scripts/build_ris_catalog.py) has no package to ask.
    identity = json.loads(Path(__file__).with_name("identity.json").read_text(encoding="utf-8"))
    return str(identity["name"])


PRODUCT_NAME = _identity_name()
