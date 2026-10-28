"""Blind spots: what the model cannot say, found from its geometry and its declarations."""

from __future__ import annotations

from ifc_spatial.briefing_reading import _georeferenced
from ifc_spatial.briefing_reading import _hosts_of
from ifc_spatial.briefing_reading import _products_with_representation
from ifc_spatial.briefing_records import BlindSpot
from ifc_spatial.briefing_rooms import _by_type
from ifc_spatial.briefing_rooms import _spaces_of

from .model import SpatialModel

# ── blind spots ─────────────────────────────────────────────────────────────


def find_blind_spots(model: SpatialModel, dialect_sample: int | None = None) -> list[BlindSpot]:
    """What this file cannot answer, worked out before anybody asks.

    The point is to move the discovery of a gap from the end of a long agent
    turn to the beginning of it. An agent told up front that this export wrote
    no space boundaries does not spend six tool calls finding out, and does not
    report "the building has no rooms" when the truth is "this export omitted a
    relation".

    Every test below is a read of the file, not of a graph: ``by_type`` for the
    relation entities, ``TrueNorth`` and ``IfcMapConversion`` for the two
    orientation facts, and the model's own record of whether the geometry pass
    has run.
    """
    spots: list[BlindSpot] = []
    spaces = len(_spaces_of(model))
    fillers = len(_by_type(model, "IfcWindow")) + len(_by_type(model, "IfcDoor"))
    boundaries = len(_by_type(model, "IfcRelSpaceBoundary"))
    fills = len(_by_type(model, "IfcRelFillsElement"))

    if spaces == 0:
        spots.append(
            BlindSpot(
                what="keine IfcSpace-Elemente",
                consequence="Raumflächen, Raumtiefen und alles je Aufenthaltsraum sind nicht ableitbar",
                remedy="Räume im CAD als IfcSpace exportieren",
            )
        )
    if boundaries == 0 and spaces > 0:
        spots.append(
            BlindSpot(
                what="keine IfcRelSpaceBoundary",
                consequence=(
                    "welche Wände einen Raum begrenzen und welche Räume aneinandergrenzen ist nicht deklariert"
                ),
                remedy=("Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung"),
            )
        )
    if fills == 0 and fillers > 0:
        spots.append(
            BlindSpot(
                what="keine IfcRelFillsElement",
                consequence=f"{fillers} Fenster/Türen lassen sich keiner Wand zuordnen",
                remedy="Öffnungen und Füllungen mitexportieren",
            )
        )
    elif fillers > 0:
        # The relation exists — but existing and RESOLVING are different facts,
        # and only the second one answers "which wall is this window in". A file
        # with fills for the doors and none for the windows passes the test
        # above and still cannot answer the question for a window.
        unresolved = sum(1 for e in [*_by_type(model, "IfcWindow"), *_by_type(model, "IfcDoor")] if not _hosts_of(e))
        if unresolved > 0:
            spots.append(
                BlindSpot(
                    what=f"{unresolved} von {fillers} Fenstern/Türen ohne auflösbare Wandzuordnung",
                    consequence=(
                        "für diese Öffnungen ist hostedIn() nicht beantwortbar — die Datei schreibt "
                        "IfcRelFillsElement, aber nicht für sie"
                    ),
                    remedy="Öffnungen und Füllungen für ALLE Fenster/Türen mitexportieren",
                )
            )
    if model.true_north is None:
        spots.append(
            BlindSpot(
                what="keine Nordrichtung",
                consequence="Fassadenorientierung (Süd/Nord) ist nicht bestimmbar",
                remedy="TrueNorth im IfcGeometricRepresentationContext setzen",
            )
        )
    if not _georeferenced(model):
        spots.append(
            BlindSpot(
                what="keine Georeferenzierung",
                consequence=(
                    "Sonnenstand und Besonnung sind nicht berechenbar (der geometrische 45°-Nachweis bleibt möglich)"
                ),
                remedy="IfcMapConversion bzw. RefLatitude/RefLongitude setzen",
            )
        )
    spots.extend(_geometry_blind_spots(model))
    if dialect_sample is not None:
        spots.append(
            BlindSpot(
                what=f"Dialekt aus einer Stichprobe von {dialect_sample} Bauteilen",
                consequence="Befüllungsgrade sind Anteile der Stichprobe, nicht des Modells",
                remedy="dialect_sample_size erhöhen",
            )
        )
    return spots


def _geometry_blind_spots(model: SpatialModel) -> list[BlindSpot]:
    """The geometry-related blind spots, which depend on whether geometry ran.

    ## The bug this shape exists to kill

    The TS ``findBlindSpots`` used to append, unconditionally,

        keine Geometrie in dieser Ausbaustufe → Abstände, lichte Maße,
        Auskragungen, Flächen aus Geometrie und der freie Lichteinfall sind noch
        nicht berechenbar

    because the list was assembled in ``buildGraph``, which by construction runs
    before the geometry pass. Every model the library opened therefore carried a
    sentence telling the reader that the geometric answers were impossible —
    printed under ``BLIND``, in front of an agent whose whole job is to decide
    what it can and cannot answer. A false "undecidable" is the exact failure
    this library was built to end, and the library was emitting one about
    itself on every file.

    So this asks the model. ``SpatialModel`` is lazy: the pass runs on the first
    model-wide question and not before, and ``geometry_seconds`` is the record
    of whether it has. When it has not, the blind spot says exactly that and
    names the remedy as a call rather than as a re-export — because nothing is
    missing from the file.

    ## And the mirror-image bug, which it then had

    „sie sind aber berechenbar, dieser Export trägt Geometrie" was emitted
    unconditionally, on files that contain no body at all. Four of the five
    fixtures — ``house-with-rooms.ifc``, ``units-feet.ifc``,
    ``floor-slab-and-window.ifc`` and ``road-ifc4x3.ifc`` — carry a
    ``Representation`` on **0** of their ``IfcProduct`` entities, and every one
    of them was told the geometric answers were only a call away. A false
    capability claim in the block whose whole job is to say what the file cannot
    answer is the same failure as the false „undecidable", pointing the other
    way: it costs the agent a geometry pass and a turn, and it propagates into
    the IDS summary.

    The honest test is one attribute read per product and no kernel work: does
    any ``IfcProduct`` carry a ``Representation`` at all.
    """
    if model.geometry_seconds <= 0:
        with_body = _products_with_representation(model)
        if with_body == 0:
            return [
                BlindSpot(
                    what="keine Körpergeometrie in dieser Datei (kein IfcProduct trägt eine Representation)",
                    consequence=(
                        "Abstände, lichte Maße, Auskragungen, Flächen aus Geometrie und der freie "
                        "Lichteinfall sind aus dieser Datei NICHT berechenbar — auch nicht nach einem "
                        "Geometrie-Pass. Der Export enthält nur Topologie und Eigenschaften"
                    ),
                    remedy=(
                        "Das Modell mit Körpergeometrie neu exportieren (Body-Repräsentation, kein reiner "
                        "Struktur- bzw. Eigenschaftsexport)"
                    ),
                )
            ]
        return [
            BlindSpot(
                what="Geometrie-Pass noch nicht gelaufen (nur Topologie gelesen)",
                consequence=(
                    "Abstände, lichte Maße, Auskragungen, Flächen aus Geometrie und der freie Lichteinfall "
                    f"sind noch nicht berechnet — sie sind aber berechenbar, {with_body} Bauteil(e) in "
                    "diesem Export tragen Geometrie"
                ),
                remedy=(
                    "measure/distance aufrufen — der Geometrie-Pass läuft dann automatisch "
                    "(einmalig ~2 s für ein Einfamilienhaus)"
                ),
            )
        ]

    spots: list[BlindSpot] = []
    spaces = _spaces_of(model)
    without_solid = [s for s in spaces if model.geometry(s.GlobalId) is None]
    if spaces and without_solid:
        spots.append(
            BlindSpot(
                what=f"{len(without_solid)} von {len(spaces)} Räumen ohne Volumenkörper",
                consequence=(
                    "für diese Räume sind Grundfläche, lichte Höhe und die aus Geometrie abgeleiteten "
                    "Raumbegrenzungen nicht bestimmbar — die Räume existieren, ihre Geometrie wurde nicht "
                    "exportiert oder nicht ausgewertet"
                ),
                remedy="Räume mit Körpergeometrie (Body-Representation) exportieren",
            )
        )
    return spots
