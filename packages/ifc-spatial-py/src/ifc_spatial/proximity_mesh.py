"""Two mesh predicates the proximity operators need and ``geom.tree.clash_*`` cannot supply.

``tree.clash_*`` returns an empty tuple for every input on the shipped 0.8.5
wheel (see the note in :mod:`ifc_spatial.clearance`), so "does A penetrate B"
and "is this point inside that solid" are answered from the triangulations,
with NumPy, the same way :func:`ifc_spatial.clearance._soup_distance` answers
"how far apart are they".

Both predicates are conservative in one named direction: they never report a
penetration that is not there, and they may miss one shallower than the
tolerance — which is what a tolerance means.
"""

from __future__ import annotations

import time

import numpy as np

from .clearance import _closest_on_triangles

#: Ray directions for the parity test. Irrational-looking on purpose: an axis
#: ray through an axis-aligned building grazes edges and coplanar faces, and a
#: grazing hit is counted twice or not at all. Three rays and a majority vote
#: absorb the case where one of them still grazes.
_RAYS = np.array(
    [
        [0.5773, 0.5774, 0.5774],
        [-0.6123, 0.3536, 0.7071],
        [0.2673, -0.8018, 0.5345],
    ]
)
#: Vertices tested for containment per element. Enough to find a corner that
#: sits inside the other solid; bounded so a 40 000-triangle chair costs the
#: same as a wall.
_MAX_CONTAINMENT_SAMPLES = 64
_EPSILON = 1e-12


def _ray_hits(origins: np.ndarray, direction: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Hit count of a ray from each origin through ``tris`` — Möller–Trumbore, ``t > 0``."""
    edge1 = tris[:, 1] - tris[:, 0]
    edge2 = tris[:, 2] - tris[:, 0]
    h = np.cross(direction, edge2)
    det = (edge1 * h).sum(-1)
    usable = np.abs(det) > _EPSILON
    inverse = 1.0 / np.where(usable, det, 1.0)
    s = origins[:, None, :] - tris[None, :, 0]
    u = (s * h[None]).sum(-1) * inverse
    q = np.cross(s, edge1[None])
    v = (q * direction).sum(-1) * inverse
    t = (q * edge2[None]).sum(-1) * inverse
    hit = usable & (u >= 0.0) & (v >= 0.0) & (u + v <= 1.0) & (t > _EPSILON)
    return hit.sum(axis=1)


#: Points per batch of the parity test. The intermediate arrays are points ×
#: triangles × 3, so a batch bounds memory: 256 points against a 40 000-triangle
#: body is ~250 MB of float64 at most, and the deadline is checked between batches.
POINT_CHUNK = 256


def points_inside(points: np.ndarray, tris: np.ndarray, deadline: float | None = None) -> np.ndarray:
    """Which points lie inside the closed triangle soup ``tris`` (ray parity, majority of three).

    Raises :class:`TimeoutError` when ``deadline`` (a ``perf_counter`` value)
    passes between two batches.
    """
    out = np.zeros(len(points), dtype=bool)
    if len(points) == 0 or len(tris) == 0:
        return out
    for start in range(0, len(points), POINT_CHUNK):
        if deadline is not None and time.perf_counter() > deadline:
            raise TimeoutError
        batch = points[start : start + POINT_CHUNK]
        votes = sum((_ray_hits(batch, ray, tris) % 2 == 1).astype(int) for ray in _RAYS)
        out[start : start + POINT_CHUNK] = votes >= 2
    return out


def point_distances(points: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Distance from each point to the nearest triangle of ``tris``."""
    out = np.empty(len(points))
    for i, point in enumerate(points):
        nearest = _closest_on_triangles(np.broadcast_to(point, (len(tris), 3)), tris)
        out[i] = float(np.linalg.norm(nearest - point, axis=1).min())
    return out


def _contains_vertex_of(inner: np.ndarray, outer: np.ndarray, tolerance: float, deadline: float) -> bool:
    """A vertex of ``inner`` lies inside ``outer`` and deeper than ``tolerance``."""
    low, high = outer.min(axis=(0, 1)), outer.max(axis=(0, 1))
    vertices = np.unique(inner.reshape(-1, 3), axis=0)
    within = vertices[((vertices > low + tolerance) & (vertices < high - tolerance)).all(axis=1)]
    if len(within) == 0:
        return False
    if len(within) > _MAX_CONTAINMENT_SAMPLES:
        step = len(within) / _MAX_CONTAINMENT_SAMPLES
        within = within[(np.arange(_MAX_CONTAINMENT_SAMPLES) * step).astype(int)]
    inside = within[points_inside(within, outer, deadline)]
    if len(inside) == 0:
        return False
    return bool((point_distances(inside, outer) > tolerance).any())


def _segment_depths(p: np.ndarray, q: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """How far past each triangle each segment reaches on its shorter side; 0 where it does not cross."""
    edge1 = tris[..., 1, :] - tris[..., 0, :]
    edge2 = tris[..., 2, :] - tris[..., 0, :]
    direction = q - p
    h = np.cross(direction, edge2)
    det = (edge1 * h).sum(-1)
    usable = np.abs(det) > _EPSILON
    inverse = 1.0 / np.where(usable, det, 1.0)
    s = p - tris[..., 0, :]
    u = inverse * (s * h).sum(-1)
    qv = np.cross(s, edge1)
    v = inverse * (direction * qv).sum(-1)
    t = inverse * (edge2 * qv).sum(-1)
    crossing = usable & (u > 0.0) & (v > 0.0) & (u + v < 1.0) & (t > 0.0) & (t < 1.0)
    length = np.linalg.norm(direction, axis=-1)
    return np.where(crossing, np.minimum(t, 1.0 - t) * length, 0.0)


def _edges_pierce(tri: np.ndarray, others: np.ndarray, tolerance: float) -> bool:
    """An edge of ``tri`` crosses one of ``others``, or the reverse, deeper than ``tolerance``."""
    count = len(others)
    starts = np.broadcast_to(tri[:, None, :], (3, count, 3))
    ends = np.broadcast_to(np.roll(tri, -1, axis=0)[:, None, :], (3, count, 3))
    if (_segment_depths(starts, ends, np.broadcast_to(others, (3, count, 3, 3))) > tolerance).any():
        return True
    other_starts = others.transpose(1, 0, 2)
    other_ends = np.roll(others, -1, axis=1).transpose(1, 0, 2)
    fixed = np.broadcast_to(tri, (3, count, 3, 3))
    return bool((_segment_depths(other_starts, other_ends, fixed) > tolerance).any())


def penetrates(tris_a: np.ndarray, tris_b: np.ndarray, tolerance: float, deadline: float) -> bool | None:
    """Whether solid A and solid B share volume deeper than ``tolerance``.

    Two ways a pair interpenetrates, and both are tested: a surface of one
    crosses a face of the other (an edge pierces a face's interior, which a
    touching pair never does — its edges end ON the face), or one sits wholly
    inside the other (a vertex inside, deeper than the tolerance).

    Returns ``None`` when ``deadline`` (a ``perf_counter`` value) passes first.
    """
    if time.perf_counter() > deadline:
        return None
    try:
        if _contains_vertex_of(tris_a, tris_b, tolerance, deadline) or _contains_vertex_of(
            tris_b, tris_a, tolerance, deadline
        ):
            return True
    except TimeoutError:
        return None
    lo_b, hi_b = tris_b.min(axis=1), tris_b.max(axis=1)
    lo_a, hi_a = tris_a.min(axis=1), tris_a.max(axis=1)
    for index in range(len(tris_a)):
        if time.perf_counter() > deadline:
            return None
        near = ((lo_b <= hi_a[index]) & (hi_b >= lo_a[index])).all(axis=1)
        if near.any() and _edges_pierce(tris_a[index], tris_b[near], tolerance):
            return True
    return False


def overlaps_by_containment(tris_a: np.ndarray, tris_b: np.ndarray) -> bool:
    """One body lies inside the other: a vertex of either is inside the other.

    The surface distance of a sofa standing inside a room is the gap to the
    nearest wall, not zero; this is what makes "how far is it" answer zero for a
    body that is IN the other one.
    """
    if points_inside(tris_a[:1, 0], tris_b)[0]:
        return True
    return bool(points_inside(tris_b[:1, 0], tris_a)[0])


__all__ = ["overlaps_by_containment", "penetrates", "point_distances", "points_inside"]
