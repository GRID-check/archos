"""Piloti's file verbs: the drafts' four, and the estate's readers beside them (ADR-0133).

Two shapes, chosen per turn:

* **The drafts alone** (:func:`draft_tools`, a turn with no estate backend):
  stock DeepAgents tools over :class:`DraftBackend`, as before ADR-0133.
* **One namespace** (:func:`filesystem_tools`): the same tools over a
  ``CompositeBackend`` whose default is the read-only estate
  (``knowledge_layer.estate``) and whose ``/drafts/`` route is the draft store.
  ``read_file`` then reads both, and renders grounding blocks on the estate
  (``filesystem.PilotiFilesystem``).

The drafts-only notes follow.

The four file verbs over the drafts, and nothing else.

``ls``, ``read_file``, ``write_file``, ``edit_file`` — stock DeepAgents tools
over :class:`~agent.tools.documents.draft_store.DraftBackend`. The
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
``SkillsBackend`` is routed under ``/skills/`` beside the working directory
(and beside the estate, in the one-namespace shape), read-only, so one verb
serves all of them and a turn with no conversation still gets ``read_file``
for its skills. A tool name is unique in a binding, which is why the skills
do not get a ``read_file`` of their own.
"""

from __future__ import annotations

import logging
from typing import Any

from deepagents.backends import CompositeBackend
from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.filesystem import FilesystemPermission
from langchain_core.tools import BaseTool

from agent.project_context import get_conversation_id_from_context
from agent.skills import SKILLS_ROOT

from .draft_store import DRAFT_ROOT
from .draft_store import DraftBackend
from .draft_store import get_draft_backend
from .filesystem import PilotiFilesystem
from .filesystem import composite_backend
from .filesystem import with_bare_schema

logger = logging.getLogger(__name__)

#: The verbs bound into Piloti's tool node, in the order the model
#: meets them, and the middleware's allowlist: nothing else is built.
DRAFT_TOOL_NAMES = ("ls", "read_file", "write_file", "edit_file")

#: The estate's readers, bound whether or not the turn has a working directory.
ESTATE_TOOL_NAMES = ("ls", "read_file", "glob", "grep")

#: The tools only a working directory gives: the two that write.
DRAFT_ONLY_TOOL_NAMES = ("write_file", "edit_file")

#: The two writing verbs, one contract whichever namespace they sit in: a draft is written once, and
#: ``edit_file`` copies its anchor from ``read_file``, whose ``@@ … @@`` header (DeepAgents 0.7) is not
#: part of the file.
_WRITE_DESCRIPTIONS = {
    "write_file": (
        f"Writes a draft as Markdown at `{DRAFT_ROOT}<name>.md` (short, lowercase, hyphens). For a commissioned "
        "document (Aktenvermerk, Protokoll, Checkliste, Flächenaufstellung): write it here, complete and starting "
        "with a `# ` heading, rather than in the answer, which then says in one sentence what was written. A draft "
        f"is written once: an existing path is refused, and edit_file changes it. Only {DRAFT_ROOT} is writable."
    ),
    "edit_file": (
        "Changes part of a draft: replaces `old_string`, which must occur exactly once (or pass "
        "`replace_all=true`), with `new_string`. Copy `old_string` verbatim from read_file's output below its "
        f"`@@ … @@` header, anchored on a heading and covering the whole paragraph you change. Only {DRAFT_ROOT} "
        "is editable."
    ),
}

#: Model-facing text for the drafts alone, replacing DeepAgents' defaults.
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
    **_WRITE_DESCRIPTIONS,
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


#: The verbs once they read the estate too: Piloti's chat binding (ADR-0133 slice 6). Each is a contract: what
#: the tool does, its arguments, what comes back, its limits, and one clause on when a neighbouring tool fits
#: instead. What a result can say at the moment it matters (caps reached, `incomplete:`, a miss, a drawing's
#: caveat, an unknown path, restricted folders) is said by the result, not here; the schema fields are bare, so
#: each argument's meaning is stated once. The texts and the sources behind them:
#: ``docs/audit/prompt-value-audit-2026-10.md`` (slice 6).
_ESTATE_DESCRIPTIONS = {
    "ls": (
        "Lists one folder: its subfolders with their document counts, and its files with pages, Dokumentart, "
        "Plankopf index and date. `path` is an absolute folder path under a mount: /project/ (this project), "
        "/office/ (the Büroablage), /chat/ (files dropped into this conversation), /law/oib/ (the "
        f'OIB-Richtlinien), {DRAFT_ROOT} (this conversation\'s drafts), {SKILLS_ROOT} (procedures); `ls("/")` '
        "lists the mounts this turn has. `depth` 2 to 4 returns the tree below as folder cards; a folder's "
        "`README.md` is its card. At most 40 files a folder are listed; a listing is an index, never cited. Use "
        "it to see what a project or folder holds; to find a file by part of its name, glob is quicker."
    ),
    "glob": (
        "Finds files by name. `pattern` takes `*`, `**`, `?`, `[abc]` and `{a,b}` (`**/*Brandschutz*`); case is "
        "ignored and ä/ae, ö/oe, ü/ue, ß/ss are folded, so `*Flaeche*` finds `Flächenwidmung`. `path` limits it to one "
        "folder; without it every mount is searched. Returns absolute paths, each with pages and Dokumentart, at "
        "most 100. Names only: for words inside documents use grep, for a topic knowledge_search."
    ),
    "grep": (
        "Finds wording inside documents: which files and pages contain a word, a number, a name, a Geschäftszahl "
        "or a clause reference, and shows that it stands nowhere else. Literal by default: case, ä/ae, ö/oe, "
        "ü/ue, ß/ss, soft hyphens and words split at a line break are folded, and a pattern of two or three "
        'characters matches whole words only. `mode="regex"` takes a regular expression (Python syntax, '
        "case-insensitive, `MA 37/\\d{6}`). `stemmed=true` also matches inflected German forms. `path` limits "
        "the search to a folder or one document and `glob` filters file names; without `path` every document "
        f"mount is searched, the OIB corpus included, and the drafts only with a {DRAFT_ROOT} path.\n"
        "`output_mode`: `files_with_matches` (default) gives each matching file with its count and pages and how "
        "many files were searched; `content` gives the matching pages as citable passages (up to 8, spread over "
        "files) and the lines around each match (`context`, 0 to 3, adds lines); `count` gives occurrences per "
        "file. `max_count` caps the matches returned. It matches words, not meaning: a question worded "
        "differently from the documents is knowledge_search's."
    ),
    "read_file": (
        f"Reads a file by its absolute path: a document, a draft under {DRAFT_ROOT} or a skill under "
        f"{SKILLS_ROOT}. A document's text is at its file name plus `.md` (`Brandschutzkonzept.pdf.md`); the bare "
        '`.pdf` path works too. `pages` ("3", "3-5", "3,7,11"; at most 30) reads those pages and `clause` '
        '("3.5.2", "Tabelle 3", or the Punkt a hit printed) one Punkt of a structured document such as an '
        "OIB-Richtlinie; without either you get the first page and the Gliederung. A document comes back one "
        "citable passage per page, up to about 6k tokens a call. `offset` and `limit` count lines (default 0 and "
        "100) and apply to drafts, skills and text files; on a paginated document use `pages`. A draft is what "
        "the answer wrote, never evidence."
    ),
    **_WRITE_DESCRIPTIONS,
}


#: The skills are read, never written, and only under their own root.
_SKILL_PERMISSION = FilesystemPermission(operations=["read"], paths=[f"{SKILLS_ROOT}**"], mode="allow")

_SKILL_READ = (
    "a skill's instructions: the `SKILL.md` at a path the Skills section lists, under "
    f"`{SKILLS_ROOT}`. Pass `limit=1000` so the whole method arrives in one read."
)
_READ_WITH_SKILLS = f"{_TOOL_DESCRIPTIONS['read_file']} It also reads {_SKILL_READ}"
_READ_SKILLS_ONLY = f"Reads {_SKILL_READ}"


def filesystem_tools(
    drafts: DraftBackend | None, estate: Any, *, skills: BackendProtocol | None = None
) -> list[BaseTool]:
    """The turn's file verbs over one namespace: the estate's readers, plus the drafts' verbs when there are drafts.

    ``estate`` is the knowledge layer's ``EstateBackend`` (built once, at boot);
    ``drafts`` the conversation's draft store, or ``None`` on a turn without a
    conversation; ``skills`` the turn's skills backend, a read-only ``/skills/``
    route beside ``/drafts/``. The tools are built per turn because the draft
    store and the skills are; their descriptions are the same on every turn, so
    the tool payload varies only with whether the two writing verbs are bound.
    """
    names = [*ESTATE_TOOL_NAMES, *(DRAFT_ONLY_TOOL_NAMES if drafts is not None else ())]
    permissions = list(_PERMISSIONS)
    if skills is not None:
        permissions.insert(0, _SKILL_PERMISSION)
    middleware = PilotiFilesystem(
        estate=estate,
        drafts=drafts is not None,
        backend=composite_backend(drafts, estate, skills=skills),
        custom_tool_descriptions=dict(_ESTATE_DESCRIPTIONS),
        permissions=permissions,
        tools=names,
    )
    by_name = {tool.name: with_bare_schema(tool) for tool in middleware.tools}
    order = [*DRAFT_TOOL_NAMES, *(name for name in ESTATE_TOOL_NAMES if name not in DRAFT_TOOL_NAMES)]
    return [by_name[name] for name in order if name in by_name]


def draft_tools(backend: DraftBackend | None, *, skills: BackendProtocol | None = None) -> list[BaseTool]:
    """The verbs for one turn without an estate: the four over the working directory, ``read_file`` over the skills.

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


async def filesystem_tools_for_turn(estate: Any = None, *, skills: BackendProtocol | None = None) -> list[BaseTool]:
    """The file verbs for the turn in context.

    Without an estate backend, exactly :func:`draft_tools_for_turn`. With one,
    the estate's readers are bound on every turn, the drafts' verbs join them
    when the turn has a working directory, and ``read_file`` reads the skills.
    """
    if estate is None:
        return await draft_tools_for_turn(skills=skills)
    return filesystem_tools(await _turn_drafts(), estate, skills=skills)


async def _turn_drafts() -> DraftBackend | None:
    """This conversation's draft store; ``None`` with no conversation, or when the store cannot be reached."""
    conversation_id = get_conversation_id_from_context()
    if not conversation_id:
        return None
    try:
        return await get_draft_backend(conversation_id)
    except Exception:  # noqa: BLE001 - a working directory is never worth the turn
        logger.warning("Working directory unavailable; this turn is answered without it.", exc_info=True)
        return None


async def draft_tools_for_turn(*, skills: BackendProtocol | None = None) -> list[BaseTool]:
    """The file verbs for the turn in context without an estate; ``[]`` when it has neither drafts nor skills.

    No conversation id means there is nothing to namespace a working directory
    by (a CLI run, an eval, a job worker), so the turn is offered no draft verbs
    at all rather than a directory shared by everyone. A store that cannot be
    reached is the same answer: the turn answers without drafting, which is what
    every turn did before this existed. ``skills``, the turn's skills backend,
    is readable either way.
    """
    return draft_tools(await _turn_drafts(), skills=skills)
