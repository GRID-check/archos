"""``ifc_measure`` tool — measure the building, and say how the number was got.

The sibling of :mod:`aiq_agent.tools.bim.register`. ``ifc_query`` reads the
extracted index and answers what the export WROTE DOWN; this tool runs the
spatial engine (IfcOpenShell/OCCT) over the model's own bytes for what it did
not: a floor area with no published quantity, a sill with no property, the
lichte Höhe under a suspended ceiling.

Every answer carries its provenance, and the renderer puts a different German
verb in front of each — *deklariert* (the file states it) / *gemessen (±tol)*
(we measured it) / *vermutlich* (a heuristic, with its confidence). Collapsing
those into one number is how a guess gets stamped. ``decidable: false`` is not
an error: the question was well-formed and THIS EXPORT cannot answer it, and
``missing.remedy`` says what the architect changes in their CAD.

Design, costs and the defects each rule answers:
``docs/roadmap/agent-spatial-reasoning.md`` and
``docs/roadmap/spatial-review-findings.md``.
"""

import asyncio
from collections.abc import Callable
from typing import Any

from pydantic import Field
from pydantic import ValidationError

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.action_rows import ActionRow
from aiq_agent.knowledge.ifc_spatial_client import call_spatial_tool
from aiq_agent.knowledge.ifc_spatial_client import open_model
from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.project_context import get_project_id_from_context
from aiq_agent.tools.bim.capability_gaps import record_gap
from aiq_agent.tools.bim.failures import ENGINE_UNAVAILABLE_TEXT
from aiq_agent.tools.bim.failures import MEASURE_FAILURES
from aiq_agent.tools.bim.failures import NO_ORG_TEXT
from aiq_agent.tools.bim.failures import NO_PROJECT_TEXT
from aiq_agent.tools.bim.failures import UNAVAILABLE_TEXT
from aiq_agent.tools.bim.measure_bodies import _body_lines
from aiq_agent.tools.bim.measure_bodies import _image_blocks
from aiq_agent.tools.bim.measure_bodies import _model_line
from aiq_agent.tools.bim.measure_bodies import _render_unresolved
from aiq_agent.tools.bim.measure_calls import _SUBJECT_OPERATIONS
from aiq_agent.tools.bim.measure_calls import _VOCABULARIES
from aiq_agent.tools.bim.measure_calls import _does_not_exist
from aiq_agent.tools.bim.measure_calls import _EngineCall
from aiq_agent.tools.bim.measure_calls import _ids
from aiq_agent.tools.bim.measure_calls import _needs
from aiq_agent.tools.bim.measure_description import _TOOL_DESCRIPTION
from aiq_agent.tools.bim.measure_input import IfcMeasureInput
from aiq_agent.tools.bim.measure_render import _provenance_line
from aiq_agent.tools.bim.measure_render import _render_answer
from aiq_agent.tools.bim.measure_results import _measured_count
from aiq_agent.tools.bim.measure_results import _measurement_sources
from aiq_agent.tools.bim.measure_vocab import _ALL_KINDS
from aiq_agent.tools.bim.measure_vocab import DISTANCE_MODES
from aiq_agent.tools.bim.measure_vocab import ENVELOPE_ASPECTS
from aiq_agent.tools.bim.measure_vocab import FIRE_ASPECTS
from aiq_agent.tools.bim.measure_vocab import GEOMETRIC_RELATIONS
from aiq_agent.tools.bim.measure_vocab import KINDS
from aiq_agent.tools.bim.measure_vocab import MAX_BATCH
from aiq_agent.tools.bim.measure_vocab import MEASURES
from aiq_agent.tools.bim.measure_vocab import NON_MEASURING_OPERATIONS
from aiq_agent.tools.bim.measure_vocab import OPERATIONS
from aiq_agent.tools.bim.measure_vocab import PROFILE_KINDS
from aiq_agent.tools.bim.measure_vocab import RELATIONS
from aiq_agent.tools.bim.measure_vocab import ROOM_KINDS
from aiq_agent.tools.bim.measure_vocab import VALID_OPERATIONS
from aiq_agent.tools.bim.measure_vocab import VIEW_MODES
from aiq_agent.tools.bim.measure_vocab import _rejected_text
from aiq_agent.tools.bim.measure_vocab import _too_large_text
from aiq_agent.tools.bim.measure_vocab import _unrunnable_text
from aiq_agent.tools.bim.measure_vocab import logger
from aiq_agent.tools.bim.measurement_evidence import measurement_evidence_line
from aiq_agent.tools.bim.measurement_sources import note_model_read
from aiq_agent.tools.bim.measurement_sources import record_measurements
from aiq_agent.tools.bim.trace import record_ifc_call
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

__all__ = [
    "DISTANCE_MODES",
    "ENGINE_UNAVAILABLE_TEXT",
    "ENVELOPE_ASPECTS",
    "FIRE_ASPECTS",
    "GEOMETRIC_RELATIONS",
    "IfcMeasureConfig",
    "IfcMeasureInput",
    "KINDS",
    "MAX_BATCH",
    "MEASURES",
    "NON_MEASURING_OPERATIONS",
    "NO_PROJECT_TEXT",
    "OPERATIONS",
    "PROFILE_KINDS",
    "RELATIONS",
    "ROOM_KINDS",
    "UNAVAILABLE_TEXT",
    "VALID_OPERATIONS",
    "VIEW_MODES",
    "_ALL_KINDS",
    "_TOOL_DESCRIPTION",
    "_build_call",
    "_image_blocks",
    "_measure",
    "_measured_count",
    "_provenance_line",
    "_rejected_text",
    "_render",
    "_render_answer",
    "_render_unresolved",
    "_run",
    "_too_large_text",
    "_trace",
    "_unrunnable_text",
    "get_organization_id_from_context",
    "get_project_id_from_context",
    "ifc_measure",
    "record_gap",
]


def _selection_args(a: IfcMeasureInput, ceiling: int) -> dict[str, Any] | str:
    """The filter half `find_elements` and `survey` share. `kind` is the spatial ROLE here, never an aspect."""
    args: dict[str, Any] = {"limit": max(1, min(a.limit, ceiling))}
    for key, value in (("ifcType", a.ifc_type), ("nameContains", a.name_contains), ("storey", a.storey)):
        if value:
            args[key] = value
    if a.kind is None:
        return args
    if a.kind not in KINDS:
        return _does_not_exist("kind", a.kind, KINDS)
    args["kind"] = a.kind
    return args


def _find_elements_call(a: IfcMeasureInput) -> _EngineCall | str:
    args = _selection_args(a, 500)
    return args if isinstance(args, str) else ("find_elements", args)


def _survey_call(a: IfcMeasureInput) -> _EngineCall | str:
    """Selection and measurement in one call, capped at 50: every row is a real geometric measurement."""
    if a.measure is None:
        return _needs("survey", "measure", tuple(MEASURES))
    args = _selection_args(a, 50)
    return args if isinstance(args, str) else ("survey", {"measure": a.measure, **args})


def _sun_position_call(a: IfcMeasureInput) -> _EngineCall | str:
    """No latitude field, deliberately: an assumed Vienna on a Vorarlberg project is 1.4° out and looks measured."""
    if not a.when:
        return (
            "Error: sun_position needs 'when' — an ISO 8601 instant WITH a time zone, e.g. "
            "'2026-06-21T12:00:00+02:00' (Austrian summer time) or '2026-06-21T10:00:00Z'. A "
            "timestamp without a zone is refused rather than read as UTC: Austria runs UTC+1 and "
            "UTC+2, so reading 12:00 as UTC moves the sun 30° east of where it stood."
        )
    return "sun_position", {"when": a.when}


def _overhang_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.global_id or not a.other_global_id:
        return (
            "Error: overhang needs TWO elements — global_id is the projecting one (the roof, the "
            "balcony) and other_global_id the one whose facade plane is the reference (the wall "
            "under it). Get the wall from relations/hostedIn on the window."
        )
    return "overhang", {"projecting": a.global_id, "facade": a.other_global_id}


def _light_incidence_call(a: IfcMeasureInput) -> _EngineCall | str:
    """The angle is refused rather than defaulted to 45: it is a fact about the CLAUSE, not the model."""
    if not a.global_id:
        return "Error: light_incidence needs global_id — the opening, or the window that fills it."
    if a.angle_deg is None:
        return (
            "Error: light_incidence needs angle_deg, and it must be between 0 and 90. The angle "
            "comes from the Bestimmung, not from the model — for OIB 3 that is 45, with "
            "swivel_deg 30. This tool does not supply it, because supplying it would be applying "
            "the clause."
        )
    args: dict[str, Any] = {"globalId": a.global_id, "angle": float(a.angle_deg)}
    if a.swivel_deg is not None:
        args["swivel"] = float(a.swivel_deg)
    # A list: a window deep in a thick wall is shaded by its own reveal AND by
    # the roof, and re-running "without the host wall" must keep the roof.
    if a.other_global_id:
        args["exclude"] = _ids(a.other_global_id)
    return "light_incidence", args


def _room_inventory_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.room_kind is None:
        return _needs("room_inventory", "room_kind", ROOM_KINDS)
    return "room_inventory", {"kind": a.room_kind}


def _fire_call(a: IfcMeasureInput) -> _EngineCall | str:
    aspect = a.kind or "escape_level"
    if aspect not in FIRE_ASPECTS:
        return f"Error: for operation 'fire', kind must be one of: {', '.join(FIRE_ASPECTS)}. Got '{a.kind}'."
    args: dict[str, Any] = {"what": aspect}
    if a.global_id:
        args["globalId"] = a.global_id
    return "fire", args


def _envelope_call(a: IfcMeasureInput) -> _EngineCall | str:
    """Whole-model only: no `globalId` is forwarded, because the engine's schema does not accept one."""
    aspect = a.kind or "thermalEnvelope"
    if aspect not in ENVELOPE_ASPECTS:
        return f"Error: for operation 'envelope', kind must be one of: {', '.join(ENVELOPE_ASPECTS)}. Got '{a.kind}'."
    return "envelope", {"what": aspect}


def _view_call(a: IfcMeasureInput) -> _EngineCall | str:
    """`global_id` is a list here: "where is this" is usually about a pair — the window AND its wall."""
    mode = a.mode or "highlight"
    if mode not in VIEW_MODES:
        return (
            "Error: for operation 'view', mode must be 'highlight' (mark these elements, keep the "
            "rest of the plan) or 'only' (draw nothing else). Default is 'highlight'."
        )
    ids = _ids(a.global_id)
    if mode == "only" and not ids:
        return "Error: mode='only' needs at least one global_id — otherwise there is nothing to draw."
    args: dict[str, Any] = {}
    if a.storey:
        args["storey"] = a.storey
    if ids:
        args[mode] = ids
    return "view", args


def _draw_call(a: IfcMeasureInput) -> _EngineCall:
    args: dict[str, Any] = {}
    if a.storey:
        args["storey"] = a.storey
    if a.ifc_type:
        args["include"] = [a.ifc_type]
    return "draw", args


def _relations_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.relation is None:
        return _needs("relations", "relation", tuple(RELATIONS))
    return "relations", {"globalId": a.global_id, "relation": a.relation}


def _measure_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.measure is None:
        return _needs("measure", "measure", tuple(MEASURES))
    return "measure", {"globalId": a.global_id, "measure": a.measure}


def _element_profile_call(a: IfcMeasureInput) -> _EngineCall:
    """`kind='expensive'` opts into escape route, reachability, turning circle and door approach."""
    args: dict[str, Any] = {"globalId": a.global_id}
    if a.kind == "expensive":
        args["include"] = "expensive"
    return "element_profile", args


def _clearance_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.other_global_id:
        return (
            "Error: clearance needs TWO elements — set 'global_id' and 'other_global_id'. For the "
            "clear width of ONE opening use operation='measure' with measure='clearWidth': an "
            "opening has two reveals but is only one element."
        )
    return "clearance", {"a": a.global_id, "b": a.other_global_id}


def _distance_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.other_global_id:
        return "Error: operation 'distance' needs two elements — set 'global_id' and 'other_global_id'."
    mode = a.mode or "min"
    if mode not in DISTANCE_MODES:
        return _does_not_exist("mode", a.mode, tuple(DISTANCE_MODES))
    return "distance", {"a": a.global_id, "b": a.other_global_id, "mode": mode}


_CALL_BUILDERS: dict[str, Callable[[IfcMeasureInput], _EngineCall | str]] = {
    # Always the rendered TEXT: the briefing's job is to be read into context and copied out of.
    "briefing": lambda a: ("briefing", {"format": "text"}),
    "find_elements": _find_elements_call,
    "element": lambda a: ("element", {"globalId": a.global_id}),
    "relations": _relations_call,
    "measure": _measure_call,
    "survey": _survey_call,
    "element_profile": _element_profile_call,
    "distance": _distance_call,
    "clearance": _clearance_call,
    "sun_position": _sun_position_call,
    "storey_heights": lambda a: ("storey_heights", {}),
    "room_inventory": _room_inventory_call,
    "draw": _draw_call,
    "view": _view_call,
    "shopping_list": lambda a: ("shopping_list", {}),
    "fire": _fire_call,
    "envelope": _envelope_call,
    "overhang": _overhang_call,
    "light_incidence": _light_incidence_call,
}


def _engine_call(arguments: IfcMeasureInput, default_limit: int = 50) -> _EngineCall | str:
    """The engine tool name and its arguments, or a correctable error string.

    Refusing here — before the model is resolved and long before it is parsed
    — is what makes the mistake correctable in the same turn.
    """
    if arguments.operation in _SUBJECT_OPERATIONS and not arguments.global_id:
        return (
            f"Error: operation '{arguments.operation}' needs a global_id (the element's IFC GlobalId). "
            "Get one from operation='find_elements' — never invent one."
        )
    with_limit = arguments.model_copy(update={"limit": arguments.limit or default_limit})
    return _CALL_BUILDERS[arguments.operation](with_limit)


def _refusal(exc: ValidationError) -> str:
    """The schema's refusal as the sentence the ToolNode hands the agent: one message, the permitted values in it."""
    error = exc.errors()[0]
    field = str(error["loc"][0]) if error["loc"] else "arguments"
    asked = error.get("input")
    if field == "operation":
        return f"Error: unknown operation '{asked}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."
    if error["type"] == "literal_error" and field in _VOCABULARIES:
        return _does_not_exist(field, asked, _VOCABULARIES[field])
    return f"Error: {field}: {error['msg']}"


def _build_call(**arguments: Any) -> _EngineCall | str:
    """The tool minus the I/O: validate the way the wire does, then build.

    The tool body holds a validated model and calls :func:`_engine_call`; this
    is the seam the tests and the question battery drive with loose keyword
    arguments. An empty string means "not given", as it always has.
    """
    given = {name: value for name, value in arguments.items() if value != ""}
    try:
        parsed = IfcMeasureInput.model_validate(given)
    except ValidationError as exc:
        return _refusal(exc)
    return _engine_call(parsed)


def _render(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None = None,
    handle: str = "",
    detail: str = "",
) -> str:
    """The engine's result as the string the model reads.

    Ends with the evidence trailer (:func:`.measurement_evidence_line`) on every
    operation that could carry a measurement; :data:`NON_MEASURING_OPERATIONS`
    get none, and an absent trailer never opens the confidence gate. This is
    also the last point at which the structured ``Answer`` exists, so it is
    where a measurement becomes a Herleitung source — a no-op unless a turn is
    capturing.
    """
    lines = [_model_line(source or {}, handle), *_body_lines(operation, payload)]
    # Two channels, deliberately: the measurement sources ground the answer's
    # confidence, the lane hit only tells the Herleitung which file this round
    # read (see ``note_model_read``).
    note_model_read(((source or {}).get("model") or {}).get("filename"), operation, detail or None)
    record_measurements(_measurement_sources(operation, payload, source=source, detail=detail))
    if operation not in NON_MEASURING_OPERATIONS:
        lines.append(measurement_evidence_line(_measured_count(payload)))
    return "\n".join(line for line in lines if line)


# ── tracing and the tool ─────────────────────────────────────────────────────


def _trace(operation: str, detail: str, *, outcome: str) -> None:
    """The SHAPE of the call for Langfuse: names from the closed vocabularies here, never model-authored text."""
    known = operation if operation in VALID_OPERATIONS else "unknown"
    known_detail = detail if detail in RELATIONS or detail in MEASURES or detail in DISTANCE_MODES else None
    record_ifc_call(f"measure:{known}", outcome, ifc_measure_detail=known_detail)


def _run(organization_id: str, project_id: str | None, model_name: str, name: str, args: dict[str, Any]):
    """Resolve, load and call — one blocking unit for ``to_thread``."""
    source = resolve_model_source(organization_id=organization_id, project_id=project_id, model_name=model_name or None)
    if not source.get("resolved"):
        return source, None, ""
    handle = open_model(source)
    return source, call_spatial_tool(handle, name, args), handle


def _reply(name: str, detail: str, source: dict[str, Any], payload: Any, handle: str) -> list[dict] | str:
    """What the agent reads once the engine has answered — or once the model could not be selected."""
    if not source.get("resolved"):
        _trace(name, detail, outcome=f"unresolved:{source.get('reason', 'unknown')}")
        return _render_unresolved(source)
    decidable = payload.get("decidable") if isinstance(payload, dict) else None
    _trace(name, detail, outcome="undecidable" if decidable is False else "resolved")
    if name == "view" and isinstance(payload, dict) and payload.get("pngBase64"):
        return _image_blocks(payload, source=source, handle=handle)
    return _render(name, payload, source=source, handle=handle, detail=detail)


def _measure_row_fields(arguments: IfcMeasureInput) -> dict[str, str]:
    """The Herleitung row of a measurement, from its own arguments: the operation and what it measures."""
    about = arguments.measure or arguments.relation or arguments.mode or arguments.kind or ""
    return {"query": f"{arguments.operation} {about}".strip()}


async def run_ifc_measure(arguments: IfcMeasureInput, default_limit: int) -> list[dict] | str:
    """:func:`_measure` with its Herleitung row (ADR-0132): one row per call, settled on every path."""
    outcome = ActionOutcome()
    row = ActionRow("model", **_measure_row_fields(arguments))
    try:
        result = await _measure(arguments, default_limit, outcome)
    except BaseException:
        row.finish("error")
        raise
    outcome.settle(row)
    return result


async def _measure(
    arguments: IfcMeasureInput, default_limit: int, outcome: ActionOutcome | None = None
) -> list[dict] | str:
    """The tool body: guard, build, run, render — every failure as text the agent can act on."""
    outcome = outcome if outcome is not None else ActionOutcome()
    outcome.failed = True  # cleared once the engine answered; a refusal on the way leaves it set
    organization_id = get_organization_id_from_context()
    if not organization_id:
        return NO_ORG_TEXT
    project_id = get_project_id_from_context()
    if not project_id:
        _trace(arguments.operation, "", outcome="no_project")
        return NO_PROJECT_TEXT
    built = _engine_call(arguments, default_limit)
    if isinstance(built, str):
        _trace(arguments.operation, "", outcome="rejected")
        return built
    name, args = built
    # The measure/relation/mode the CALL asked for: the only headline a single-`Answer` payload has.
    detail = str(args.get("relation") or args.get("measure") or args.get("mode") or "")
    try:
        source, payload, handle = await asyncio.to_thread(
            _run, organization_id, project_id, arguments.model_name, name, args
        )
    except MEASURE_FAILURES.exceptions as exc:
        failure = MEASURE_FAILURES.describe(exc)
        logger.log(failure.level, "ifc_measure %s: %s", failure.outcome, exc)
        _trace(name, detail, outcome=failure.outcome)
        return failure.text(exc)
    outcome.failed = not source.get("resolved")
    if isinstance(payload, dict) and isinstance(payload.get("elements"), list):
        outcome.hits = len(payload["elements"])
    return _reply(name, detail, source, payload, handle)


class IfcMeasureConfig(FunctionBaseConfig, name="ifc_measure"):
    """Configuration for the ``ifc_measure`` spatial tool."""

    default_limit: int = Field(default=50, description="Rows returned by 'find_elements' when none is given.")


@register_function(config_type=IfcMeasureConfig)
async def ifc_measure(tool_config: IfcMeasureConfig, builder: Builder):
    async def _ifc_measure(arguments: IfcMeasureInput) -> list[dict] | str:
        """Measure the project's IFC/BIM model and report the provenance."""
        return await run_ifc_measure(arguments, tool_config.default_limit)

    # `input_schema` is what NAT hands LangChain as `args_schema`: the enums,
    # the per-parameter text and the one required field reach the model.
    yield FunctionInfo.from_fn(_ifc_measure, input_schema=IfcMeasureInput, description=_TOOL_DESCRIPTION)
