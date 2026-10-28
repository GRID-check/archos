"""The turning circle a wheelchair needs in a room, measured on its free floor."""

from __future__ import annotations

import math
from typing import Any

from ifc_spatial.accessibility_constants import _NOT_A_VERDICT
from ifc_spatial.accessibility_floor import _free_floor
from ifc_spatial.accessibility_floor import _largest_circle
from ifc_spatial.accessibility_threshold import _no_footprint

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind

# ════════════════════════════════════════════════════════════════════════════
# 1 — turning circle
# ════════════════════════════════════════════════════════════════════════════


def turning_circle(model: SpatialModel, space_global_id: str, diameter: float | None = None) -> Answer[dict[str, Any]]:
    """The largest circle that fits in this room's clear floor, and where it sits.

    The Bewegungsfläche question, as geometry: the room's own footprint polygon,
    less the plan shadow of everything standing on it, eroded until nothing is
    left. See :func:`_largest_circle` for why erosion IS the inscribed-circle
    test rather than an approximation of it, and :func:`_free_floor` for what
    gets subtracted.

    ## The diameter, and why it is optional rather than required

    ``diameter`` defaults to ``None`` and this module never supplies one. OIB 4
    names 1.50 m; that number is a fact about the clause and writing it as a
    default here would make this file believe in it.

    The choice against a hard refusal — the one ``light_incidence`` makes about
    its 45° — is deliberate and rests on a difference between the two questions.
    A light prism without an angle is not a smaller answer, it is no geometry at
    all: there is nothing to build and nothing to report, so refusing is the only
    honest move. A turning circle without a diameter is a complete measurement —
    *the largest circle that fits is 3.46 m and its centre is here* — and that
    number is useful, checkable and clause-free. Refusing to hand it over would
    withhold a measurement in order to enforce a parameter it does not need.

    When a diameter IS given it adds one field, ``requested.fits``, which is a
    comparison of two measured lengths and not a verdict: it says the circle fits
    on this geometry, not that the room complies. A nonsensical diameter is
    refused outright rather than silently clamped.

    ## What was counted, which is a judgment and not a measurement

    ``value["diameter"]`` counts **fixed** obstruction only — walls intruding,
    columns, stairs, the door leaf as modelled. Loose furniture
    (``IfcFurnishingElement`` and its subtypes) is reported in the parallel
    ``mitMoeblierung`` block and is NOT in the headline, because a permit is
    granted on the building and the piano in this fixture's living room was
    placed by whoever made the visualisation. IFC carries no fixed/loose flag at
    all, so the split is by entity type: a built-in wardrobe exported as
    ``IfcFurniture`` lands on the loose side and the caveat says so.

    Measured on ``Ifc4_SampleHouse``: bedroom 3.463 m fixed / 2.478 m furnished,
    living room 5.606 / 4.402, entrance hall 1.953 / 1.953. The bedroom's fixed
    figure is its own clear width to the millimetre, which is the check that the
    polygon is the room and not something near it.

    ## What this does not see

    The shadow is taken over the full height of each obstacle, so a wall cabinet
    hung clear of the floor is not counted (it fails the floor-contact test) and
    a table is counted over its whole top (a footrest fits under it). The first
    error makes the circle too large and the second too small; both are named in
    the caveat, because a clearance whose error direction is invisible cannot be
    argued with.
    """
    method = (
        f"turningCircle({space_global_id})" if diameter is None else f"turningCircle({space_global_id}, {diameter})"
    )
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        _wrong_kind(
            subject,
            method,
            "turningCircle",
            "einen Raum (IfcSpace)",
            "für die freie Fläche vor einer Tür: clearApproach(); für ein lichtes Maß: clearOpeningWidth()",
        )

    if diameter is not None:
        if isinstance(diameter, bool) or not isinstance(diameter, (int, float)) or not math.isfinite(diameter):
            diameter = float("nan")
        if not (0 < float(diameter) < 100):
            return undecidable(
                from_=[space_global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what="brauchbarer Durchmesser (0 m < diameter < 100 m)",
                    remedy=(
                        "Der Durchmesser der Bewegungsfläche stammt aus der Bestimmung, nicht aus dem Modell — "
                        "turningCircle() mit dem Wert der Klausel aufrufen, oder ohne Durchmesser, dann wird "
                        "nur der größte einbeschriebene Kreis gemeldet."
                    ),
                    elements=[space_global_id],
                ),
            )
        diameter = float(diameter)

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    free = _free_floor(model, subject)
    if isinstance(free, Answer):
        return free
    if free is None:
        return _no_footprint(model, subject, method)

    fixed = _largest_circle(free.fixed)
    furnished = _largest_circle(free.furnished)
    if fixed is None:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine freie Bodenfläche in „{model.label(subject) or space_global_id}“",
                remedy=(
                    "Die Grundrissfläche dieses Raums ist von Bauteilen vollständig überdeckt. Das ist fast "
                    "immer ein Befund über den Export — ein Bauteil, dessen Körper den ganzen Raum füllt — "
                    "und selten über den Raum. bounds() zeigt, was den Raum begrenzt."
                ),
                elements=[space_global_id],
            ),
        )

    loose = [o for o in free.obstacles if o["counts"] == "furnished"]
    payload: dict[str, Any] = {
        "diameter": round(2 * fixed[0], 4),
        "radius": round(fixed[0], 4),
        "centre": [round(fixed[1][0], 4), round(fixed[1][1], 4), round(free.floor_z, 4)],
        "freeArea": round(float(free.fixed.area), 4),
        "footprintArea": round(float(free.footprint.area), 4),
        "counted": "feste Einbauten (alles außer IfcFurnishingElement und Untertypen)",
        "mitMoeblierung": None
        if furnished is None
        else {
            "diameter": round(2 * furnished[0], 4),
            "radius": round(furnished[0], 4),
            "centre": [round(furnished[1][0], 4), round(furnished[1][1], 4), round(free.floor_z, 4)],
            "freeArea": round(float(free.furnished.area), 4),
            "pieces": len(loose),
        },
        "obstacles": free.obstacles,
        "requested": None
        if diameter is None
        else {
            "diameter": diameter,
            "fits": bool(2 * fixed[0] + DIMENSION_TOLERANCE >= diameter),
            "fitsWithFurnishing": None
            if furnished is None
            else bool(2 * furnished[0] + DIMENSION_TOLERANCE >= diameter),
        },
    }

    caveat = (
        f"{_NOT_A_VERDICT} Gemeldet ist der größte Kreis, der in die freie Bodenfläche passt, mit seinem "
        "Mittelpunkt — nachprüfbar im Grundriss. Abgezogen sind die Grundrissschatten der FESTEN Bauteile, "
        "die bis auf den Fußboden reichen; lose Möblierung steht getrennt unter „mitMoeblierung“ und ist im "
        "Hauptwert NICHT enthalten. IFC kennt kein Merkmal fest/lose — die Trennung erfolgt allein über den "
        "Bauteiltyp, ein als IfcFurniture exportierter Einbauschrank zählt hier deshalb als lose."
    )
    if loose:
        caveat += f" In diesem Raum stehen {len(loose)} Möbel; ohne sie ist der Kreis um "
        caveat += (
            f"{2 * fixed[0] - 2 * furnished[0]:.3f} m größer." if furnished else "einen nicht messbaren Betrag größer."
        )
    caveat += (
        " Der Schatten eines Hindernisses wird über seine volle Höhe genommen: ein Tisch wird über die ganze "
        "Tischplatte abgezogen, obwohl Fußstützen darunter passen (das Maß ist insofern zu KLEIN), und ein "
        "frei über dem Boden hängender Einbau wird gar nicht gezählt (insofern zu GROSS). Ein Türblatt zählt "
        "in der Lage, in der es modelliert ist — in den meisten Exporten geschlossen, der Schwenkbereich "
        "ist damit nicht berücksichtigt."
    )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[space_global_id, *[o["globalId"] for o in free.obstacles]],
        method=method,
        caveat=caveat,
    )
