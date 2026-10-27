"""Reading the model for the briefing: storeys and their heights, the product and space inventory, and counts."""

from __future__ import annotations

from typing import Any

from ifc_spatial.briefing_constants import KIND_LABEL
from ifc_spatial.briefing_constants import RoomUseKind
from ifc_spatial.briefing_lexicon import LEXICON
from ifc_spatial.briefing_records import RoomProposal
from ifc_spatial.briefing_rooms import _by_type
from ifc_spatial.briefing_rooms import _spaces_of
from ifc_spatial.briefing_rooms import _window_assignment
from ifc_spatial.briefing_rooms import classify_rooms

from .envelope import Answer
from .envelope import MissingFact
from .envelope import declared
from .envelope import inferred
from .envelope import undecidable
from .model import SpatialModel
from .model import Storey

# ── storey_heights() ────────────────────────────────────────────────────────


def storey_heights(model: SpatialModel) -> Answer[list[dict[str, Any]]]:
    """Storey heights as the difference between consecutive declared elevations.

    ## Why the caveat is not optional

    This number is a *Rohbau-Geschoßhöhe*: top of slab to top of slab. The
    number an architect is usually being asked for — and the one OIB 3 §3 and
    every habitable-room check want — is the *lichte Raumhöhe*, which is this
    minus the floor build-up and the slab. The two differ by 30–50 cm, which is
    the entire margin of a 2.50 m minimum. Reporting the storey pitch as a room
    height turns a failing room into a passing one, and reads perfectly while
    doing it. So the caveat travels with the value, and a caller that drops it
    is publishing a different claim than the one this function makes.

    ## Why the top storey is ``None``

    There is no next elevation. Every fallback available — the storey below, an
    average, a default 2.80 — is a fabrication that the answer contract has no
    way to mark, since it would arrive as a number like all the others. ``None``
    survives into the render as "nicht bestimmbar", which is true.

    Storeys with no declared elevation are excluded rather than interpolated,
    and the caveat says how many, because a silently shortened list is a subset
    reported as a total.

    ## Why this is ``declared`` and not ``computed``

    It returned ``computed``, and the renderer prints that as „aus der Geometrie
    berechnet, nicht deklariert" — directly contradicting this function's own
    caveat two lines below it („gebildet aus den deklarierten Höhenlagen"), in
    the same answer. Nothing here touches geometry: ``elevation`` is
    ``IfcBuildingStorey.Elevation`` read verbatim, and ``height`` is one declared
    number minus the next. The reviewer verified it — ``model.geometry_seconds``
    stays 0.000 across the call.

    A subtraction of two numbers the file states does not change where they came
    from. If the elevations are wrong, this answer is wrong, and that is exactly
    what ``declared`` means: „wrong only if the export is wrong". Calling it
    ``computed`` claims a measurement error band this value does not have and
    hides the one error source it does have — the architect's own elevations. The
    subtraction is named in the caveat, where a reviewer can check it.
    """
    method = "storeyHeights(model)"
    ordered = _sorted_storeys(model)
    with_elevation = [s for s in ordered if s.elevation is not None]
    missing_elevation = len(ordered) - len(with_elevation)

    if len(with_elevation) < 2:
        return undecidable(
            from_=[s.global_id for s in ordered],
            # `provenance` on an undecidable records which ROUTE was attempted,
            # and the route here is the declared elevation — no geometry is read
            # on the way to this refusal either.
            provenance="declared",
            method=method,
            missing=MissingFact(
                what="IfcBuildingStorey.Elevation",
                remedy=(
                    "Das Modell enthält keine IfcBuildingStorey. Geschoße im CAD anlegen und mitexportieren."
                    if not ordered
                    else (
                        "Mindestens zwei Geschoße müssen eine Höhenlage (Elevation) deklarieren. "
                        "Im CAD die Geschoßhöhen setzen und neu exportieren."
                    )
                ),
                elements=[s.global_id for s in ordered],
            ),
        )

    value: list[dict[str, Any]] = []
    for index, storey in enumerate(with_elevation):
        nxt = with_elevation[index + 1] if index + 1 < len(with_elevation) else None
        value.append(
            {
                "storey": storey.name or storey.global_id,
                "elevation": storey.elevation,
                # Rounded to the millimetre: the difference of two
                # floating-point elevations produces 2.8499999999999996, and a
                # height printed with sixteen digits reads as a precision this
                # value does not have.
                "height": None if nxt is None else round((nxt.elevation - storey.elevation) * 1000) / 1000,  # type: ignore[operator]
            }
        )

    caveat = [
        "Rohbau-Geschoßhöhe von Geschoßoberkante zu Geschoßoberkante, gebildet aus den deklarierten "
        "Höhenlagen. Kein Deckenaufbau und keine Deckenstärke abgezogen — das ist NICHT die lichte "
        "Raumhöhe und nicht für einen Raumhöhennachweis verwendbar.",
        f"Das oberste Geschoß ({value[-1]['storey'] if value else '—'}) hat keine nächste Höhenlage; "
        "seine Höhe bleibt offen statt geschätzt.",
    ]
    if missing_elevation > 0:
        caveat.append(
            f"{missing_elevation} Geschoß(e) ohne deklarierte Höhenlage sind nicht enthalten — die Liste ist "
            "kein vollständiges Geschoßverzeichnis."
        )
    # A non-positive pitch is not a building; it is two storeys sharing an
    # elevation or an inverted export. Worth surfacing, because every downstream
    # height check would otherwise consume it as a measurement.
    suspicious = sum(1 for entry in value if entry["height"] is not None and entry["height"] <= 0)
    if suspicious > 0:
        caveat.append(
            f"{suspicious} Geschoßübergang(e) ergeben eine Höhe ≤ 0 — zwei Geschoße mit gleicher oder "
            "fallender Höhenlage. Das ist ein Befund über den Export, nicht über das Gebäude."
        )

    return declared(
        value,
        unit="m",
        from_=[s.global_id for s in with_elevation],
        method=method,
        caveat=" ".join(caveat),
    )


def inventory(model: SpatialModel, kind: RoomUseKind) -> Answer[list[RoomProposal]]:
    """Propose which rooms are Aufenthaltsräume, Nebenräume or
    Erschließungsflächen, from what they are CALLED.

    ## This is a proposal for a human, never a verdict

    **Aufenthaltsraum is a legal classification, not a geometric one.** OIB and
    the Länder-Bauordnungen define it by intended use — a room meant for more
    than transient occupancy — and that intent lives in the architect's head and
    the Einreichplan, not in the IFC file. Nothing measurable settles it: a 14 m²
    room with a window is a Kinderzimmer or a Lagerraum depending on what the
    plan says it is. This is the one operator no geometry kernel can take over,
    which is why ``COVERAGE.md`` lists it as *not available* from IfcOpenShell
    and why it stays hand-written and stays ``inferred``.

    What this function has is the name the architect typed. That is real
    evidence — people call bedrooms "Schlafen" — and it is *only* evidence. So
    every result is ``inferred``, carries a per-room confidence and the reasons
    behind it, and is phrased as a proposal a human confirms. An agent that
    reports "7 Aufenthaltsräume" as a finding has misused this function.

    ## Why the lexicon is German and umlaut-tolerant

    The room names in an Austrian or German model are German, and exporters
    mangle umlauts in three different ways depending on the file's encoding and
    the CAD's locale: ``Küche``, ``Kueche``, ``KÜCHE``, and NFD-decomposed
    ``Küche`` are all the same room. Matching on the raw string would classify
    the same building differently depending on which machine exported it.

    ## Why the longest match wins

    ``Waschküche`` contains ``küche``. Ranking matches by the length of the
    matched term puts a laundry in ``ancillary_room`` where it belongs, instead of
    proposing it as a habitable room because it has a kitchen in its name.
    """
    method = f"inventory(model, '{kind}')"
    spaces = _spaces_of(model)

    if not spaces:
        return undecidable(
            from_=[],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcSpace",
                remedy=(
                    "Dieser Export enthält keine Räume. Räume im CAD als IfcSpace exportieren — ohne sie ist "
                    "keine Raumnutzung ableitbar, weder aus Namen noch aus Geometrie."
                ),
            ),
        )

    classified = classify_rooms(model)
    matching = [room for room in classified if room.kind == kind]
    unnamed = sum(1 for room in classified if room.name is None)
    unclassified = sum(1 for room in classified if room.kind is None)

    value = [
        RoomProposal(global_id=room.global_id, name=room.name, confidence=room.confidence, because=list(room.because))
        for room in matching
    ]

    because = [
        f"Einstufung aus dem Raumnamen gegen ein deutsch/österreichisch-englisches Lexikon ({len(LEXICON)} Einträge), "
        "Groß-/Kleinschreibung und Umlautvarianten (Küche/Kueche/KÜCHE) vereinheitlicht.",
        "Bei mehreren Treffern gewinnt der längere Begriff (Waschküche vor Küche).",
        f"{len(matching)} von {len(spaces)} Räumen als {KIND_LABEL[kind]} vorgeschlagen.",
    ]
    lit_source = _window_assignment(model)
    if lit_source is not None:
        because.append("Fensterzuordnung (opensTo) als Zusatzsignal, wo der Export sie hergibt.")
    else:
        because.append(
            "Keine Fensterzuordnung im Modell — die Einstufung stützt sich allein auf den Namen, nicht auf Belichtung."
        )

    caveat = [
        "Aufenthaltsraum ist eine RECHTLICHE Einstufung nach der Nutzung, keine geometrische Eigenschaft. "
        "Diese Liste ist ein Vorschlag aus Raumnamen und muss von einem Menschen bestätigt werden — sie "
        "ist kein Nachweis und keine Feststellung.",
    ]
    if unnamed > 0:
        caveat.append(f"{unnamed} Raum/Räume tragen keinen Namen und konnten gar nicht eingestuft werden.")
    if unclassified > unnamed:
        caveat.append(
            f"{unclassified - unnamed} weitere Raumnamen passen zu keinem Lexikoneintrag — ein Befund über die "
            "Raumbenennung im Export, nicht über die Nutzung."
        )
    if not value:
        caveat.append(
            f"Kein Raumname in diesem Modell deutet auf {KIND_LABEL[kind]} hin. Das heißt nicht, dass das "
            "Gebäude keine hat — es heißt, dass die Benennung im Export nichts dazu sagt."
        )

    # The envelope's single confidence is the mean of the per-room values, so a
    # list built from three weak substring matches cannot present itself with
    # the same authority as a list of exact hits. Per-room numbers stay in
    # `value`; this one is what a renderer puts in front of the sentence.
    mean = 0.0 if not value else round(sum(r.confidence for r in value) / len(value) * 100) / 100

    return inferred(
        value,
        from_=[room.global_id for room in value],
        method=method,
        confidence=mean,
        because=because,
        caveat=" ".join(caveat),
    )


def _products_with_representation(model: SpatialModel) -> int:
    """How many products carry a shape — an attribute read, never the kernel.

    Deliberately counts ``Representation`` rather than asking
    :meth:`SpatialModel.geometry`, because the point of this check is to keep the
    briefing free of geometry work: shaping a model to find out whether it has
    shapes is the cost the blind spot exists to save the caller. A product whose
    ``Representation`` the kernel later rejects is a different finding, and
    :func:`ifc_spatial.operators._no_geometry` reports that one per element.
    """
    try:
        products = model.file.by_type("IfcProduct")
    except RuntimeError:
        return 0
    return sum(1 for product in products if getattr(product, "Representation", None))


def _georeferenced(model: SpatialModel) -> bool:
    """``SpatialModel.georeferenced``, survivable on IFC2X3.

    The model's own property reaches for ``IfcMapConversion``, which the 2X3
    schema does not define. That module is the spike's frozen parity spec and
    may not be edited, so the guard lives here: a schema with no map conversion
    is a file with no map conversion, which is what the blind spot says.
    """
    try:
        return bool(model.georeferenced)
    except RuntimeError:
        return False


def _nodes_of(model: SpatialModel) -> list[Any]:
    """Everything the TS graph would have made a node of.

    ``IfcProduct`` covers every physical and spatial element; ``IfcProject`` and
    ``IfcGroup`` are the two node kinds that are not products. Types
    (``IfcWindowType``), property definitions and relationships are deliberately
    not nodes: they are not things an agent asks a spatial question about, and
    counting them would inflate every total in the briefing.
    """
    return [*_by_type(model, "IfcProject"), *_by_type(model, "IfcProduct"), *_by_type(model, "IfcGroup")]


def _sorted_storeys(model: SpatialModel) -> list[Storey]:
    """Lowest first, storeys without an elevation last.

    The order is load-bearing: :func:`storey_heights` takes the difference of
    consecutive entries, and a file that lists its storeys top-down would
    otherwise produce negative heights that read like a finding about the
    building.
    """
    return sorted(model.storeys, key=lambda s: (s.elevation is None, s.elevation if s.elevation is not None else 0.0))


def _heights_of(model: SpatialModel) -> dict[str, float]:
    """Storey → derived height, shared by :func:`briefing` and
    :func:`storey_heights` so the two cannot disagree."""
    answer = storey_heights(model)
    out: dict[str, float] = {}
    if not answer.decidable or answer.value is None:
        return out
    # `Answer.from_` carries the storeys in the order the values were derived,
    # so the two lists line up by index without re-deriving which storey is
    # which.
    for index, entry in enumerate(answer.value):
        if index < len(answer.from_) and entry["height"] is not None:
            out[answer.from_[index]] = entry["height"]
    return out


def _hosts_of(element: Any) -> list[Any]:
    """The building elements a window or door resolves to, through the two
    declared relations ``FillsVoids`` → ``VoidsElements``."""
    return [
        rel.RelatingBuildingElement
        for fills in (getattr(element, "FillsVoids", None) or [])
        for rel in (getattr(fills.RelatingOpeningElement, "VoidsElements", None) or [])
        if rel.RelatingBuildingElement is not None
    ]


def _declared_boundaries(space: Any) -> list[Any]:
    return [
        rel.RelatedBuildingElement
        for rel in (getattr(space, "BoundedBy", None) or [])
        if rel.RelatedBuildingElement is not None
    ]


def _entity_count(model: SpatialModel) -> int:
    try:
        return len(list(model.file))
    except Exception:
        return 0


def _edge_count(model: SpatialModel) -> int:
    """Declared relationship links, counted as the operators would traverse them.

    Not a graph edge count — there is no graph. This counts the individual
    LINKS the relation entities carry (an ``IfcRelContainedInSpatialStructure``
    with 18 related elements is 18), because that is the number the TS briefing
    printed and because a count of relation ENTITIES would understate the
    connectivity by an order of magnitude on any real file.
    """
    total = 0
    for ifc_type, attribute in (
        ("IfcRelContainedInSpatialStructure", "RelatedElements"),
        ("IfcRelAggregates", "RelatedObjects"),
        ("IfcRelVoidsElement", None),
        ("IfcRelFillsElement", None),
        ("IfcRelSpaceBoundary", None),
        ("IfcRelConnectsPathElements", None),
        ("IfcRelConnectsElements", None),
    ):
        try:
            instances = model.file.by_type(ifc_type)
        except RuntimeError:
            continue
        if attribute is None:
            total += len(instances)
            continue
        for rel in instances:
            total += len(getattr(rel, attribute, None) or ())
    return total
