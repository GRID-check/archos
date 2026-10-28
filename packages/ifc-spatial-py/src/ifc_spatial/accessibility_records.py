"""The frozen records a room's free floor and an opening's frame are read into."""

from __future__ import annotations

from typing import Any

import numpy as np


class _FreeFloor:
    """A room's clear floor, and the bookkeeping of what was taken out of it."""

    __slots__ = ("footprint", "fixed", "furnished", "floor_z", "obstacles", "triangles")

    def __init__(self, footprint: Any, floor_z: float) -> None:
        self.footprint = footprint
        self.fixed = footprint
        self.furnished = footprint
        self.floor_z = floor_z
        self.obstacles: list[dict[str, Any]] = []
        self.triangles = 0


# ════════════════════════════════════════════════════════════════════════════
# opening geometry — the frame the three door/window operators share
# ════════════════════════════════════════════════════════════════════════════


class _Frame:
    """An opening's own coordinate frame in plan: ``lateral`` across it, ``normal``
    through it, and how far the wall reaches on either side.

    Every one of the three opening operators needs the same four things — which
    way is through, how wide the opening is, where its two faces are, and how
    high its underside sits — so they are built once.
    """

    __slots__ = (
        "normal",
        "lateral",
        "u_min",
        "u_max",
        "v_min",
        "v_max",
        "z_min",
        "z_max",
        "host_min",
        "host_max",
    )

    def __init__(self, normal: np.ndarray, lateral: np.ndarray) -> None:
        self.normal = normal
        self.lateral = lateral
        self.host_min: float | None = None
        self.host_max: float | None = None

    def point(self, u: float, v: float) -> np.ndarray:
        """A point of the opening's plane, in model plan coordinates."""
        return self.lateral * u + self.normal * v

    @property
    def u_centre(self) -> float:
        return (self.u_min + self.u_max) / 2.0

    def outer_face(self, sign: float) -> float:
        """How far through the construction, on the given side, the outer face lies.

        The HOST wall's extent wins when it reaches further than the element's
        own, which it usually does: a door leaf is 44 mm thick and the wall it
        sits in is 300 mm, so a probe 30 cm past the LEAF is still inside the
        masonry, and the ray cast there finds the wall's own underside instead
        of the ground outside.
        """
        own = self.v_max if sign > 0 else self.v_min
        host = self.host_max if sign > 0 else self.host_min
        if host is None:
            return own
        return max(own, host) if sign > 0 else min(own, host)
