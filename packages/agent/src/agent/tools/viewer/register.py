"""``show_in_viewer``: Piloti proposes to move the asker's own document viewer (ADR-0144).

When an answer rests on a place in a document („Baubeschreibung S. 4“), the
person's next move is to go there. This tool lets Piloti take them: open a
document at a page, mark a passage or a box on it, open a comparison of two
Fassungen, or select an element of a building model. Each is one action of an
allow-list (``wire_v2.ViewerActionName``) and travels as one AG-UI frontend tool
call, the ``viewer_action`` event. The asker's live page runs it on their own
screen, announces it in the chat with a way back, and runs nothing for anyone
else: not a spectator, not a replay, not another agent.

It exists for a turn only when the asking page declared it can run it
(``user_message.client_tools``, AG-UI's ``RunAgentInput.tools``;
``common/client_tools``). A phone, a tab one release older, a background run
and an agent at the door declare nothing, and the model is not offered the tool
there (``agents/piloti/register._tools_in_scope``). It proposes ONE place per
turn: the page runs it after the answer has arrived, and a second call is
refused.

What this tier decides is only WHICH document and WHERE. The document is
resolved the way ``look`` resolves one (``look/resolve.py``) and read through
the BFF in the person's session (the canvas route's ``list``, which loads the
row with ``findDocumentForSession`` and admits it against the conversation's
audience), once: when resolving it already asked, that answer stands. A
document the person cannot see comes back refused and no event is sent. A chat
attachment is refused too: it is on no shelf, so the page's own read
(``GET /api/documents/{id}``, which lists shelves) could never open it, and a
proposal the page must refuse is not one to send. The browser reads the
document again before it moves anything, so a stale or forged event cannot open
what the reader may not see.

Its own entry point (``aiq_viewer`` in the root ``pyproject.toml``).
"""

from __future__ import annotations

import logging
from typing import Any
from typing import get_args
from uuid import uuid4

from pydantic import ValidationError

from aiq_agent.common.client_tools import claim_once
from aiq_agent.common.client_tools import client_tool_declared
from aiq_agent.common.turn_status import emit
from aiq_agent.common.wire_v2 import MAX_VIEWER_PASSAGE_CHARS
from aiq_agent.common.wire_v2 import ViewerActionBody
from aiq_agent.common.wire_v2 import ViewerActionName
from aiq_agent.common.wire_v2 import ViewerActionValue
from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX
from aiq_agent.observability.retrieval_trace import emit_step_span
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from ..canvas.calls import Refused
from ..canvas.calls import call
from ..canvas.calls import envelope
from ..look.resolve import Resolved
from ..look.resolve import resolve_document

logger = logging.getLogger(__name__)

#: The name the model calls.
TOOL = "show_in_viewer"

ACTIONS: tuple[str, ...] = get_args(ViewerActionName)

DESCRIPTION = (
    "Takes the person to the place your answer points at, in their own document viewer beside the chat. "
    "`action`: `open_document` (optionally at `page`), `highlight_passage` (`page` and `passage`, the exact words "
    "on that page, at most a sentence or two), `highlight_region` (`page` and `region=[x, y, w, h]`, shares of the "
    "page as shown, as `look` takes them), `compare_revisions` (`against`: an older Fassung of the same document), "
    "`focus_ifc_element` (an `.ifc` model and `element`, the element's IFC GlobalId). `document`: the file name "
    "from the inventory or a hit's `Citation:` line, or a document id; empty means the document open on the "
    "canvas, then this chat's document. One call per answer, for the one place the person will want to see; "
    "a second call is refused, and it is never for browsing. It is a proposal: the person's page shows it once "
    "your answer has arrived, decides whether it moves, and offers a way back. Do not write that their screen "
    "moved. Only a document of the office or the project opens; a chat attachment, and a document they may not "
    "see, are refused."
)

NOT_ON_THE_LIST = "Not possible: `action` is one of {actions}. Nothing was shown."
NOT_A_WORKSPACE_DOCUMENT = (
    "Not possible: '{name}' is not a document of the office or the project, so it has no viewer to open in. "
    "Cite it instead."
)
NOT_A_MODEL = "Not possible: '{name}' is no building model (.ifc), so no element can be selected in it."
SAME_DOCUMENT = "Not possible: `against` must be another Fassung than `document`. Nothing was shown."
INVALID = "Not shown: {detail}. Correct the arguments."
NOT_DECLARED = (
    "Not possible: the person's page cannot show a place in this turn (no viewer beside the chat). "
    "Cite the place in the answer instead; do not retry."
)
ONCE = "Not shown: one place per answer was already proposed. Do not call this again in this answer."
SESSION_ATTACHMENT = (
    "Not possible: '{name}' is a file attached to this chat, and the viewer opens only documents of the office or "
    "the project. Cite it instead."
)
READ_FORBIDDEN = "Not shown: the person may not open '{name}'. Tell them so; do not retry."
READ_GONE = "Not shown: '{name}' is not available to the person (deleted, held, or not theirs to see). Do not retry."
PROPOSED = (
    "Proposed to the person's viewer: {what}. Their page shows it in the chat and moves only if they allow it; "
    "do not write that their screen moved."
)


def _is_model(file_name: str) -> bool:
    return file_name.lower().endswith(".ifc")


def _is_attachment(resolved: Resolved) -> bool:
    collection = resolved.collection or (resolved.target.collection if resolved.target else "") or ""
    return collection.startswith(SESSION_COLLECTION_PREFIX)


async def _read_as_person(resolved: Resolved) -> None:
    """The BFF's own visibility, in the person's session, worded as the READ it is; a 403 or 404 is a refusal."""
    assert resolved.target is not None and resolved.signed is not None
    try:
        await call({"op": "list"}, resolved.target, resolved.signed)
    except Refused as refused:
        if refused.code == "forbidden":
            raise Refused(READ_FORBIDDEN.format(name=resolved.file_name), "forbidden") from refused
        if refused.code == "not_found":
            raise Refused(READ_GONE.format(name=resolved.file_name), "not_found") from refused
        raise


async def _visible(document: str) -> Resolved:
    """The workspace document ``document`` names, read as the person; ``Refused`` when the page could not open it."""
    # No person, no screen: a run without the turn's envelope (CLI, eval, a background run) shows nothing.
    envelope()
    resolved = await resolve_document(document)
    if isinstance(resolved, str):
        raise Refused(resolved, "unresolved")
    if _is_attachment(resolved):
        raise Refused(SESSION_ATTACHMENT.format(name=resolved.file_name), "attachment")
    if resolved.target is None or resolved.signed is None or not resolved.target.document_id:
        raise Refused(NOT_A_WORKSPACE_DOCUMENT.format(name=resolved.file_name), "not_workspace")
    # Resolving an id already read it through the BFF (for its name); a second read would answer the same.
    if not resolved.read_by_bff:
        await _read_as_person(resolved)
    return resolved


def _what(value: ViewerActionValue) -> str:
    args = value.args
    where = f"{args.document_name}" + (f", p. {args.page}" if args.page else "")
    if value.tool_call_name == "compare_revisions":
        where = f"{args.document_name} against {args.against_document_name or args.against_document_id}"
    if value.tool_call_name == "focus_ifc_element":
        where = f"{args.document_name}, element {args.element}"
    return f"{value.tool_call_name} ({where})"


async def _build(
    action: str,
    document: str,
    page: int | None,
    passage: str,
    region: list[float] | None,
    against: str,
    element: str,
) -> ViewerActionValue:
    """The checked call, or ``Refused`` with the sentence the model reads."""
    if action not in ACTIONS:
        raise Refused(NOT_ON_THE_LIST.format(actions=", ".join(f"`{a}`" for a in ACTIONS)), "not_allowed")
    resolved = await _visible(document)
    target = resolved.target
    assert target is not None and target.document_id  # _visible guarantees it
    args: dict[str, Any] = {"document_id": target.document_id, "document_name": resolved.file_name}
    if action == "focus_ifc_element" and not _is_model(resolved.file_name):
        raise Refused(NOT_A_MODEL.format(name=resolved.file_name), "not_model")
    if action == "compare_revisions":
        older = await _visible(against)
        if older.target is None or older.target.document_id == target.document_id:
            raise Refused(SAME_DOCUMENT, "same_document")
        args |= {"against_document_id": older.target.document_id, "against_document_name": older.file_name}
    if page is not None and action in ("open_document", "highlight_passage", "highlight_region"):
        args["page"] = page
    if action == "highlight_passage" and passage.strip():
        args["passage"] = passage.strip()[:MAX_VIEWER_PASSAGE_CHARS]
    if action == "highlight_region" and region is not None:
        args["region"] = region
    if action == "focus_ifc_element" and element.strip():
        args["element"] = element.strip()
    try:
        return ViewerActionValue(tool_call_id=f"va_{uuid4().hex[:12]}", tool_call_name=action, args=args)
    except ValidationError as exc:
        detail = "; ".join(error["msg"] for error in exc.errors())
        raise Refused(INVALID.format(detail=detail), "invalid") from exc


async def run_show_in_viewer(
    action: str,
    document: str = "",
    page: int | None = None,
    passage: str = "",
    region: list[float] | None = None,
    against: str = "",
    element: str = "",
) -> str:
    """Propose one viewer action to the asker's page; the sentence the model reads back."""
    if not client_tool_declared(TOOL):
        _observe(action, outcome="not_declared")
        return NOT_DECLARED
    try:
        value = await _build(action, document, page, passage or "", region, against or "", element or "")
    except Refused as refused:
        _observe(action, outcome=refused.code)
        return refused.message
    # Claimed at the send, not before the reads: of two calls in one round, the first to finish is the one.
    if not claim_once(TOOL):
        _observe(action, outcome="once")
        return ONCE
    emit(ViewerActionBody(value=value))
    _observe(action, outcome="proposed", page=value.args.page is not None)
    return PROPOSED.format(what=_what(value))


def _observe(action: str, *, outcome: str, page: bool = False) -> None:
    """One ``show_in_viewer`` observation: which action and what became of it. Never the passage or the name."""
    emit_step_span(TOOL, {"action": action if action in ACTIONS else "unknown", "page": page}, {"outcome": outcome})


class ShowInViewerConfig(FunctionBaseConfig, name="show_in_viewer"):
    """Configuration for ``show_in_viewer``. It has none: the allow-list is the wire's."""


@register_function(config_type=ShowInViewerConfig)
async def show_in_viewer(config: ShowInViewerConfig, _builder: Builder):
    """NAT function: ``show_in_viewer``, bound to Piloti in chat only."""

    async def _show_in_viewer(
        action: str,
        document: str = "",
        page: int | None = None,
        passage: str = "",
        region: list[float] | None = None,
        against: str = "",
        element: str = "",
    ) -> str:
        return await run_show_in_viewer(action, document, page, passage, region, against, element)

    yield FunctionInfo.from_fn(_show_in_viewer, description=DESCRIPTION)
