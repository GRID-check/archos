"""Small helpers the tools share: clamping, lowering, the node walk, the element selection and the JSON-safe view."""

from __future__ import annotations

import dataclasses
import math
from typing import Any

import numpy as np

from ifc_spatial.tools_types import ToolError

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from .model import SpatialModel

# ── find_elements ───────────────────────────────────────────────────────


def _select(
    model: SpatialModel,
    args: dict[str, Any],
    limit: int,
    subject_types: tuple[str, ...] = (),
) -> tuple[list[Any], int]:
    """The selection half of `find_elements`, shared with `survey`.

    Kept as one function so the two tools cannot drift: a caller who scopes
    a survey with `storey="Keller"` has to get exactly the set that
    `find_elements(storey="Keller")` lists, or the names beside the numbers
    would be answering a different question than the numbers.
    """
    wanted_type = _lower(args.get("ifcType"))
    wanted_name = _lower(args.get("nameContains"))
    wanted_storey = _lower(args.get("storey"))
    wanted_kind = _lower(args.get("kind"))

    matches: list[Any] = []
    total = 0
    for element in _nodes(model):
        if wanted_type and element.is_a().lower() != wanted_type:
            continue
        # Subtype-aware, unlike `ifcType`, because this filter is the
        # measure's own definition of its subject rather than the caller's
        # spelling: `IfcWallStandardCase` IS an `IfcWall`, and an ArchiCAD
        # export writes only the former.
        if subject_types and not any(element.is_a(subject) for subject in subject_types):
            continue
        if wanted_kind and model.kind_of(element) != wanted_kind:
            continue
        if wanted_storey:
            storey = model.storey_of(element)
            if (getattr(storey, "Name", None) or "").lower() != wanted_storey:
                continue
        if wanted_name:
            haystack = f"{getattr(element, 'Name', '') or ''} {getattr(element, 'LongName', '') or ''}".lower()
            if wanted_name not in haystack:
                continue
        total += 1
        if len(matches) < limit:
            matches.append(element)
    return matches, total


# ── helpers ─────────────────────────────────────────────────────────────────


def _nodes(model: SpatialModel) -> list[Any]:
    return [
        *model.file.by_type("IfcProject"),
        *model.file.by_type("IfcProduct"),
        *model.file.by_type("IfcGroup"),
    ]


def _jsonable(value: Any) -> Any:
    """Everything this package returns, as plain JSON types.

    Answers, element refs and room proposals all carry a ``to_dict``; NumPy
    scalars and arrays arrive from the geometry operators and are not JSON at
    all. Converting here rather than in each handler is what keeps a new
    operator from silently serialising as ``"<ndarray object at 0x…>"``.
    """
    if isinstance(value, (str, bool, int)) or value is None:
        return value
    if isinstance(value, float):
        # NaN and ±Inf are not JSON. They arrive from a degenerate mesh, and a
        # transport-level crash is a worse report than a null.
        return value if math.isfinite(value) else None
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return _jsonable(value.to_dict())
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, np.ndarray):
        return [_jsonable(v) for v in value.tolist()]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _jsonable(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    return str(value)


def _short(digest: str) -> str:
    return digest[:12]


def _lower(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


def _clamp(value: Any, low: int, high: int) -> int:
    try:
        number = int(float(value))
    except TypeError, ValueError:
        return low
    return max(low, min(high, number))


def _require(args: dict[str, Any], key: str) -> str:
    """A required GlobalId, or a mistake the model can correct."""
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"{key} fehlt — eine GlobalId angeben (aus find_elements)")
    return value.strip()
