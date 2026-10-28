"""The frozen records a stair is read into: treads, flights, bodies, running surfaces and rakes."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# ════════════════════════════════════════════════════════════════════════════
# the tread reading — one flight's body, turned into risers and goings
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Tread:
    """One horizontal step surface, as the mesh shows it."""

    z: float
    area: float
    #: Area-weighted centroid of the tread surface, world coordinates.
    centre: np.ndarray
    #: The tread's extent along the flight's own axes: (along_min, along_max,
    #: across_min, across_max), after the axes are known.
    span: tuple[float, float, float, float]


@dataclass(frozen=True)
class _Flight:
    """Everything one flight's solid says about its steps.

    One flight, not one body: a body that runs up, turns at a landing and runs
    up again holds three of these. See :func:`_read_body`.
    """

    global_id: str
    treads: list[_Tread]
    #: Riser heights, bottom to top. See :data:`BASE_RISER_RELATIVE_SLACK` for
    #: when the first one is in here and when it cannot be.
    risers: list[float]
    #: Whether the bottom riser (body base → first tread, or landing → first
    #: tread where a landing carries this flight) is among them.
    base_riser_used: bool
    #: Goings, bottom to top — plan distance between consecutive tread centres.
    goings: list[float]
    #: Narrowest tread surface: the Nutzbreite this body supports.
    clear_width: float
    #: Plan projection of all tread surfaces, along the flight's own axis.
    total_going: float
    total_rise: float
    #: Unit horizontal direction of travel, upward.
    along: np.ndarray
    #: Unit horizontal direction across the flight.
    across: np.ndarray
    #: Nosing points, bottom to top: the front edge of each tread at its centre.
    nosings: np.ndarray
    #: A Podest carries the foot of this flight / receives its head. Both are
    #: false for a flight that starts on the floor and ends on the storey above.
    landing_below: bool = False
    landing_above: bool = False


@dataclass(frozen=True)
class _Body:
    """What one solid holds: its flights, its landings, and what it refused.

    ``refusals`` is the part of the body the reader would not turn into numbers,
    in German and with the measurement that decided it. It is not an error
    channel — a body can yield two good flights and one refusal — and it is what
    the operators put in front of the reader instead of a number they made up.
    """

    flights: list[_Flight]
    landings: int
    refusals: list[str]
    #: Horizontal faces the body showed at all, after the buried ones are gone.
    levels: int


# ════════════════════════════════════════════════════════════════════════════
# ramp_slope
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Running:
    """A ramp flight's running surface: the dominant up-facing planar cluster."""

    global_id: str
    normal: np.ndarray
    rise: float
    run: float
    width: float
    #: Unit horizontal direction of the ascent, or ``None`` for a level surface.
    uphill: np.ndarray | None
    corners: np.ndarray


# ════════════════════════════════════════════════════════════════════════════
# headroom
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Rake:
    """The walking plane of one flight, as a rectangle with a normal."""

    global_id: str
    #: Four corners: bottom-left, bottom-right, top-right, top-left.
    corners: np.ndarray
    #: Unit normal, pointing up out of the walking surface.
    normal: np.ndarray
    #: Unit direction up the pitch.
    pitch: np.ndarray
    length: float
    width: float
