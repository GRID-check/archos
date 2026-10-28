"""Tolerances, probe offsets and the verdict sentinel the accessibility checks share."""

from __future__ import annotations

# ── the error model, and the cost bounds ────────────────────────────────────
#
# No tolerance is invented here. The two that travel with these answers are
# `operators.DIMENSION_TOLERANCE` (10 mm — a dimension is a difference of two
# independently tessellated faces, so both errors are in it) and
# `operators.COORDINATE_TOLERANCE` (5 mm — one surface). The constants below are
# MODELLING decisions and cost bounds, and each says which failure it prevents.

#: How far above a room's floor an element's underside may sit and still count as
#: standing ON that floor, in metres.
#:
#: The rule this implements is the whole obstacle filter: an element takes floor
#: away from a wheelchair when it reaches down to the floor. Without it the
#: sample house's every room measures **zero** free floor, because the ceiling
#: covering, the roof and the upper slab each project over 100 % of the plan —
#: 15.42 m² of "obstacle" in a 15.42 m² bedroom. 20 mm is one tessellation
#: tolerance plus a fitting gap, not a construction dimension.
FLOOR_CONTACT = 0.02

#: Below this, an element's intrusion into a room's plan is tessellation noise
#: and not an obstacle, in m². 1 cm².
#:
#: A door leaf modelled flush in its wall shares an EDGE with the room polygon,
#: and floating point turns a shared edge into a sliver of a few µm². Subtracting
#: those slivers costs shapely a great deal and changes no answer.
MIN_OBSTACLE_AREA = 1e-4

#: Quadrant segments in the negative buffer that erodes the free-floor polygon.
#:
#: Eroding by ``r`` and asking whether anything is left is exactly the test "does
#: a disc of radius r fit", and GEOS approximates the disc with a polygon
#: INSIDE it — so the eroded region comes out slightly too large and the radius
#: slightly too generous. 16 segments per quadrant is a 64-gon, whose error is
#: ``1 − cos(π/64) = 0.12 %`` of r: 0.9 mm on a 0.75 m radius, an order below
#: `DIMENSION_TOLERANCE`. The default of 8 would be 3.6 mm, which is still
#: inside the tolerance but no longer negligible against it.
BUFFER_QUAD_SEGS = 16

#: Bisection steps for the largest inscribed circle. Over a bracket no wider
#: than a room, 40 halvings land far below any tolerance this answer carries;
#: the count is fixed rather than adaptive so the number is reproducible.
INSCRIBED_STEPS = 40

#: How far past the outer face of a wall the ground on the far side is sampled,
#: in metres.
#:
#: Far enough to clear the wall itself and the cill projecting past it — the
#: sample house's external door has a 30 mm cill projection declared — and close
#: enough that the surface found is still the one at the opening rather than the
#: garden path beyond it.
OUTSIDE_PROBE = 0.30

#: How far above an opening's underside the probe for the far-side surface
#: starts, in metres. The ray goes DOWN from there, so anything the probe finds
#: is at or below the opening's own sill: that is what makes it a surface
#: somebody could land on rather than the roof overhang above their head, which
#: is what a probe started at the opening's head finds on this very fixture
#: (2.018 m of flat roof, 30 cm outside the bedroom window).
PROBE_LIFT = 0.10

#: Horizontal reach, in metres, within which an ``IfcRailing`` counts as standing
#: AT an edge rather than merely somewhere in the building. A balustrade is built
#: on the edge it protects; a metre of slack covers a railing set back behind a
#: planter and stops one on the far side of a terrace from being credited here.
RAILING_REACH = 1.0

#: How far above the walking level a railing's own FOOT may sit and still be
#: that level's balustrade, in metres.
#:
#: Not a tolerance — a modelling allowance. A balustrade is regularly set on an
#: upstand, a kerb or a plinth, and its body then starts 50 to 300 mm above the
#: floor; a millimetre-tight test would drop it and report an unprotected edge
#: at a protected one, which is the dangerous direction. Half a metre is five
#: times any such detail and a fifth of the smallest storey pitch, so the
#: balustrade of the floor ABOVE — the thing this test exists to exclude, since
#: every storey of a building has the same plan — is never inside it.
RAILING_FOOT = 0.5

#: Host types at which an aperture is a hole in a WALL whatever its proportions,
#: and is never measured as a floor void. Subtypes are covered — the test is
#: ``entity.is_a(name)`` — so ``IfcWallStandardCase`` needs no entry of its own.
_VERTICAL_HOSTS = ("IfcWall", "IfcCurtainWall", "IfcColumn", "IfcBeam", "IfcMember")

#: Probe points across a floor void's plan rectangle, as fractions of its extent.
#:
#: Five and not one. The rectangle is a BOUNDING box: an L-shaped or a
#: stair-shaped void has solid slab inside it, and a probe that lands there
#: reads the slab's own top and reports a fall of zero. The deepest of the five
#: is taken, which is also the answer at a stairwell void whose centre happens to
#: sit over a tread — the drop past the tread is the one somebody falls.
_VOID_PROBES = ((0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75))

#: Triangles the free-floor construction may union before it refuses.
#:
#: A cost bound in the spirit of ``clearance.CLEARANCE_MAX_TRIANGLE_PAIRS``, not
#: a tolerance. Every candidate standing on the floor has each of its triangles
#: projected and unioned, and shapely's union is superlinear in the count. The
#: sample house's living room — the worst room in it, with a curtain wall, six
#: glazed panels and twelve pieces of furniture — needs under 5 000. The bound
#: sits two orders above that, because past it the honest answer is that this
#: operator wants a plan-section primitive and does not have one.
FREE_FLOOR_MAX_TRIANGLES = 500_000

#: Contact slack for the broad phase around a room, metres. The same 5 cm
#: ``operators.CONTACT`` uses, spelled separately because this one bounds a BOX
#: query and not a solid offset — a candidate list is allowed to be generous,
#: since every entry is then tested exactly against the room's footprint.
CONTACT_EXTEND = 0.05

#: The types :func:`threshold_height` will measure a step at. Deliberately not
#: :data:`~ifc_spatial.operators.FENESTRATION`: a window has no threshold, and
#: answering "0 mm" for one would be a number about nothing.
DOORWAY = {"IfcDoor", "IfcDoorStandardCase", "IfcOpeningElement"}

_NOT_A_VERDICT = (
    "Gemessene Geometrie, kein Befund: dieses Modul kennt keinen Grenzwert und wendet keinen an. "
    "Ob das gemessene Maß genügt, entscheidet die Bestimmung."
)
