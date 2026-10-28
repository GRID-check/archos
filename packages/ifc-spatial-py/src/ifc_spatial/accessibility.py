"""Barrierefreiheit as geometry — the four clearances OIB 4 is decided on, measured.

OIB Richtlinie 4 covers *Nutzungssicherheit und Barrierefreiheit*, and almost
every barrier-free requirement in it comes down to a distance this engine could
not measure: can a wheelchair turn in this room, is there a step at this door,
is anything standing at an edge you can fall over, is there room to stand beside
the door while pulling it open. All four are geometry. None of them is a
verdict, and this module produces none.

## Why a module about accessibility is the one that must not judge

Every other operator here refuses to judge for the same reason — the number
belongs to the model and the threshold belongs to the Bestimmung. This module is
the one where that discipline is hardest to keep and most expensive to lose.
OIB 4 names 1.50 m of Bewegungsfläche and it names a maximum step, so the
temptation to write ``fits >= 1.50 → barrierefrei`` is right there in the
requirement. Two things make that wrong, and both of them hurt a real person:

  - **A false „erfüllt"** is a building that a wheelchair user cannot use, signed
    off by a machine that measured the Rohbau and called it the finished floor.
    Every caveat in this file names a way that can happen: a 0 mm threshold on a
    slab that has no screed on it yet, a turning circle in a room whose fitted
    wardrobe was never exported, a clear approach measured with the door leaf in
    its modelled — that is, closed — position.
  - **A false „nicht erfüllt"** costs an applicant a redesign for a defect that
    lives in the export rather than in the building, which is how an architect
    learns to stop reading the tool.

So: this layer measures what IS there, says what it measured it ON, and hands
the number to the clause. The words „barrierefrei", „erfüllt" and „entspricht"
do not appear in any answer this module returns, and the thresholds do not
appear in its code.

## What is new here, and what is deliberately not

Read together with the three modules it stands on and does not duplicate:
:func:`~ifc_spatial.clearance.clear_opening_width` measures a door *aperture*
(this measures the floor in front of it), :func:`~ifc_spatial.circulation.egress_path`
walks a door *graph* (this never leaves one room), and
:func:`~ifc_spatial.daylight.above` / :func:`~ifc_spatial.daylight.below` cast
vertical *rays* (this uses them, for the surface on the far side of a wall).

The one genuinely new primitive is the **largest inscribed circle in a free
floor polygon** — the room's own footprint minus the plan silhouette of
everything standing on it — because that is the shape of the Bewegungsfläche
question and nothing in this library could produce it.

## The parameters, and why they are not defaulted

:func:`turning_circle` takes a ``diameter`` and :func:`balustrade_check` takes a
``fall_height``. Both default to ``None``, and neither is ever supplied by this
module. That is a weaker refusal than the one ``light_incidence`` makes about
its 45°, and the difference is argued at each call site: an incidence prism
without an angle is not a smaller answer, it is *no geometry at all*, so that
operator must refuse. A turning circle without a diameter is still a complete
measurement — the largest circle that fits — and refusing to hand it over would
withhold a number that needs no clause. So the parameter is optional rather than
required, and hard-coding 1.50 m as its default is the one thing that is out of
the question: that would put an OIB number in this file.
"""

from __future__ import annotations

from ifc_spatial.accessibility_approach import clear_approach  # noqa: F401
from ifc_spatial.accessibility_balustrade import balustrade_check  # noqa: F401
from ifc_spatial.accessibility_constants import MIN_OBSTACLE_AREA  # noqa: F401
from ifc_spatial.accessibility_floor import _frame_of  # noqa: F401
from ifc_spatial.accessibility_floor import _free_floor  # noqa: F401
from ifc_spatial.accessibility_floor import _is_floor_void  # noqa: F401
from ifc_spatial.accessibility_floor import _plan_footprint  # noqa: F401
from ifc_spatial.accessibility_floor import _plan_silhouette  # noqa: F401
from ifc_spatial.accessibility_records import _FreeFloor  # noqa: F401
from ifc_spatial.accessibility_threshold import threshold_height  # noqa: F401
from ifc_spatial.accessibility_turning import turning_circle  # noqa: F401

__all__ = [
    "balustrade_check",
    "clear_approach",
    "threshold_height",
    "turning_circle",
]
