"""Balustrades: whether a drop has a railing of the required height, at its edge and along each opening."""

from __future__ import annotations

import math
from typing import Any

from ifc_spatial.accessibility_constants import _NOT_A_VERDICT
from ifc_spatial.accessibility_constants import OUTSIDE_PROBE
from ifc_spatial.accessibility_fall import _fall_through
from ifc_spatial.accessibility_fall import _railings_at
from ifc_spatial.accessibility_floor import _frame_of
from ifc_spatial.accessibility_floor import _levels_both_sides

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE
from .operators import FENESTRATION
from .operators import _require
from .operators import _wrong_kind

# ════════════════════════════════════════════════════════════════════════════
# 3 — balustrade check
# ════════════════════════════════════════════════════════════════════════════


def balustrade_check(
    model: SpatialModel, space_or_element_global_id: str, fall_height: float | None = None
) -> Answer[dict[str, Any]]:
    """Where there is a fall, how deep it is, and what stands at the edge.

    ``sillAndHead`` already measures a parapet, so the new work here is finding
    the **drop**: an opening with a floor far below on the far side. For every
    window, door and unfilled opening at this room, both standing levels are
    measured (:func:`_standing_level`) and the difference is the Absturzhöhe.
    The classic case is a window with a low sill over a two-storey drop, and it
    falls straight out of the two numbers.

    ## The height is the caller's, exactly as in :func:`turning_circle`

    ``fall_height`` defaults to ``None`` and nothing here supplies one. Without
    it every opening is reported with its measured fall and **nothing is called
    an Absturzkante** — which is coherent rather than evasive: whether a fall
    needs protecting is precisely what the parameter decides, so with no
    parameter there is no edge to protect. With it, the openings whose fall
    exceeds it are collected under ``edges`` and each carries what stands
    there.

    ## Why a missing railing is undecidable and not „kein Geländer"

    An IFC export that contains no ``IfcRailing`` at all has not told you the
    building has no railings; it has told you the exporter did not write them,
    which is extremely common — balustrades live in the architectural model as
    generic components, in a separate metalwork model, or nowhere until detail
    design. So when an edge IS found over the caller's height and the file
    contains not one ``IfcRailing``, this returns **undecidable**, with the edges
    and their measured falls spelled out in ``missing.what`` so no number is
    lost. Reporting „Absturzkante ohne Geländer" from such a file would be a
    finding about the export dressed as a finding about the building — and in
    this direction it is the finding that gets an applicant a redesign for a
    defect that is not there.

    Where the file DOES carry railings, each edge reports the ones standing
    within :data:`RAILING_REACH` of it and how high they rise above the floor
    on the inside. The parapet — the sill height over the inside floor — is
    measured either way, because a wall under a window is protection too.

    ## Two kinds of opening, two measurements — ``position``

    A hole in a WALL and a hole in a FLOOR are both Absturzkanten and they are
    not the same geometry, so every entry says which it is:

    - ``position`` „vertical" — the fall runs sideways past the opening, from the
      floor inside to the ground :data:`OUTSIDE_PROBE` in front of it, and
      ``parapet`` is the sill height over the inside floor.
    - ``position`` „horizontal" — a gallery void, a stairwell, any slab opening. The
      fall runs straight DOWN through it (:func:`_fall_through`) and ``parapet``
      is ``null``, because a hole in a floor has no Brüstung.

    Measuring the second as if it were the first is what this operator used to
    do, and on ``AC20-FZK-Haus``'s gallery void it produced „fall 0.000 m,
    parapet 2.500 m" at the one edge in the house where both of the model's
    railings stand — while the real drop from „Galerie" (floor z = 2.700) to
    „Wohnen" (floor z = 0.000) is 2.700 m. It now reads 2.700 m with both
    railings at 1.000 m over the gallery floor.

    A „horizontal" entry with ``fall = null`` is not a failed measurement: it is
    a floor void that reaches this room's list without being an edge OF this
    room — because it sits in its ceiling, or because it is somewhere else in
    the same slab. ``outside.via`` says which, in numbers.

    ## What is scanned, and what is not

    Openings: windows, doors, and openings with no filler — which is how a
    balcony door hole reaches an export, and how a gallery void does, and the
    second is measured as the floor void it is. A free floor EDGE with no
    opening in it — the unwalled side of a loggia, the open side of a ramp, a
    gallery whose void was modelled by simply not drawing slab there — is
    **not** found by this and no answer here should be read as covering it. That
    gap is named in the caveat rather than left for the reader to discover.
    """
    method = (
        f"balustradeCheck({space_or_element_global_id})"
        if fall_height is None
        else f"balustradeCheck({space_or_element_global_id}, {fall_height})"
    )
    subject = _require(model, space_or_element_global_id, method)

    if fall_height is not None:
        if (
            isinstance(fall_height, bool)
            or not isinstance(fall_height, (int, float))
            or not math.isfinite(fall_height)
            or float(fall_height) <= 0
        ):
            return undecidable(
                from_=[space_or_element_global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what="brauchbare Absturzhöhe (fallHeight > 0 m)",
                    remedy=(
                        "Ab welcher Fallhöhe eine Absturzsicherung verlangt ist, steht in der Bestimmung und "
                        "nicht im Modell — balustradeCheck() mit dem Wert der Klausel aufrufen, oder ohne "
                        "Höhe, dann werden alle gemessenen Höhenunterschiede ohne Bewertung gemeldet."
                    ),
                    elements=[space_or_element_global_id],
                ),
            )
        fall_height = float(fall_height)

    kind = model.kind_of(subject)
    if kind == "space":
        openings = _openings_at(model, subject)
        if isinstance(openings, Answer):
            return openings
    elif subject.is_a() in FENESTRATION:
        openings = [subject]
    else:
        _wrong_kind(
            subject,
            method,
            "balustradeCheck",
            "einen Raum (IfcSpace), ein Fenster, eine Tür oder eine Öffnung",
            "für eine Wand: hosts() liefert ihre Öffnungen, danach balustradeCheck() je Öffnung",
        )

    railings = _railings(model)
    results: list[dict[str, Any]] = []
    unmeasurable: list[str] = []
    for opening in openings:
        entry = _fall_at(model, opening, railings, subject if kind == "space" else None)
        if entry is None:
            unmeasurable.append(opening.GlobalId)
            continue
        results.append(entry)
    results.sort(key=lambda e: (-(e["fall"] if e["fall"] is not None else -1e9), e["globalId"]))

    edges = (
        []
        if fall_height is None
        else [e for e in results if e["fall"] is not None and e["fall"] > fall_height + DIMENSION_TOLERANCE]
    )

    if edges and not railings:
        listed = "; ".join(_edge_text(e) for e in edges)
        return undecidable(
            from_=[space_or_element_global_id, *[e["globalId"] for e in edges]],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=(
                    f"IfcRailing — diese Datei enthält kein einziges. Gemessen sind {len(edges)} Kante(n) mit "
                    f"einer Fallhöhe über {fall_height:.3f} m: {listed}. Was dort steht, ist offen."
                ),
                remedy=(
                    "Ob an diesen Kanten eine Absturzsicherung steht, ist aus diesem Export nicht zu "
                    "entnehmen: er enthält überhaupt kein IfcRailing. Das heißt NICHT, dass keine Geländer "
                    "geplant sind — Geländer fehlen in Architekturexporten regelmäßig, weil sie im "
                    "Metallbaumodell liegen oder erst in der Ausführungsplanung entstehen. Abhilfe: Geländer "
                    "als IfcRailing mitexportieren. Die gemessenen Fallhöhen und Brüstungshöhen oben gelten "
                    "unabhängig davon."
                ),
                elements=[e["globalId"] for e in edges],
            ),
        )

    payload = {
        "openings": results,
        "edges": edges,
        "fallHeight": fall_height,
        "railingsInModel": len(railings),
    }

    caveat = (
        f"{_NOT_A_VERDICT} An einer SENKRECHTEN Öffnung (lage „senkrecht“: Fenster, Tür, Wandöffnung) ist "
        f"„fall“ der gemessene Höhenunterschied zwischen dem Fußboden innen und der Fläche "
        f"{OUTSIDE_PROBE:.2f} m vor der Öffnung, „parapet“ die Höhe der Öffnungsunterkante über dem Fußboden "
        "innen. An einer WAAGRECHTEN Öffnung (lage „waagrecht“: Deckendurchbruch, Galerieöffnung) ist „fall“ "
        "der Abstand vom Fußboden am Rand der Öffnung senkrecht hinab zur tiefsten von fünf Sondierungen "
        "durch die Öffnung, und „parapet“ ist null, weil eine Bodenöffnung keine Brüstung hat. Welche "
        "Fallhöhe eine Absturzsicherung verlangt und wie hoch sie sein muss, steht in der Bestimmung."
    )
    if fall_height is None:
        caveat += (
            " Ohne fallHeight ist keine Kante als Absturzkante ausgewiesen — die Grenze kommt aus der "
            "Bestimmung, deshalb sind hier nur die gemessenen Höhenunterschiede aufgeführt."
        )
    if not railings:
        caveat += (
            " Diese Datei enthält kein IfcRailing. Solange keine Kante die vorgegebene Fallhöhe überschreitet, "
            "ist das folgenlos; überschreitet eine, ist nicht bestimmbar, was dort steht."
        )
    caveat += (
        " Gesucht wird an ÖFFNUNGEN — Fenstern, Türen und ungefüllten Öffnungen. Eine freie Bodenkante ohne "
        "Öffnung (die offene Seite einer Loggia, ein Galeriedurchbruch ohne IfcOpeningElement) wird hier "
        "NICHT gefunden; diese Antwort ist keine Vollständigkeitsaussage über die Absturzkanten des Gebäudes."
    )
    if unmeasurable:
        caveat += (
            f" {len(unmeasurable)} Öffnung(en) ohne senkrechte Ebene oder ohne bestimmbares Niveau auf einer "
            "Seite sind nicht enthalten — die Liste ist insofern unvollständig."
        )
    without_fall = [e for e in results if e["fall"] is None]
    if without_fall:
        caveat += (
            f" {len(without_fall)} waagrechte Öffnung(en) sind mit fall = null aufgeführt: sie liegen in der "
            "DECKE dieses Raums oder überhaupt nicht an ihm — von hier aus führt durch sie kein Absturz. Der "
            "Grund steht je Öffnung unter outside.via; gemessen wird die Fallhöhe an dem Raum, dessen "
            "Fußboden an der Öffnung endet."
        )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[space_or_element_global_id, *[e["globalId"] for e in results]],
        method=method,
        caveat=caveat,
    )


def _edge_text(edge: dict[str, Any]) -> str:
    """One edge, spelled out for ``missing.what``.

    The measurement does not disappear because the answer is undecidable: an
    ``undecidable`` carries no value by contract, so the falls and parapets that
    WERE measured are written into the German sentence the architect reads.
    Dropping them would turn a partial answer into no answer.
    """
    if edge["parapet"] is not None:
        parapet = f"Brüstungshöhe {edge['parapet']:.3f} m"
    elif edge.get("position") == "horizontal":
        parapet = "keine Brüstung (waagrechte Öffnung im Boden)"
    else:
        parapet = "Brüstungshöhe nicht messbar"
    return (
        f"{edge['ifcType']} „{edge['name'] or edge['globalId']}“ ({edge['globalId']}): "
        f"Fallhöhe {edge['fall']:.3f} m, {parapet}"
    )


def _openings_at(model: SpatialModel, space: Any) -> list[Any] | Answer[Any]:
    """Windows, doors and unfilled holes at this room.

    The filled ones come off ``bounds()``; the unfilled ones off the bounding
    walls' ``hosts()``, because an opening with no filler is a HOLE and a hole is
    the purest form of the edge this operator is looking for.
    """
    from .operators import bounds
    from .operators import hosts

    bounding = bounds(model, space.GlobalId)
    if not bounding.decidable:
        return bounding
    found: dict[str, Any] = {}
    for ref in bounding.value or []:
        if ref.ifc_type in FENESTRATION:
            found[ref.global_id] = model.file.by_guid(ref.global_id)
            continue
        holes = hosts(model, ref.global_id)
        if not holes.decidable or not holes.value:
            continue
        for hole in holes.value:
            opening = model.file.by_guid(hole.global_id)
            if getattr(opening, "HasFillings", None):
                continue
            found[hole.global_id] = opening
    return [found[key] for key in sorted(found)]


def _railings(model: SpatialModel) -> list[Any]:
    try:
        return [r for r in model.file.by_type("IfcRailing") if getattr(r, "GlobalId", None)]
    except RuntimeError:
        # A schema that has never heard of IfcRailing is not a file without
        # railings; both are handled the same way by the caller, which reports
        # the absence as undecidable rather than as an answer.
        return []


def _fall_at(model: SpatialModel, opening: Any, railings: list[Any], space: Any | None = None) -> dict[str, Any] | None:
    """One opening: the levels on both sides, the parapet, and what stands outside.

    ``space`` is the room the caller asked about, when it asked about a room. It
    is not used for a wall opening — the two sides speak for themselves — and it
    decides everything for a hole in a floor, which is a fall for the room ABOVE
    it and a hole in the ceiling for the room below. See :func:`_fall_through`.
    """
    frame = _frame_of(model, opening)
    if frame is None:
        return _fall_through(model, opening, railings, space)
    sides = _levels_both_sides(model, opening, frame)
    known = [s for s in sides if s["level"] is not None]
    if len(known) < 2:
        return None

    # "Inside" is the side with the room on it; with rooms on both sides the
    # higher floor is inside, because the fall is measured from where somebody
    # stands down to where they land.
    with_space = [s for s in sides if s["space"] is not None]
    if len(with_space) == 1:
        inside = with_space[0]
    else:
        inside = max(known, key=lambda s: float(s["level"]))
    outside = next(s for s in sides if s is not inside)
    if outside["level"] is None:
        return None

    fall = float(inside["level"]) - float(outside["level"])
    parapet = round(frame.z_min - float(inside["level"]), 4)
    sign = 1.0 if outside["direction"][0] * frame.normal[0] + outside["direction"][1] * frame.normal[1] > 0 else -1.0

    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": round(fall, 4),
        "parapet": parapet,
        "position": "vertical",
        "inside": inside,
        "outside": outside,
        "railings": _railings_at(model, frame, sign, float(inside["level"]), railings),
    }
