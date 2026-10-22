"""the four file verbs Piloti gets, and nothing else.

``ls``, ``read_file``, ``write_file``, ``edit_file`` — stock DeepAgents tools
over :class:`~aiq_agent.tools.documents.draft_store.DraftBackend`. ``glob``,
``grep`` and ``execute`` are built by the same middleware and dropped here:
over one flat directory of at most a handful of files, a search verb buys
nothing and costs a tool call, and ``execute`` has no sandbox behind it.

The descriptions are German, because the model writes German documents and the
tool description is the last thing it reads before choosing a verb. Two things
they deliberately do NOT say:

* **"You must read the file before editing it."** DeepAgents' stock text claims
  it; nothing enforces it here, and an instruction the system does not check is
  one the model learns to ignore.
* **Anything about filing.** The working directory is not the project. What a
  draft becomes is decided by a person, through the lifecycle API.
"""

from __future__ import annotations

import logging

from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.filesystem import FilesystemPermission
from langchain_core.tools import BaseTool

from aiq_agent.project_context import get_conversation_id_from_context

from .draft_store import DRAFT_ROOT
from .draft_store import DraftBackend
from .draft_store import get_draft_backend

logger = logging.getLogger(__name__)

#: The verbs bound into Piloti's tool node, in the order the model
#: meets them. Everything else the middleware builds is dropped.
DRAFT_TOOL_NAMES = ("ls", "read_file", "write_file", "edit_file")

#: Model-facing text, replacing DeepAgents' defaults. ``edit_file`` carries the
#: two things that actually make an exact-string replacement land: anchor on a
#: heading, and copy the paragraph rather than retyping it — with the warning
#: that ``read_file`` prints line numbers that are not part of the file.
_TOOL_DESCRIPTIONS = {
    "ls": (
        "Lists the drafts of this conversation. The working directory is at "
        f"`{DRAFT_ROOT}` and contains only what was written in this conversation — "
        "no project files, no office shelf (Büroablage). Call it before a revision when the "
        "path of the draft is not known."
    ),
    "read_file": (
        "Reads a draft from the working directory. The output has a line number "
        "and a tab prepended to the text of each line; both belong to the display and not to the "
        "document. Read before a revision, so that `old_string` comes verbatim from the document. "
        "What stands here, the answer wrote itself; evidence comes from the "
        "source tools."
    ),
    "write_file": (
        "Writes a NEW document into this conversation's working directory, as Markdown "
        f"under `{DRAFT_ROOT}<name>.md` (short, descriptive file name, lowercase, "
        "hyphens). For a commissioned document — Aktenvermerk, protocol, "
        "checklist, area schedule, concept draft: the document is written, not "
        "described in the answer. The document begins with a heading (`# …`) and is "
        "complete; the answer then says in one sentence what was written. "
        "Only creates new files: if the path already exists, `edit_file` is the tool."
    ),
    "edit_file": (
        "Revises an existing draft by replacing `old_string` exactly once with "
        "`new_string`. `old_string` must be unique in the document: anchor on a "
        "heading and take over the whole paragraph from the heading to the end of the text to "
        "change, verbatim from the output of `read_file` — without the "
        "prepended line numbers and tabs. If the text occurs several times, the "
        "tool reports the count; then retry with more surrounding context. For a new document "
        "use `write_file`."
    ),
}

#: Read and write are confined to the one root. The permission is checked in the
#: TOOL, before the backend is reached, so the model gets "permission denied" on
#: a path it invented instead of a storage error; the backend refuses the same
#: paths on its own (``draft_store.path_refusal``), because a second consumer
#: of the backend must not have to remember this list. The root itself is
#: allowed — ``ls`` lists it — in both spellings, because the middleware
#: normalises the trailing slash away before matching.
_PERMISSIONS = [
    FilesystemPermission(
        operations=["read", "write"],
        paths=[DRAFT_ROOT.rstrip("/"), DRAFT_ROOT, f"{DRAFT_ROOT}**"],
        mode="allow",
    ),
    FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="deny"),
]


def draft_tools(backend: DraftBackend) -> list[BaseTool]:
    """The four verbs bound to one conversation's working directory."""
    middleware = FilesystemMiddleware(
        backend=backend,
        custom_tool_descriptions=_TOOL_DESCRIPTIONS,
        _permissions=_PERMISSIONS,
    )
    by_name = {tool.name: tool for tool in middleware.tools}
    return [by_name[name] for name in DRAFT_TOOL_NAMES if name in by_name]


async def draft_tools_for_turn() -> list[BaseTool]:
    """The working-directory tools for the turn in context; ``[]`` when there is none.

    No conversation id means there is nothing to namespace a working directory
    by (a CLI run, an eval, a job worker), so the turn is offered no file verbs
    at all rather than a directory shared by everyone. A store that cannot be
    reached is the same answer: the turn answers without drafting, which is what
    every turn did before this existed.
    """
    conversation_id = get_conversation_id_from_context()
    if not conversation_id:
        return []
    try:
        backend = await get_draft_backend(conversation_id)
    except Exception:  # noqa: BLE001 - a working directory is never worth the turn
        logger.warning("Working directory unavailable; this turn is answered without it.", exc_info=True)
        return []
    return draft_tools(backend)
