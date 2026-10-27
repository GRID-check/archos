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

from aiq_agent.project_context import get_conversation_id_from_context
from aiq_agent.skills import SKILLS_ROOT

from .draft_store import DRAFT_ROOT
from .draft_store import DraftBackend
from .draft_store import get_draft_backend
from .filesystem import PilotiFilesystem
from .filesystem import composite_backend

logger = logging.getLogger(__name__)

#: The verbs bound into Piloti's tool node, in the order the model
#: meets them, and the middleware's allowlist: nothing else is built.
DRAFT_TOOL_NAMES = ("ls", "read_file", "write_file", "edit_file")

#: The estate's readers, bound whether or not the turn has a working directory.
ESTATE_TOOL_NAMES = ("ls", "read_file", "glob", "grep")

#: The tools only a working directory gives: the two that write.
DRAFT_ONLY_TOOL_NAMES = ("write_file", "edit_file")

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


#: The verbs once they read the estate too. Each a contract: what it reads, how it is addressed, what comes back,
#: what is not evidence, and which of the other verbs fits instead.
_ESTATE_DESCRIPTIONS = {
    "ls": (
        "Lists one folder of the office's documents (read-only) or of this conversation's drafts. `ls(\"/\")` "
        "shows the places: /project/ (this project), /office/ (the Büroablage), /chat/ (files dropped into this "
        f"conversation), /law/oib/ (the OIB-Richtlinien) and `{DRAFT_ROOT}`. A folder shows its subfolders with "
        "document counts and one line per file: the path leaf (`<file name>.md`, the leaf read_file takes), pages, "
        "Dokumentart, Plankopf Index and the document's own date, and which file replaced it. `depth` 2 to 4 "
        "returns the tree below the folder as folder cards. Every folder holds a `README.md`: its folder card, "
        "readable with read_file. At most 40 files per folder are listed; the rest are counted. Restricted folders "
        "are never listed. An index, not a source: it says which files exist, never what they say, so it is never "
        "cited; read_file reads, grep finds wording, knowledge_search finds meaning. list_files is the former "
        "name and stays for one release."
    ),
    "grep": (
        "Finds WORDING in the office's documents, not meaning: every place a word, number, code or phrase "
        'stands. mode="exact" (default) matches `pattern` literally, folding case, ä/ae, ß/ss, soft hyphens and '
        'line-break hyphenation; a pattern of 2-3 characters matches a whole word only. mode="regex" takes a '
        "Python regular expression (case-insensitive). `stemmed=true` also finds inflected forms. `path` limits it "
        "to a place, a folder or one file (default: every place the person may see; the drafts only under "
        "/drafts/); `glob` to file names. output_mode: `files_with_matches` (default) lists each file with its "
        "count and pages, `count` the counts, `content` the matching pages as citable passages (each with a "
        "`Citation:` and a `Path:` line, up to 8, spread over the files) and, with `context` 1-3, the lines "
        "around each match. It counts each place in a document once and says how many files it searched. A no "
        "is a no for the wording only (knowledge_search finds a topic by meaning), and a result marked "
        "`incomplete` is not a no for what it could not search. Files and counts are an index; only `content` "
        'passages are cited. knowledge_search(match="exact") is the former name and stays for one release.'
    ),
    "glob": (
        "Finds the office's documents by file NAME: `*`, `**`, `?`, `[abc]`, `{a,b}`. A pattern without `/` "
        "matches the name at any depth (`*Brandschutz*`, `*.pdf`); one with `/` matches the path below `path` "
        "(`Einreichung/**/*.pdf`), an absolute one the whole path (`/project/**/EP-*`). Case, umlauts (ä/ae) and "
        "ß/ss do not matter. `path` limits the search to one place or folder (default: every place the person may "
        "see; drafts only when `path` is under /drafts/). Returns absolute paths, one per line with pages and "
        "Dokumentart, at most 100. An index, not a source: a name says nothing of the content; grep for wording, "
        "knowledge_search for meaning, read_file to read."
    ),
    "read_file": (
        "Reads one file by its absolute path. Two kinds of file:\n"
        "- The office's documents (read-only): /project/ (this project), /office/ (the Büroablage), /chat/ "
        "(files dropped into this conversation), /law/oib/ (the OIB-Richtlinien). A document's text is served as "
        "`<file name>.md` (Plan.pdf is /project/<folder>/Plan.pdf.md; the bare .pdf path works too). Address a "
        'paginated document with `pages` ("3", "3-5", "3,7,11"; at most 30) or one Punkt with `clause` '
        '("3.5.2"); with neither you get the opening page and the Gliederung. A text file (txt, md, csv) is read '
        "by `offset`/`limit` in lines. Returns one block per page, each with a `Citation:` line to copy verbatim "
        "(`<file name>, p.N`) and a `Path:` line; at most about 6k tokens per read, and the result names the next "
        "call. A drawing's text is a vision model's reading, not a measurement. A path you did not get from a "
        "listing, a search hit or the person may not exist; a miss says so and suggests names. "
        "`<folder>/README.md` is the folder's card, an index and never cited.\n"
        f"- This conversation's drafts under `{DRAFT_ROOT}`: read before a revision, so that `old_string` comes "
        "verbatim from the document. The output starts with a `@@ lines … @@` header that is not part of the file. "
        "A draft is what the answer wrote itself, never evidence.\n"
        "Paths come from a hit's `Path:` line, a listing, the turn context or the person. To find which "
        "document says something, search first: knowledge_search by meaning, grep for a wording. read_passage "
        "is the former name of this read and stays for one release."
    ),
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
    store and the skills are.
    """
    names = [*ESTATE_TOOL_NAMES, *(DRAFT_ONLY_TOOL_NAMES if drafts is not None else ())]
    descriptions = {**_TOOL_DESCRIPTIONS, **_ESTATE_DESCRIPTIONS}
    permissions = list(_PERMISSIONS)
    if skills is not None:
        descriptions["read_file"] = f"{descriptions['read_file']}\n- {_SKILL_READ[0].upper()}{_SKILL_READ[1:]}"
        permissions.insert(0, _SKILL_PERMISSION)
    middleware = PilotiFilesystem(
        estate=estate,
        drafts=drafts is not None,
        backend=composite_backend(drafts, estate, skills=skills),
        custom_tool_descriptions=descriptions,
        permissions=permissions,
        tools=names,
    )
    by_name = {tool.name: tool for tool in middleware.tools}
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
