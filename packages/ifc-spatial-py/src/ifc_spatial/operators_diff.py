"""What moved between two revisions of a model, by GlobalId, from their element indexes alone.

The comparison is box against box, so it answers "where did this element go"
and "did it change size", not "did its shape change": a door swapped for a
door of the same size in the same place is ``unchanged`` here. A GlobalId is
the identity; an element deleted and redrawn under a new GlobalId reads as one
``removed`` and one ``added``, which is what the file says happened.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .element_index import ElementIndex
from .envelope import Answer
from .envelope import computed
from .operators_proximity import ProximityLimitError
from .operators_proximity import _check_count
from .operators_proximity import _check_number

#: 5 mm: below it a centroid or size change is export noise (re-tessellation,
#: rounding in another authoring tool), not a modelling change.
DIFF_TOLERANCE = 0.005
MAX_DIFF_IDS = 5000
#: Changes listed per answer. The counts always cover everything.
MAX_DIFF_CHANGES = 2000
DIFF_STATUSES = ("added", "removed", "moved", "resized", "unchanged", "no-geometry")


def _compare(base: ElementIndex, current: ElementIndex, global_id: str, tolerance: float) -> dict[str, Any]:
    """One GlobalId's status between ``base`` and ``current``."""
    old, new = base.row(global_id), current.row(global_id)
    if old is None and new is None:
        return {"globalId": global_id, "status": "no-geometry", "reason": "unknown-global-id"}
    if old is None:
        return {"globalId": global_id, "status": "added"}
    if new is None:
        return {"globalId": global_id, "status": "removed"}
    if not (base.ok[old] and current.ok[new]):
        return {
            "globalId": global_id,
            "status": "no-geometry",
            "reason": f"base {base.status[old]}, current {current.status[new]}",
        }
    moved = current.centroids[new] - base.centroids[old]
    resized = (current.maxs[new] - current.mins[new]) - (base.maxs[old] - base.mins[old])
    out: dict[str, Any] = {"globalId": global_id, "status": "unchanged"}
    if float(np.abs(resized).max()) > tolerance:
        out.update(status="resized", sizeDelta=[float(v) for v in resized])
    if float(np.linalg.norm(moved)) > tolerance:
        out["centroidDelta"] = [float(v) for v in moved]
        if out["status"] == "unchanged":
            out["status"] = "moved"
    return out


def box_diff(
    base: ElementIndex,
    current: ElementIndex,
    ids: list[str] | None = None,
    tolerance: float = DIFF_TOLERANCE,
) -> Answer[dict[str, Any]]:
    """Per GlobalId: ``added`` / ``removed`` / ``moved`` (Δcentroid) / ``resized`` (Δsize) / ``unchanged``.

    With ``ids``, every one of them is listed, unchanged ones included. Without,
    the whole model is compared and only the changes are listed; ``counts``
    covers every element either way. ``resized`` wins over ``moved`` when both
    hold; ``centroidDelta`` is then present too.
    """
    tolerance = _check_number("tolerance", tolerance, 0.0, 1.0)
    explicit = ids is not None
    wanted = _check_count("globalIds", ids, MAX_DIFF_IDS) if explicit else _all_ids(base, current)
    entries = [_compare(base, current, gid, tolerance) for gid in wanted]
    counts = {status: 0 for status in DIFF_STATUSES}
    for entry in entries:
        counts[entry["status"]] += 1
    listed = entries if explicit else [e for e in entries if e["status"] != "unchanged"]
    shown = listed[:MAX_DIFF_CHANGES]
    return computed(
        {"elements": shown, "counts": counts, "truncated": len(listed) > len(shown)},
        unit="m",
        tolerance=tolerance,
        from_=[e["globalId"] for e in shown],
        method=f"box_diff({len(wanted)} ids, tolerance={tolerance:g})",
        caveat="Compared by box and centroid: a change of shape inside the same box is not detected.",
    )


def _all_ids(base: ElementIndex, current: ElementIndex) -> list[str]:
    ids = list(dict.fromkeys([*base.global_ids, *current.global_ids]))
    if not ids:
        raise ProximityLimitError("both indexes are empty")
    return ids


__all__ = ["DIFF_STATUSES", "DIFF_TOLERANCE", "MAX_DIFF_IDS", "box_diff"]
