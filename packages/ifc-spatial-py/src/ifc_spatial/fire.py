"""Brandabschnitte, Trennbauteile und Grundstücksabstände — the geometry OIB 2 turns on.

:mod:`~ifc_spatial.circulation` already answers the escape-ROUTE half of OIB
Richtlinie 2 (*welcher Weg, wie lang*). This module is the other half, the one
about **compartments and distances**, and it deliberately overlaps with nothing
there:

  - :func:`escape_level` — the height of the topmost floor level intended for
    occupancy, above the lowest adjoining ground.
  - :func:`compartment_area` — the floor area a Brandabschnitt is measured on,
    over a group of spaces taken together.
  - :func:`separating_elements` — what lies BETWEEN two spaces, and the declared
    ``FireRating`` of each, including the door in the fire wall.
  - :func:`distance_to_site_boundary` — how far the building stands from the
    site boundary, for Brandübertragung auf Nachbargrundstücke.

## The line this module does not cross, and why it is drawn here

**No verdict, no threshold, and above all no Gebäudeklasse.**

:func:`escape_level` returns a HEIGHT IN METRES. Which Gebäudeklasse that height
implies is a *legal* classification: OIB Richtlinie 2 sets the bands, the
Landesrecht adopts them with its own amendments, and the classification also
depends on the number of Geschoße, the Brutto-Grundfläche and the use — none of
which is a fact about this file's geometry. A tool that answers „GK5“ has
applied a rule it never read, and the sentence it produces reads exactly like a
measurement. ``light_incidence`` refuses to supply its own 45° for the same
reason and :mod:`~ifc_spatial.circulation` refuses to know the maximum
Fluchtweglänge; this module refuses to know the Gebäudeklasse bands. The height
goes out, the classification stays with whoever signs it.

The same applies downward: :func:`separating_elements` reports the
``FireRating`` an export declares and never says whether REI 90 is *enough*, and
:func:`compartment_area` reports square metres and never compares them against
the maximum Brandabschnittsfläche.

## Two of these four are ordinarily underivable, and the module says which

Measured on this repository's five fixtures:

  - **Not one of them carries a site boundary.** All five have an ``IfcSite``
    with ``Representation = None``, and there is no ``IfcAnnotation``,
    ``IfcGeographicElement`` or ``IfcExternalSpatialElement`` in any of them.
    The sample house even carries ``RefLatitude`` — it is georeferenced and
    still has no boundary, which is the normal state of an architectural export.
    :func:`distance_to_site_boundary` therefore returns ``undecidable`` on every
    one of them, and it does **not** fall back to the site's bounding box. See
    that function's docstring for why an honest refusal is worth more than the
    number a bounding box would produce.
  - **``Ifc4_SampleHouse.ifc`` declares ``FireRating`` nowhere** — zero of its
    75 products carry the property, in any pset. That is the single most common
    finding in Austrian exports, and :func:`separating_elements` names it as a
    gap in the EXPORT rather than reporting a wall with no fire resistance.

## What is inferred here, and why it may not be anything else

"Intended for occupancy" is not measurable. A 16 m² room on the top floor is a
Büro or a Lüftungszentrale depending on what the plan says it is, and the plan
is not in the file. :func:`escape_level` therefore reuses this package's own
room lexicon (:func:`~ifc_spatial.briefing.classify_rooms`) plus the storey's
name, returns ``inferred``, and reports **every** storey it looked at with the
reason it was counted or not — so a reviewer can correct the one storey that is
wrong instead of discarding the number.

When the evidence is absent rather than negative, the storey is **counted**. A
Fluchtniveau reported too LOW is the dangerous direction: it understates the
height on which the Gebäudeklasse turns, and every requirement downstream of
that classification gets looser. Silence in an export is not evidence that a
floor is uninhabited, so silence does not remove a storey.
"""

from __future__ import annotations

from ifc_spatial.fire_compartments import compartment_area  # noqa: F401
from ifc_spatial.fire_constants import BOUNDARY_TERMS  # noqa: F401
from ifc_spatial.fire_constants import MIN_OVERLAP_AREA  # noqa: F401
from ifc_spatial.fire_constants import NOT_OCCUPIED_TERMS  # noqa: F401
from ifc_spatial.fire_constants import SEPARATION_SLACK  # noqa: F401
from ifc_spatial.fire_distance import _matching_term  # noqa: F401
from ifc_spatial.fire_distance import distance_to_site_boundary  # noqa: F401
from ifc_spatial.fire_escape import escape_level  # noqa: F401
from ifc_spatial.fire_records import SeparatingElement  # noqa: F401
from ifc_spatial.fire_records import StoreyJudgement  # noqa: F401
from ifc_spatial.fire_separation import _declares_fire_rating  # noqa: F401
from ifc_spatial.fire_separation import _fire_rating  # noqa: F401
from ifc_spatial.fire_separation import separating_elements  # noqa: F401

__all__ = [
    "BOUNDARY_TERMS",
    "MIN_OVERLAP_AREA",
    "NOT_OCCUPIED_TERMS",
    "SEPARATION_SLACK",
    "SeparatingElement",
    "StoreyJudgement",
    "compartment_area",
    "distance_to_site_boundary",
    "escape_level",
    "separating_elements",
]
