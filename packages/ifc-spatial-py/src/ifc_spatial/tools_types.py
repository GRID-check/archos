"""The two types a tool is described and fails with: ToolDef and ToolError."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.


@dataclass(frozen=True)
class ToolDef:
    """JSON-Schema-shaped input description. Deliberately plain dicts."""

    name: str
    title: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]


class ToolError(Exception):
    """A mistake the model can correct, phrased for the model.

    Distinct from every ``decidable: false`` answer: this means the call could
    not be made at all — no such model handle, no such GlobalId, no source. A
    "the file cannot say" is a successful result and must never arrive here.
    """
