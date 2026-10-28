"""Renders one engine answer into the lines the model reads, operation by operation."""

from collections.abc import Callable
from typing import Any

from agent.tools.bim.measure_format import _angle
from agent.tools.bim.measure_format import _decimals
from agent.tools.bim.measure_format import _num
from agent.tools.bim.measure_format import _tolerance_text
from agent.tools.bim.measure_format import _value_text
from agent.tools.bim.rendering import listed


def _element_line(entry: dict[str, Any]) -> str:
    label = entry.get("name") or entry.get("globalId")
    via = f" (via {entry['via']})" if entry.get("via") else ""
    return f"- {entry.get('ifcType')} „{label}“ · GlobalId {entry.get('globalId')}{via}"


def _provenance_line(answer: dict[str, Any]) -> str:
    """The one line the agent quotes — with the right provenance verb in front.

    Three provenances, three sentences, and a fourth for the undecidable case.
    They are written out rather than composed from a template on purpose: the
    difference between „das Modell deklariert 15,4 m²“ and „gemessen: 15,4 m²
    (±5 mm)“ is the difference between reporting the architect's own statement
    and reporting ours, and a reader has to be able to tell which they are being
    handed.
    """
    if not answer.get("decidable", True):
        missing = answer.get("missing") or {}
        what = missing.get("what") or "the required information"
        remedy = missing.get("remedy") or ""
        # `missing.what` is the engine's own phrase (German, sometimes negated:
        # „keine IfcSpace-Elemente"). It is put after a colon, never into a
        # sentence of ours, so its grammar cannot turn the finding around.
        return (
            f"UNDECIDABLE: this export cannot answer it — missing: {what}. "
            "This is a finding about the EXPORT, not about the building." + (f" Remedy: {remedy}" if remedy else "")
        )

    text = _value_with_unit(answer)
    tolerance = answer.get("tolerance")
    unit = answer.get("unit")
    provenance = answer.get("provenance")

    if provenance == "declared":
        return f"deklariert: {text} — this is what the file states."
    if provenance == "inferred":
        confidence = answer.get("confidence")
        band = f" (confidence {_num(confidence)})" if confidence is not None else ""
        return f"vermutlich: {text}{band} — a proposal for confirmation, not a finding."
    # The tolerance is always a scalar in the value's unit, whatever shape the
    # value itself has — so it takes the plain unit, not the parenthesised one.
    band = f" (±{_tolerance_text(tolerance)}{' ' + unit if unit else ''})" if tolerance is not None else ""
    return f"gemessen{band}: {text} — computed from the geometry, not declared."


def _value_with_unit(answer: dict[str, Any]) -> str:
    """The answer's value, rounded to its band and carrying its unit.

    Split out of :func:`_provenance_line` so the Herleitung card and the
    sentence the agent reads are formatted by ONE function. A card that
    re-derives „2,70 m" from the same envelope is a second implementation of a
    rounding rule, and the first time the two disagree the surface that exists
    to prove the derivation is the one contradicting it.
    """
    unit = answer.get("unit")
    value = answer.get("value")
    # A declared figure is the file's own statement and is never re-rounded; a
    # measured one is shown to its band and no further.
    decimals = _decimals(answer.get("tolerance")) if answer.get("provenance") == "computed" else None
    text = _value_text(value, decimals)
    # A unit belongs after a NUMBER. Appended to a list or to a set of named
    # numbers it produces "2 Einträge m" and "sill=0.9, head=2.11 m", the second
    # of which reads as though only the last figure carried the unit.
    scalar = isinstance(value, (int, float)) and not isinstance(value, bool)
    suffix = (f" {unit}" if scalar else f" ({unit})") if unit else ""
    return f"{text}{suffix}"


def _computed_decimals(answer: dict[str, Any]) -> int | None:
    """Decimals for a `computed` value; a declared figure is the file's own statement and is not rounded."""
    return _decimals(answer.get("tolerance")) if answer.get("provenance") == "computed" else None


def _missing_what(answer: dict[str, Any]) -> str:
    return (answer.get("missing") or {}).get("what") or "undecidable"


def _all_numbers(value: list) -> bool:
    return bool(value) and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)


def _trailer(answer: dict[str, Any]) -> list[str]:
    """The caveat and the method, which close every special-shape answer."""
    lines: list[str] = []
    if answer.get("caveat"):
        lines.append(f"Note: {answer['caveat']}")
    if answer.get("method"):
        lines.append(f"Method: {answer['method']}")
    return lines


# ── the special answer shapes ────────────────────────────────────────────────
#
# Three operators answer with a structured value that `_value_text` would
# flatten into „results=17 Einträge": the light-entry area, the egress path and
# the door graph. Each gets its own headline in place of the provenance line.


def _render_light_entry(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    decimals = _computed_decimals(answer)
    band = f" (±{_tolerance_text(answer.get('tolerance'))} m²)" if answer.get("tolerance") is not None else ""
    lines = [
        f"gemessen{band}: light entry area {_num(value.get('lightEntryArea'), decimals)} m² on "
        f"{_num(value.get('floorArea'), decimals)} m² floor area = **{_num(value.get('percent'), 2)} %** "
        "— computed from the geometry, not declared."
    ]
    lines += [
        f"- exterior: {e.get('ifcType')} „{e.get('name')}“ · {_num(e.get('area'), 3)} m² · GlobalId {e.get('globalId')}"
        for e in value.get("openings") or []
    ]
    excluded = (
        ("interior", "NOT counted (interior)"),
        ("undetermined", "NOT counted (exterior/interior undetermined)"),
    )
    for key, label in excluded:
        lines += [
            f"- {label}: {e.get('ifcType')} „{e.get('name')}“ · {_num(e.get('area'), 3)} m² · {e.get('because')}"
            for e in value.get(key) or []
        ]
    return lines + _trailer(answer)


def _leg_row(leg: dict[str, Any]) -> str:
    door = leg.get("door") or {}
    to = leg.get("to") or {}
    target = "TO THE OUTSIDE" if to.get("kind") == "outside" else to.get("name")
    start = (leg.get("from") or {}).get("name")
    return (
        f"- {start} → {target} through „{door.get('name')}“ ({_num(leg.get('length'), 2)} m) "
        f"· GlobalId {door.get('globalId')}"
    )


def _render_egress(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    room = (value.get("space") or {}).get("name") or "the room"
    head = f"gemessen: NO door connection leads from „{room}“ to the outside."
    if value.get("reachesOutside"):
        head = (
            f"gemessen: „{room}“ reaches the outside through {value.get('doorCount')} door(s), "
            f"path length {_num(value.get('length'), 2)} m — computed from the geometry, not declared."
        )
    return [head, *(_leg_row(leg) for leg in value.get("legs") or []), *_trailer(answer)]


def _render_door_graph(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    edges = value.get("edges") or []
    rooms = [n for n in value.get("nodes") or [] if isinstance(n, dict) and n.get("globalId") != "AUSSEN"]
    outside = sum(1 for e in edges if isinstance(e, dict) and e.get("external"))
    room_text = "1 room" if len(rooms) == 1 else f"{len(rooms)} rooms"
    door_text = "1 door connection" if len(edges) == 1 else f"{len(edges)} door connections"
    reached = {node for e in edges if isinstance(e, dict) for node in (e.get("connects") or [])}
    stranded = [n for n in rooms if n.get("globalId") not in reached]

    def named(prefix: str, entry: dict[str, Any], tail: str) -> str:
        return f"- {prefix}: {entry.get('ifcType')} „{entry.get('name')}“ · GlobalId {entry.get('globalId')} — {tail}"

    lines = [
        f"gemessen: {room_text}, {door_text}, of which {outside} to the outside "
        "— derived from the geometry, not declared."
    ]
    lines += listed(
        stranded,
        list_limit,
        "rooms without a door edge",
        lambda n: named("NO door edge", n, "this room has no exit in this file"),
    )
    lines += listed(
        value.get("undetermined") or [],
        list_limit,
        "undetermined doors",
        lambda e: named("UNDETERMINED", e, e.get("why")),
    )
    lines += listed(
        value.get("excluded") or [],
        list_limit,
        "excluded doors",
        lambda e: named("NOT counted as an edge", e, e.get("why")),
    )
    return lines + _trailer(answer)


#: (does the value have this shape, how to render it) — first match wins.

_ANSWER_SHAPES: tuple[tuple[Callable[[Any], bool], Callable[[dict[str, Any], int], list[str]]], ...] = (
    (lambda v: isinstance(v, dict) and "lightEntryArea" in v, _render_light_entry),
    (lambda v: isinstance(v, dict) and "legs" in v and "reachesOutside" in v, _render_egress),
    (lambda v: isinstance(v, dict) and "nodes" in v and "edges" in v and "undetermined" in v, _render_door_graph),
)


def _prism_line(answer: dict[str, Any], decimals: int | None) -> str:
    """FREI or NICHT FREI, with the prism's angles as the caller wrote them."""
    unit = answer.get("unit") or "m"
    prism = answer.get("prism") or {}
    angles = ""
    if prism:
        swivel = f", lateral {_angle(prism.get('swivelDeg'))}°" if prism.get("swivelDeg") is not None else ""
        angles = f" (prism {_angle(prism.get('angleDeg'))}°{swivel})"
    if answer.get("free"):
        return f"FREI{angles}: no element protrudes into the prism."
    value = answer.get("value")
    count = len(value) if isinstance(value, list) else 0
    intruders = [e for e in value if isinstance(e, dict)] if isinstance(value, list) else []
    deepest = max((e.get("intrusionDepth", 0) for e in intruders), default=None)
    depth = f", deepest intrusion {_num(deepest, decimals)} {unit}" if deepest is not None else ""
    subject = "1 element protrudes" if count == 1 else f"{count} elements protrude"
    return f"NICHT FREI{angles}: {subject} into the prism{depth}."


def _list_entry(entry: Any, answer: dict[str, Any], decimals: int | None) -> str:
    """One row of a list-valued answer, by what the row carries."""
    if not isinstance(entry, dict):
        return f"- {entry}"
    name = entry.get("name") or entry.get("globalId")
    if "intrusionDepth" in entry:
        unit = answer.get("unit") or "m"
        depth = _num(entry.get("intrusionDepth"), decimals)
        return f"- {name} · GlobalId {entry.get('globalId')} · protrudes {depth} {unit} into the prism"
    if "ifcType" in entry:
        return _element_line(entry)
    if "storey" in entry:
        height = entry.get("height")
        tail = f", storey height {_num(height, decimals)}" if height is not None else ", storey height not determinable"
        return f"- {entry.get('storey')}: elevation {_num(entry.get('elevation'), decimals)}{tail}"
    if "confidence" in entry:
        because = ", ".join(entry.get("because") or [])
        return f"- {name} · GlobalId {entry.get('globalId')} · confidence {_num(entry.get('confidence'))}" + (
            f" ({because})" if because else ""
        )
    return f"- {entry}"


def _render_answer(answer: dict[str, Any], *, list_limit: int = 40) -> list[str]:
    """An :class:`ifc_spatial.envelope.Answer` as lines."""
    value = answer.get("value")
    for matches, render in _ANSWER_SHAPES:
        if matches(value):
            return render(answer, list_limit)
    decimals = _computed_decimals(answer)
    lines = [_provenance_line(answer)]
    if "free" in answer:
        lines.append(_prism_line(answer, decimals))
    if isinstance(value, list) and value and not _all_numbers(value):
        lines += listed(value, list_limit, "entries", lambda entry: _list_entry(entry, answer, decimals))
    if answer.get("agreement") == "disagree":
        lines.append("CONTRADICTION between two methods for this number — see the note.")
    if answer.get("caveat"):
        lines.append(f"Note: {answer['caveat']}")
    if answer.get("because") and not isinstance(value, list):
        lines.append("Reasoning: " + "; ".join(str(reason) for reason in answer["because"]))
    if answer.get("method"):
        lines.append(f"Method: {answer['method']}")
    if answer.get("from"):
        lines.append("Reference: " + ", ".join(str(ref) for ref in answer["from"][:8]))
    return lines
