"""``show_in_viewer``: Piloti proposes to move the asker's own document viewer (ADR-0144).

When an answer rests on a place in a document („Baubeschreibung S. 4“), the
person's next move is to go there. This tool lets Piloti take them: open a
document at a page, mark a passage or a box on it, open a comparison of two
Fassungen, or select an element of a building model. Each is one action of an
allow-list (``wire_v2.ViewerActionName``) and travels as one AG-UI frontend tool
call, the ``viewer_action`` event. The asker's live page runs it on their own
screen, announces it in the chat with a way back, and runs nothing for anyone
else: not a spectator, not a replay, not another agent.

What this tier decides is only WHICH document and WHERE. The document is
resolved the way ``look`` resolves one (``look/resolve.py``) and then read once
through the BFF in the person's session (the canvas route's ``list``, which
loads the row with ``findDocumentForSession`` and admits it against the
conversation's audience). A document the person cannot see comes back refused
and no event is sent. The browser asks the BFF again before it moves anything,
so a stale or forged event cannot open what the reader may not see.

Never offered on the agent door: the exposure config withholds the viewer as
the person's own screen state (``document-viewer-place-get``, ``ui-state``).

Its own entry point (``aiq_viewer`` in the root ``pyproject.toml``).
"""

from __future__ import annotations

import logging
from typing import Any
from typing import get_args
from uuid import uuid4

from pydantic import ValidationError

from aiq_agent.common.turn_status import emit
from aiq_agent.common.wire_v2 import MAX_VIEWER_PASSAGE_CHARS
from aiq_agent.common.wire_v2 import ViewerActionBody
from aiq_agent.common.wire_v2 import ViewerActionName
from aiq_agent.common.wire_v2 import ViewerActionValue
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
    "page as shown, as `look` takes them), `compare_revisions` (`against`: the older Fassung of the same plan), "
    "`focus_ifc_element` (an `.ifc` model and `element`, the element's IFC GlobalId). `document`: the file name "
    "from the inventory or a hit's `Citation:` line, or a document id; empty means the document open on the "
    "canvas, then this chat's document. Use it once per answer, for the one place the person will want to see; "
    "never to browse. It is a proposal: the person's page decides whether it moves, and shows it in the chat "
    "with a way back. Do not write that their screen moved. Only a document of the office or the project opens; "
    "a document they may not see is refused."
)

NOT_ON_THE_LIST = "Not possible: `action` is one of {actions}. Nothing was shown."
NOT_A_WORKSPACE_DOCUMENT = (
    "Not possible: '{name}' is not a document of the office or the project, so it has no viewer to open in. "
    "Cite it instead."
)
NOT_A_MODEL = "Not possible: '{name}' is no building model (.ifc), so no element can be selected in it."
SAME_DOCUMENT = "Not possible: `against` must be another Fassung than `document`. Nothing was shown."
INVALID = "Not shown: {detail}. Correct the arguments."
PROPOSED = (
    "Proposed to the person's viewer: {what}. Their page shows it in the chat and moves only if they allow it; "
    "do not write that their screen moved."
)


def _is_model(file_name: str) -> bool:
    return file_name.lower().endswith(".ifc")


async def _visible(document: str) -> Resolved:
    """The workspace document ``document`` names, read once as the person; ``Refused`` when they cannot see it."""
    # No person, no screen: a run without the turn's envelope (CLI, eval, a background run) shows nothing.
    envelope()
    resolved = await resolve_document(document)
    if isinstance(resolved, str):
        raise Refused(resolved, "unresolved")
    if resolved.target is None or resolved.signed is None or not resolved.target.document_id:
        raise Refused(NOT_A_WORKSPACE_DOCUMENT.format(name=resolved.file_name), "not_workspace")
    # The BFF's own visibility, in the person's session: a 403 or 404 is a refusal the model relays.
    await call({"op": "list"}, resolved.target, resolved.signed)
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
    try:
        value = await _build(action, document, page, passage or "", region, against or "", element or "")
    except Refused as refused:
        _observe(action, outcome=refused.code)
        return refused.message
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
