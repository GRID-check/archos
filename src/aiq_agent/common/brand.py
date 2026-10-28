"""The product's name, for every prompt that says who the agent is.

The name is copy and will change again (`docs/contributing/code-conventions.md#no-brand-names`):
a prompt says ``{{ product_name }}`` and ``render_prompt_template`` puts this in.
The UI's ``PRODUCT_NAME`` (``frontends/ui/src/lib/brand.ts``) is the same
string; ``tests/test_product_name_parity.py`` holds them equal.
"""

from __future__ import annotations

PRODUCT_NAME = "Piloti"
