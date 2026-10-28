"""Tolerances and vocabulary the operators share: the numbers that decide an answer, each named once."""

from __future__ import annotations

# ── the error model, ported verbatim from metric.ts ─────────────────────────

#: One coordinate off a tessellated solid, in metres. Covers the kernel's chord
#: deviation on curved surfaces plus the millimetre sloppiness of ordinary
#: authoring. A stated assumption, not a measurement of this kernel.
COORDINATE_TOLERANCE = 0.005
#: A linear dimension: ``max − min`` subtracts two independently tessellated
#: faces, so both errors are in it.
DIMENSION_TOLERANCE = 2 * COORDINATE_TOLERANCE
#: Areas, relative. 1 % of a 50 m² room is what 5 mm of edge error over a ~30 m
#: perimeter actually produces.
AREA_RELATIVE_TOLERANCE = 0.01
#: A compass bearing, in degrees.
AZIMUTH_TOLERANCE_DEGREES = 3
#: Tessellation error on a surface-based measurement, metres.
TESSELLATION_TOLERANCE = 0.005
#: Tolerance on a measurement taken from a bounding box instead of surfaces.
BOX_TOLERANCE = 0.05
#: Below this, an intrusion into a volume is tessellation noise, metres.
MIN_INTRUSION = 0.005
#: Contact tolerance for the exact solid proximity queries, metres. Five
#: centimetres rather than the TS derivation's thirty, because ``tree.select``
#: tests real solids and not bounding boxes.
CONTACT = 0.05
#: |cos| between the facade normal and the direction out of the plan centre,
#: below which "outward" is not established.
OUTWARD_MIN_DOT = 0.15
#: Minimum distance from the plan centre for the outward test to mean anything.
OUTWARD_MIN_SPAN = 0.25

#: German 16-point compass, in the notation an Austrian or German architect
#: writes: **O** for east, not E.
COMPASS = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

#: The types :func:`sill_and_head` will measure. ``IfcOpeningElement`` is in the
#: list deliberately: an agent chaining off ``hosts()`` holds the opening's id.
FENESTRATION = {
    "IfcWindow",
    "IfcWindowStandardCase",
    "IfcDoor",
    "IfcDoorStandardCase",
    "IfcOpeningElement",
}

#: Excluded from the clear-height scan. A chair is not a Raumhöhe.
FURNISHING = ("IfcFurnishingElement", "IfcFurniture", "IfcSystemFurnitureElement")

# The IFC relation behind each answer, and what to tell the architect. Lifted
# verbatim from topology.ts so that the same gap produces the same German
# sentence whichever engine discovered it.
_RELATIONS = {
    "voids": ("IfcRelVoidsElement", "Öffnungen und Füllungen mitexportieren"),
    "fills": ("IfcRelFillsElement", "Öffnungen und Füllungen mitexportieren"),
    "interfaceOf": (
        "IfcRelSpaceBoundary",
        "Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung",
    ),
    "connects": (
        "IfcRelConnectsElements / IfcRelConnectsPathElements",
        "Bauteilverbindungen mitexportieren — viele Exporte lassen sie weg",
    ),
    "containsElement": (
        "IfcRelContainedInSpatialStructure",
        "Bauteile der Ebene bzw. dem Raum zuordnen und die räumliche Struktur mitexportieren",
    ),
}

_DERIVED_BOUNDARY_CAVEAT = (
    "Aus der Geometrie abgeleitet (geom.tree.select, Berührungstoleranz {contact:.2f} m), nicht in der Datei "
    "deklariert: dieser Export enthält keine IfcRelSpaceBoundary. Die gemessenen Beziehungen tragen eine "
    "Toleranz und können danebenliegen."
)


#: Element classes that can only ever separate two spaces horizontally.
#:
#: A shared one of these means the rooms are STACKED, not adjacent. Kept as a
#: type list rather than a geometric test because the geometric test costs a
#: triangulation per candidate and this runs inside a loop over every space.
_HORIZONTAL_SEPARATORS = ("IfcSlab", "IfcRoof", "IfcCovering")


#: How far a room centroid must sit off an element's plane to count as a side.
#:
#: A room whose centroid lands essentially ON the plane says nothing about which
#: side it is on, and the commonest way that happens is a space modelled to the
#: wall's centre line rather than its face. Ignored rather than guessed.
SIDE_TOLERANCE = 0.05
