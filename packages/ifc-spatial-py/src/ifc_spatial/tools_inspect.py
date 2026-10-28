"""Inspecting elements: finding them, one element's profile, its relations, the room inventory and the shopping list."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any

from ifc_spatial.tools_constants import _PROFILE_DROPS
from ifc_spatial.tools_constants import GEOMETRIC_RELATIONS
from ifc_spatial.tools_constants import KINDS
from ifc_spatial.tools_constants import MEASURE_EXPENSIVE
from ifc_spatial.tools_constants import MEASURE_FN
from ifc_spatial.tools_constants import MEASURE_SUBJECT
from ifc_spatial.tools_constants import MEASURES
from ifc_spatial.tools_constants import RELATION_FN
from ifc_spatial.tools_constants import RELATIONS
from ifc_spatial.tools_helpers import _clamp
from ifc_spatial.tools_helpers import _jsonable
from ifc_spatial.tools_helpers import _lower
from ifc_spatial.tools_helpers import _require
from ifc_spatial.tools_helpers import _select
from ifc_spatial.tools_measure import _compact
from ifc_spatial.tools_session import run
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import operators as op
from .briefing import KIND_LABEL
from .briefing import LEGACY_ROOM_USE_KINDS
from .briefing import inventory
from .model import SpatialModel
from .model import WrongKindError


def find_elements(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    limit = _clamp(args.get("limit", 50), 1, 500)
    matches, total = _select(model, args, limit)

    out: dict[str, Any] = {
        "elements": [model.ref(e).to_dict() for e in matches],
        "total": total,
        # Stated rather than implied: a page presented as a total is the
        # failure this whole library is built to avoid.
        "truncated": total > len(matches),
    }
    if total == 0:
        out["hint"] = (
            'Keine Treffer. Vor der Schlussfolgerung „gibt es nicht" das Briefing prüfen: '
            "Geschoßnamen und Typen stammen aus diesem Export."
        )
    return out


# ── element ─────────────────────────────────────────────────────────────


def element(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    global_id = str(args.get("globalId") or "")
    try:
        subject = model.file.by_guid(global_id)
    except RuntimeError, KeyError:
        raise ToolError(
            f"Bauteil {global_id} ist in diesem Modell nicht enthalten — GlobalId mit find_elements prüfen"
        ) from None

    storey = model.storey_of(subject)
    container = run(lambda: op.container_of(model, global_id))
    # Only the relations that are attribute reads are probed. The four in
    # GEOMETRIC_RELATIONS fall back to a contact map that costs seconds, and
    # building a menu is not worth that; they are listed separately as
    # "askable" instead of as "available", which is the honest distinction.
    available = []
    for name, fn in RELATION_FN.items():
        if name in GEOMETRIC_RELATIONS:
            continue
        try:
            answer = fn(model, global_id)
        except WrongKindError:
            # The ONE place a wrong kind is a question rather than a
            # mistake: this loop asks every relation whether it applies to
            # this element, and `hosts` on an IfcSpace answering "no" is the
            # menu working. Everywhere else the same refusal is the caller's
            # error and must reach them — so it is caught here by hand and
            # nowhere else, rather than softened at the source.
            continue
        if not answer.decidable:
            continue
        value = answer.value
        present = len(value) > 0 if isinstance(value, list) else value is not None
        if present:
            available.append(name)

    return {
        "element": model.ref(subject).to_dict(),
        "storey": getattr(storey, "Name", None),
        "elevation": next(
            (s.elevation for s in model.storeys if storey is not None and s.global_id == storey.GlobalId),
            None,
        ),
        "predefinedType": getattr(subject, "PredefinedType", None),
        "container": _jsonable(container.value),
        "available": available,
        "note": (
            "bounds, enclosedBy, opensTo und adjacentSpaces stehen nicht in dieser Liste: sie sind in "
            "einem Export ohne IfcRelSpaceBoundary nur aus der Geometrie ableitbar und kosten einmalig "
            "einige Sekunden. Über relations sind sie normal abrufbar."
        ),
    }


# ── relations / measure / distance ──────────────────────────────────────


def relations(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    name = str(args.get("relation") or "")
    fn = RELATION_FN.get(name)
    if fn is None:
        raise ToolError(f'relation "{name}" gibt es nicht. Erlaubt: {", ".join(RELATIONS)}')
    return run(lambda: fn(model, str(args.get("globalId") or "")))


def _profile_measures(model: SpatialModel, global_id: str, applicable: list[str]) -> dict[str, Any]:
    measures: dict[str, Any] = {}
    for name in applicable:
        fn = MEASURE_FN[name]
        try:
            answer = _jsonable(run(lambda fn=fn: fn(model, global_id)))
        except Exception as exc:  # noqa: BLE001
            # One measure that throws must not cost the caller the other
            # fifteen. The failure is reported in place, as a failure, and
            # the profile still comes back — the alternative is a dead call
            # and another turn spent finding out which kind was to blame.
            measures[name] = {"decidable": False, "error": f"{type(exc).__name__}: {exc}"}
            continue
        if isinstance(answer, dict):
            answer = {key: _compact(val) for key, val in answer.items() if key not in _PROFILE_DROPS}
        measures[name] = answer
    return measures


def element_profile(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """Every measure that applies to ONE element — the inverse of `survey`.

    `survey` is one measure over many elements; this is many measures over
    one. Both exist for the same reason: the expensive thing is not the
    measurement, it is the turn. „Erzähl mir alles über diesen Raum" is a
    normal opening move for a reviewer who has just been pointed at an
    outlier, and composed from primitives it costs one `measure` call per
    kind — twenty turns for a question that has one answer.

    Which measures apply is read from `MEASURE_SUBJECT`, so a door is not
    asked for its lichte Raumhöhe and a room is not asked for its
    Schwellenhöhe. The refusals that would produce are not useful output;
    they are noise that pushes the real numbers out of the context window.
    """
    model = resolve(args.get("model"))
    global_id = _require(args, "globalId")
    try:
        subject = model.file.by_guid(global_id)
    except RuntimeError, KeyError:
        raise ToolError(
            f"GlobalId {global_id} steht nicht in diesem Modell. "
            "Mit find_elements suchen — GlobalIds sind exakt 22 Zeichen und gelten je Datei."
        ) from None

    ifc_type = subject.is_a()
    applicable = [
        name
        for name in MEASURES
        if not MEASURE_SUBJECT.get(name, ())
        or any(subject.is_a(subject_type) for subject_type in MEASURE_SUBJECT[name])
    ]
    if not _lower(args.get("include")) == "expensive":
        applicable = [name for name in applicable if name not in MEASURE_EXPENSIVE]

    measures = _profile_measures(model, global_id, applicable)

    skipped = [name for name in MEASURES if name not in applicable]
    out: dict[str, Any] = {
        "element": model.ref(subject).to_dict(),
        "storey": getattr(model.storey_of(subject), "Name", None),
        "measures": measures,
    }
    if skipped:
        out["notMeasured"] = {
            "kinds": skipped,
            "why": (
                f"Diese Kennwerte sind nicht über ein {ifc_type} definiert (oder sind teuer und "
                'wurden übersprungen — dann include="expensive" setzen). Kein Befund über das '
                "Bauteil, sondern über die Frage."
            ),
        }
    return out


# ── ids ─────────────────────────────────────────────────────────────────


def shopping_list(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """The model's blind spots as a buildingSMART IDS file.

    The one output of this package that leaves the conversation and keeps
    working. Everything else is a sentence an architect reads once; this is
    a file they run in their own checker, on their own schedule, and re-run
    after the fix to prove it landed.
    """
    # Imported HERE, not at module scope. `ids_export` needs `ifctester`,
    # which ships with IfcOpenShell as a separate distribution and is not
    # guaranteed present — and a module-level import made a missing optional
    # dependency take down the ENTIRE tool surface, so a deployment without
    # it could not measure a wall either. One tool degrading is a fact about
    # one capability; eleven tools vanishing is an outage.
    try:
        from . import ids_export as ids
    except ImportError as error:
        raise ToolError(
            "Die IDS-Ausgabe steht in dieser Installation nicht zur Verfügung (ifctester fehlt). "
            "Die fehlenden Angaben stehen weiterhin im Briefing unter FEHLT und BLIND und können "
            "dort berichtet werden."
        ) from error

    model = resolve(args.get("model"))
    document = ids.blind_spots_as_ids(
        model,
        title=(str(args["title"]).strip() if args.get("title") else None),
        author=(str(args["author"]).strip() if args.get("author") else None),
    )
    written = ids.write_ids(document)
    return {**written, "summary": document.summary()}


# ── room_inventory ──────────────────────────────────────────────────────


def room_inventory(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """``kind`` is validated here, exactly like ``relation`` and ``measure``.

    It used to go straight through as ``str(args.get("kind") or "")``, and
    ``briefing.inventory`` indexed ``KIND_LABEL`` with it — so an omitted or
    misspelt kind came back as ``KeyError: ''`` from ``briefing.py:799``. A
    Python traceback is not a refusal: the caller cannot read it, cannot act
    on it, and an MCP client sees a crash where every other enum in this file
    produces a German sentence naming the allowed values. The NAT tool layer
    happened to validate ``kind`` before this was reached, but this module is
    documented as transport-free and ``mcp_server`` hands arguments here
    unfiltered.
    """
    model = resolve(args.get("model"))
    kind = str(args.get("kind") or "").strip()
    kind = LEGACY_ROOM_USE_KINDS.get(kind, kind)
    if kind not in KIND_LABEL:
        raise ToolError(
            f'kind "{kind}" gibt es nicht. Erlaubt: {", ".join(KIND_LABEL)}'
            if kind
            else f"kind fehlt. Erlaubt: {', '.join(KIND_LABEL)}"
        )
    return inventory(model, kind)  # type: ignore[arg-type]


def _find_elements_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="find_elements",
        title="Bauteile suchen",
        description=(
            "Findet Bauteile nach IFC-Typ, Namensbestandteil, Geschoß oder Art und gibt ihre GlobalIds "
            "zurück — die Eingabe für jedes andere Werkzeug hier. Geschoßnamen wörtlich aus dem Briefing "
            "übernehmen."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "ifcType": {"type": "string", "description": "z. B. IfcWall, IfcWindow, IfcSpace"},
                "nameContains": {"type": "string"},
                "storey": {"type": "string", "description": "Geschoßname, wörtlich aus dem Briefing"},
                "kind": {"type": "string", "enum": KINDS},
                "limit": {"type": "number", "default": 50},
            },
            "required": ["model"],
        },
        handler=partial(find_elements, resolve),
    )


def _element_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="element",
        title="Ein Bauteil",
        description=(
            "Alles über EIN Bauteil: Typ, Name, Geschoß, Container — und welche Relationen es überhaupt "
            "hat. Kostet keine Geometrie."
        ),
        input_schema={
            "type": "object",
            "properties": {"model": {"type": "string"}, "globalId": {"type": "string"}},
            "required": ["model", "globalId"],
        },
        handler=partial(element, resolve),
    )


def _relations_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="relations",
        title="Räumliche Beziehungen",
        description=(
            "Die topologischen Operatoren. Jede Antwort sagt, WOHER sie kommt: `declared` steht so in "
            "der Datei, `computed` haben wir aus anderen Relationen oder aus der Geometrie abgeleitet. "
            'Ein leeres Ergebnis heißt „dieses Bauteil hat keine solche Beziehung"; `decidable: false` '
            'heißt „dieser Export schreibt diese Relation gar nicht" — das ist ein Befund über den '
            "Export, nicht über das Gebäude, und `missing` sagt, was ihn behebt.\n\n"
            + "\n".join(f"  {name} — {meaning}" for name, meaning in RELATIONS.items())
            + "\n\nbounds, enclosedBy, opensTo und adjacentSpaces greifen auf die Geometrie zurück, wenn "
            "die Datei keine IfcRelSpaceBoundary schreibt (der Normalfall). Der erste solche Aufruf "
            "baut eine Kontaktkarte über alle Räume — einige Sekunden, danach sofort."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {"type": "string"},
                "relation": {"type": "string", "enum": list(RELATIONS)},
            },
            "required": ["model", "globalId", "relation"],
        },
        handler=partial(relations, resolve),
    )


def _element_profile_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="element_profile",
        title="Alles Messbare an einem Bauteil",
        description=(
            "Misst ALLE Kennwerte, die für dieses eine Bauteil definiert sind, in einem Aufruf — "
            "welche das sind, ergibt sich aus seinem IFC-Typ. Der Griff, sobald ein Bauteil "
            "interessant geworden ist: der Ausreißer aus einem survey, der Raum aus der Frage, die "
            "Tür, um die es geht. Statt zwanzig Mal `measure` mit geratenem Kennwert.\n\n"
            "Teure Kennwerte (Fluchtweg, Erreichbarkeit, Bewegungsfläche, Türvorfeld) laufen nur mit "
            'include="expensive" mit; sie brauchen den Türgraph oder ein Raster über das Modell. '
            "Was NICHT gemessen wurde, steht mit Begründung in der Antwort — das ist eine Aussage "
            "über die Frage, nicht über das Gebäude."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {"type": "string"},
                "include": {
                    "type": "string",
                    "enum": ["expensive"],
                    "description": "Teure Kennwerte mitmessen (Sekunden statt Millisekunden).",
                },
            },
            "required": ["model", "globalId"],
        },
        handler=partial(element_profile, resolve),
    )


def _shopping_list_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="shopping_list",
        title="Fehlende Angaben als IDS-Datei",
        description=(
            "Schreibt die blinden Flecken dieses Modells als buildingSMART-IDS-Datei (Version 1.0) "
            "— also das, was der Export NICHT hergibt, in einem Format, das die Architektin in "
            "Solibri, BIMcollab oder ifctester gegen ihr eigenes Modell laufen lassen kann. Nach der "
            "Korrektur nochmals laufen lassen beweist, dass die Ergänzung angekommen ist.\n\n"
            "Die Datei verlangt nur, DASS ein Merkmal vorhanden und auswertbar ist, nie WELCHEN WERT "
            "es haben muss: Grenzwerte stehen in der OIB-Richtlinie, und einen erfundenen Grenzwert "
            "in das Prüfwerkzeug einer Architektin zu schreiben wäre der schwerste Fehler, den "
            "dieses Werkzeug machen könnte.\n\n"
            "Nicht jeder blinde Fleck lässt sich als IDS ausdrücken — fehlende IfcRelSpaceBoundary "
            "etwa nicht. Was nicht ausdrückbar ist, wird gemeldet und NICHT stillschweigend "
            "weggelassen; die Zusammenfassung nennt beide Zahlen."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "title": {"type": "string", "description": "Titel der IDS-Datei"},
                "author": {"type": "string", "description": "E-Mail oder Name für den IDS-Kopf"},
            },
            "required": ["model"],
        },
        handler=partial(shopping_list, resolve),
    )


def _room_inventory_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="room_inventory",
        title="Räume nach vermuteter Nutzung",
        description=(
            "Ordnet Räume nach Namen einer vermuteten Nutzung zu (Aufenthaltsraum, Nebenraum, "
            "Erschließung). Das Ergebnis ist ausdrücklich `inferred`: ob ein Raum ein Aufenthaltsraum "
            "ist, ist eine rechtliche Einstufung und keine geometrische. Als Vorschlag zur Bestätigung "
            "behandeln, nie als Feststellung."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "kind": {
                    "type": "string",
                    "enum": ["habitable_room", "ancillary_room", "circulation"],
                },
            },
            "required": ["model", "kind"],
        },
        handler=partial(room_inventory, resolve),
    )
