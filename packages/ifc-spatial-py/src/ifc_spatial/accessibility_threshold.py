"""Thresholds: the height of a step at a doorway, and the finishes that lift a floor above it."""

from __future__ import annotations

from typing import Any

from ifc_spatial.accessibility_constants import _NOT_A_VERDICT
from ifc_spatial.accessibility_constants import DOORWAY
from ifc_spatial.accessibility_constants import OUTSIDE_PROBE
from ifc_spatial.accessibility_floor import _frame_of
from ifc_spatial.accessibility_floor import _levels_both_sides
from ifc_spatial.accessibility_floor import _no_plane

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel
from .operators import COORDINATE_TOLERANCE
from .operators import DIMENSION_TOLERANCE
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind


def _no_footprint(model: SpatialModel, subject: Any, method: str) -> Answer[Any]:
    name = model.label(subject) or subject.GlobalId
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"keine waagrechte Fläche an {subject.is_a()} „{name}“ — kein Grundriss ableitbar",
            remedy=(
                "Dieser Körper hat keine waagrechten Flächen, aus denen sich eine Grundrissfläche bilden "
                "ließe. Bei einem Raum heißt das fast immer, dass der Raumkörper im Export beschädigt ist. "
                "Abhilfe: den Raum im CAD neu aufziehen und mit Körpergeometrie exportieren."
            ),
            elements=[subject.GlobalId],
        ),
    )


# ════════════════════════════════════════════════════════════════════════════
# 2 — threshold height
# ════════════════════════════════════════════════════════════════════════════


def threshold_height(model: SpatialModel, door_global_id: str) -> Answer[dict[str, Any]]:
    """The step at a door: the height difference between the floors on either side.

    ## The number is only as honest as what it was measured on

    Barrier-free design allows almost no step, so this is a measurement in
    millimetres — and that is exactly why it must say what it measured. Two
    caveats travel with every answer and neither is boilerplate:

    1. **The precision the export can support.** A level difference is a
       difference of two independently tessellated faces, so it carries
       ``DIMENSION_TOLERANCE`` = **10 mm**. The step a barrier-free doorway is
       allowed is of the same order. A measured 0 mm and a measured 15 mm are
       therefore *not* reliably distinguishable by this route, and the answer
       says so instead of printing three decimals and letting the reader assume
       them.
    2. **Whether there is a finished floor in the file at all.** If no
       ``IfcCovering`` of ``PredefinedType`` ``FLOORING`` exists, the levels are
       those of the room bodies and the structural slabs — the Rohbau. A 0 mm
       threshold on raw slabs says nothing whatever about the finished floor,
       because the screed, the tiles and the door seal are the things that make
       the step, and none of them is in the file. Reporting that 0 mm without
       the caveat would be the most misleading number this module could produce,
       and on this repository's own fixture it is exactly the number that comes
       out: both rooms' bodies start at z = 0.000, the ground slab's top is
       z = 0.000, and the file contains three ``IfcCovering`` — all of them
       ceilings.

    ## The declared route, which is NOT triangulated against this

    ``IfcDoorLiningProperties`` carries ``ThresholdThickness``,
    ``ThresholdDepth`` and ``ThresholdOffset``, and where they are set they are
    reported under ``declared`` — beside the measurement, never merged with it.
    They describe the threshold BOARD, not the difference in floor level, and
    triangulating one against the other would produce the expensive kind of
    wrong: a number right to the millimetre that answers a different question.
    The sample house is instructive here too — it carries an
    ``IfcDoorLiningProperties`` for each of its three doors and every attribute
    of all three is unset.

    Never a verdict: the permitted step is in the Bestimmung, not here.
    """
    method = f"thresholdHeight({door_global_id})"
    subject = _require(model, door_global_id, method)
    if subject.is_a() not in DOORWAY:
        _wrong_kind(
            subject,
            method,
            "thresholdHeight",
            "eine Tür oder eine Türöffnung (IfcDoor, IfcOpeningElement)",
            (
                "ein Fenster hat keine Schwelle — für seine Brüstung: sillAndHead(), für eine Absturzkante: "
                "balustradeCheck(); für die Höhenlage eines beliebigen Bauteils: elevation()"
            ),
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]
    frame = _frame_of(model, subject)
    if frame is None:
        return _no_plane(model, subject, method)

    sides = _levels_both_sides(model, subject, frame)
    known = [s for s in sides if s["level"] is not None]
    if len(known) < 2:
        return _one_sided(model, subject, method, sides)

    step = abs(float(known[0]["level"]) - float(known[1]["level"]))
    finishes = _floor_finishes(model)
    declared_lining = _lining_thresholds(model, subject)

    # The room body and the slab under it are two independent statements about
    # the same floor. Where they disagree the export is saying two things, and
    # the difference is usually the unmodelled build-up — which is the whole
    # subject of this operator, so it is reported and not averaged away.
    drift = [
        s
        for s in known
        if s["surface"] is not None
        and s["surface"]["gap"] is not None
        and abs(float(s["surface"]["gap"])) > COORDINATE_TOLERANCE
    ]

    payload = {
        "threshold": round(step, 4),
        "thresholdMm": round(step * 1000.0, 1),
        "sides": sides,
        "basis": "Fertigfußboden" if finishes else "Rohbau (Raumkörper bzw. Rohdecke)",
        "floorFinishes": finishes,
        "declared": declared_lining,
    }

    caveat = (
        f"{_NOT_A_VERDICT} Die Toleranz dieser Messung beträgt ±{DIMENSION_TOLERANCE * 1000:.0f} mm und liegt "
        "damit in derselben Größenordnung wie das Maß selbst: eine gemessene Differenz unterhalb der Toleranz "
        "ist von 0 mm NICHT zu unterscheiden. Ein Nachweis im Millimeterbereich lässt sich aus einem "
        "tessellierten Export grundsätzlich nicht führen — dafür ist der Detailschnitt zuständig."
    )
    if not finishes:
        caveat += (
            " Diese Datei enthält keinen Fußbodenaufbau (kein IfcCovering mit PredefinedType FLOORING). "
            "Gemessen ist damit der ROHBAU — die Unterkante der Raumkörper bzw. die Oberkante der Rohdecken. "
            "Über die Höhe des FERTIGEN Fußbodens sagt dieses Maß nichts: Estrich, Belag und Türdichtung "
            "erzeugen die Schwelle und stehen nicht in der Datei. Abhilfe: den Fußbodenaufbau als "
            "IfcCovering (FLOORING) mitexportieren."
        )
    else:
        caveat += (
            f" Diese Datei enthält {len(finishes)} Bodenbelag/Bodenbeläge als IfcCovering (FLOORING). Die hier "
            "gemeldeten Niveaus stammen trotzdem aus den Raumkörpern bzw. den Bauteilen unter ihnen — ob der "
            "Belag über oder unter der Raumunterkante liegt, ist Konvention des Exports und nicht prüfbar."
        )
    if drift:
        caveat += (
            " Raumkörper und darunterliegendes Bauteil liegen auf mindestens einer Seite nicht auf gleicher "
            "Höhe (siehe „surface.gap“). Das ist ein Befund über den Export: entweder trägt der Raum einen "
            "Aufbau, der nicht modelliert ist, oder der Raumkörper steht nicht auf seiner Decke."
        )
    if declared_lining:
        caveat += (
            " Die Datei deklariert Schwellenmaße an IfcDoorLiningProperties. Sie stehen unter „declared“ und "
            "sind NICHT mit der Messung verrechnet: sie beschreiben das Schwellenprofil, nicht den "
            "Höhenversatz der beiden Fußböden — zwei verschiedene Größen."
        )
    if any(s["space"] is None and s["level"] is not None for s in sides):
        caveat += (
            f" Auf mindestens einer Seite liegt kein IfcSpace; dort wurde das Niveau {OUTSIDE_PROBE:.2f} m vor "
            "der Öffnung mit einem Strahl nach unten bestimmt. Das ist die Oberfläche an genau diesem einen "
            "Punkt und keine Aussage über das Gelände ringsum."
        )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[door_global_id, *[s["space"] for s in sides if s["space"]]],
        method=method,
        caveat=caveat,
    )


def _one_sided(model: SpatialModel, subject: Any, method: str, sides: list[dict[str, Any]]) -> Answer[Any]:
    """One side of the door has no measurable floor at all — undecidable, with why."""
    name = model.label(subject) or subject.GlobalId
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"das Fußbodenniveau auf einer Seite von {subject.is_a()} „{name}“",
            remedy=(
                "Eine Schwelle ist die Differenz zweier Fußböden; auf einer Seite dieser Tür ist keiner "
                "bestimmbar. Auf dieser Seite liegt weder ein IfcSpace noch ein Bauteil unter der "
                f"Türunterkante ({OUTSIDE_PROBE:.2f} m vor der Öffnung nach unten geprüft). Abhilfe: den "
                "angrenzenden Raum als IfcSpace exportieren, oder das Gelände bzw. die Bodenplatte "
                "mitmodellieren — bei einer Außentür ist das der übliche Fall."
            ),
            elements=[subject.GlobalId],
        ),
    )


def _floor_finishes(model: SpatialModel) -> list[dict[str, Any]]:
    """Every ``IfcCovering`` the file marks as flooring — the finished-floor evidence."""
    try:
        coverings = model.file.by_type("IfcCovering")
    except RuntimeError:
        return []
    found = []
    for covering in coverings:
        if str(getattr(covering, "PredefinedType", "") or "").upper() != "FLOORING":
            continue
        found.append({"globalId": covering.GlobalId, "name": model.label(covering), "ifcType": covering.is_a()})
    return found


def _lining_thresholds(model: SpatialModel, door: Any) -> list[dict[str, Any]]:
    """``IfcDoorLiningProperties`` threshold attributes, where the file sets any.

    Reached through the door's type — ``IsTypedBy`` in IFC4, ``IsDefinedBy`` in
    IFC2X3 where an ``IfcDoorStyle`` carries the same property sets — because
    lining properties hang off the TYPE and not the occurrence.
    ``model.declared_property`` cannot find them: they are entity attributes,
    not pset values, and a pset search reports „nicht deklariert" about a file
    that declares them.
    """
    found: list[dict[str, Any]] = []
    types = []
    for rel in getattr(door, "IsTypedBy", []) or []:
        types.append(rel.RelatingType)
    for rel in getattr(door, "IsDefinedBy", []) or []:
        related = getattr(rel, "RelatingType", None)
        if related is not None:
            types.append(related)
    for door_type in types:
        for pset in getattr(door_type, "HasPropertySets", []) or []:
            try:
                if not pset.is_a("IfcDoorLiningProperties"):
                    continue
            except Exception:
                continue
            values = {
                name: getattr(pset, name, None) for name in ("ThresholdDepth", "ThresholdThickness", "ThresholdOffset")
            }
            if all(v is None for v in values.values()):
                continue
            found.append(
                {
                    "globalId": pset.GlobalId,
                    **{k: None if v is None else round(float(v) * model.unit_scale, 4) for k, v in values.items()},
                }
            )
    return found
