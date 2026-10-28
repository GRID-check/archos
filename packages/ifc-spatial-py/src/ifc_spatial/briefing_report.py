"""The briefing itself: built from the readers above, rendered as text, and hashed for the cache."""

from __future__ import annotations

import hashlib
from pathlib import Path

from ifc_spatial.briefing_blind_spots import find_blind_spots
from ifc_spatial.briefing_constants import _HASHES
from ifc_spatial.briefing_constants import DIALECT_SAMPLE_SIZE
from ifc_spatial.briefing_constants import MAX_BLIND_SPOTS
from ifc_spatial.briefing_constants import MAX_STOREYS
from ifc_spatial.briefing_constants import MAX_TYPES
from ifc_spatial.briefing_dialect import _summarise_dialect
from ifc_spatial.briefing_dialect import measure_dialect
from ifc_spatial.briefing_reading import _declared_boundaries
from ifc_spatial.briefing_reading import _edge_count
from ifc_spatial.briefing_reading import _entity_count
from ifc_spatial.briefing_reading import _heights_of
from ifc_spatial.briefing_reading import _hosts_of
from ifc_spatial.briefing_reading import _nodes_of
from ifc_spatial.briefing_reading import _sorted_storeys
from ifc_spatial.briefing_records import Briefing
from ifc_spatial.briefing_records import BriefingCount
from ifc_spatial.briefing_records import BriefingRoomUse
from ifc_spatial.briefing_records import BriefingStorey
from ifc_spatial.briefing_records import Coverage
from ifc_spatial.briefing_rooms import _by_type
from ifc_spatial.briefing_rooms import _spaces_of
from ifc_spatial.briefing_rooms import classify_rooms
from ifc_spatial.briefing_text import _coverage_line
from ifc_spatial.briefing_text import _metres
from ifc_spatial.briefing_text import _plural
from ifc_spatial.briefing_text import _shorten
from ifc_spatial.briefing_text import _wrap

from .model import SpatialModel

# ── briefing() ──────────────────────────────────────────────────────────────


def briefing(model: SpatialModel, *, dialect_sample_size: int = DIALECT_SAMPLE_SIZE) -> Briefing:
    """Compute the précis. Deterministic, and free of geometry.

    Deterministic matters more than it sounds: this text enters the model's
    context on every conversation about the file, so a briefing that varied
    between calls would make two answers about the same building differ for
    reasons nobody can reconstruct afterwards. Every list below is therefore
    sorted by a total order, and the scan walks the file in file order.
    """
    spaces = _spaces_of(model)
    windows = _by_type(model, "IfcWindow")
    doors = _by_type(model, "IfcDoor")
    nodes = _nodes_of(model)

    # Storey occupancy, counted from the RESOLVED storey rather than from the
    # containment relation: an element contained in a space is still on a
    # storey, and `SpatialModel.storey_of` walks containment and aggregation to
    # find it. Counting the relation would under-report every model whose
    # exporter nests elements inside spaces or assemblies.
    elements_per_storey: dict[str, int] = {}
    spaces_per_storey: dict[str, int] = {}
    kind_counts: dict[str, int] = {}
    for element in nodes:
        kind = model.kind_of(element)
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        if kind in ("project", "site", "building", "storey"):
            continue
        storey = model.storey_of(element)
        if storey is None:
            continue
        bucket = spaces_per_storey if kind == "space" else elements_per_storey
        if kind in ("space", "element", "opening"):
            bucket[storey.GlobalId] = bucket.get(storey.GlobalId, 0) + 1

    heights = _heights_of(model)
    storeys = [
        BriefingStorey(
            global_id=storey.global_id,
            name=storey.name,
            elevation=storey.elevation,
            height=heights.get(storey.global_id),
            element_count=elements_per_storey.get(storey.global_id, 0),
            space_count=spaces_per_storey.get(storey.global_id, 0),
        )
        for storey in _sorted_storeys(model)
    ]

    type_counts: dict[str, int] = {}
    for element in nodes:
        type_counts[element.is_a()] = type_counts.get(element.is_a(), 0) + 1
    by_type = [
        BriefingCount(key=key, count=count)
        for key, count in sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    fillers = [*windows, *doors]
    hosted = sum(1 for e in fillers if _hosts_of(e))
    bounded = sum(1 for s in spaces if _declared_boundaries(s))
    named = sum(1 for s in spaces if model.label(s) is not None)
    with_elevation = sum(1 for s in model.storeys if s.elevation is not None)
    placeable = [e for e in nodes if model.kind_of(e) in ("element", "opening")]
    placed = sum(1 for e in placeable if model.storey_of(e) is not None)

    coverage = [
        Coverage(
            id="oeffnungenMitWand",
            what="Fenster/Türen einer Wand zugeordnet",
            n=hosted,
            of=len(fillers),
            relation="IfcRelVoidsElement + IfcRelFillsElement",
        ),
        Coverage(
            id="raeumeMitBegrenzung",
            what="Räume mit deklarierter Raumbegrenzung",
            n=bounded,
            of=len(spaces),
            relation="IfcRelSpaceBoundary",
        ),
        Coverage(
            id="raeumeMitNamen",
            what="Räume mit Namen",
            n=named,
            of=len(spaces),
            relation="IfcSpace.Name / LongName",
        ),
        Coverage(
            id="geschosseMitHoehenlage",
            what="Geschoße mit Höhenlage",
            n=with_elevation,
            of=len(model.storeys),
            relation="IfcBuildingStorey.Elevation",
        ),
        Coverage(
            id="bauteileMitGeschoss",
            what="Bauteile einem Geschoß zugeordnet",
            n=placed,
            of=len(placeable),
            relation="IfcRelContainedInSpatialStructure",
        ),
    ]

    classified = classify_rooms(model)
    room_use = BriefingRoomUse(
        habitable_room=sum(1 for r in classified if r.kind == "habitable_room"),
        ancillary_room=sum(1 for r in classified if r.kind == "ancillary_room"),
        circulation=sum(1 for r in classified if r.kind == "circulation"),
        unclassified=sum(1 for r in classified if r.kind is None),
        decidable=len(spaces) > 0,
    )

    measured, scanned, sampled = measure_dialect(model, nodes, dialect_sample_size)
    dialect, omitted, absent = _summarise_dialect(measured)

    return Briefing(
        content_hash=content_hash(model),
        schema=str(model.file.schema),
        source_name=_header(model, "name"),
        originating_system=_header(model, "originating_system"),
        totals={
            "entities": _entity_count(model),
            "nodes": len(nodes),
            "edges": _edge_count(model),
            "buildings": len(_by_type(model, "IfcBuilding")),
            "storeys": len(model.storeys),
            "spaces": len(spaces),
            "windows": len(windows),
            "doors": len(doors),
        },
        storeys=storeys,
        storey_heights_decidable=with_elevation >= 2,
        by_kind=[
            BriefingCount(key=key, count=count)
            for key, count in sorted(kind_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        by_type=by_type[:MAX_TYPES],
        types_omitted=max(0, len(by_type) - MAX_TYPES),
        coverage=coverage,
        room_use=room_use,
        dialect=dialect,
        dialect_omitted=omitted,
        properties_scanned=scanned,
        absent_properties=absent,
        blind_spots=find_blind_spots(model, dialect_sample_size if sampled else None),
    )


# ── render_briefing() ───────────────────────────────────────────────────────


def render_briefing(model: SpatialModel, *, dialect_sample_size: int = DIALECT_SAMPLE_SIZE) -> str:
    """The text block the agent gets in context. The single most important
    function in this module.

    ## Why render at all, when :func:`briefing` returns data

    Because this is read by a language model under a budget, and JSON spends a
    third of its tokens on punctuation and repeated keys. A fixed-column block
    with German labels also has a property JSON does not: it is quotable. An
    agent that copies ``Pset_WallCommon.ThermalTransmittance`` out of the
    DIALEKT block cannot mistype it, which was the failure this whole module
    exists to prevent.

    ## The budget is a correctness feature, not a cost feature

    Every list here is capped and every cap announces what it dropped
    (``+18 weitere Typen``). Silent truncation is the same bug as a subset
    reported as a total: an agent reading a list that ENDS believes it is
    complete, and then answers "the model contains no IfcRamp" from a table that
    was cut at 15 rows.
    """
    b = briefing(model, dialect_sample_size=dialect_sample_size)
    lines: list[str] = []

    def add(label: str, *body: str) -> None:
        for index, text in enumerate(body):
            lines.append(f"{label:<10}{text}" if index == 0 else f"{'':<10}{text}")

    # GEBÄUDE ─ identity first, so a briefing pasted into a transcript can still
    # be matched to the file it describes six turns later.
    identity = [
        b.source_name or "Datei ohne Namen im IFC-Header",
        b.schema,
        b.originating_system or "Herkunftssystem nicht im Header deklariert",
        f"sha {b.content_hash[:8]}",
    ]
    add(
        "GEBÄUDE",
        " · ".join(identity),
        " · ".join(
            [
                # A missing spatial container is named by its ENTITY, never
                # counted as zero: "0 Gebäude" is a sentence about a building
                # site, "kein IfcBuilding" is a sentence about this export —
                # which is the true one.
                _plural(b.totals["buildings"], "Gebäude", "Gebäude")
                if b.totals["buildings"] > 0
                else "kein IfcBuilding",
                _plural(b.totals["storeys"], "Geschoß", "Geschoße")
                if b.totals["storeys"] > 0
                else "keine IfcBuildingStorey",
                _plural(b.totals["spaces"], "Raum", "Räume") if b.totals["spaces"] > 0 else "keine IfcSpace",
                f"{b.totals['nodes']} Knoten",
                f"{b.totals['edges']} Beziehungen",
            ]
        ),
    )

    # GESCHOSSE ─ the names an agent must not invent. A model with no storey
    # structure says so; it never renders as an empty list.
    if not b.storeys:
        add("GESCHOSSE", "keine IfcBuildingStorey — dieser Export enthält keine Geschoßgliederung")
    else:
        shown = b.storeys[:MAX_STOREYS]
        cells = []
        for storey in shown:
            height = "" if storey.height is None else f" h {storey.height:.2f}"
            where = "ohne Höhenlage" if storey.elevation is None else _metres(storey.elevation)
            cells.append(f"{storey.name or storey.global_id} {where}{height} · {storey.element_count} Bauteile")
        overflow = len(b.storeys) - len(shown)
        add("GESCHOSSE", *_wrap(cells, " | ", f"(+{overflow} weitere Geschoße)" if overflow > 0 else None))
        add(
            "",
            "h = Rohbau-Geschoßhöhe OK–OK aus den Höhenlagen, kein Deckenaufbau abgezogen — nicht die lichte Raumhöhe"
            if b.storey_heights_decidable
            else "keine Geschoßhöhen: weniger als zwei Geschoße veröffentlichen eine Höhenlage",
        )

    # BAUTEILE ─ the type vocabulary. An agent filtering on
    # `IfcWallStandardCase` in an IFC4 file that only has `IfcWall` gets
    # nothing; this block is where it finds out which spelling this file uses.
    if not b.by_type:
        add("BAUTEILE", "keine Bauteile im Modell — dieser Export enthält keine IfcProduct-Instanzen")
    else:
        cells = [f"{entry.key} {entry.count}" for entry in b.by_type]
        add(
            "BAUTEILE",
            *_wrap(cells, " · ", f"(+{b.types_omitted} weitere Typen)" if b.types_omitted > 0 else None),
        )

    # RÄUME ─ every count here is `n von m` with the responsible relation named,
    # so a zero can be read as a statement about the export and not the building.
    if b.totals["spaces"] == 0:
        add(
            "RÄUME",
            "keine IfcSpace/IfcSpatialZone — Räume wurden nicht exportiert; über die Raumaufteilung des",
            "Gebäudes sagt das nichts",
        )
    else:
        add("RÄUME", f"{b.totals['spaces']} IfcSpace/IfcSpatialZone")
        for wanted in ("raeumeMitNamen", "raeumeMitBegrenzung"):
            entry = next((c for c in b.coverage if c.id == wanted), None)
            if entry:
                add("", _coverage_line(entry))
        use = b.room_use
        add(
            "",
            f"Lexikonvorschlag (unbestätigt): {use.habitable_room} Aufenthalts-, {use.ancillary_room} Neben-, "
            f"{use.circulation} Erschließungsräume, {use.unclassified} ohne Zuordnung",
        )
        add("", "Aufenthaltsraum ist eine rechtliche Einstufung — dieser Vorschlag ersetzt keine Prüfung")

    # ÖFFNUNGEN ─ window↔wall is the relation most exports drop, and its absence
    # is the difference between "no window in this wall" and "no relation in
    # this file".
    openings = next((c for c in b.coverage if c.id == "oeffnungenMitWand"), None)
    if b.totals["windows"] + b.totals["doors"] == 0:
        add("ÖFFNUNGEN", "keine IfcWindow/IfcDoor — Öffnungen wurden nicht exportiert")
    else:
        add("ÖFFNUNGEN", f"{b.totals['windows']} Fenster · {b.totals['doors']} Türen")
        if openings:
            add("", _coverage_line(openings))

    # DIALEKT ─ the reason this module exists. Absolute counts, not percentages
    # of a population nobody defined: the scan measures fill against every
    # scanned element, so "3 %" for a wall property would be arithmetic on the
    # wrong denominator, printed as a fact.
    if not b.dialect:
        add("DIALEKT", "keine Merkmale gefunden — dieser Export schreibt keine Property Sets an Bauteile")
    else:
        add("DIALEKT", f"{b.properties_scanned} Bauteile untersucht; Zahl = Bauteile mit befülltem Wert")
        for entry in b.dialect:
            gloss = f"{entry.concept} → " if entry.concept else ""
            sample = f"  [{', '.join(_shorten(v) for v in entry.sample[:2])}]" if entry.sample else ""
            add("", f"{gloss}{entry.set}.{entry.property} {entry.filled}{sample}")
        if b.dialect_omitted > 0:
            add("", f"(+{b.dialect_omitted} weitere Merkmale, nach Befüllung sortiert)")

    # FEHLT ─ what the DIALEKT block structurally cannot show. A property absent
    # from the file has no row to appear in, and a filter on it returns nothing
    # that looks exactly like a real negative answer.
    # Suppressed when the dialect is empty: the DIALEKT block has already said
    # that this export writes no property sets at all, and repeating every
    # decisive property underneath it would imply nine separate findings where
    # there is one.
    if b.absent_properties and b.dialect:
        add(
            "FEHLT",
            *_wrap([f"{e['concept']} ({e['property']})" for e in b.absent_properties], " · ", None),
        )
        add("", 'nirgends in dieser Datei befüllt — eine Abfrage darauf liefert leer, nicht „nein"')

    # BLIND ─ the honesty budget.
    spots = b.blind_spots[:MAX_BLIND_SPOTS]
    if spots:
        add("BLIND", *[f"{s.what} → {s.consequence}; Abhilfe: {s.remedy}" for s in spots])
        overflow = len(b.blind_spots) - len(spots)
        if overflow > 0:
            add("", f"(+{overflow} weitere)")

    return "\n".join(lines)


def _header(model: SpatialModel, field_name: str) -> str | None:
    """One STEP header field, with the empty string folded to ``None``.

    Exporters write ``''`` for a field they have nothing to say about, and an
    empty string rendered into the identity line looks like a name nobody can
    read rather than like an absent fact.
    """
    try:
        value = getattr(model.file.header.file_name, field_name, None)
    except Exception:
        return None
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(v) for v in value if v)
    if not value or not str(value).strip():
        return None
    return str(value).strip()


def content_hash(model: SpatialModel) -> str:
    """sha256 of the file's bytes — the identity of everything in the briefing.

    Memoised on ``(path, size, mtime_ns)`` rather than on the path alone: a file
    that was edited in place must produce a different hash, and a hash that
    survives an edit is exactly the failure the content-addressing exists to
    prevent. See :mod:`ifc_spatial.cache` for the same rule applied to the model
    cache itself.
    """
    path = Path(model.path)
    try:
        stat = path.stat()
    except OSError:
        return hashlib.sha256(str(model.path).encode()).hexdigest()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    cached = _HASHES.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    _HASHES[key] = digest.hexdigest()
    return _HASHES[key]
