"""``canvas``: Piloti's hands on a document, as an agent-runtime function group.

Eight tools, the way a person works a document on the review canvas: see who
is in the ``room`` and where, ``point`` and ``highlight`` to show what is meant,
read the ``marks``, set a ``mark`` (a proposal a person takes over, or open when
the person asked for exactly that mark), ``update`` or ``delete`` one when the
person asks, and ``reply`` in a mark's thread. Looking at a page or a box on it
is ``look``, a tool of its own bound in every context (``tools/look``,
ADR-0128); it shares this group's target resolution and makes the box glow
through ``presence.show_reading``. The model calls these as ``canvas__room`` and
so on; one group,
because they share the client,
the target resolution and the restricted-folder rule, and because the agent runtime can serve
a function group over MCP as it stands, so a second client never means a second
implementation (ADR-0055).

## Which document, and as whom

Every tool takes an optional ``document`` (a file name from the inventory, or
an id) and otherwise acts on the document open on the canvas, then on the
conversation's subject (``target.py``). The BFF checks the document against the
asker's own access and the turn's signed scope, and acts as the person the
signed envelope names (echo, never sign: ``tools/AGENTS.md``). A thread question
is answered when the model calls ``reply``, which the prompt asks it to do; when
it does not, the turn's answer goes into the thread once the turn has ended
(``agent.turn.annotation_reply``), so ``reply``, ``update`` with its note and
``delete`` each note the mark they spoke in.

## What everyone sees

``mark``, ``update``, ``delete``, ``reply``, ``highlight`` and a labelled
``point`` are read by everyone who opens the document, so each passes
``policy.shared_write_refusal`` first. ``point`` and ``highlight`` are
ephemeral; the turn harness takes them down when the answer is out
(``presence.py``). ``mark``, ``update``, ``delete`` and ``reply`` put what the
BFF confirmed on the turn's ``canvas_activity`` card (``cards.py``); ``point``
and ``highlight`` add a ``reference`` item to the document's ``look`` card
(``tools/look/cards.py``), so a chat reader sees what the answer points at.

## Parity, with light reporting

What the person asks for, Piloti does under that person's rights, through the
same service a person's PATCH runs (``lib/annotations/agent.ts``): set a mark
open, resolve, reopen, dismiss, take over, assign, date, reword, delete one
the person set. Each change posts the model's ``note`` as Piloti's reply in the
mark's thread, and the card lists it with an undo. Findings of its own stay
proposals.

Parity is the office's choice: with the organization switch ``piloti-acts``
off (the default), the BFF refuses ``create``, ``update`` and ``delete`` with
``piloti-acts-off``, and the result tells the model to propose the mark, or
that the person makes the change themselves (``calls.refusal_for``).
"""

from __future__ import annotations

import logging
from typing import Any

from agent.turn.annotation_reply import note_thread_post
from nat.plugin_api import Builder
from nat.plugin_api import FunctionGroup
from nat.plugin_api import FunctionGroupBaseConfig
from nat.plugin_api import register_function_group

from ..look.cards import note_reference
from .calls import Refused
from .calls import call
from .calls import document_of
from .calls import envelope
from .calls import observe
from .cards import record_canvas_activity
from .marks import MAX_PROPOSALS_PER_CALL
from .marks import AnnotationProposal
from .marks import annotation_entry
from .marks import annotation_number
from .marks import changed_item
from .marks import create_payload
from .marks import created_items
from .marks import deleted_item
from .marks import marks_observation
from .marks import propose_payload
from .marks import proposed_items
from .marks import render_created
from .marks import render_deleted
from .marks import render_list
from .marks import render_proposed
from .marks import render_replied
from .marks import render_updated
from .marks import replied_item
from .marks import reply_body
from .marks import update_payload
from .policy import shared_write_refusal
from .presence import note_presence
from .room import highlight_payload
from .room import point_payload
from .room import render_room
from .room import room_observation
from .target import Target
from .target import Unresolved
from .target import is_uuid
from .target import resolve_target

logger = logging.getLogger(__name__)

#: The instance name the config gives the group: the model sees ``canvas__<tool>``.
GROUP = "canvas"

_DOCUMENT = (
    "`document` (optional): the file name from the overview, or the id; without it, the document open on the canvas, "
    "otherwise this chat's document."
)
_FRAME = "Locations are a share of the page as displayed: 0 to 1, origin top left, no pixels."

DESCRIPTIONS = {
    "room": (
        "Who has the document open right now: each person's page and viewport, which annotation they selected, "
        "which frame they are drawing, and how many annotations are open. Use it when „hier“, "
        f"„das“ or „diese Stelle“ is not already settled by the focus region. {_DOCUMENT}"
    ),
    "point": (
        "Moves your pointer, for everyone in the document, to `page`, `x`, `y`, with a short `label` (at most 80 "
        f"characters). Disappears when your answer is finished. {_FRAME} {_DOCUMENT}"
    ),
    "highlight": (
        "Shows everyone in the document a frame `page`, `x`, `y`, `w`, `h` with `label`, e.g. „Hier: Fluchtweg "
        "1,10 m“. For what your answer refers to; disappears when it is finished. Look first with "
        f"`look`. {_FRAME} {_DOCUMENT}"
    ),
    "marks": (
        "Reads a document's annotations with number, page, kind, status, text, basis, assignee, "
        "due date and replies. Read before a protocol, before a reply in the thread and before `mark`, so nothing "
        f"is marked twice. {_DOCUMENT}"
    ),
    "mark": (
        "Sets `proposals` as PROPOSALS from Piloti; none of them counts until a person takes the proposal over in "
        "the document or dismisses it. Never say a defect has been entered. `open=true` "
        "only when the person asks for exactly this "
        "annotation to be set (then it is open at once, in their name; if the office lets Piloti only propose, this is "
        "refused, then retry without `open`); your own findings, even in a requested review, stay proposals. "
        "First look at the page with `look` and estimate the spot there. Per proposal: `page` (from 1); `shape` "
        "`region` (preferred: a tight frame "
        "around the component) or `point`; `x`/`y` the top left corner, for `region` also `w`/`h` (x+w and y+h "
        "at most 1); `kind` `hint`, `question` or `defect`; `body` in the office's German, concrete and short "
        "(at most 2000 characters); `basis` with the source reference when the finding rests on a norm. At most "
        f"{MAX_PROPOSALS_PER_CALL} per call, the most important first. The file is called Dokument or Fassung, never "
        f"Plan. {_FRAME} {_DOCUMENT}"
    ),
    "update": (
        "Changes the annotation `annotation` (number or id) in the person's name, only "
        "when they ask for this change to "
        "this annotation. Give only what changes: `status` `open` (take over, reopen), "
        "`resolved` or `dismissed` (dismiss a proposal); `assignee` (name); `due_on` (YYYY-MM-DD); `kind`; "
        "`body`; `-` clears `assignee`/`due_on`. `note` (required): one sentence on what you did, e.g. „Erledigt: "
        "Lichte Breite im Schnitt B-B mit 1,25 m kotiert.“; it appears as a reply from Piloti in the thread. Give "
        "the number in your answer. If the office lets Piloti only propose, this is "
        "refused: then the person changes it "
        "themselves. A request to check whether something is fixed asks for no change: then you answer with `reply`, "
        f"and the person resolves it. {_DOCUMENT}"
    ),
    "delete": (
        "Deletes the annotation `annotation` (number or id) with its thread, permanently. Only on explicit request, "
        "and only annotations the person set themselves; if the office lets Piloti only propose, the person deletes "
        f"it themselves. {_DOCUMENT}"
    ),
    "reply": (
        "Writes `body` as Piloti's reply into the thread of the annotation `annotation` (its id or number). "
        "Everyone who opens the document reads it at once: short, understandable on its own, without source marks like "
        "[1], at most 2000 characters. Use it when you were asked in the thread or are asked to. "
        "If you are to check whether annotations from an earlier revision are fixed in the current one: one "
        "reply per annotation, beginning with „In <Fassung> behoben:“ or „Weiterhin offen:“ and saying what you see "
        "at the spot; look first with `look`. You do not change the status in doing so. "
        f"{_DOCUMENT}"
    ),
}


class DocumentCanvasConfig(FunctionGroupBaseConfig, name="document_canvas"):
    """Configuration for the ``canvas`` function group. The render limits moved to ``look``'s own config."""


async def _target(document: str) -> tuple[Target, Any]:
    signed = envelope()
    target = await resolve_target(document, signed)
    if isinstance(target, Unresolved):
        raise Refused(target.message, "unresolved_document")
    return target, signed


def _shared_write_allowed(step: str) -> None:
    if (refusal := shared_write_refusal()) is not None:
        observe(step, {"step": step}, {"refused": "restricted"})
        raise Refused(refusal, "restricted")


async def _refusing(step: str, run: Any) -> Any:
    """Run one tool body; a :class:`Refused` becomes its sentence, recorded by its code."""
    try:
        return await run()
    except Refused as refused:
        if refused.code != "restricted":
            observe(step, {"step": step}, {"refused": refused.code})
        return refused.message


async def run_room(document: str = "") -> str:
    """Who has the document open, and where."""

    async def body() -> str:
        target, signed = await _target(document)
        result = await call({"op": "room"}, target, signed)
        observe("room", {"step": "room"}, room_observation(result))
        return render_room(result)

    return await _refusing("room", body)


async def run_point(page: int, x: float, y: float, label: str = "", document: str = "") -> str:
    """Move Piloti's pointer, for everyone in the document."""

    async def body() -> str:
        payload = point_payload(page, x, y, label)
        if "label" in payload:
            _shared_write_allowed("point")
        target, signed = await _target(document)
        result = await call(payload, target, signed)
        note_presence(target.document_id)
        note_reference(
            document_of(result, target),
            payload["page"],
            point=[payload["x"], payload["y"]],
            label=payload.get("label", ""),
        )
        observe("point", {"page": payload["page"], "label": "label" in payload}, {"ok": True})
        return (
            f"Your pointer is on p. {payload['page']}, visible to everyone in the document "
            f"until your answer is finished."
        )

    return await _refusing("point", body)


async def run_highlight(page: int, x: float, y: float, w: float, h: float, label: str, document: str = "") -> str:
    """Show everyone in the document a labelled box."""

    async def body() -> str:
        payload = highlight_payload(page, x, y, w, h, label)
        _shared_write_allowed("highlight")
        target, signed = await _target(document)
        result = await call(payload, target, signed)
        note_presence(target.document_id)
        box = [payload["x"], payload["y"], payload["w"], payload["h"]]
        note_reference(document_of(result, target), payload["page"], region=box, label=payload["label"])
        observe("highlight", {"page": payload["page"]}, {"ok": True})
        return (
            f"The frame „{payload['label']}“ on p. {payload['page']} is visible to everyone in the document until your "
            "answer is finished."
        )

    return await _refusing("highlight", body)


async def run_marks(document: str = "") -> str:
    """Read the marks on the document."""

    async def body() -> str:
        target, signed = await _target(document)
        result = await call({"op": "list"}, target, signed)
        observe("marks", {"step": "marks"}, marks_observation("list", result))
        return render_list(result)

    return await _refusing("marks", body)


async def run_mark(proposals: list[AnnotationProposal] | None = None, document: str = "", open: bool = False) -> str:  # noqa: A002 - the model's word
    """Propose marks on the document, or set them open when the person asked for exactly these."""

    async def body() -> str:
        items = list(proposals or [])
        payload = create_payload(items) if open else propose_payload(items)
        _shared_write_allowed("mark")
        target, signed = await _target(document)
        result = await call(payload, target, signed)
        operation = "create" if open else "propose"
        made = created_items(result) if open else proposed_items(result)
        record_canvas_activity(document_of(result, target), made)
        count = len(payload["marks" if open else "proposals"])
        observe("mark", {"proposals": count, "open": open}, marks_observation(operation, result))
        return render_created(result) if open else render_proposed(result)

    return await _refusing("mark", body)


async def _annotation_ref(annotation: str, target: Target, signed: Any, tool: str) -> tuple[str, str | None]:
    """The id to act on, and the status read with it: as given (no status), or looked up by its number."""
    ref = (annotation or "").strip()
    if is_uuid(ref):
        return ref, None
    number = annotation_number(ref)
    if number is None:
        raise Refused(f"Error: `{tool}` needs `annotation`: the id or the number from `marks`.")
    entry = annotation_entry(await call({"op": "list"}, target, signed), number)
    status = entry.get("status")
    return entry["id"], status if isinstance(status, str) else None


async def run_update(
    annotation: str,
    note: str,
    status: str = "",
    assignee: str = "",
    due_on: str = "",
    kind: str = "",
    body: str = "",
    document: str = "",
) -> str:
    """Change a mark the person named, in their name, and say so in its thread."""

    async def run() -> str:
        change = update_payload(status=status, assignee=assignee, due_on=due_on, kind=kind, body=body, note=note)
        _shared_write_allowed("update")
        target, signed = await _target(document)
        annotation_id, seen = await _annotation_ref(annotation, target, signed, "update")
        # A mark looked up by its number is changed only if it still stands as it was read.
        guard = {"expectedStatus": seen} if seen else {}
        result = await call({"op": "update", "annotationId": annotation_id, **change, **guard}, target, signed)
        if result.get("noted"):
            record_canvas_activity(document_of(result, target), [changed_item(result, change["note"])])
            note_thread_post(annotation_id)  # the note is Piloti's reply in that thread
        observe("update", {"fields": sorted(set(change) - {"note"})}, marks_observation("update", result))
        return render_updated(result)

    return await _refusing("update", run)


async def run_delete(annotation: str, document: str = "") -> str:
    """Delete a mark the person set, at their explicit request."""

    async def run() -> str:
        _shared_write_allowed("delete")
        target, signed = await _target(document)
        annotation_id, _ = await _annotation_ref(annotation, target, signed, "delete")
        result = await call({"op": "delete", "annotationId": annotation_id}, target, signed)
        record_canvas_activity(document_of(result, target), [deleted_item(result)])
        note_thread_post(annotation_id)  # no thread is left to answer in
        observe("delete", {"step": "delete"}, marks_observation("delete", result))
        return render_deleted(result)

    return await _refusing("delete", run)


async def run_reply(annotation: str, body: str, document: str = "") -> str:
    """Answer in a mark's thread."""

    async def run() -> str:
        text = reply_body(body)
        _shared_write_allowed("reply")
        target, signed = await _target(document)
        annotation_id, _ = await _annotation_ref(annotation, target, signed, "reply")
        result = await call({"op": "reply", "annotationId": annotation_id, "body": text}, target, signed)
        record_canvas_activity(document_of(result, target), [replied_item(result, text)])
        note_thread_post(annotation_id)
        observe("reply", {"step": "reply"}, marks_observation("reply", result))
        return render_replied(result)

    return await _refusing("reply", run)


@register_function_group(config_type=DocumentCanvasConfig)
async def document_canvas(config: DocumentCanvasConfig, _builder: Builder):
    """The canvas tools, as one group."""
    group = FunctionGroup(config=config)
    for name, fn in (
        ("room", run_room),
        ("point", run_point),
        ("highlight", run_highlight),
        ("marks", run_marks),
        ("mark", run_mark),
        ("update", run_update),
        ("delete", run_delete),
        ("reply", run_reply),
    ):
        group.add_function(name, fn, description=DESCRIPTIONS[name])
    yield group
