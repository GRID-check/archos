"""Turns a validated input into the engine call for its operation, or into the refusal that says what is missing."""

from collections.abc import Sequence
from typing import Any

from aiq_agent.tools.bim.measure_vocab import _ALL_KINDS
from aiq_agent.tools.bim.measure_vocab import DISTANCE_MODES
from aiq_agent.tools.bim.measure_vocab import MEASURES
from aiq_agent.tools.bim.measure_vocab import RELATIONS
from aiq_agent.tools.bim.measure_vocab import ROOM_KINDS
from aiq_agent.tools.bim.measure_vocab import VIEW_MODES

# ── the engine call ──────────────────────────────────────────────────────────
#
# The vocabularies are the schema's business: by the time a call is built here
# every enum has been case-folded and refused by `IfcMeasureInput`. What is left
# to decide is what the schema cannot say — which fields an operation needs,
# which of `kind`'s four vocabularies applies to it, and the engine's own
# argument names.

_EngineCall = tuple[str, dict[str, Any]]


#: The operations that are about ONE element, and refuse without it.

_SUBJECT_OPERATIONS = frozenset({"element", "relations", "measure", "element_profile", "clearance", "distance"})


#: Which vocabulary a refused field is listed against, for the sentence.

_VOCABULARIES: dict[str, Sequence[str]] = {
    "relation": tuple(RELATIONS),
    "measure": tuple(MEASURES),
    "mode": (*DISTANCE_MODES, *VIEW_MODES),
    "kind": _ALL_KINDS,
    "room_kind": ROOM_KINDS,
}


_KIND_ADVICE = "'kind' is the spatial ROLE (a room is 'space'); an IFC type goes in 'ifc_type'."


_MODE_ADVICE = (
    "All four are AXIS distances between centroids or boxes — none is a clear dimension. "
    "For a lichte Breite use operation='measure' with measure='clearWidth' on the opening, and "
    "for a lichte Höhe measure='clearHeight' on the room."
)


#: What a refused field's sentence goes on to say, where the vocabulary alone misleads.

_ADVICE = {"kind": _KIND_ADVICE, "mode": _MODE_ADVICE}


def _does_not_exist(field: str, asked: Any, vocabulary: Sequence[str]) -> str:
    advice = _ADVICE.get(field)
    return f"Error: {field} '{asked}' does not exist. Use one of: {', '.join(vocabulary)}." + (
        f" {advice}" if advice else ""
    )


def _needs(operation: str, field: str, vocabulary: Sequence[str]) -> str:
    return f"Error: operation '{operation}' needs '{field}'. Use one of: {', '.join(vocabulary)}."


def _ids(text: str) -> list[str]:
    return [part.strip() for part in text.split(",") if part.strip()]
