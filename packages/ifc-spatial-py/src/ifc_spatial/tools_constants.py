"""The tool surface vocabulary: its relations, measures, fire and envelope aspects, and limits."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import accessibility as acc
from . import circulation as circ
from . import clearance as clr
from . import daylight as dl

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import operators as op
from . import relations as extra
from . import stairs as st
from .envelope import Answer
from .model import SpatialModel

#: The relation names ``relations`` accepts, and what each one answers.
RELATIONS: dict[str, str] = {
    "hostedIn": "Welche Wand trägt dieses Fenster / diese Tür? (aus voids+fills abgeleitet)",
    "hosts": "Welche Öffnungen sind aus diesem Bauteil ausgeschnitten?",
    "fillerOf": "Was füllt diese Öffnung?",
    "bounds": "Welche Bauteile begrenzen diesen Raum?",
    "enclosedBy": "Welche Räume begrenzt dieses Bauteil?",
    "opensTo": "In welche Räume öffnet dieses Fenster / diese Tür?",
    "connects": "Welche Bauteile schließen an dieses an?",
    "contains": "Welche Bauteile liegen in diesem Geschoß oder Raum?",
    "containerOf": "In welchem Geschoß oder Raum liegt dieses Bauteil?",
    "adjacentSpaces": "Welche Räume grenzen an diesen Raum?",
    "elementsOfStorey": "Alle Bauteile dieses Geschoßes (auch die in Räumen).",
    "above": "Was liegt direkt über diesem Bauteil oder Raum? (Strahlen nach oben, Möblierung ausgenommen)",
    "below": "Was liegt direkt darunter?",
}

RELATION_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "hostedIn": op.hosted_in,
    "hosts": op.hosts,
    "fillerOf": op.filler_of,
    "bounds": op.bounds,
    "enclosedBy": op.enclosed_by,
    "opensTo": op.opens_to,
    "connects": extra.connects,
    "contains": op.contains,
    "containerOf": op.container_of,
    "adjacentSpaces": op.adjacent_spaces,
    "elementsOfStorey": extra.elements_of_storey,
    "above": dl.above,
    "below": dl.below,
}

#: The relations that fall back to the geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the common case.
#:
#: Named as a set rather than left implicit because two things depend on it: the
#: warning in the ``relations`` description, and ``element``'s refusal to probe
#: them just to list what is available. A six-second contact map is a reasonable
#: price for an answer somebody asked for and an unreasonable one for a menu.
GEOMETRIC_RELATIONS = frozenset(
    {
        "bounds",
        "enclosedBy",
        "opensTo",
        "adjacentSpaces",
        # `above`/`below` cast rays, so they need the OCCT tree. Left out of this
        # set they were probed by `element` to build its "available relations"
        # menu — which ran the geometry pass on a model whose caller had only
        # asked what an element is called. That is the one rule this file has.
        "above",
        "below",
    }
)

#: The measurements ``measure`` exposes, and what each one answers.
MEASURES: dict[str, str] = {
    "extent": "Abmessungen und Schwerpunkt: Breite, Tiefe, Höhe, Mittelpunkt.",
    "floorArea": (
        "Bodenfläche aus der Geometrie — auch wenn das Modell keine Raumfläche deklariert. Deklariert das "
        "Modell eine, werden beide Wege gegeneinander geprüft und ein Widerspruch gemeldet."
    ),
    "sillAndHead": "Brüstungs- und Sturzhöhe eines Fensters oder einer Tür über SEINEM Geschoß.",
    "elevation": "Unter- und Oberkante, absolut und über dem eigenen Geschoß.",
    # NOT the TS wording. The TS operator returns the height of the space solid
    # and its own caveat says the real clear height needs an intersection test
    # it does not have; this engine has that test and measures the lichte Höhe
    # under the lowest obstruction. On the sample house the two differ by 30 cm
    # — under a suspended ceiling — and the TS number is the unsafe side of an
    # OIB minimum room height. Keeping the old sentence would describe an
    # operator that no longer exists.
    "clearHeight": (
        "Lichte Raumhöhe: vom Boden senkrecht nach oben bis zum untersten hineinragenden Bauteil "
        "(abgehängte Decke, Unterzug, Leitung). NICHT die Höhe des Raumkörpers — die liefert extent(). "
        "Möblierung ist ausgenommen. Rasterabtastung, ~0,5 s."
    ),
    "azimuth": "Himmelsrichtung der Fassadenebene. Ohne TrueNorth in der Datei nicht entscheidbar.",
    "lightEntryArea": (
        "Lichteintrittsfläche eines RAUMS und ihr Anteil an der Bodenfläche — die Zahl, auf die ein "
        "Tageslichtnachweis nach OIB 3 hinausläuft. Summiert nur die AUSSENLIEGENDEN Öffnungen "
        "(Innentüren belichten nicht) und misst die Rohbaulichte, nicht die Glasfläche. Kein Grenzwert "
        "angewandt — der Prozentsatz steht im Regelwerk, nicht im Modell."
    ),
    "egressPath": (
        "Kürzester begehbarer Weg eines RAUMS ins Freie, über Türen — Räume, Türen und eine Länge. "
        "Nachbarschaft ist keine Begehbarkeit: zwei Räume an derselben Wand ohne Tür dazwischen "
        "grenzen aneinander und sind unerreichbar. Die Länge ist ein Streckenzug über Raum- und "
        "Türmittelpunkte und damit eine UNTERGRENZE, keine Fluchtweglänge im Sinne der OIB 2."
    ),
    "reachableFrom": (
        "Alle über Türen erreichbaren Räume mit Anzahl der Türen dazwischen. Beantwortet „welche "
        "Räume liegen hinter dieser Tür, und findet Räume ganz ohne Ausgang — was selbst ein Befund ist."
    ),
    "clearWidth": (
        "LICHTE Breite und Höhe einer Öffnung, an der Öffnung selbst gemessen (Rohbaulichte) — die "
        "Zahl, die eine Durchgangs- oder Fluchtwegbreite verlangt. NICHT distance: dessen Modi messen "
        "Schwerpunkte und Hüllboxen und liefern einen Achsabstand."
    ),
    "orientedExtent": (
        "Länge, Breite und Höhe entlang der EIGENEN Achsen des Bauteils, plus seine Verdrehung gegen "
        "Norden. Für alles, was schräg im Modell steht: extent() ist achsparallel und meldet dort "
        "systematisch zu große Werte, die weder Länge noch Dicke sind."
    ),
    "roomDepth": (
        "Raumtiefe senkrecht zur belichtenden Fassade, dazu die Breite entlang dieser Fassade und das "
        "Verhältnis zur lichten Raumhöhe — für Tageslichtfragen, bei denen die Tiefe zählt. Die "
        "gewählte Fassade wird genannt; bei einem Eckraum steht die zweitbeste dabei."
    ),
    "stairGeometry": (
        "Steigungshöhe, Auftrittsbreite, Anzahl der Steigungen und die NUTZBREITE eines Treppenlaufs "
        "— und die STREUUNG der Steigungen über den Lauf. Ungleiche Steigungen sind selbst der Befund: "
        "eine Treppe kann im Mittel stimmen und trotzdem unbegehbar sein. Deklarierte Werte werden "
        "gegen die Geometrie geprüft und ein Widerspruch gemeldet."
    ),
    "rampSlope": (
        "Neigung einer Rampe als Prozent UND als Verhältnis, dazu Lauflänge, Höhenunterschied und "
        "lichte Breite. Beide Formen, weil eine Bestimmung mal die eine und mal die andere nennt."
    ),
    "headroom": (
        "Durchgangshöhe über einem Treppenlauf oder einer Rampe, SENKRECHT ZUR LAUFEBENE gemessen — "
        "nicht lotrecht. Die Engstelle liegt dort, wo der Lauf unter die Decke darüber läuft, und ein "
        "lotrechter Strahl vom Auftritt geht daran vorbei (1,35 m gegen 1,65 m im Testfall)."
    ),
    "stepsOf": (
        "Die Läufe und Podeste, aus denen eine Treppe zusammengesetzt ist — um einen einzelnen Lauf zu "
        "befragen statt der Baugruppe. Podeste zählen, weil Bestimmungen die Zahl der Steigungen je "
        "Lauf ohne Podest begrenzen."
    ),
    "turningCircle": (
        "Der größte Kreis, der auf der freien Bodenfläche eines RAUMS Platz hat — die Zahl, auf die ein "
        "Wendekreis hinausläuft. Gezählt werden nur feste Einbauten; die Möblierung steht separat unter "
        "mitMoeblierung, weil eine Baubewilligung für das Gebäude gilt und nicht für die Stühle. Kein "
        "Grenzwert angewandt."
    ),
    "thresholdHeight": (
        "Die Stufe an einer Tür: der Höhenunterschied der Böden beiderseits. Enthält der Export keinen "
        "Fußbodenaufbau, ist es ein ROHBAUMASS — dann sagt die Antwort das, denn Estrich, Belag und "
        "Dichtung machen die Stufe erst aus, und 0 mm am Rohbau heißt nichts über die fertige Schwelle."
    ),
    "balustrade": (
        "Wo es an einer Öffnung hinuntergeht: die Absturzhöhe und was dort steht, samt seiner Höhe. "
        "Fehlen IfcRailing im Export ganz, ist die Antwort nicht entscheidbar — kein Geländer im Modell "
        "heißt nicht kein Geländer am Bau."
    ),
    "clearApproach": (
        "Die freie Bodenfläche vor einer Tür, beidseitig, und was sie begrenzt — was jemand braucht, um "
        "die Tür überhaupt öffnen zu können."
    ),
}

MEASURE_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "extent": op.extent,
    "floorArea": op.floor_area,
    "sillAndHead": op.sill_and_head,
    "elevation": op.elevation,
    "clearHeight": op.clear_height,
    "azimuth": op.azimuth,
    "lightEntryArea": op.light_entry_area,
    "egressPath": circ.egress_path,
    "reachableFrom": circ.reachable_from,
    "clearWidth": clr.clear_opening_width,
    "orientedExtent": clr.oriented_extent,
    "roomDepth": dl.room_depth,
    "stairGeometry": st.stair_geometry,
    "rampSlope": st.ramp_slope,
    "headroom": st.headroom,
    "stepsOf": st.steps_of,
    "turningCircle": acc.turning_circle,
    "thresholdHeight": acc.threshold_height,
    "balustrade": acc.balustrade_check,
    "clearApproach": acc.clear_approach,
}

#: Which IFC types each measure is ABOUT, read off the operators' own
#: signatures — `clear_height(model, space_global_id)` takes a space, and
#: `threshold_height(model, door_global_id)` takes a door.
#:
#: An empty tuple means the measure is about geometry as such and applies to
#: anything with a shape (`extent`, `elevation`, `orientedExtent`, `floorArea`).
#:
#: This is deliberately NOT wired into `measure` as a refusal. Asking for the
#: floor area of a wall is odd but answerable, and a guard here would turn a
#: type this table happens not to list — IfcSpatialZone, a proxy standing in for
#: a room — into a refusal for a measurement that would have worked. The table
#: exists to CHOOSE, in `profile`, not to forbid.
MEASURE_SUBJECT: dict[str, tuple[str, ...]] = {
    "extent": (),
    "elevation": (),
    "orientedExtent": (),
    "floorArea": (),
    "clearHeight": ("IfcSpace",),
    "lightEntryArea": ("IfcSpace",),
    "egressPath": ("IfcSpace",),
    "reachableFrom": ("IfcSpace",),
    "roomDepth": ("IfcSpace",),
    "turningCircle": ("IfcSpace",),
    "balustrade": ("IfcSpace",),
    "sillAndHead": ("IfcWindow", "IfcDoor"),
    "clearWidth": ("IfcOpeningElement", "IfcDoor", "IfcWindow"),
    "azimuth": ("IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcPlate", "IfcWindow", "IfcDoor"),
    "thresholdHeight": ("IfcDoor",),
    "clearApproach": ("IfcDoor",),
    "stairGeometry": ("IfcStair", "IfcStairFlight"),
    "rampSlope": ("IfcRamp", "IfcRampFlight"),
    "headroom": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
    "stepsOf": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
}

#: Measures that walk the door graph or sample a raster over the whole model.
#: `profile` runs them only when asked, because a profile is meant to be the
#: cheap „was ist das für ein Bauteil" call and these are seconds, not
#: milliseconds — the same budget argument that motivates `survey`.
MEASURE_EXPENSIVE: frozenset[str] = frozenset({"egressPath", "reachableFrom", "turningCircle", "clearApproach"})

#: A DIFFERENT expensive, and the distinction is the point.
#:
#: `MEASURE_EXPENSIVE` names measures with a large fixed setup — the door graph,
#: a raster over the model — which a profile pays once and a survey amortises
#: over the whole set. These are the opposite: cheap to start and costly PER
#: ELEMENT, so a survey multiplies them. Measured on AC20-Institute-Var-2:
#: `balustrade` over 50 rooms is 53 s and `headroom` over FOUR stairs is 50 s,
#: while `egressPath` — nominally the expensive one — is 0.03 s over 50 rooms.
#:
#: A tool call that takes a minute is a broken tool at a budget of five turns,
#: so the default set is smaller for these and the narrowing is stated. A caller
#: who wants all fifty says so with an explicit `limit`.
MEASURE_SLOW_PER_ELEMENT: frozenset[str] = frozenset({"balustrade", "headroom", "roomDepth", "thresholdHeight"})
SLOW_DEFAULT_LIMIT = 12

#: The one number a caller means when a measure returns a dict.
#:
#: Most measures answer with a structure — `clearWidth` returns width, height,
#: area and rectangularity — and a survey over fifty of them could report no
#: spread at all, because there was no single number to disperse. Eighteen of
#: the twenty measures were in that state: the tool sold „die Spanne ist der
#: Befund" and produced a Spanne for `floorArea` and `clearHeight` only.
#:
#: The key is NAMED in the output (`summary.spreadOf`) rather than assumed, so
#: „Spanne 0.13" cannot be read as being about the height when it is about the
#: width.
MEASURE_HEADLINE: dict[str, str] = {
    "clearWidth": "width",
    "turningCircle": "diameter",
    "lightEntryArea": "percent",
    "headroom": "headroom",
    "sillAndHead": "sill",
    "roomDepth": "depth",
    "thresholdHeight": "threshold",
    "azimuth": "degrees",
    "rampSlope": "percent",
    "elevation": "heightAboveStorey",
    "egressPath": "length",
}


#: Audit fields a profile drops. Not because they do not matter — they are the
#: reason this package exists — but because a profile is the ORIENTATION call,
#: and `from`/`method` for sixteen measures at once is several thousand tokens
#: of provenance for numbers the caller has not yet decided to care about. One
#: `measure` call brings the full answer back for the one that mattered.
_PROFILE_DROPS = ("from", "method", "because")
_PROFILE_LIST_CAP = 3


#: The `what` values `fire` accepts.
FIRE_ASPECTS: dict[str, str] = {
    "escape_level": (
        "Höhe des obersten Aufenthaltsgeschoßes über dem tiefsten anschließenden Gelände — die Zahl, "
        "an der die Gebäudeklasse hängt. Welche Geschoße gezählt wurden, steht in der Antwort"
    ),
    "compartmentArea": "Bodenfläche eines Brandabschnitts über mehrere Räume, mit jedem Raum einzeln",
    "separatingElements": (
        "Was zwischen zwei Räumen liegt — Wand, Decke, und die Türen darin — je mit seinem "
        "DEKLARIERTEN FireRating, und ausdrücklich mit dessen Fehlen"
    ),
    "siteBoundary": (
        "Abstand zur Grundgrenze (Brandübertragung). Auf den meisten Exporten nicht entscheidbar: "
        "eine Grundgrenze wird selten mitexportiert, und geraten wird sie hier nicht"
    ),
    "doorGraph": (
        "Der begehbare Graph des GANZEN Gebäudes: Räume als Knoten, DRAUSSEN als eigener Knoten, "
        "Türen als Kanten — und ausdrücklich die Türen, die zu keiner Kante wurden (unbestimmt, "
        "excluded). Ein Raum ohne Kante hat keinen Ausgang, und eine unbestimmte Tür ist ein "
        "Loch in JEDEM Weg dieses Gebäudes. measure/egressPath nennt EINE Route; das hier sagt, wie "
        "vollständig die Grundlage aller Routen ist. Teilt sich den Aufbau mit egressPath und "
        "reachableFrom, kostet also nur beim ersten der drei Aufrufe Sekunden"
    ),
}

#: The `what` values `envelope` accepts.
#:
#: Grouped for the same reason as `FIRE_ASPECTS`: one subject — the building as
#: a heat-loss problem — asked three ways. All three take the WHOLE model and no
#: GlobalId, which is what separates them from `measure`: an envelope is not a
#: property of an element, it is the set of elements that happens to bound the
#: heated volume, and asking about it one wall at a time is how the wall that
#: was left out stays invisible.
ENVELOPE_ASPECTS: dict[str, str] = {
    "thermalEnvelope": (
        "Welche Bauteile die Grenze zwischen beheiztem Innen und Außen bilden, nach Art gruppiert, "
        "je mit Fläche und DEKLARIERTEM U-Wert. Jeder Eintrag nennt, WORAUS die Zuordnung folgt — "
        "IsExternal deklariert oder aus den Raumberührungen abgeleitet ist nicht dieselbe Aussage. "
        "Dazu die zwei Listen, die die Summe überprüfbar machen: interior (entschieden und "
        "weggelassen) und undetermined (nicht entschieden, also weder gezählt noch verworfen)"
    ),
    "areaByOrientation": (
        "Hüllfläche je Himmelsrichtung, opak und transparent getrennt, mit dem Fensterflächenanteil "
        "(WWR) je Fassade. Braucht einen deklarierten TrueNorth — ohne den wird die Richtung nicht "
        "geraten, sondern verweigert"
    ),
    "compactness": (
        "A/V in 1/m, mit der charakteristischen Länge l_c = V/A daneben. A und V kommen einzeln "
        "zurück, weil ein Verhältnis, dessen Eingangsgrößen unsichtbar sind, von der Person, die es "
        "unterschreibt, nicht geprüft werden kann. V ist das NETTO-Volumen (Summe der IfcSpace-Körper)"
    ),
}

#: How many elements one `measure` call may take.
#:
#: The cap exists because the geometry is real work — a `clearHeight` is a
#: 25-ray raster per room — and an agent that pastes a whole building into
#: the field would sit inside one tool call for minutes with no way to see
#: progress. Fifty covers every storey in the corpus (the largest is 22
#: rooms) and refuses the paste.
MAX_BATCH = 50

KINDS = ["project", "site", "building", "storey", "space", "element", "opening", "group"]

#: Downloads are capped. A tool that will read whatever a URL hands it is a way
#: to fill a disk from a chat message.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

#: Set to ``1`` when the host KNOWS its own network and wants ``open_model(url=…)``
#: to reach it anyway — a presigned URL served by a MinIO on the same compose
#: network is the case this exists for.
#:
#: It is opt-in and not opt-out because the two failure modes are not
#: symmetric. A deployment that needed it and did not set it gets a refusal it
#: can read and fix in one environment variable; a deployment that did not need
#: it and was never asked gets an agent-controlled URL fetched from inside its
#: own perimeter, and nobody finds out.
ALLOW_PRIVATE_URLS_ENV = "IFC_SPATIAL_ALLOW_PRIVATE_URLS"

#: Every network failure that is not an HTTP status answers with THIS sentence
#: and no detail.
#:
#: „Connection refused" and „timed out" are different words for two ports on the
#: same host, which is a port scanner: the agent picks the URL, so the difference
#: between the two is a readout on a network the agent cannot otherwise see.
_UNREACHABLE_TEXT = (
    "Modell konnte nicht geladen werden: die URL war nicht abrufbar. "
    "Datei lokal ablegen und path verwenden, oder base64 übergeben."
)
