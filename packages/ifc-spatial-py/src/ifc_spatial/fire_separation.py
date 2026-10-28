"""Separating elements: the walls, floors and doors that keep a fire in its compartment, and their fire ratings."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from ifc_spatial.fire_constants import _FIRE_RATING_MEMO
from ifc_spatial.fire_constants import SEPARATION_SLACK
from ifc_spatial.fire_records import SeparatingElement

from . import operators as op
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import undecidable
from .model import SpatialModel


def separating_elements(model: SpatialModel, space_a: str, space_b: str) -> Answer[dict[str, Any]]:
    """The elements between two spaces — the wall, the slab, and the door in it.

    :func:`~ifc_spatial.operators.bounds` gives each space's boundary; this is
    their INTERSECTION, plus the two things an intersection alone gets wrong.

    ## A shared bounding element is not necessarily a separating one

    A continuous south facade bounds every room along it and separates none of
    them. So each shared element is classified rather than reported flat, by two
    independent geometric tests, and an element passing **either** is
    ``separating``:

    1. **Achsentest** — the two room bodies are disjoint along one axis, and the
       element lies inside that gap (within :data:`SEPARATION_SLACK`) while
       overlapping both rooms on the other two. This is what catches the
       partition and misses the facade.
    2. **Sichtlinie** — the straight segment between the two room centroids
       passes through the element's body. This catches the floor slab between a
       room and the room above it, where the gap is zero-width and the slab's
       body reaches into the space solid.

    Either test alone loses a real fire wall on ordinary geometry, and losing
    one is the dangerous direction, so the union is taken and every element says
    which test found it. Elements that pass neither are still reported, under
    ``shared`` with their reason — nothing is dropped silently.

    When the spaces carry no body at all (a topology-only export), no test can
    run: the shared bounding elements are reported as ``separating`` with
    ``why`` saying betweenness was **not** checked. Excluding an element on no
    evidence would be worse.

    ## The openings, because the door is the weak point

    For every separating element the opening chain is walked
    (:func:`~ifc_spatial.operators.hosts` → ``filler_of``) and each filler comes
    back under ``openings`` with its OWN declared ``FireRating``. A REI 90
    wall with an undeclared door in it is a finding, and it is invisible if only
    the wall is reported.

    ## FireRating, and the sentence that is worth more than a number

    Every element carries ``Pset_*Common.FireRating`` exactly as declared, and
    ``None`` when no pset carries it — searched across all psets and inherited
    from the type, because the SET the property lands in is not standardised.
    ``Ifc4_SampleHouse.ifc`` declares it on **none** of its 75 products, which
    is the most common finding in Austrian exports and the reason the caveat
    says so in full rather than leaving an empty field to be read as "kein
    Feuerwiderstand".

    A property present but EMPTY is not a declaration either, and is reported as
    if it were absent — see :func:`_fire_rating`. ``AC20-FZK-Haus.ifc`` carries
    ``FireRating = ''`` on four ArchiCAD placeholders and nothing else; reading
    those as declarations turned a finding about the export into a finding about
    the design.

    No verdict: whether REI 90 is sufficient is a question about the
    Bestimmung, and the Bestimmung answers it.
    """
    method = f"separatingElements({space_a}, {space_b})"
    first = op._require(model, space_a, method)
    second = op._require(model, space_b, method)

    for subject in (first, second):
        if model.kind_of(subject) != "space":
            op._wrong_kind(
                subject,
                method,
                "separatingElements",
                "zwei Räume (IfcSpace)",
                "für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt",
            )
    if space_a == space_b:
        return undecidable(
            from_=[space_a],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="zweimal derselbe Raum übergeben",
                remedy=(
                    "separatingElements() braucht zwei verschiedene Räume. Für die begrenzenden Bauteile eines "
                    "einzelnen Raums: bounds()."
                ),
                elements=[space_a],
            ),
        )

    bounds_a = op.bounds(model, space_a)
    bounds_b = op.bounds(model, space_b)
    for answer in (bounds_a, bounds_b):
        if not answer.decidable or answer.value is None:
            return answer  # type: ignore[return-value]

    by_id = {ref.global_id: ref for ref in bounds_a.value}
    shared = [by_id[ref.global_id] for ref in bounds_b.value if ref.global_id in by_id]

    geo_a = model.geometry(space_a)
    geo_b = model.geometry(space_b)
    testable = geo_a is not None and geo_b is not None
    axis = _separating_axis(geo_a, geo_b) if testable else None

    walls: list[SeparatingElement] = []
    alongside: list[SeparatingElement] = []
    openings: list[dict[str, Any]] = []
    seen_openings: set[str] = set()
    #: Fenestration the BOUNDARIES named directly, held back until the void
    #: chains have been walked. Order matters: the chain knows which wall the
    #: door sits in and a 2nd-level boundary does not, so processing the chain
    #: first is what puts a host in `inBauteil` instead of a null.
    from_boundaries: list[Any] = []

    for ref in sorted(shared, key=lambda r: r.global_id):
        element = model.file.by_guid(ref.global_id)
        rating = _fire_rating(model, element)
        compartmentation = model.declared_property(element, ("Compartmentation",))
        role, why = _classify(model, element, geo_a, geo_b, axis, testable)
        entry = SeparatingElement(
            global_id=ref.global_id,
            name=ref.name,
            ifc_type=ref.ifc_type,
            role=role,
            why=why,
            fire_rating=rating,
            compartmentation=compartmentation if isinstance(compartmentation, bool) else None,
        )
        if element.is_a() in op.FENESTRATION and role == "separating":
            # A door found through the boundaries is an OPENING in this answer,
            # never a separating element in its own right: listing it in both
            # places would let a reader count one door as two barriers. A
            # fenestration element that is only `shared` still goes to
            # `alongside` below — nothing leaves this loop unreported.
            from_boundaries.append(element)
            continue
        (walls if role == "separating" else alongside).append(entry)

    for entry in walls:
        for opening in _openings_in(model, entry.global_id):
            if opening["globalId"] in seen_openings:
                continue
            seen_openings.add(opening["globalId"])
            openings.append(opening)

    for element in from_boundaries:
        if element.GlobalId in seen_openings:
            continue
        seen_openings.add(element.GlobalId)
        openings.append(_opening_entry(model, element, host=None, via="als Raumgrenze deklariert"))

    missing_rating = [e.global_id for e in walls if e.fire_rating is None]
    missing_rating += [o["globalId"] for o in openings if o["fireRating"] is None]

    caveat = _separating_caveat(model, walls, alongside, openings, missing_rating, testable, axis, bounds_a, bounds_b)
    value = {
        "spaceA": model.ref(first).to_dict(),
        "spaceB": model.ref(second).to_dict(),
        "separating": [entry.to_dict() for entry in walls],
        "shared": [entry.to_dict() for entry in alongside],
        "openings": openings,
        "ohneFeuerwiderstand": missing_rating,
    }
    from_ = [space_a, space_b, *[entry.global_id for entry in walls], *[o["globalId"] for o in openings]]
    if bounds_a.provenance == "declared" and bounds_b.provenance == "declared":
        return declared(value, from_=from_, method=method, caveat=caveat)
    return computed(value, from_=from_, method=method, caveat=caveat)


def _separating_axis(geo_a: Any, geo_b: Any) -> tuple[int, float, float] | None:
    """The one axis the two bodies are disjoint on, and the gap between them.

    ``None`` when they overlap on every axis (interpenetrating rooms — a finding
    in itself) or on more than one (diagonal neighbours, which share a corner
    and no separating element).
    """
    a_low, a_high = geo_a.box
    b_low, b_high = geo_b.box
    gaps: list[tuple[int, float, float]] = []
    for i in range(3):
        if float(a_high[i]) <= float(b_low[i]):
            gaps.append((i, float(a_high[i]), float(b_low[i])))
        elif float(b_high[i]) <= float(a_low[i]):
            gaps.append((i, float(b_high[i]), float(a_low[i])))
    if len(gaps) != 1:
        return None
    return gaps[0]


def _classify(
    model: SpatialModel,
    element: Any,
    geo_a: Any,
    geo_b: Any,
    axis: tuple[int, float, float] | None,
    testable: bool,
) -> tuple[str, str]:
    """``separating`` or ``shared``, and the German reason."""
    if not testable:
        return (
            "separating",
            "gemeinsames begrenzendes Bauteil beider Räume. Ob es ZWISCHEN ihnen liegt, ist hier nicht "
            "geprüft: mindestens einer der beiden Räume trägt in dieser Datei keinen Körper",
        )
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return (
            "separating",
            "gemeinsames begrenzendes Bauteil beider Räume; dieses Bauteil trägt keinen auswertbaren Körper, "
            "die Lage zwischen den Räumen ist deshalb nicht geprüft",
        )

    if axis is not None and _in_gap(geo, geo_a, geo_b, axis):
        names = ("x", "y", "z")
        return (
            "separating",
            f"Achsentest: die beiden Raumkörper sind in {names[axis[0]]} getrennt, und dieses Bauteil liegt in "
            f"der Lücke zwischen ihnen ({axis[1]:.3f} m bis {axis[2]:.3f} m, Toleranz "
            f"{SEPARATION_SLACK:.2f} m)",
        )
    if _segment_hits_box(geo_a.centroid, geo_b.centroid, geo.box):
        return (
            "separating",
            "Sichtlinie: die gerade Verbindung zwischen den beiden Raumschwerpunkten führt durch dieses Bauteil",
        )
    if axis is None:
        return (
            "shared",
            "begrenzt beide Räume. Die beiden Raumkörper sind auf keiner einzelnen Achse voneinander "
            "getrennt (sie durchdringen einander oder liegen über Eck), und die Sichtlinie führt nicht durch "
            "dieses Bauteil",
        )
    return (
        "shared",
        "begrenzt beide Räume, liegt aber nicht zwischen ihnen — das Bauteil läuft an beiden Räumen entlang "
        "(eine durchlaufende Fassade begrenzt jeden Raum an ihr und trennt keinen davon)",
    )


def _in_gap(geo: Any, geo_a: Any, geo_b: Any, axis: tuple[int, float, float]) -> bool:
    """Does this body sit in the gap between the two rooms, and span both?"""
    index, low, high = axis
    e_low, e_high = geo.box
    if float(e_low[index]) < low - SEPARATION_SLACK or float(e_high[index]) > high + SEPARATION_SLACK:
        return False
    for other in range(3):
        if other == index:
            continue
        for room in (geo_a, geo_b):
            overlap = min(float(e_high[other]), float(room.box[1][other])) - max(
                float(e_low[other]), float(room.box[0][other])
            )
            if overlap <= op.COORDINATE_TOLERANCE:
                return False
    return True


def _segment_hits_box(start: np.ndarray, end: np.ndarray, box: tuple[np.ndarray, np.ndarray]) -> bool:
    """Slab method: does the segment ``start → end`` cross this axis-aligned box?

    The 3D form of the test a plan drawing does by eye. Written out rather than
    delegated to ``tree.select_ray`` because the ray would report the FIRST hit
    only — and the question here is asked once per candidate element, not once
    per pair.
    """
    direction = np.asarray(end, dtype=float) - np.asarray(start, dtype=float)
    low, high = np.asarray(box[0], dtype=float), np.asarray(box[1], dtype=float)
    t_enter, t_exit = 0.0, 1.0
    for i in range(3):
        if abs(direction[i]) < 1e-12:
            if start[i] < low[i] - op.COORDINATE_TOLERANCE or start[i] > high[i] + op.COORDINATE_TOLERANCE:
                return False
            continue
        first = (low[i] - float(start[i])) / float(direction[i])
        second = (high[i] - float(start[i])) / float(direction[i])
        if first > second:
            first, second = second, first
        t_enter = max(t_enter, first)
        t_exit = min(t_exit, second)
        if t_enter > t_exit:
            return False
    return True


def _openings_in(model: SpatialModel, global_id: str) -> list[dict[str, Any]]:
    """The windows and doors sitting in this element, each with its own FireRating."""
    hosted = op.hosts(model, global_id)
    if not hosted.decidable or not hosted.value:
        return []
    out: list[dict[str, Any]] = []
    for opening_ref in hosted.value:
        fillers = op.filler_of(model, opening_ref.global_id)
        if not fillers.decidable or not fillers.value:
            out.append(
                {
                    "globalId": opening_ref.global_id,
                    "name": opening_ref.name,
                    "ifcType": opening_ref.ifc_type,
                    "inBauteil": global_id,
                    "via": "IfcRelVoidsElement — Öffnung ohne Füllung",
                    "fireRating": None,
                    "fireRatingDeklariert": False,
                }
            )
            continue
        for ref in fillers.value:
            element = model.file.by_guid(ref.global_id)
            out.append(_opening_entry(model, element, host=global_id, via="IfcRelVoidsElement + IfcRelFillsElement"))
    return out


def _opening_entry(model: SpatialModel, element: Any, host: str | None, via: str) -> dict[str, Any]:
    rating = _fire_rating(model, element)
    return {
        "globalId": element.GlobalId,
        "name": model.label(element),
        "ifcType": element.is_a(),
        "inBauteil": host,
        "via": via,
        "fireRating": rating,
        "fireRatingDeklariert": rating is not None,
    }


def _separating_caveat(
    model: SpatialModel,
    walls: Sequence[SeparatingElement],
    alongside: Sequence[SeparatingElement],
    openings: Sequence[dict[str, Any]],
    missing_rating: Sequence[str],
    testable: bool,
    axis: tuple[int, float, float] | None,
    bounds_a: Answer[Any],
    bounds_b: Answer[Any],
) -> str:
    parts: list[str] = []
    if not walls and not openings:
        parts.append(
            "Zwischen diesen beiden Räumen liegt in diesem Export KEIN gemeinsames Bauteil. Das heißt "
            "zunächst, dass die beiden Räume hier nicht aneinandergrenzen — es kann aber auch heißen, dass "
            "die Raumgrenzen unvollständig exportiert sind. adjacentSpaces() zeigt, welche Räume dieser "
            "Export als benachbart führt."
        )
    if not testable:
        parts.append(
            "Mindestens einer der beiden Räume trägt in dieser Datei keinen Körper. Es wurde deshalb NICHT "
            "geprüft, ob die gemeinsamen Bauteile wirklich zwischen den Räumen liegen — die Liste ist die "
            "Schnittmenge der begrenzenden Bauteile und kann durchlaufende Bauteile enthalten, die beide "
            "Räume begrenzen, ohne sie zu trennen."
        )
    else:
        parts.append(
            "Trennend heißt: das Bauteil liegt in der Lücke zwischen den beiden Raumkörpern (Achsentest, "
            f"Toleranz {SEPARATION_SLACK:.2f} m) ODER die gerade Verbindung der beiden Raumschwerpunkte führt "
            "hindurch (Sichtlinie). Beide Tests arbeiten mit achsparallelen Hüllboxen; ein schräg stehendes "
            "Trennbauteil kann dabei unter „gemeinsam“ landen, obwohl es trennt. Nichts wird verworfen — die "
            "Begründung steht je Bauteil."
        )
        if axis is None:
            parts.append(
                "Die beiden Raumkörper sind auf keiner einzelnen Achse voneinander getrennt: sie "
                "durchdringen einander, stoßen über Eck aneinander oder einer liegt im anderen. Der "
                "Achsentest ist damit ausgefallen, geprüft wurde allein über die Sichtlinie."
            )
    if alongside:
        parts.append(
            f"{len(alongside)} Bauteil(e) begrenzen beide Räume, ohne zwischen ihnen zu liegen; sie stehen "
            "unter „gemeinsam“ mit Begründung."
        )
    if openings:
        parts.append(
            f"{len(openings)} Öffnung(en) in den trennenden Bauteilen sind mitgeführt: eine Tür in einer "
            "Brandwand ist die schwache Stelle des Abschlusses und wird getrennt vom Bauteil ausgewiesen."
        )
    else:
        parts.append(
            "In den trennenden Bauteilen ist keine Öffnung hinterlegt. Das heißt NICHT zwingend, dass keine "
            "Tür darin sitzt: viele Exporte schreiben die Rohbauöffnung nicht mit (IfcRelVoidsElement / "
            "IfcRelFillsElement fehlen) und tragen den Ausschnitt bereits im Wandkörper."
        )

    declared_anywhere, blanks = _fire_rating_scan(model)
    if missing_rating and not declared_anywhere:
        parts.append(
            "In dieser Datei ist NIRGENDS ein Feuerwiderstand deklariert — kein einziges Bauteil trägt "
            "Pset_*Common.FireRating. Das ist ein Befund über den EXPORT und keine Aussage über das Gebäude: "
            "die Wände haben einen Feuerwiderstand, dieser Export nennt ihn nur nicht. Abhilfe: im CAD den "
            "Feuerwiderstand am Bauteil bzw. am Bauteiltyp setzen (Pset_WallCommon.FireRating, "
            "Pset_DoorCommon.FireRating, Pset_SlabCommon.FireRating) und mitexportieren."
        )
        if blanks:
            # Named separately because the file LOOKS like it declares something.
            # In `AC20-FZK-Haus.ifc` four ArchiCAD placeholders carry FireRating
            # as the empty string; counting those as declarations sent the whole
            # answer down the „Lücke in genau diesen Bauteilen" branch below and
            # blamed the architect for a defect that is the export's.
            parts.append(
                f"{blanks} Bauteil(e) führen das Merkmal FireRating zwar mit, aber LEER — ein Platzhalter, "
                "wie ihn manche CAD-Vorlagen mitexportieren. Ein leerer Wert ist keine Deklaration und wird "
                "hier wie ein fehlender behandelt; im CAD ist an diesen Bauteilen ein Wert einzutragen."
            )
    elif missing_rating:
        parts.append(
            f"{len(missing_rating)} der genannten Bauteile tragen keinen deklarierten Feuerwiderstand, obwohl "
            "die Datei ihn andernorts deklariert — das ist eine Lücke in genau diesen Bauteilen und steht "
            "unter „ohneFeuerwiderstand“. Fehlend heißt fehlend, nicht null."
        )
    parts.append(
        "Der Feuerwiderstand ist wörtlich übernommen, wie die Datei ihn schreibt. Ob die angegebene Klasse "
        "für diesen Abschluss ausreicht, entscheidet die Bestimmung — hier wird nichts geprüft und nichts "
        "verglichen."
    )
    for answer in (bounds_a, bounds_b):
        if answer.provenance == "computed" and answer.caveat:
            parts.append(f"Raumbegrenzung: {answer.caveat}")
            break
    return " ".join(parts)


def _fire_rating(model: SpatialModel, element: Any) -> str | None:
    """The declared ``FireRating`` of one element, or ``None`` — blank is ``None``.

    The single place this property is turned into an answer, because the empty
    string has to mean the same thing at every one of them.

    ``AC20-FZK-Haus.ifc`` carries ``FireRating = ''`` on four ArchiCAD
    placeholder properties (two ``IfcDoor``, two ``IfcWindow``) and declares a
    fire resistance nowhere else. ``''`` is not ``None``, so every reader of the
    raw property counted those four as declarations:
    :func:`_declares_fire_rating` answered ``True`` and
    :func:`_separating_caveat` therefore told the reader the gap was „eine Lücke
    in genau diesen Bauteilen" — a finding about the DESIGN, addressed to the
    architect — where the truth is a finding about the EXPORT, addressed to
    whoever runs the CAD, with a different remedy attached. ``_opening_entry``
    published ``{'fireRating': '', 'fireRatingDeklariert': True}``: a declared
    class that is blank.

    Whitespace counts as blank for the same reason: ``' '`` is what a cleared
    field leaves behind, and it is not a fire resistance class either.
    """
    value = model.declared_property(element, ("FireRating",))
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _fire_rating_scan(model: SpatialModel) -> tuple[bool, int]:
    """``(does any product declare a FireRating, how many declare it BLANK)``.

    The difference between "this wall has no fire rating" and "this export has
    no fire ratings at all" is the difference between a finding about a building
    and a finding about a file, and only the second one is true here. The blank
    count is carried alongside because a file with four empty placeholders looks
    from the outside like the first case and is the second.

    Memoised on the ``SpatialModel`` and not in a module-level table, for the
    reason :mod:`~ifc_spatial.circulation` gives for its own memo: one model
    instance is one content hash, so a memo that lives and dies with it cannot
    serve an answer derived from different bytes. The scan reads every product's
    psets once — 75 products on the sample house — and
    :func:`separating_elements` may be called once per room pair.
    """
    cached = getattr(model, _FIRE_RATING_MEMO, None)
    if isinstance(cached, tuple):
        return cached
    declared_anywhere = False
    blanks = 0
    for element in model.file.by_type("IfcProduct"):
        raw = model.declared_property(element, ("FireRating",))
        if raw is None:
            continue
        if str(raw).strip():
            declared_anywhere = True
        else:
            blanks += 1
    result = (declared_anywhere, blanks)
    setattr(model, _FIRE_RATING_MEMO, result)
    return result


def _declares_fire_rating(model: SpatialModel) -> bool:
    """Does ANY product in this file declare a NON-BLANK FireRating?"""
    return _fire_rating_scan(model)[0]
