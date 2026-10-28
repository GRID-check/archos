"""Escape level: which storey a person leaves a building from, judged storey by storey against the ground."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ifc_spatial.fire_constants import _GROUND_CAVEAT
from ifc_spatial.fire_constants import _NO_BUILDING_CLASS
from ifc_spatial.fire_distance import _matching_term
from ifc_spatial.fire_distance import _metres
from ifc_spatial.fire_records import StoreyJudgement

from .briefing import classify_rooms
from .envelope import Answer
from .envelope import MissingFact
from .envelope import inferred
from .envelope import undecidable
from .model import SpatialModel


def escape_level(model: SpatialModel) -> Answer[dict[str, Any]]:
    """The topmost occupied floor level above the lowest adjoining ground, in metres.

    ``Fluchtniveau`` in the OIB sense: *die Höhenlage des höchstgelegenen zum
    Aufenthalt von Menschen bestimmten Fußbodenniveaus über dem tiefer gelegenen
    anschließenden Gelände*. Both halves of that sentence are geometric, and
    neither of them is trivial.

    ## The upper half is a judgement, so it is ``inferred``

    "Zum Aufenthalt von Menschen bestimmt" is a statement about intent. Nothing
    in an IFC file settles it — a 16 m² room under the roof is a Kinderzimmer or
    a Lüftungszentrale depending on the Einreichplan. Two signals are used, both
    of them evidence and neither of them proof, **and they are ranked**:

    1. the rooms on it, classified by this package's existing room lexicon
       (:func:`~ifc_spatial.briefing.classify_rooms`) — one Aufenthaltsraum
       counts the storey, and a storey whose every room is a Neben- or
       Erschließungsfläche is not a level people stay on;
    2. only where the lexicon places nothing at all: the storey's own NAME
       against :data:`NOT_OCCUPIED_TERMS` (``Technikgeschoss``,
       ``Dachgeschoss``, ``Attika``), and then only while every unplaceable room
       name falls in that same vocabulary.

    The order is not cosmetic. Tested first, the name vetoed unconditionally and
    reported **1.00 m** instead of **3.70 m** for ``AC20-FZK-Haus.ifc``, whose
    „Dachgeschoss" holds a 107 m² Galerie — see :func:`_judge_one_storey`.

    A storey is removed only on **positive** evidence. A storey with no rooms in
    the export, or with rooms the lexicon cannot place and a name nothing
    corroborates, is COUNTED, because a Fluchtniveau reported too low is the
    dangerous direction: it understates the height the Gebäudeklasse turns on,
    and every requirement behind that classification loosens with it. Every
    storey comes back in ``storeys`` with its reason, counted or not.

    ## The lower half is a measurement with three possible references

    In priority order, and the one actually used is named in
    ``groundReference.via``:

    1. **``IfcSite`` body geometry** — the lowest point of the modelled terrain.
       The only route that measures *Gelände* at all, and the one almost no
       architectural export supports.
    2. **the lowest declared storey elevation** (``IfcBuildingStorey.Elevation``).
       This is a FLOOR level, not a terrain level; on a building with a
       basement it sits metres below the ground and the answer comes out too
       large, on a building whose ground floor is raised above the terrain it
       comes out too small.
    3. **the lowest point of the built geometry** — the underside of the lowest
       slab or footing, when no storey declares an elevation at all.

    ``RefElevation`` is deliberately NOT a route: it is defined relative to sea
    level, the geometry is not, and mixing the two produces exactly the
    tens-of-metres datum error that
    :func:`~ifc_spatial.operators._storey_datum_drift` exists to catch. It is
    reported under ``candidates`` for a human to compare, never subtracted.

    ## What this returns, and what it never returns

    A height in metres. **Never a Gebäudeklasse** — see the module docstring;
    that classification is law plus Landesrecht plus facts this file does not
    hold, and a library that emits „GK5“ has quietly applied a rule it never
    read.
    """
    method = "escape_level(model)"
    storeys = model.storeys
    if not storeys:
        return undecidable(
            from_=[],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcBuildingStorey",
                remedy=(
                    "Dieser Export enthält keine Geschoße. Geschoße im CAD anlegen und mit ihrer Höhenlage "
                    "(Elevation) mitexportieren — ohne Geschoßebenen gibt es kein Fußbodenniveau, dessen Höhe "
                    "gemessen werden könnte."
                ),
            ),
        )

    with_elevation = [s for s in storeys if s.elevation is not None]
    if not with_elevation:
        return undecidable(
            from_=[s.global_id for s in storeys],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcBuildingStorey.Elevation",
                remedy=(
                    f"Dieser Export enthält {len(storeys)} Geschoß(e), aber keines davon deklariert eine "
                    "Höhenlage. Im CAD die Geschoßhöhen setzen und neu exportieren — aus der Reihenfolge der "
                    "Geschoße allein lässt sich keine Höhe bilden, und eine geschätzte Geschoßhöhe wäre in der "
                    "Antwort nicht mehr als Schätzung erkennbar."
                ),
                elements=[s.global_id for s in storeys],
            ),
        )

    judgements = _judge_storeys(model, storeys)
    counted = [j for j in judgements if j.counted and j.elevation is not None]
    if not counted:
        return undecidable(
            from_=[j.global_id for j in judgements],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="ein Geschoß, das erkennbar zum Aufenthalt von Menschen bestimmt ist",
                remedy=(
                    "Auf keinem Geschoß dieses Exports deutet etwas auf Aufenthalt hin: entweder trägt jedes "
                    "Geschoß einen Namen aus dem Technik-/Dachbereich, oder alle Räume darauf sind Neben- und "
                    "Erschließungsflächen. Abhilfe: Räume als IfcSpace mit sprechendem Namen bzw. LongName "
                    "exportieren und Pset_SpaceCommon setzen. Die Einstufung „zum Aufenthalt bestimmt“ ist "
                    "eine Nutzungsangabe und steht nicht in der Geometrie."
                ),
                elements=[j.global_id for j in judgements],
            ),
        )

    top = max(counted, key=lambda j: (j.elevation, j.global_id))
    ground = _ground_reference(model)
    if ground is None:
        return undecidable(
            from_=[top.global_id],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="ein Geländebezug (IfcSite mit Körpergeometrie, sonst eine Geschoßhöhenlage)",
                remedy=(
                    "Weder ein Geländemodell noch eine deklarierte Geschoßhöhenlage noch auswertbare "
                    "Bauteilgeometrie ist vorhanden. Ohne einen unteren Bezugspunkt ist eine Höhe ÜBER etwas "
                    "nicht bildbar. Abhilfe: das Gelände als IfcSite mit Körpergeometrie exportieren."
                ),
            ),
        )

    value = round(float(top.elevation) - ground["z"], 4)
    because, confidence = _escape_level_reasons(judgements, top, ground)

    caveat = [_NO_BUILDING_CLASS, _GROUND_CAVEAT]
    caveat.append(
        f"Gezählt wurden {len(counted)} von {len(judgements)} Geschoß(en); maßgeblich ist "
        f"„{top.name or top.global_id}“ auf {_metres(top.elevation)}. Die vollständige Liste mit Begründung "
        "je Geschoß steht unter „storeys“ — ein Geschoß, das hier falsch eingestuft ist, lässt sich dort "
        "benennen und die Zahl mit einer Subtraktion korrigieren."
    )
    dropped = [j for j in judgements if not j.counted]
    if dropped:
        caveat.append("NICHT gezählt: " + ", ".join(f"„{j.name or j.global_id}“ ({j.why})" for j in dropped) + ".")
    caveat.append(
        "Gemessen wird auf die deklarierte Geschoßebene (Rohbau-Oberkante), nicht auf den fertigen Fußboden; "
        "ein Fußbodenaufbau darüber hebt das wirkliche Fußbodenniveau um seine Dicke an."
    )

    return inferred(
        {
            "escape_level": value,
            "topOccupiedFloor": {
                "globalId": top.global_id,
                "name": top.name,
                "elevation": top.elevation,
            },
            "groundReference": ground,
            "storeys": [j.to_dict() for j in judgements],
        },
        unit="m",
        from_=[top.global_id, *ground["from"]],
        method=method,
        confidence=confidence,
        because=because,
        caveat=" ".join(caveat),
    )


def _judge_storeys(model: SpatialModel, storeys: Sequence[Any]) -> list[StoreyJudgement]:
    """Every storey, with the occupancy call and the signal that made it.

    The room classification is taken from :func:`classify_rooms` rather than
    re-derived here, for the reason that function itself gives: two independent
    classifiers over one model is a contradiction waiting to be quoted, and this
    module would be the one quoting it.
    """
    rooms = {room.global_id: room for room in classify_rooms(model)}
    per_storey: dict[str, list[Any]] = {}
    for space in model.file.by_type("IfcSpace"):
        storey = model.storey_of(space)
        if storey is not None:
            per_storey.setdefault(storey.GlobalId, []).append(space)

    out: list[StoreyJudgement] = []
    for storey in sorted(storeys, key=lambda s: (s.elevation is None, s.elevation or 0.0, s.global_id)):
        spaces = per_storey.get(storey.global_id, [])
        described = [
            {
                "globalId": space.GlobalId,
                "name": model.label(space),
                "use": rooms[space.GlobalId].kind if space.GlobalId in rooms else None,
            }
            for space in spaces
        ]

        counted, why = _judge_one_storey(storey, described)

        out.append(
            StoreyJudgement(
                global_id=storey.global_id,
                name=storey.name,
                elevation=storey.elevation,
                counted=counted and storey.elevation is not None,
                why=(
                    why
                    if storey.elevation is not None
                    else why + ", aber dieses Geschoß deklariert keine Höhenlage und kann deshalb nicht maßgeblich sein"
                ),
                spaces=described,
            )
        )
    return out


def _judge_one_storey(storey: Any, described: Sequence[dict[str, Any]]) -> tuple[bool, str]:
    """Counted or not, and the German reason — rooms first, storey name last.

    ## The order is the fix, and it is the second time it had to be made

    The room evidence is read FIRST and the storey's own name only breaks a tie.
    Until this ordering the storey name was tested ahead of everything and
    vetoed unconditionally, which is the same mistake the comment below records
    against ROOM names, one level up: a substring is not the positive evidence
    the rule demands, and it was outranking the rooms that are.

    Measured on ``AC20-FZK-Haus.ifc``: the „Dachgeschoss" at elevation 2.70 m
    holds the 107 m² **Galerie** — two windows, a stair up to it, a 2.70 m drop
    into the living room — and was struck out because the German word for an
    attic storey contains „dach". The Fluchtniveau came back **1.00 m** instead
    of **3.70 m**, on the one number the Gebäudeklasse hangs on and in the
    direction the module docstring names as the dangerous one.

    ## Why the name still has a job, and exactly how small a one

    ``Ifc4_SampleHouse.ifc`` has a storey called „Roof" at 2.50 m whose single
    space is also called „Roof" — a bungalow, Fluchtniveau **0.00 m**, and
    counting that level would report 2.50 m for a single-storey house. Nothing
    in the lexicon places a room called „Roof", so the room evidence there is
    silent and only the names are left. So the name decides ONLY where the
    lexicon has no opinion at all, and only while the rooms do not dispute it:
    every room the lexicon could not place must itself fall in the same
    not-occupied vocabulary. „Roof" in a „Roof" corroborates; „Galerie" in a
    „Dachgeschoss" does not, and 107 m² of Galerie is precisely the thing a
    substring must not be allowed to overrule.

    Note what this is NOT: :data:`NOT_OCCUPIED_TERMS` never removes a room the
    lexicon has placed — that veto was taken out once already (see below) and
    stays out. It is read over room names only to corroborate a storey name
    where the lexicon returned nothing, and never to contradict it.

    ``AC20-Institute-Var-2.ifc`` needs none of this: its „Dachgeschoss" at
    9.00 m holds ``Dachboden-1``, ``Dachboden-2`` and a Flur, all three placed
    by the lexicon as Neben-/Erschließungsflächen, so the room branch drops it
    on room evidence alone and the Fluchtniveau stays **9.30 m**. That is the
    proof that the name was never carrying this case.
    """
    # The lexicon's classification is the whole of the positive room signal. The
    # veto that used to sit here ran `NOT_OCCUPIED_TERMS` — a STOREY vocabulary,
    # matched on substrings — over ROOM names, so a „Dachzimmer" or
    # „Attikazimmer" that `classify_rooms` had placed as `habitable_room` was
    # struck out. With no habitable room left, the branch below then read „Alle
    # Räume … sind Neben- oder Erschließungsflächen" and dropped the storey: on
    # a two-storey house whose upper storey is cleanly named „1. Obergeschoss"
    # and holds one Dachzimmer, the Fluchtniveau came back 0.000 m instead of
    # 3.500 m. That is the direction the module docstring names as the dangerous
    # one, the reason given was untrue, and a substring on a room name is not
    # the positive evidence the rule demands.
    habitable = [entry for entry in described if entry["use"] == "habitable_room"]
    placed = [entry for entry in described if entry["use"] is not None]
    unplaced = [entry for entry in described if entry["use"] is None]

    if habitable:
        return (
            True,
            f"{len(habitable)} von {len(described)} Raum/Räumen auf diesem Geschoß sind dem Lexikon "
            f"nach Aufenthaltsräume (z. B. „{habitable[0]['name']}“)",
        )
    if described and not unplaced:
        return (
            False,
            f"Alle {len(described)} Räume auf diesem Geschoß sind dem Lexikon nach Neben- oder "
            f"Erschließungsflächen (z. B. „{placed[0]['name']}“) — kein Raum, in dem sich Menschen "
            "dauernd aufhalten",
        )

    # No positive and no negative room signal. Only here does the storey name
    # count, and only while every unplaceable room name agrees with it.
    hit = _matching_term(storey.name)
    corroborating = [(entry, _matching_term(entry["name"])) for entry in unplaced]
    if hit is not None and all(term is not None for _, term in corroborating):
        if not described:
            return (
                False,
                f"Geschoßname „{storey.name}“ enthält „{hit}“ — das deutet auf ein Technik-, Dach- oder "
                "Attikageschoß und damit nicht auf Aufenthalt; ein Raum, der dem widerspräche, ist auf "
                "diesem Geschoß nicht exportiert",
            )
        return (
            False,
            f"Geschoßname „{storey.name}“ enthält „{hit}“ — das deutet auf ein Technik-, Dach- oder "
            f"Attikageschoß und damit nicht auf Aufenthalt; die Raumnamen bestätigen das "
            f"(z. B. „{corroborating[0][0]['name']}“ enthält „{corroborating[0][1]}“) und kein Raum "
            "dieses Geschoßes ist dem Lexikon nach ein Aufenthaltsraum",
        )

    if not described:
        return (
            True,
            "Auf diesem Geschoß ist kein IfcSpace exportiert — über die Nutzung sagt die Datei nichts. "
            "Im Zweifel MITGEZÄHLT: ein zu niedrig gemeldetes Fluchtniveau ist die gefährliche Richtung",
        )
    naming = (
        f"; der Geschoßname enthält zwar „{hit}“, wird aber von den Raumnamen nicht bestätigt"
        if hit is not None
        else ""
    )
    return (
        True,
        f"{len(unplaced)} von {len(described)} Raumnamen passen zu keinem Lexikoneintrag; die Nutzung "
        f"dieses Geschoßes ist damit offen{naming}. Im Zweifel MITGEZÄHLT: ein zu niedrig gemeldetes "
        "Fluchtniveau ist die gefährliche Richtung",
    )


def _ground_reference(model: SpatialModel) -> dict[str, Any] | None:
    """The lower datum, the route it came from, and every route that was available.

    ``candidates`` is not decoration. The three routes disagree by the depth of
    a foundation, and a reviewer who knows the terrain falls 1.8 m to the north
    can only substitute their own number if they can see which one was used.
    """
    candidates: list[dict[str, Any]] = []

    site_low: float | None = None
    site_id: str | None = None
    for site in model.file.by_type("IfcSite"):
        geo = model.geometry(site.GlobalId)
        if geo is None:
            continue
        low = float(geo.box[0][2])
        if site_low is None or low < site_low:
            site_low, site_id = low, site.GlobalId
    if site_low is not None and site_id is not None:
        candidates.append(
            {
                "z": round(site_low, 4),
                "via": "IfcSite-Körpergeometrie, tiefster Punkt des modellierten Geländes",
                "from": [site_id],
            }
        )

    elevations = [s for s in model.storeys if s.elevation is not None]
    if elevations:
        lowest = min(elevations, key=lambda s: (s.elevation, s.global_id))
        candidates.append(
            {
                "z": round(float(lowest.elevation), 4),
                "via": (
                    f"tiefste deklarierte Geschoßebene „{lowest.name or lowest.global_id}“ "
                    "(IfcBuildingStorey.Elevation) — eine FUSSBODENebene, kein Gelände"
                ),
                "from": [lowest.global_id],
            }
        )

    if model.bounds is not None:
        candidates.append(
            {
                "z": round(float(model.bounds[0][2]), 4),
                "via": "tiefster Punkt der Modellgeometrie (Unterkante des untersten Bauteils) — kein Gelände",
                "from": [],
            }
        )

    if not candidates:
        return None

    chosen = dict(candidates[0])
    # `RefElevation` is reported and never used: it is declared relative to SEA
    # LEVEL while every coordinate here is on the project origin, and subtracting
    # one from the other is the tens-of-metres datum error `_storey_datum_drift`
    # was written to catch. A human comparing the two numbers can spot it; an
    # operator that silently mixes them cannot be spotted at all.
    declared_elevations = [
        {
            "refElevation": float(site.RefElevation),
            "globalId": site.GlobalId,
            "via": "IfcSite.RefElevation (Meereshöhe)",
        }
        for site in model.file.by_type("IfcSite")
        if getattr(site, "RefElevation", None) is not None
    ]
    chosen["candidates"] = candidates
    chosen["nichtVerwendet"] = declared_elevations
    return chosen


def _escape_level_reasons(
    judgements: Sequence[StoreyJudgement], top: StoreyJudgement, ground: dict[str, Any]
) -> tuple[list[str], float]:
    """The `because` list and a confidence that moves for stated reasons only."""
    because = [
        f"Oberstes mitgezähltes Geschoß: „{top.name or top.global_id}“ auf {_metres(top.elevation)} ({top.why}).",
        f"Unterer Bezug: {ground['via']}, {_metres(ground['z'])}.",
        f"{sum(1 for j in judgements if j.counted)} von {len(judgements)} Geschoß(en) als zum Aufenthalt "
        "bestimmt gewertet; die Begründung je Geschoß steht in „storeys“.",
    ]
    confidence = 0.85
    if not ground["via"].startswith("IfcSite"):
        confidence -= 0.15
        because.append(
            "Kein Geländemodell in dieser Datei — der untere Bezug ist eine Bauwerkskante, nicht das "
            "anschließende Gelände."
        )
    uncertain = [j for j in judgements if j.counted and "Im Zweifel" in j.why]
    if uncertain:
        confidence -= 0.15
        because.append(
            f"{len(uncertain)} Geschoß(e) wurden ohne positives Nutzungssignal mitgezählt — das ist die "
            "vorsichtige Richtung und macht die Zahl eher zu groß als zu klein."
        )
    if top is judgements[-1] and not any(not j.counted for j in judgements):
        because.append("Kein Geschoß musste ausgeschieden werden; das oberste Geschoß ist das maßgebliche.")
    return because, round(max(0.3, confidence), 2)
