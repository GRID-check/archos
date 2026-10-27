"""the four file verbs Piloti gets, and nothing else.

``ls``, ``read_file``, ``write_file``, ``edit_file`` — stock DeepAgents tools
over :class:`~aiq_agent.tools.documents.draft_store.DraftBackend`. The
middleware's ``tools=`` allowlist builds only these four: ``glob`` and ``grep``
buy nothing over one flat directory of at most a handful of files, ``execute``
has no sandbox behind it, and ``delete`` (DeepAgents 0.7, recursive, offered
whenever the backend implements it, which ``StoreBackend`` does) would let the
model drop a draft the reader has a card for.

The descriptions are our own (English, like everything an agent reads; the
documents the model writes are German), because the tool description is the
last thing it reads before choosing a verb. Two things
they deliberately do NOT say:

* **"You must read the file before editing it."** DeepAgents' stock text claims
  it; nothing enforces it here, and an instruction the system does not check is
  one the model learns to ignore.
* **Anything about filing.** The working directory is not the project. What a
  draft becomes is decided by a person, through the lifecycle API.

The same ``read_file`` reads the turn's skills (ADR-0135): the run's
``SkillsBackend`` is routed under ``/skills/`` beside the working directory,
read-only, so one verb serves both and a turn with no conversation still gets
``read_file`` for its skills alone. A tool name is unique in a binding, which
is why the skills do not get a ``read_file`` of their own.
"""

from __future__ import annotations

import logging

from deepagents.backends import CompositeBackend
from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.filesystem import FilesystemPermission
from langchain_core.tools import BaseTool

from aiq_agent.project_context import get_conversation_id_from_context
from aiq_agent.skills import SKILLS_ROOT

from .draft_store import DRAFT_ROOT
from .draft_store import DraftBackend
from .draft_store import get_draft_backend

logger = logging.getLogger(__name__)

#: The verbs bound into Piloti's tool node, in the order the model
#: meets them, and the middleware's allowlist: nothing else is built.
DRAFT_TOOL_NAMES = ("ls", "read_file", "write_file", "edit_file")

#: Model-facing text, replacing DeepAgents' defaults. ``edit_file`` carries the
#: two things that actually make an exact-string replacement land: anchor on a
#: heading, and copy the paragraph rather than retyping it — with the warning
#: that ``read_file`` prints a ``@@ lines … @@`` header that is not part of the
#: file (since DeepAgents 0.7 the body below it is verbatim, without the line
#: numbers and tabs it used to carry).
_TOOL_DESCRIPTIONS = {
    "ls": (
        "Lists the drafts of this conversation. The working directory is at "
        f"`{DRAFT_ROOT}` and contains only what was written in this conversation — "
        "no project files, no office shelf (Büroablage). Call it before a revision when the "
        "path of the draft is not known."
    ),
    "read_file": (
        "Reads a draft from the working directory. The output starts with a header line "
        "`@@ lines … @@` that belongs to the display and not to the document; the lines below it "
        "are the document verbatim. Read before a revision, so that `old_string` comes verbatim "
        "from the document. "
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
        "change, verbatim from the output of `read_file` — without its "
        "`@@ lines … @@` header line. If the text occurs several times, the "
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

#: The skills are read, never written, and only under their own root.
_SKILL_PERMISSION = FilesystemPermission(operations=["read"], paths=[f"{SKILLS_ROOT}**"], mode="allow")

_SKILL_READ = (
    "a skill's instructions: the `SKILL.md` at a path the Skills section lists, under "
    f"`{SKILLS_ROOT}`. Pass `limit=1000` so the whole method arrives in one read."
)
_READ_WITH_SKILLS = f"{_TOOL_DESCRIPTIONS['read_file']} It also reads {_SKILL_READ}"
_READ_SKILLS_ONLY = f"Reads {_SKILL_READ}"


def draft_tools(backend: DraftBackend | None, *, skills: BackendProtocol | None = None) -> list[BaseTool]:
    """The verbs for one turn: the four over the working directory, ``read_file`` over the skills.

    With both, the skills backend is a ``/skills/`` route on a composite whose
    default is the working directory; with skills alone, ``read_file`` is the
    only verb. Every path outside the two roots is denied in the tool.
    """
    if backend is None and skills is None:
        return []
    names = DRAFT_TOOL_NAMES if backend is not None else ("read_file",)
    descriptions = dict(_TOOL_DESCRIPTIONS)
    permissions = list(_PERMISSIONS)
    mounted: BackendProtocol = backend if backend is not None else skills  # ty: ignore[invalid-assignment]
    if skills is not None:
        mounted = CompositeBackend(default=mounted, routes={SKILLS_ROOT: skills})
        descriptions["read_file"] = _READ_WITH_SKILLS if backend is not None else _READ_SKILLS_ONLY
        permissions.insert(0, _SKILL_PERMISSION)
    middleware = FilesystemMiddleware(
        backend=mounted,
        custom_tool_descriptions=descriptions,
        permissions=permissions,
        tools=list(names),
    )
    by_name = {tool.name: tool for tool in middleware.tools}
    return [by_name[name] for name in names if name in by_name]


async def draft_tools_for_turn(*, skills: BackendProtocol | None = None) -> list[BaseTool]:
    """The file verbs for the turn in context; ``[]`` when it has neither drafts nor skills.

    No conversation id means there is nothing to namespace a working directory
    by (a CLI run, an eval, a job worker), so the turn is offered no draft verbs
    at all rather than a directory shared by everyone. A store that cannot be
    reached is the same answer: the turn answers without drafting, which is what
    every turn did before this existed. ``skills``, the turn's skills backend,
    is readable either way.
    """
    conversation_id = get_conversation_id_from_context()
    backend: DraftBackend | None = None
    if conversation_id:
        try:
            backend = await get_draft_backend(conversation_id)
        except Exception:  # noqa: BLE001 - a working directory is never worth the turn
            logger.warning("Working directory unavailable; this turn is answered without it.", exc_info=True)
    return draft_tools(backend, skills=skills)
