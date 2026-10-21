"""A turn that carries what the chat socket sends beside the question: the box a person drew (north-star set).

``nat run --input`` hands the workflow a plain string, so a run has no ``focus_region``. A row with
``box: given`` (``north_star_eval``) needs one: the review canvas sends ``user_message.focus_region``
(``common/wire_v2.py::FocusRegion``) with the open document's name, and the turn's prompt then carries
the „Fokusbereich“ section (``agents/piloti/prompt.py::focus_region_block``) that tells the model to
look at exactly that crop. The suite hands the row's box to the run through ``GRID_EVAL_USER_MESSAGE``
(:func:`env_for`); ``sitecustomize.py`` calls :func:`install` in the run's process, which makes the
turn's own parse (``aiq_agent.turn.payload.extract_turn_inputs``) read the string as the
``UserMessage`` the socket would have built. Nothing else about the turn is faked.

What a row's two harness needs mean here:

- ``given_box``: the turn carries the drawn box (``focus_region``: page, x, y, w, h);
- ``canvas``: the turn is asked with a document open (``focus_file_name``, on the project's shelf), the
  way the canvas chat is, so the turn's surface is ``review_canvas`` and ``canvas__*`` is in play.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

ENV = "GRID_EVAL_USER_MESSAGE"
#: The harness abilities this module gives a row (``north_star_eval.HARNESS``).
ABILITIES = frozenset({"given_box", "canvas"})
#: The ids the wire frame requires; the turn's own ids come from the run's conversation (`--conversation_id`).
MESSAGE_ID = "eval-turn"
CONVERSATION_ID = "eval-conversation"


def message_fields(row: dict[str, Any]) -> dict[str, Any] | None:
    """The ``UserMessage`` fields a row adds to its turn, or None for a row that sends only the question.

    A ``box: given`` row names the box in ``region`` (x, y, w, h as shares of the page) and the page and
    document in its gold; the document is the one open on the canvas.
    """
    if row.get("box") != "given":
        return None
    gold = row.get("gold") or []
    if isinstance(gold, dict):
        gold = [gold]
    if not gold:
        raise ValueError(f"{row.get('id')}: box: given needs a gold, which names the open document and page")
    x, y, w, h = (float(part) for part in row["region"])
    return {
        "focus_file_name": str(gold[0]["document"]),
        "focus_shelf": "project",
        "focus_region": {"page": int(gold[0]["page"]), "x": x, "y": y, "w": w, "h": h},
    }


def env_for(row: dict[str, Any]) -> dict[str, str]:
    """The run's extra environment for the row: empty unless it sends more than the question."""
    fields = message_fields(row)
    return {ENV: json.dumps(fields)} if fields else {}


def user_message(question: str, fields: dict[str, Any]) -> Any:
    """The v2 ``user_message`` the socket would have sent for this question and these fields."""
    from aiq_agent.common.wire_v2 import UserMessage

    return UserMessage(message_id=MESSAGE_ID, conversation_id=CONVERSATION_ID, text=question, **fields)


def wrapped(original: Callable[[Any], Any], fields: dict[str, Any]) -> Callable[[Any], Any]:
    """``extract_turn_inputs`` that reads a plain question as a ``user_message`` carrying ``fields``."""

    def extract_turn_inputs(request: Any) -> Any:
        if isinstance(request, str):
            request = user_message(request, fields)
        return original(request)

    return extract_turn_inputs


def install(environ: dict[str, str] | None = None) -> bool:
    """Make this process's turns carry the row's fields, when the suite asked; whether it did.

    Called before the workflow module is imported (``sitecustomize``), because it binds the parse by name
    (``from aiq_agent.turn.payload import extract_turn_inputs``) and so takes whatever is there then.
    """
    raw = (os.environ if environ is None else environ).get(ENV)
    if not raw:
        return False
    from aiq_agent.turn import payload

    payload.extract_turn_inputs = wrapped(payload.extract_turn_inputs, json.loads(raw))
    return True
