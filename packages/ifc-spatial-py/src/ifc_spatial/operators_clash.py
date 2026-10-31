"""Pairs of bodies: what touches an element, and which elements clash.

Own broad and narrow phase, deliberately. ``geom.tree.clash_intersection_many``
and its siblings return ``()`` for every input on the shipped 0.8.5 wheel
without raising (see :mod:`ifc_spatial.clearance`), and a clash check built on
them would report a clean model for every model. So:

- **broad phase** — the :class:`~ifc_spatial.element_index.ElementIndex` boxes,
  vectorised one row against a whole set;
- **narrow phase** — the triangulations: :func:`ifc_spatial.clearance._soup_distance`
  for the surface distance, :func:`ifc_spatial.proximity_mesh.penetrates` for
  shared volume.

Every stage has a published bound, and running into one sets ``truncated``
rather than returning a short list as if it were complete.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .clearance import _soup_distance
from .element_index import MAX_PART_DEPTH
from .element_index import ElementIndex
from .element_index import element_index
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel
from .operators_constants import COORDINATE_TOLERANCE
from .operators_constants import TESSELLATION_TOLERANCE
from .operators_proximity import MAX_RESULTS
from .operators_proximity import ProximityLimitError
from .operators_proximity import _check_count
from .operators_proximity import _check_number
from .operators_proximity import _missing_reason
from .operators_proximity import _ref
from .operators_proximity import _split
from .operators_proximity import _triangles
from .operators_proximity import _type_mask
from .operators_proximity import _work_budget
from .proximity_mesh import penetrates

CLASH_MODES = ("intersect", "touch", "clearance")
MAX_CLASH_SET = 2000
MAX_CANDIDATE_PAIRS = 20_000
MAX_NARROW_PAIRS = 2000
CLASH_BUDGET_SECONDS = 20.0
#: Default tolerance for ``intersect`` and ``touch``: a penetration or a gap
#: below this is modelling noise, not a finding.
DEFAULT_CLASH_TOLERANCE = COORDINATE_TOLERANCE
MAX_CLEARANCE = 5.0
MAX_NEIGHBOUR_GAP = 1.0
NEIGHBOUR_BUDGET_SECONDS = 20.0


# ── neighbours ──────────────────────────────────────────────────────────────


def neighbours(
    model: SpatialModel, global_id: str, gap: float = 0.05, *, budget_s: float | None = None
) -> Answer[dict[str, Any]]:
    """Elements whose surface comes within ``gap`` of this element's surface.

    ``touching`` when the surfaces meet (within the coordinate tolerance),
    ``near`` otherwise. Openings are left out: they are holes, and the element
    that fills one is what a reader means by its neighbour.
    """
    gap = _check_number("gap", gap, 0.0, MAX_NEIGHBOUR_GAP)
    budget = _work_budget(budget_s, NEIGHBOUR_BUDGET_SECONDS)
    method = f"neighbours({global_id}, gap={gap:g})"
    model.by_id(global_id, method)
    index = element_index(model)
    subject = _triangles(model, global_id) if _missing_reason(index, global_id) is None else None
    if subject is None:
        return _no_body(index, global_id, method)
    row = index.row(global_id)
    mask = _type_mask(index, None)
    mask[row] = False
    candidates = np.flatnonzero(mask & _within_gap(index, row, gap))
    found, unmeasured = _measure_neighbours(model, index, subject, candidates, gap, budget)
    found.sort(key=lambda item: (item[1], index.global_ids[item[0]]))
    shown = found[:MAX_RESULTS]
    caveat = None
    if unmeasured:
        caveat = f"Stopped after {budget:g} s; {unmeasured} candidates were not measured."
    return computed(
        {
            "neighbours": [
                _ref(index, r, distance=d, kind="touching" if d <= COORDINATE_TOLERANCE else "near") for r, d in shown
            ],
            "candidates": int(len(candidates)),
            "truncated": bool(unmeasured) or len(found) > MAX_RESULTS,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[global_id, *(index.global_ids[r] for r, _ in shown)],
        method=method,
        caveat=caveat,
    )


def _within_gap(index: ElementIndex, row: int, gap: float) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        per_axis = np.maximum(index.mins - index.maxs[row], index.mins[row] - index.maxs)
        return (per_axis <= gap).all(axis=1)


def _measure_neighbours(
    model: SpatialModel,
    index: ElementIndex,
    subject: np.ndarray,
    candidates: np.ndarray,
    gap: float,
    budget: float = NEIGHBOUR_BUDGET_SECONDS,
) -> tuple[list[tuple[int, float]], int]:
    started = time.perf_counter()
    found: list[tuple[int, float]] = []
    for position, row in enumerate(candidates.tolist()):
        remaining = budget - (time.perf_counter() - started)
        if remaining <= 0:
            return found, len(candidates) - position
        tris = _triangles(model, index.global_ids[row])
        if tris is None:
            continue
        distance, _, _, _, aborted = _soup_distance(subject, tris, remaining)
        if aborted:
            return found, len(candidates) - position
        if distance <= gap:
            found.append((row, float(distance)))
    return found, 0


def _no_body(index: ElementIndex, global_id: str, method: str) -> Answer[Any]:
    reason = _missing_reason(index, global_id) or "empty-mesh"
    return undecidable(
        from_=[global_id],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"a body for {global_id} ({reason})",
            remedy="Export the element with its Body representation; without one it has no surface to measure.",
            elements=[global_id],
        ),
    )


# ── clash ───────────────────────────────────────────────────────────────────


def _broad_pairs(
    index: ElementIndex, rows_a: list[int], rows_b: list[int] | None, threshold: float
) -> tuple[list[tuple[int, int]], bool]:
    """Box pairs whose per-axis gap is at most ``threshold`` (negative: overlapping by more).

    ``rows_b`` of ``None`` pairs set A with itself, each pair once.
    """
    others = np.asarray(rows_a if rows_b is None else rows_b, dtype=int)
    pairs: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for position, a in enumerate(rows_a):
        pool = others[position + 1 :] if rows_b is None else others[others != a]
        if len(pool) == 0:
            continue
        gap = np.maximum(index.mins[pool] - index.maxs[a], index.mins[a] - index.maxs[pool])
        hits = pool[(gap <= threshold).all(axis=1)]
        fresh = [(a, int(b)) for b in hits if (int(b), a) not in seen]
        seen.update(fresh)
        pairs.extend(fresh)
        if len(pairs) > MAX_CANDIDATE_PAIRS:
            return pairs[:MAX_CANDIDATE_PAIRS], True
    return pairs, False


def _classify(
    tris_a: np.ndarray, tris_b: np.ndarray, mode: str, tolerance: float, deadline: float, deep: bool
) -> tuple[str, float] | None:
    """``(kind, distance)`` for one pair, ``None`` when the mode does not report it.

    Raises :class:`TimeoutError` when the deadline passes mid-pair.
    """
    depth = DEFAULT_CLASH_TOLERANCE if mode == "clearance" else tolerance
    shared = penetrates(tris_a, tris_b, depth, deadline) if deep else False
    if shared is None:
        raise TimeoutError
    if shared:
        return "intersect", 0.0
    if mode == "intersect":
        return None
    distance, _, _, _, aborted = _soup_distance(tris_a, tris_b, max(deadline - time.perf_counter(), 0.0))
    if aborted:
        raise TimeoutError
    touch_limit = tolerance if mode == "touch" else COORDINATE_TOLERANCE
    if distance <= touch_limit:
        return "touch", float(distance)
    if mode == "clearance" and distance < tolerance:
        return "clearance", float(distance)
    return None


def _check_clash_args(mode: str, tolerance: float | None) -> float:
    if mode not in CLASH_MODES:
        raise ProximityLimitError(f"mode must be one of {', '.join(CLASH_MODES)}")
    if mode == "clearance" and tolerance is None:
        raise ProximityLimitError("mode clearance needs tolerance: the clearance to check, in metres")
    if tolerance is None:
        return DEFAULT_CLASH_TOLERANCE
    upper = MAX_CLEARANCE if mode == "clearance" else 0.1
    return _check_number("tolerance", tolerance, 0.0, upper)


def clash(
    model: SpatialModel,
    set_a: list[str],
    set_b: list[str] | None = None,
    mode: str = "intersect",
    tolerance: float | None = None,
    *,
    budget_s: float | None = None,
) -> Answer[dict[str, Any]]:
    """Pairs between ``set_a`` and ``set_b`` (or within ``set_a``) that intersect, touch or come too close.

    - ``intersect`` — the bodies share volume deeper than ``tolerance`` (default 5 mm);
    - ``touch`` — also pairs whose surfaces come within ``tolerance``;
    - ``clearance`` — every pair closer than ``tolerance`` (required, the clearance asked for).

    Each pair carries ``kind`` (``intersect`` / ``touch`` / ``clearance``) and the
    surface ``distance`` (0 for ``intersect``). Pairs whose contact the file
    declares — a window in its wall, an opening in its host, a part in its
    assembly — are skipped and counted in ``skippedDeclared``.

    Deterministic: the sets are ordered by GlobalId before any limit applies,
    each pair is written with ``a < b``, and the list is sorted by ``(a, b)``,
    so the same question asked in another order gets the same answer.
    """
    tolerance = _check_clash_args(mode, tolerance)
    budget = _work_budget(budget_s, CLASH_BUDGET_SECONDS)
    ids_a = _check_count("setA", set_a, MAX_CLASH_SET)
    ids_b = None if set_b is None else _check_count("setB", set_b, MAX_CLASH_SET)
    index = element_index(model)
    rows_a, missing = _split(index, sorted(set(ids_a)))
    rows_b = None
    if ids_b is not None:
        rows_b, missing_b = _split(index, sorted(set(ids_b)))
        missing += [m for m in missing_b if m not in missing]
    threshold = -tolerance if mode == "intersect" else tolerance
    pairs, broad_truncated = _broad_pairs(index, rows_a, rows_b, threshold)
    pairs = sorted(
        {_ordered(index, a, b) for a, b in pairs}, key=lambda p: (index.global_ids[p[0]], index.global_ids[p[1]])
    )
    declared_pairs = _declared_pairs(model)
    kept = [p for p in pairs if frozenset((index.global_ids[p[0]], index.global_ids[p[1]])) not in declared_pairs]
    skipped, pairs = len(pairs) - len(kept), kept
    found, tested, narrow_truncated = _narrow(model, index, pairs, mode, tolerance, budget)
    truncated = broad_truncated or narrow_truncated
    return computed(
        {
            "pairs": found,
            "candidatePairs": len(pairs),
            "tested": tested,
            "skippedDeclared": skipped,
            "truncated": truncated,
            "missing": missing,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=list(dict.fromkeys(gid for pair in found for gid in (pair["a"], pair["b"]))),
        method=f"clash({len(ids_a)}, {'self' if ids_b is None else len(ids_b)}, {mode}, {tolerance:g})",
        caveat=_clash_caveat(truncated, len(pairs), tested, budget),
    )


def _ordered(index: ElementIndex, a: int, b: int) -> tuple[int, int]:
    return (a, b) if index.global_ids[a] <= index.global_ids[b] else (b, a)


def _declared_pairs(model: SpatialModel) -> set[frozenset[str]]:
    """Pairs whose contact the file declares, so a clash between them is by construction.

    - ``IfcRelFillsElement`` / ``IfcRelVoidsElement``: filler and opening, filler
      and host, opening and host. A window's frame usually reaches into the
      reveal; reporting it would bury every real finding under one per window.
    - ``IfcRelAggregates``: an assembly and each of its parts, at any depth up
      to :data:`MAX_PART_DEPTH`. A curtain wall's box is the union of its panels.
    """
    out: set[frozenset[str]] = set()
    for rel in model.file.by_type("IfcRelVoidsElement"):
        out.add(frozenset((rel.RelatingBuildingElement.GlobalId, rel.RelatedOpeningElement.GlobalId)))
    for rel in model.file.by_type("IfcRelFillsElement"):
        opening, filler = rel.RelatingOpeningElement, rel.RelatedBuildingElement
        out.add(frozenset((opening.GlobalId, filler.GlobalId)))
        out.update(
            frozenset((v.RelatingBuildingElement.GlobalId, filler.GlobalId)) for v in opening.VoidsElements or []
        )
    parent: dict[str, str] = {}
    for rel in model.file.by_type("IfcRelAggregates"):
        parent.update((child.GlobalId, rel.RelatingObject.GlobalId) for child in rel.RelatedObjects)
    for child in parent:
        out.update(frozenset((child, ancestor)) for ancestor in _ancestors(parent, child))
    return out


def _ancestors(parent: dict[str, str], child: str) -> list[str]:
    """The assemblies above ``child``, nearest first, at most :data:`MAX_PART_DEPTH` deep."""
    out: list[str] = []
    ancestor = parent.get(child)
    while ancestor is not None and len(out) < MAX_PART_DEPTH:
        out.append(ancestor)
        ancestor = parent.get(ancestor)
    return out


def _narrow(
    model: SpatialModel,
    index: ElementIndex,
    pairs: list[tuple[int, int]],
    mode: str,
    tolerance: float,
    budget: float = CLASH_BUDGET_SECONDS,
) -> tuple[list[dict[str, Any]], int, bool]:
    deadline = time.perf_counter() + budget
    found: list[dict[str, Any]] = []
    for tested, (a, b) in enumerate(pairs):
        if tested >= MAX_NARROW_PAIRS or time.perf_counter() > deadline:
            return found, tested, True
        tris_a = _triangles(model, index.global_ids[a])
        tris_b = _triangles(model, index.global_ids[b])
        if tris_a is None or tris_b is None:
            continue
        deep = bool((np.minimum(index.maxs[a], index.maxs[b]) - np.maximum(index.mins[a], index.mins[b]) > 0).all())
        try:
            result = _classify(tris_a, tris_b, mode, tolerance, deadline, deep)
        except TimeoutError:
            return found, tested, True
        if result is not None:
            found.append({"a": index.global_ids[a], "b": index.global_ids[b], "kind": result[0], "distance": result[1]})
    return found, len(pairs), False


def _clash_caveat(truncated: bool, candidates: int, tested: int, budget: float = CLASH_BUDGET_SECONDS) -> str | None:
    if not truncated:
        return None
    return (
        f"Incomplete: {tested} of {candidates} candidate pairs were tested before a limit "
        f"({MAX_CANDIDATE_PAIRS} candidates, {MAX_NARROW_PAIRS} tested pairs or {budget:g} s). "
        "Narrow the sets and ask again; pairs not listed here were not checked."
    )


__all__ = ["CLASH_MODES", "MAX_CANDIDATE_PAIRS", "MAX_CLASH_SET", "MAX_NARROW_PAIRS", "clash", "neighbours"]
