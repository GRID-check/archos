"""Model-level operators: what the agent is told before it asks anything.

A port of ``packages/ifc-spatial/src/operators/model.ts`` plus the two functions
in ``graph/build.ts`` that feed it — ``measureDialect`` and ``findBlindSpots`` —
onto IfcOpenShell. The German wording is verbatim; what changes underneath is
only where the facts come from, because there is no CSR graph here to read them
out of.

## Why a briefing exists at all

The expensive failures in model question-answering are not arithmetic failures.
They are GROUNDING failures: the agent filters on ``Pset_WallCommon`` in a file
whose exporter wrote ``AllplanAttributes``, asks for storey ``"Erdgeschoss"`` in
a file that calls it ``"EG 00"``, and gets back zero rows. Zero rows renders as
"no external walls on the ground floor" — a confident, fluent, wrong sentence
that nothing downstream can catch, because a filter that matched nothing and a
building that contains nothing produce the same empty list.

So the cure is not a warning ("check the property names first"); it is to hand
the agent the file's own vocabulary before it writes a query.
:func:`render_briefing` is that hand-over — a deterministic, rendered fact
sheet, not prose from a model, computed once per file and injected when a
conversation first touches it.

## The rule every line in here obeys

**An absent fact must never render as a zero.** ``0 Fenster mit Wandzuordnung``
is a sentence about a building. What this module actually knows, when
``IfcRelFillsElement`` was never exported, is a sentence about a FILE. The two
are told apart everywhere below: a population of zero says "the export contains
none", a resolution of zero out of many names the relation that is missing, and
neither is allowed to look like a measurement.

## What the briefing may and may not do to the model

**It never runs geometry.** §8.2 makes ``briefing()`` the free rung of the
disclosure ladder, and on this engine the geometry pass costs 1.6–2.4 s and the
space contact map another 6 s. A briefing that triggered them would make the
cheapest call the most expensive one. What it does instead is REPORT whether the
pass has already run, and say — as a blind spot, in German — that the measured
answers are unavailable until it does. That is the same discipline the TS
version applies from the other side: its briefing has no geometry because its
graph builder runs first, and the bug it had to fix was a hard-coded sentence
claiming the geometric answers were impossible on files where they were not.

## Where the facts come from now

The TS briefing reads a materialised graph: ``out(graph, 'hostedIn', id)``,
``graph.stats.edgesByKind``, ``graph.dialect``. None of that exists here, and
none of it needs to: ``FillsVoids``/``VoidsElements`` is the hostedIn coverage,
``IfcSpace.BoundedBy`` is the boundary coverage, and
``ifcopenshell.util.element.get_psets`` is the dialect. What survives unchanged
is every sentence and every cap.
"""

from __future__ import annotations

from ifc_spatial.briefing_blind_spots import _geometry_blind_spots  # noqa: F401
from ifc_spatial.briefing_blind_spots import find_blind_spots  # noqa: F401
from ifc_spatial.briefing_constants import DECISIVE_PROPERTIES  # noqa: F401
from ifc_spatial.briefing_constants import KIND_LABEL  # noqa: F401
from ifc_spatial.briefing_constants import LEGACY_ROOM_USE_KINDS  # noqa: F401
from ifc_spatial.briefing_constants import RoomUseKind  # noqa: F401
from ifc_spatial.briefing_dialect import measure_dialect  # noqa: F401
from ifc_spatial.briefing_lexicon import LEXICON  # noqa: F401
from ifc_spatial.briefing_reading import inventory  # noqa: F401
from ifc_spatial.briefing_reading import storey_heights  # noqa: F401
from ifc_spatial.briefing_records import BlindSpot  # noqa: F401
from ifc_spatial.briefing_records import Briefing  # noqa: F401
from ifc_spatial.briefing_records import BriefingCount  # noqa: F401
from ifc_spatial.briefing_records import BriefingDialectEntry  # noqa: F401
from ifc_spatial.briefing_records import BriefingRoomUse  # noqa: F401
from ifc_spatial.briefing_records import BriefingStorey  # noqa: F401
from ifc_spatial.briefing_records import ClassifiedRoom  # noqa: F401
from ifc_spatial.briefing_records import Coverage  # noqa: F401
from ifc_spatial.briefing_records import DialectEntry  # noqa: F401
from ifc_spatial.briefing_records import LexiconEntry  # noqa: F401
from ifc_spatial.briefing_records import RoomProposal  # noqa: F401
from ifc_spatial.briefing_report import briefing  # noqa: F401
from ifc_spatial.briefing_report import content_hash  # noqa: F401
from ifc_spatial.briefing_report import render_briefing  # noqa: F401
from ifc_spatial.briefing_rooms import classify_rooms  # noqa: F401
from ifc_spatial.briefing_rooms import normalise  # noqa: F401

__all__ = [
    "BlindSpot",
    "Briefing",
    "BriefingCount",
    "BriefingDialectEntry",
    "BriefingRoomUse",
    "BriefingStorey",
    "ClassifiedRoom",
    "Coverage",
    "DialectEntry",
    "LEXICON",
    "LexiconEntry",
    "RoomProposal",
    "RoomUseKind",
    "briefing",
    "classify_rooms",
    "content_hash",
    "find_blind_spots",
    "inventory",
    "measure_dialect",
    "normalise",
    "render_briefing",
    "storey_heights",
]
