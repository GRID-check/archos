"""Measuring: the measure and survey tools, distance, clearance, overhang, light incidence and storey heights."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any

from ifc_spatial.tools_constants import _PROFILE_LIST_CAP
from ifc_spatial.tools_constants import MAX_BATCH
from ifc_spatial.tools_constants import MEASURE_FN
from ifc_spatial.tools_constants import MEASURE_HEADLINE
from ifc_spatial.tools_constants import MEASURE_SLOW_PER_ELEMENT
from ifc_spatial.tools_constants import MEASURE_SUBJECT
from ifc_spatial.tools_constants import MEASURES
from ifc_spatial.tools_constants import SLOW_DEFAULT_LIMIT
from ifc_spatial.tools_helpers import _clamp
from ifc_spatial.tools_helpers import _jsonable
from ifc_spatial.tools_helpers import _lower
from ifc_spatial.tools_helpers import _require
from ifc_spatial.tools_helpers import _select
from ifc_spatial.tools_session import run
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

from . import clearance as clr

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import operators as op
from .briefing import storey_heights
from .model import SpatialModel


def _measure_one(
    run: Callable[[Callable[[], Any]], Any],
    fn: Callable[..., Any],
    model: SpatialModel,
    global_id: str,
) -> Any:
    """One element's measurement, where a thrown exception is that element's
    answer rather than the whole call's.

    `run()` converts the two failures this package models — an unknown id and a
    wrong kind — into `ToolError`. It does not convert a kernel-level failure: a
    `RuntimeError` out of the tessellator propagates, and in a batch that aborts
    the other forty-nine measurements. That is precisely the defect `survey` and
    the multi-id `measure` were added to remove, so catching only `ToolError`
    here reintroduces it one layer down. `element_profile` already caught
    `Exception` for this reason; all three paths now share the rule.
    """
    try:
        return run(lambda: fn(model, global_id))
    except Exception as exc:  # noqa: BLE001
        return {"decidable": False, "error": f"{type(exc).__name__}: {exc}"}


def _headline(measure: str, answer: dict[str, Any] | None) -> float | None:
    """The scalar a summary should disperse over, or None if there isn't one."""
    value = (answer or {}).get("value")
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    key = MEASURE_HEADLINE.get(measure)
    if key and isinstance(value, dict):
        inner = value.get(key)
        if isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return float(inner)
    return None


def _compact(value: Any) -> Any:
    """Shorten the nested lists inside a measure's value, saying how many were cut."""
    if isinstance(value, list):
        if len(value) > _PROFILE_LIST_CAP:
            return [_compact(item) for item in value[:_PROFILE_LIST_CAP]] + [
                f"… {len(value) - _PROFILE_LIST_CAP} weitere (measure aufrufen für die vollständige Liste)"
            ]
        return [_compact(item) for item in value]
    if isinstance(value, dict):
        return {key: _compact(inner) for key, inner in value.items()}
    return value


def measure(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """One measurement, of one element or of MANY.

    `globalId` takes a comma-separated list, the way `view` and
    `fire/compartmentArea` already do. That is not a convenience — it is
    what makes the common question answerable inside a caller's budget.

    „Wie hoch ist der Keller?" is one question and seventeen rooms. Asked
    one call at a time it costs seventeen tool calls, and the agent that
    reported this had a budget of FIVE: it spent them on two briefings and
    a storey table, was cut off before the first `clearHeight`, and fell
    back to the declared storey pitch of 3.00 m for rooms whose measured
    clear height is 2.70 m. The measurement was available and correct the
    whole time; nothing in the answer was wrong except which number it
    reached for, and it ran out of turns before it could reach the right
    one.

    A list also answers a question a single measurement cannot: whether the
    rooms AGREE. „Alle 17 Kellerräume 2.70 m" is a different and much
    stronger statement than one room measured and sixteen assumed, and it
    is the statement a Raumhöhennachweis actually needs.
    """
    model = resolve(args.get("model"))
    name = str(args.get("measure") or "")
    fn = MEASURE_FN.get(name)
    if fn is None:
        raise ToolError(f'measure "{name}" gibt es nicht. Erlaubt: {", ".join(MEASURES)}')

    ids = [part.strip() for part in str(args.get("globalId") or "").split(",") if part.strip()]
    if not ids:
        raise ToolError("globalId fehlt — eine GlobalId angeben (aus find_elements)")
    if len(ids) == 1:
        return run(lambda: fn(model, ids[0]))
    if len(ids) > MAX_BATCH:
        raise ToolError(
            f"höchstens {MAX_BATCH} GlobalIds je Aufruf — {len(ids)} übergeben. "
            "In mehreren Aufrufen messen, oder mit find_elements eingrenzen."
        )

    results = _batch_results(model, fn, ids)
    decided = [r for r in results if (r["answer"] or {}).get("decidable")]
    # `_headline`, not `answer["value"]`: eighteen of the twenty measures
    # answer with a DICT, and reading `value` off those yields nothing to
    # disperse. The batch path used to do exactly that, so a comma-separated
    # `clearWidth` returned `measured`/`of` and no range while the same
    # measure through `survey` returned the spread — one renderer branch,
    # two different answers to the same question.
    numeric = [value for value in (_headline(name, r["answer"]) for r in decided) if value is not None]
    agreement: dict[str, Any] = {
        "measured": len(decided),
        "of": len(ids),
        "undecidable": [r["globalId"] for r in results if not (r["answer"] or {}).get("decidable")],
    }
    # Two measurements or none — the same rule `survey` keeps, and for the
    # same reason: `spread: 0.0` off a single element reads as „they all
    # agree", which is the strongest claim this tool can make, produced from
    # one sample.
    _survey_spread(agreement, name, numeric)
    return {"measure": name, "results": results, "summary": agreement}


def _batch_results(model: SpatialModel, fn: Any, ids: list[str]) -> list[dict[str, Any]]:
    # Each element keeps its OWN answer, with its own provenance, tolerance
    # and refusal. A batch that merged them into one number would be the
    # error this package exists to prevent: seventeen rooms measured and
    # one of them undecidable is not „the basement is 2.70 m", and the
    # caller has to be able to see which one.
    return [{"globalId": gid, "answer": _jsonable(_measure_one(run, fn, model, gid))} for gid in ids]


def _check_survey_limit(requested: Any) -> None:
    # A limit that cannot be read is a limit nobody set. `_clamp` floors to
    # its low bound, and flooring to 1 turns „limit": 0" — or a stray string
    # — into a survey of ONE room out of eighty-two that still reports a
    # spread of 0.0. That is a machine-generated „alle Räume gleich", which
    # is the single sentence this tool exists to make impossible.
    try:
        if int(requested) < 1:
            raise ToolError(
                f'limit muss mindestens 1 sein — "{requested}" übergeben. Ohne limit werden '
                f"bis zu {MAX_BATCH} Bauteile gemessen."
            )
    except TypeError, ValueError:
        raise ToolError(
            f'limit muss eine ganze Zahl sein — "{requested}" übergeben. Ohne limit werden '
            f"bis zu {MAX_BATCH} Bauteile gemessen."
        ) from None


def _empty_survey(name: str, subjects: tuple[str, ...], auto_scoped: bool) -> dict[str, Any]:
    return {
        "measure": name,
        "results": [],
        "summary": {"measured": 0, "of": 0, "undecidable": []},
        "hint": (
            "Kein Bauteil passt zu dieser Auswahl — gemessen wurde daher nichts. "
            + (f"Gesucht wurde nach {', '.join(subjects)}, weil {name} darüber definiert ist. " if auto_scoped else "")
            + "Geschoßnamen und Typen stehen im Briefing; sie stammen aus diesem Export "
            "und lauten selten so, wie die Frage sie nennt."
        ),
    }


def _survey_rows(
    model: SpatialModel, matches: list[Any], subjects: tuple[str, ...], fn: Any
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    # Elements this measure is not ABOUT are set aside before anything runs,
    # not discovered by crashing into them. „wie hoch ist der Keller" scopes
    # by storey, a storey holds IfcAnnotation and IfcWall as well as rooms,
    # and `clearHeight` refuses a wall by raising — so the flagship call of
    # this very tool used to die on the first annotation and return NOTHING
    # about the seventeen rooms behind it. The caller loses the turn and
    # learns nothing, which at a budget of five is most of the question.
    results: list[dict[str, Any]] = []
    not_applicable: list[dict[str, Any]] = []
    for element in matches:
        ref = model.ref(element).to_dict()
        global_id = str(ref.get("globalId") or "")
        if subjects and not any(element.is_a(subject) for subject in subjects):
            not_applicable.append({"globalId": global_id, "name": ref.get("name"), "ifcType": element.is_a()})
            continue
        # One element the geometry kernel chokes on must not cost the
        # caller the other forty-nine — see `_measure_one`, which all three
        # batch paths share so the rule cannot drift between them.
        answer = _jsonable(_measure_one(run, fn, model, global_id))
        results.append(
            {
                "globalId": global_id,
                # The name is the whole point of surveying rather than
                # batching: a caller that has to report WHICH room is the
                # outlier cannot do it from a GlobalId.
                "name": ref.get("name"),
                "storey": getattr(model.storey_of(element), "Name", None),
                "answer": answer,
            }
        )
    return results, not_applicable


def _survey_summary(results: list[dict[str, Any]], decided: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "measured": len(decided),
        "of": len(results),
        "undecidable": [
            {"globalId": r["globalId"], "name": r["name"]} for r in results if not (r["answer"] or {}).get("decidable")
        ],
    }


def _survey_spread(summary: dict[str, Any], name: str, numeric: list[Any]) -> None:
    # A spread is a claim about a POPULATION. Derived from one element it is
    # not a weak claim, it is a false one: `spread: 0.0` off a single room
    # reads as „they all agree", and agreement is the strongest thing this
    # tool can say. Below two measurements there is nothing to disperse, so
    # the keys are absent rather than zero.
    if len(numeric) >= 2:
        low, high = min(numeric), max(numeric)
        summary |= {
            "min": round(low, 6),
            "max": round(high, 6),
            "spread": round(high - low, 6),
            "spreadOver": len(numeric),
            "spreadOf": MEASURE_HEADLINE.get(name) or "value",
        }
    elif len(numeric) == 1:
        summary["note"] = (
            "Nur ein Bauteil lieferte eine Zahl — daraus folgt keine Spanne und keine Aussage über die übrigen."
        )


def _survey_not_applicable(
    summary: dict[str, Any], name: str, subjects: tuple[str, ...], not_applicable: list[dict[str, Any]]
) -> None:
    if not_applicable:
        kinds = sorted({entry["ifcType"] for entry in not_applicable})
        summary["notApplicable"] = {
            "count": len(not_applicable),
            "ifcTypes": kinds,
            "why": (
                f"{name} ist über {', '.join(subjects)} definiert; diese Bauteile sind "
                f"{', '.join(kinds)}. Sie wurden übergangen, nicht gemessen und nicht als "
                "unentscheidbar gewertet — das ist eine Aussage über die Auswahl."
            ),
        }


def _survey_provenance(summary: dict[str, Any], decided: list[dict[str, Any]]) -> None:
    # Where the numbers CAME FROM, counted. A set answered half from the
    # file's own declarations and half from geometry is not one finding, and
    # the split is the caller's business: a declared value is wrong only if
    # the export is wrong, a computed one carries a tolerance. `disagree`
    # counts the elements where an operator ran both routes and they did not
    # match — those are export defects, and they are the reason a reviewer
    # asked in the first place.
    provenances = [(r["answer"] or {}).get("provenance") for r in decided]
    summary["provenance"] = {
        kind: provenances.count(kind) for kind in ("declared", "computed", "inferred") if provenances.count(kind)
    }
    disagreeing = [r for r in decided if (r["answer"] or {}).get("agreement") == "disagree"]
    if disagreeing:
        summary["disagree"] = [{"globalId": r["globalId"], "name": r["name"]} for r in disagreeing]


def _mark_survey_truncated(
    out: dict[str, Any],
    name: str,
    total: int,
    not_applicable: list[dict[str, Any]],
    results: list[dict[str, Any]],
    requested: Any,
    slow: bool,
) -> None:
    # `not_applicable` elements were SELECTED but never measured, so they
    # widen `total` without being a truncation: a caller who pins
    # `ifcType="IfcWall"` and asks for `clearHeight` has every wall land
    # there, and reporting „gemessen wurden die ersten N" would name a limit
    # that never bound. Truncation is what the LIMIT cut off, and that is
    # what the hint must be about.
    if total - len(not_applicable) <= len(results):
        return
    # Said out loud, never inferred. A survey of 50 of 200 rooms
    # reported as „the rooms" is the one error this package exists to
    # prevent, and silence would produce it every time.
    out["truncated"] = True
    measurable = total - len(not_applicable)
    out["summary"]["selected"] = measurable
    out["hint"] = (
        f"{measurable} messbare Bauteile passen zur Auswahl, gemessen wurden die ersten {len(results)}. "
        "Die Spanne gilt NUR für diese; enger auswählen (storey, nameContains) und erneut messen."
        + (
            f" {name} kostet je Bauteil spürbar Zeit, deshalb liegt die Voreinstellung hier bei "
            f"{SLOW_DEFAULT_LIMIT} statt {MAX_BATCH} — mit einem ausdrücklichen limit messbar."
            if slow and requested is None
            else ""
        )
    )


def survey(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    """One measurement over a NAMED SET — selection, measurement and names
    in a single call.

    This exists because of the shape of the questions, not the shape of the
    code. „Wie hoch ist der Keller?" is not a question about a room; it is a
    question about seventeen rooms, and the honest answer is a range with an
    outlier in it. Composed from primitives it costs `find_elements` +
    `measure` + a GlobalId→Name join the caller has to carry in its head —
    four turns of a five-turn budget, which is exactly how a real query came
    back quoting the declared storey pitch of 3.00 m for rooms that measure
    2.70 m, with one at 0.25 m nobody saw.

    `find_elements` and `measure` stay: a caller who needs an unusual set,
    or one element, should not pay for a survey. This is the composition of
    the two, not a replacement for either — and it deliberately reports the
    same set `find_elements` would, because names beside numbers are only
    useful if they belong to the same rooms.
    """
    model = resolve(args.get("model"))
    name = str(args.get("measure") or "")
    fn = MEASURE_FN.get(name)
    if fn is None:
        raise ToolError(f'measure "{name}" gibt es nicht. Erlaubt: {", ".join(MEASURES)}')

    requested = args.get("limit")
    slow = name in MEASURE_SLOW_PER_ELEMENT
    default = SLOW_DEFAULT_LIMIT if slow else MAX_BATCH
    limit = _clamp(default if requested is None else requested, 1, MAX_BATCH)
    if requested is not None:
        _check_survey_limit(requested)

    # When the caller has not pinned a type, the MEASURE picks it. „Wie hoch
    # ist der Keller" scopes by storey, and a storey holds annotations,
    # walls, slabs and doors alongside its rooms — so without this the first
    # fifty nodes of the Institute's basement are annotations and the survey
    # measures nothing at all while 17 rooms sit behind the cap. Making the
    # caller name `ifcType` would work and is exactly the ambiguity this
    # tool exists to remove: `clearHeight` already knows it is about rooms.
    subjects = MEASURE_SUBJECT.get(name, ())
    auto_scoped = bool(subjects) and not _lower(args.get("ifcType"))
    matches, total = _select(model, args, limit, subjects if auto_scoped else ())
    if not matches:
        return _empty_survey(name, subjects, auto_scoped)

    results, not_applicable = _survey_rows(model, matches, subjects, fn)
    decided = [r for r in results if (r["answer"] or {}).get("decidable")]
    numeric = [value for value in (_headline(name, r["answer"]) for r in decided) if value is not None]
    summary = _survey_summary(results, decided)
    _survey_spread(summary, name, numeric)
    _survey_not_applicable(summary, name, subjects, not_applicable)
    _survey_provenance(summary, decided)

    out: dict[str, Any] = {"measure": name, "results": results, "summary": summary}
    if auto_scoped:
        # Said out loud: the caller asked about a storey and got its rooms,
        # which is a narrowing they did not write and must be able to see.
        out["scopedTo"] = list(subjects)
    _mark_survey_truncated(out, name, total, not_applicable, results, requested, slow)
    return out


def distance(resolve: Callable[[Any], SpatialModel], args: dict[str, Any]) -> Any:
    model = resolve(args.get("model"))
    mode = str(args.get("mode") or "min")
    return run(lambda: op.distance(model, str(args.get("a") or ""), str(args.get("b") or ""), mode))


def _measure_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="measure",
        title="Measurements from the geometry",
        description=(
            "Measures one element on the model. These numbers come from the GEOMETRY, not from declared "
            "properties — so they are available even when the export writes no quantities, and they always "
            "carry a tolerance. That is exactly why room areas and sill heights are answerable here where a "
            "pure property query comes back empty.\n\n"
            + "\n".join(f"  {name} — {meaning}" for name, meaning in MEASURES.items())
            + "\n\nApplies to ONE element. For a whole storey or a group of rooms use `survey` — same "
            "quantities, but with names and spread, in one call instead of twenty. (globalId also takes a "
            "comma-separated list here when the set is already fixed.)\n\n"
            "The first call tessellates the model (~2 s for a single-family house); after that the measures "
            "take milliseconds."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "globalId": {
                    "type": "string",
                    "description": (f"One GlobalId, or up to {MAX_BATCH} comma-separated to measure several elements."),
                },
                "measure": {"type": "string", "enum": list(MEASURES)},
            },
            "required": ["model", "globalId", "measure"],
        },
        handler=partial(measure, resolve),
    )


def _survey_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="survey",
        title="One measurement over a whole storey",
        description=(
            "Measures ONE quantity on ALL elements of a selection and names each of them. The first call to "
            "make once the question is plural — 'how high is the basement', 'how large are the offices', "
            "'do all habitable rooms get enough light': each is one question about many rooms, and it is "
            "answered only once all of them are measured.\n\n"
            "Selection works as in find_elements (storey, ifcType, nameContains, kind); the quantities are "
            "those of `measure`, explained there. Returned per element: name, storey and its own answer, plus "
            "the spread.\n\n"
            "The spread is the actual finding. 'All 17 basement rooms 2.70 m' and '16 of them 2.70 m, one "
            "0.25 m' are different answers to the same question, and a single measured room implies neither."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "measure": {"type": "string", "enum": list(MEASURES)},
                "storey": {"type": "string", "description": "Storey name exactly as in the briefing"},
                "ifcType": {"type": "string", "description": "e.g. IfcSpace, IfcWindow, IfcDoor"},
                "nameContains": {"type": "string"},
                "kind": {"type": "string"},
                "limit": {"type": "integer", "description": f"at most {MAX_BATCH}"},
            },
            "required": ["model", "measure"],
        },
        handler=partial(survey, resolve),
    )


def _distance_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="distance",
        title="Distance between two elements",
        description=(
            "Distance between two elements. mode: min (shortest distance between the bounding volumes — 0 "
            "when they overlap), centroid, horizontal, vertical. A reviewer checking a clear width wants "
            "horizontal; one checking a height wants vertical. The slanted distance answers neither."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "a": {"type": "string"},
                "b": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": ["min", "centroid", "horizontal", "vertical"],
                    "default": "min",
                },
            },
            "required": ["model", "a", "b"],
        },
        handler=partial(distance, resolve),
    )


def _clearance_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="clearance",
        title="Clear dimension between two elements",
        description=(
            "The smallest SURFACE-to-SURFACE distance between two bodies, in metres — the clear dimension "
            "that distance does not have. For the corridor between two walls, the gap between handrail and "
            "wall, the passage between two fitted units.\n\n"
            "NOT distance: its min is the distance between BOUNDING BOXES. For the mono-pitch roof against "
            "the sample house's inner wall, min reports 0.000 m — the roof's box swallows the wall's — where "
            "the clear dimension is 0.995 m. A box gap is always a lower bound and never an upper bound: it "
            "reports elements closer than they are, in the direction where too narrow passes as free.\n\n"
            "For the clear dimension of ONE opening, measure/clearWidth is the call — an opening has two "
            "reveals but only one element, and this tool needs two.\n\n"
            "The answer carries the two points it measured between (for a dimension line in your own model) "
            "and boxGap: the number distance('min') would have returned. The difference between the two is "
            "itself the finding.\n\n"
            "Needs geometry: a few seconds on the first call on a model."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "a": {"type": "string", "description": "GlobalId of the first element"},
                "b": {"type": "string", "description": "GlobalId of the second element"},
            },
            "required": ["model", "a", "b"],
        },
        handler=lambda args: _jsonable(
            clr.clear_width(resolve(args.get("model")), _require(args, "a"), _require(args, "b"))
        ),
    )


def _storey_heights_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="storey_heights",
        title="Storey heights",
        description=(
            "Storey heights as the difference of the storey elevations. That is the STRUCTURAL height from "
            "slab to slab, not the clear room height — the answer says so itself, and the note belongs in "
            "every statement about it. measure/clearHeight gives the clear room height."
        ),
        input_schema={
            "type": "object",
            "properties": {"model": {"type": "string"}},
            "required": ["model"],
        },
        handler=lambda args: storey_heights(resolve(args.get("model"))),
    )
