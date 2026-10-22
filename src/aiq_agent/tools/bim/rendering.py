"""Rendering primitives both BIM tools share: clipped lists and the unresolved-model reply."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from aiq_agent.tools.bim.failures import NO_MODEL_TEXT
from aiq_agent.tools.bim.failures import NOT_READY_TEXT

#: Plural noun → its singular. A lookup rather than a rule because English
#: plurals are not derivable either ("storeys", "properties"), and
#: "1 more rooms" in an answer an architect reads is worse than a wrong number.
_SINGULAR = {
    "storeys": "storey",
    "elements": "element",
    "element types": "element type",
    "affected elements": "affected element",
    "rooms": "room",
    "rooms without a door edge": "room without a door edge",
    "rules": "rule",
    "groups": "group",
    "properties": "property",
    "missing properties": "missing property",
    "new elements": "new element",
    "removed elements": "removed element",
    "changed elements": "changed element",
    "entries": "entry",
    "undetermined doors": "undetermined door",
    "excluded doors": "excluded door",
}


def clipped(items: list, shown: int, noun: str) -> str | None:
    """A line saying what a clipped list left out, or None when nothing was.

    Every list a renderer cuts must say so, or the agent presents fifty rows as
    the whole set. Singular when exactly one was left out.
    """
    missing = len(items) - shown
    if missing <= 0:
        return None
    if missing == 1:
        return f"… 1 more {_SINGULAR.get(noun, noun)} not shown."
    return f"… {missing} more {noun} not shown."


def listed(
    items: list,
    shown: int,
    noun: str,
    render: Callable[[Any], str | list[str]],
    *,
    indent: str = "",
) -> list[str]:
    """The first ``shown`` items rendered, followed by the clip note when the list was cut."""
    lines: list[str] = []
    for item in items[:shown]:
        rendered = render(item)
        lines.extend([rendered] if isinstance(rendered, str) else rendered)
    note = clipped(items, shown, noun)
    return lines + [f"{indent}{note}"] if note else lines


#: The reasons no argument fixes within this turn, each with the sentence that
#: says so. ``ambiguous`` and ``no_match`` are deliberately absent: there a
#: second call with a different ``model_name`` is the right move, and the
#: listed alternatives are what it is made from.
_NOTHING_TO_READ = {
    "no_models": NO_MODEL_TEXT,
    "extraction_failed": NO_MODEL_TEXT,
    "not_ready": NOT_READY_TEXT,
}


def render_unresolved(result: dict[str, Any], fallback: str) -> str:
    """A model that could not be selected, with the alternatives when there are any.

    "Available" only when the list really is a set of alternatives: on
    ``not_ready`` the route returns the model that could not be read, and
    calling that available beside "(processing, 0 Bauteile)" reads as a
    building with no elements.

    A project with nothing to read gets the sentence saying so AND what to do
    with it (:data:`~aiq_agent.tools.bim.failures.NO_MODEL_TEXT`). The route's
    „Für dieses Projekt ist kein IFC-Modell hinterlegt" (the route's German sentence) alone reads as one
    operation's miss, and the agent spent the rest of its rounds trying the
    others. ``not_ready`` gets its own sentence
    (:data:`~aiq_agent.tools.bim.failures.NOT_READY_TEXT`) for the same reason
    and a different fact: extraction finishes after this turn, so the model
    named under "not yet queryable" answers a later question and not this
    one.
    """
    text = _unresolved_message(result, fallback)
    advice = _NOTHING_TO_READ.get(str(result.get("reason")))
    return f"{text} {advice}" if advice else text


def _unresolved_message(result: dict[str, Any], fallback: str) -> str:
    """The route's own sentence, plus the model list when there is one."""
    message = result.get("message") or fallback
    models = result.get("models") or []
    if not models:
        return str(message)
    listed_models = ", ".join(
        f"{m.get('filename')} ({m.get('status')}, {m.get('elements', 0)} elements)" for m in models[:10]
    )
    heading = (
        "Available models"
        if result.get("reason") in {"no_match", "ambiguous"}
        else "Models in this project (not yet queryable)"
    )
    return f"{message} {heading}: {listed_models}."
