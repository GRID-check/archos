"""Renders each operation's payload as a body for the reader, and the image blocks that go with it."""

from collections.abc import Callable
from typing import Any

from aiq_agent.tools.bim.measure_format import _decimals
from aiq_agent.tools.bim.measure_format import _num
from aiq_agent.tools.bim.measure_format import _value_text
from aiq_agent.tools.bim.measure_render import _element_line
from aiq_agent.tools.bim.measure_render import _missing_what
from aiq_agent.tools.bim.measure_render import _render_answer
from aiq_agent.tools.bim.rendering import listed
from aiq_agent.tools.bim.rendering import render_unresolved

# ── the payload shapes ───────────────────────────────────────────────────────


def _is_profile(payload: Any) -> bool:
    """`element_profile`: many measures over ONE element."""
    return isinstance(payload, dict) and "measures" in payload and "element" in payload


def _is_batch(payload: Any) -> bool:
    """`survey`, or `measure` over a list: ONE measure over many elements."""
    return isinstance(payload, dict) and "results" in payload and "summary" in payload


def _model_identity(source: dict[str, Any] | None) -> str | None:
    """Which file, its schema and its size — without the „Model: " label the prose header adds."""
    model = (source or {}).get("model") or {}
    filename = model.get("filename")
    if not filename:
        return None
    facts = [str(model["schemaVersion"])] if model.get("schemaVersion") else []
    if model.get("elements"):
        facts.append(f"{model['elements']} elements")
    return f"{filename} ({', '.join(facts)})" if facts else str(filename)


def _model_line(result: dict[str, Any], handle: str = "") -> str:
    identity = _model_identity(result)
    if not identity:
        return ""
    return f"Model: {identity}" + (f" · handle {handle[:12]}" if handle else "")


def _briefing_lines(payload: Any) -> list[str]:
    text = (
        payload["briefing"] if isinstance(payload, dict) and isinstance(payload.get("briefing"), str) else str(payload)
    )
    return [
        text,
        "Take storey and property names from this briefing verbatim — they come from "
        "THIS file. The BLIND section says what this file cannot answer.",
    ]


def _find_elements_lines(payload: dict[str, Any]) -> list[str]:
    elements = payload.get("elements") or []
    lines = [f"{payload.get('total', len(elements))} hits, {len(elements)} listed."]
    lines += [_element_line(entry) for entry in elements]
    if payload.get("truncated"):
        lines.append("(More hits exist — narrow the search.)")
    if payload.get("hint"):
        lines.append(str(payload["hint"]))
    return lines


def _element_lines(payload: dict[str, Any]) -> list[str]:
    element = payload.get("element") or {}
    label = element.get("name") or element.get("globalId")
    lines = [f"{element.get('ifcType')} „{label}“ · GlobalId {element.get('globalId')}"]
    if payload.get("storey"):
        lines.append(f"Storey: {payload['storey']}")
    if payload.get("predefinedType"):
        lines.append(f"PredefinedType: {payload['predefinedType']}")
    container = payload.get("container")
    if isinstance(container, dict):
        lines.append(f"Located in: {container.get('ifcType')} „{container.get('name')}“")
    if payload.get("available"):
        lines.append("Available relations: " + ", ".join(str(name) for name in payload["available"]))
    if payload.get("note"):
        lines.append(f"Note: {payload['note']}")
    return lines


def _shopping_list_lines(payload: dict[str, Any]) -> list[str]:
    lines = [str(payload.get("summary") or "")]
    if payload.get("path"):
        lines.append(
            f"IDS file written: {payload['path']} "
            f"({payload.get('specifications')} specifications, {payload.get('bytes')} bytes)."
        )
    lines += [f"- included: {entry}" for entry in payload.get("exported") or []]
    lines += [f"- NOT expressible as IDS: {e.get('what')} — {e.get('why')}" for e in payload.get("notExportable") or []]
    lines.append(
        "The file only requires THAT a property exists, never which value it must have. "
        "Limit values come from the Bestimmung."
    )
    return lines


def _draw_lines(payload: dict[str, Any]) -> list[str]:
    return [
        f"Drawing created: {payload.get('path')} ({payload.get('bytes')} bytes, {payload.get('seconds')} s).",
        "The drawing is a file on the server. Do NOT read dimensions off the image — use "
        "operation='measure' or 'distance' for that.",
    ]


def _profile_row(name: str, answer: dict[str, Any]) -> str:
    if answer.get("error"):
        return f"- {name}: ERROR — {answer['error']}"
    if answer.get("decidable"):
        return f"- {name}: {_value_text(answer.get('value'))} {answer.get('unit') or ''}".rstrip()
    return f"- {name}: UNDECIDABLE — {_missing_what(answer)}"


def _profile_lines(payload: dict[str, Any]) -> list[str]:
    """Every measure that applies to one element, one line each — never the raw dict."""
    element = payload.get("element") or {}
    storey = f", {payload['storey']}" if payload.get("storey") else ""
    lines = [f"gemessen on {element.get('name') or element.get('globalId')} ({element.get('ifcType')}{storey}):"]
    lines += [_profile_row(name, answer or {}) for name, answer in (payload.get("measures") or {}).items()]
    skipped = payload.get("notMeasured") or {}
    if skipped.get("kinds"):
        lines.append(f"Not measured: {', '.join(skipped['kinds'])}. {skipped.get('why') or ''}".strip())
    lines.append(
        "Shortened overview: operation='measure' returns tolerance, provenance and method per value "
        "for the one that matters. Long lists are clipped."
    )
    return lines


def _batch_headline(payload: dict[str, Any]) -> str:
    """The SPREAD first, because that is the finding: „alle 17 bei 2.70 m" and „16 bei 2.70 m, einer bei 0.25 m" differ.

    Flattening this through `_value_text` would print „results=17 Einträge" — seventeen measurements and not one number.
    """
    summary = payload.get("summary") or {}
    results = payload.get("results") or []
    spread = summary.get("spread")
    measured, of = summary.get("measured", 0), summary.get("of", len(results))
    head = f"gemessen: {payload.get('measure')} on {measured} of {of} elements"
    if spread is not None and spread > 0:
        head += f" — from {_num(summary.get('min'), 3)} to {_num(summary.get('max'), 3)}, spread {_num(spread, 3)}"
    elif spread == 0:
        head += f" — uniformly {_num(summary.get('min'), 3)}"
    if payload.get("truncated"):
        head += f" (of {summary.get('selected')} matching — ONLY this selection)"
    return head + "."


def _batch_row(entry: dict[str, Any]) -> str:
    """The name where the payload has one: a 22-character GlobalId is nothing a reviewer carries to a CAD window."""
    answer = entry.get("answer") or {}
    label = entry.get("name") or entry.get("globalId")
    if entry.get("name") and entry.get("storey"):
        label = f"{entry['name']} ({entry['storey']})"
    if answer.get("decidable"):
        value = _num(answer.get("value"), _decimals(answer.get("tolerance")))
        return f"- {label}: {value} {answer.get('unit') or ''}".rstrip()
    return f"- {label}: UNDECIDABLE — {_missing_what(answer)}"


def _batch_lines(payload: dict[str, Any]) -> list[str]:
    summary = payload.get("summary") or {}
    lines = [_batch_headline(payload)]
    lines += listed(payload.get("results") or [], 40, "elements", _batch_row)
    if summary.get("undecidable"):
        count = len(summary["undecidable"])
        noun = "element could" if count == 1 else "elements could"
        lines.append(
            f"{count} {noun} not be measured — they are named individually above and must "
            "not be reported as „wie die anderen“."
        )
    if summary.get("disagree"):
        named = ", ".join(entry.get("name") or entry.get("globalId") for entry in summary["disagree"])
        lines.append(
            f"CONTRADICTION between declared and measured value for: {named}. "
            "This is a finding about the export, not about the building."
        )
    if payload.get("hint"):
        lines.append(str(payload["hint"]))
    if summary.get("spread"):
        lines.append("The spread is the finding: a single measured room proves nothing about the others.")
    return lines


_BODY_RENDERERS: dict[str, Callable[[dict[str, Any]], list[str]]] = {
    "find_elements": _find_elements_lines,
    "element": _element_lines,
    "shopping_list": _shopping_list_lines,
    "draw": _draw_lines,
}


def _body_lines(operation: str, payload: Any) -> list[str]:
    """The result itself: by operation where the shape is the operation's own, by payload shape otherwise."""
    if operation == "briefing":
        return _briefing_lines(payload)
    renderer = _BODY_RENDERERS.get(operation)
    if renderer is not None and isinstance(payload, dict):
        return renderer(payload)
    if _is_profile(payload):
        return _profile_lines(payload)
    if _is_batch(payload):
        return _batch_lines(payload)
    if isinstance(payload, dict) and "decidable" in payload:
        return _render_answer(payload)
    # Never `str(payload)`: a raw dict dump strips the provenance verbs, which
    # is the defect this renderer exists to prevent. A shape nobody renders is
    # a bug to fix, and a test should be what finds it.
    raise TypeError(f"ifc_measure: no renderer for the {operation!r} payload ({type(payload).__name__})")


def _image_blocks(payload: dict[str, Any], *, source: dict[str, Any] | None, handle: str) -> list[dict]:
    """The plan as something the model can actually LOOK at: a caption block and an image block.

    The caption carries what the pixels cannot state exactly — storey, rooms,
    marked GlobalIds — and the prohibition: a dimension read off a raster is
    guessed even when it happens to be right.
    """
    lines = [_model_line(source or {}, handle), str(payload.get("note") or "")]
    if payload.get("rooms"):
        lines.append("Rooms in the image: " + ", ".join(str(room) for room in payload["rooms"]) + ".")
    if payload.get("highlighted"):
        lines.append("Marked red: " + ", ".join(str(item) for item in payload["highlighted"]) + ".")
    if not payload.get("northDeclared"):
        lines.append(
            "No north arrow: this file declares no north direction. No compass direction can be derived from the image."
        )
    lines.append(
        "The image serves orientation and identifying elements. NEVER read dimensions off it — "
        "use operation='measure' or 'distance' for that, which return their tolerance."
    )
    return [
        {"type": "text", "text": "\n".join(line for line in lines if line)},
        {
            "type": "image_url",
            "image_url": {"url": f"data:{payload.get('mediaType', 'image/png')};base64,{payload['pngBase64']}"},
        },
    ]


def _render_unresolved(result: dict[str, Any]) -> str:
    """A model that could not be selected — the same shape ``ifc_query`` uses."""
    return render_unresolved(result, "The model could not be read.")
