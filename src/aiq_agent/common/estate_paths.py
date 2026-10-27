"""The paths Piloti reads the office's documents by (ADR-0133, ``docs/architecture/agent-filesystem.md`` §1).

One namespace, five mounts. Four are the estate, read-only, each a shelf the
turn's scope already names; the fifth is the conversation's drafts, the one
place ``write_file`` and ``edit_file`` reach:

====================  ==============  ==========================================
Mount                 Shelf           What
====================  ==============  ==========================================
``/project/``         ``project``     the turn's project
``/office/``          ``office_shelf`` the Büroablage
``/chat/``            ``session``     files dropped into this conversation
``/law/oib/``         ``base``        the platform's OIB corpus
``/drafts/``          (none)          this conversation's drafts
====================  ==============  ==========================================

Pure: no store, no I/O. Everything that READS the estate lives in the knowledge
layer (``knowledge_layer.estate``); this module is the vocabulary both it and the
agent's turn plumbing (the Herleitung, the wire's ``mount``, the per-mount source
toggle, the repeat-fetch guard) share, so a path means one thing to all of them.

Three rules worth reading twice:

* **The leaf is the immutable file name**, the citation key's stem, with ``.md``
  appended when the file is not text already (``Plan.pdf`` is served as
  ``Plan.pdf.md``): the stock ``read_file`` decides by extension, and a ``.pdf``
  path that returns text is sent as a base64 file block (ADR-0133 §5).
* **A path never names a collection.** Admission's text backstop withholds any
  text carrying a restricted collection id, so a path that held one would be
  withheld, and a collection id is nobody's word for a folder.
* **Canonical form only.** Absolute POSIX, no ``..``, no percent-encoding, no
  backslash. A path that is not canonical is refused before any lookup, so no
  spelling of a path can reach an object the scoped lookup did not resolve.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any
from typing import Literal

Mount = Literal["drafts", "skills", "project", "office", "chat", "law"]

#: The estate mounts, in the order ``ls("/")`` lists them.
ESTATE_MOUNTS: tuple[Mount, ...] = ("project", "office", "chat", "law")

#: Where each mount is rooted. ``/law/`` holds one corpus today, the OIB's.
MOUNT_ROOTS: dict[Mount, str] = {
    "project": "/project/",
    "office": "/office/",
    "chat": "/chat/",
    "law": "/law/oib/",
    "drafts": "/drafts/",
    "skills": "/skills/",
}

#: The drafts' root before it had an English name; stored turns still carry it.
LEGACY_DRAFT_ROOT = "/entwuerfe/"

#: Shelf wire value (``common.source_kinds.Shelf``) -> mount.
SHELF_MOUNTS: dict[str, Mount] = {
    "project": "project",
    "office_shelf": "office",
    "session": "chat",
    "base": "law",
}

#: Mount -> shelf wire value, the inverse.
MOUNT_SHELVES: dict[Mount, str] = {mount: shelf for shelf, mount in SHELF_MOUNTS.items()}

#: Files that are text already keep their own name; everything else is served as its text, ``<name>.md``.
TEXT_EXTENSIONS = (".txt", ".md", ".csv")

#: The prefix an agent-filed document's file name carries (``piloti/<name>``); no such directory is shown.
AGENT_FILED_PREFIX = "piloti/"

#: The four tools that take a path, and which argument holds it.
PATH_ARGUMENTS: dict[str, str] = {"ls": "path", "glob": "path", "grep": "path", "read_file": "file_path"}

#: The two that write; they only ever reach ``/drafts/``.
WRITE_TOOLS = frozenset({"write_file", "edit_file"})

_PERCENT_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")


def nfc(text: str) -> str:
    """``text`` NFC-normalised, the form every stored file name has."""
    return unicodedata.normalize("NFC", text or "")


def leaf_for(file_name: str) -> str:
    """The path leaf a stored file name is served under.

    ``Plan.pdf`` -> ``Plan.pdf.md``; ``Notiz.txt`` stays ``Notiz.txt``;
    ``piloti/Aktenvermerk.pdf`` -> ``Aktenvermerk.pdf.md``. Appending rather
    than replacing keeps the original name whole, so dropping ``.md`` gives the
    citation key's stem.
    """
    name = nfc(file_name).strip()
    if name.startswith(AGENT_FILED_PREFIX):
        name = name[len(AGENT_FILED_PREFIX) :]
    name = name.rsplit("/", 1)[-1]
    if not name:
        return ""
    if name.lower().endswith(TEXT_EXTENSIONS):
        return name
    return f"{name}.md"


def estate_path(shelf: Any, folder: str | None, file_name: str) -> str | None:
    """The absolute path a document of ``shelf`` filed in ``folder`` is read by; ``None`` for an unknown shelf.

    The base corpus is flat: its documents sit directly under ``/law/oib/``
    whatever folder a row states.
    """
    value = str(getattr(shelf, "value", shelf) or "").strip().lower()
    if value == "archiv":  # the office shelf's legacy wire value (source_kinds.LEGACY_SHELF_VALUES)
        value = "office_shelf"
    mount = SHELF_MOUNTS.get(value)
    leaf = leaf_for(file_name)
    if mount is None or not leaf:
        return None
    root = MOUNT_ROOTS[mount]
    parts = [] if mount == "law" else [part for part in nfc(folder or "").strip().strip("/").split("/") if part]
    return root + "".join(f"{part}/" for part in parts) + leaf


def is_draft_path(path: str | None) -> bool:
    """Whether ``path`` is under the drafts' root, in either spelling (the bare suffix spelling too)."""
    candidate = (path or "").strip()
    if not candidate.startswith("/"):
        candidate = "/" + candidate
    for root in (MOUNT_ROOTS["drafts"], LEGACY_DRAFT_ROOT):
        if candidate == root.rstrip("/") or candidate.startswith(root):
            return True
    return False


def is_skill_path(path: str | None) -> bool:
    """Whether ``path`` is under the skills' root (ADR-0135): the turn's skills, read-only, never evidence."""
    candidate = (path or "").strip()
    root = MOUNT_ROOTS["skills"]
    return candidate == root.rstrip("/") or candidate.startswith(root)


def mount_of_path(path: str | None) -> Mount | None:
    """The mount ``path`` lies in; ``None`` for the root, a bare ``/law/`` or an unknown prefix."""
    if is_draft_path(path):
        return "drafts"
    if is_skill_path(path):
        return "skills"
    candidate = nfc((path or "").strip())
    if not candidate.startswith("/"):
        return None
    for mount in ESTATE_MOUNTS:
        root = MOUNT_ROOTS[mount]
        if candidate == root.rstrip("/") or candidate.startswith(root):
            return mount
    return None


def call_path(tool: str, args: Any) -> str | None:
    """The path argument of one filesystem tool call, or ``None`` (absent, empty, or not a path tool)."""
    if not isinstance(args, dict):
        return None
    name = PATH_ARGUMENTS.get(tool)
    if name is None:
        return None
    value = args.get(name)
    text = str(value).strip() if value is not None else ""
    return text or None


def call_mount(tool: str, args: Any) -> Mount | Literal["estate"] | None:
    """Which mount one call of a filesystem tool reaches.

    ``"drafts"`` for a path under ``/drafts/`` (and for the two write verbs,
    which reach nothing else); the estate mount for a path in one; ``"estate"``
    for a call that covers every estate mount the person may see (no path, or
    ``/``); ``None`` for a tool that takes no path.
    """
    if tool in WRITE_TOOLS:
        return "drafts"
    if tool not in PATH_ARGUMENTS:
        return None
    path = call_path(tool, args)
    if path is None or path.strip() in ("/", ""):
        return "estate"
    mount = mount_of_path(path)
    return mount if mount is not None else "estate"


def reaches_drafts_only(tool: str, args: Any) -> bool:
    """Whether a filesystem call stays off the estate, in the drafts or the skills.

    Such a call is never a source, never signed by the repeat-fetch guard and
    never refused by a data-source toggle: a draft is what the answer wrote, a
    skill is a method, and neither is the office's evidence.
    """
    return call_mount(tool, args) in ("drafts", "skills")


@dataclass(frozen=True)
class EstatePath:
    """A canonical estate path, cut into what resolution reads."""

    path: str
    #: ``None`` for the root ``/`` (and for ``/law/``, the corpus directory above ``/law/oib/``).
    mount: Mount | None
    #: Folder segments below the mount root, in the path's own spelling.
    folders: tuple[str, ...]
    #: The last segment, or ``None`` when the path names a directory (ends in ``/`` or is a mount root).
    leaf: str | None

    @property
    def folder(self) -> str:
        """The folder part as the inventory spells a folder path (``Einreichung/Pläne``)."""
        return "/".join(self.folders)


class PathRefused(ValueError):
    """A path that is not canonical; the message is what the model reads."""


def parse_estate_path(path: str | None, *, directory: bool = False) -> EstatePath:
    """``path`` as an :class:`EstatePath`; raises :class:`PathRefused` for a non-canonical one.

    ``directory`` reads the last segment as a folder (``ls``), not a leaf. The
    drafts are not parsed here: the caller routes ``/drafts/`` to the draft
    store before asking.
    """
    raw = nfc((path or "").strip())
    if not raw:
        raw = "/"
    if not raw.startswith("/"):
        raise PathRefused(f'Paths are absolute: "{raw}" does not start with "/". Start from "/" or a mount root.')
    if "\\" in raw:
        raise PathRefused(f'"{raw}" holds a backslash; paths use "/".')
    if _PERCENT_ESCAPE.search(raw):
        raise PathRefused(f'"{raw}" holds a percent-escape; write the name as it is (umlauts and spaces included).')
    segments = [segment for segment in raw.split("/") if segment not in ("", ".")]
    if ".." in segments or raw.startswith("~"):
        raise PathRefused(f'"{raw}" climbs out of its folder (".."); paths are absolute and canonical.')
    names_directory = directory or raw.endswith("/") or not segments
    canonical = "/" + "/".join(segments) + ("/" if names_directory and segments else "")
    if not segments:
        return EstatePath(path="/", mount=None, folders=(), leaf=None)
    if segments[0] == "law" and (len(segments) == 1 or segments[1] != "oib"):
        if len(segments) == 1:
            return EstatePath(path="/law/", mount=None, folders=(), leaf=None)
        return EstatePath(path=canonical, mount="law", folders=(), leaf=None if names_directory else segments[-1])
    mount = mount_of_path(canonical if canonical.endswith("/") else canonical + "/") or mount_of_path(canonical)
    if mount is None or mount == "drafts":
        return EstatePath(path=canonical, mount=None, folders=tuple(segments), leaf=None)
    depth = 2 if mount == "law" else 1
    rest = segments[depth:]
    if names_directory or not rest:
        return EstatePath(path=canonical if rest else MOUNT_ROOTS[mount], mount=mount, folders=tuple(rest), leaf=None)
    return EstatePath(path=canonical, mount=mount, folders=tuple(rest[:-1]), leaf=rest[-1])


def file_name_candidates(leaf: str) -> list[str]:
    """The stored file names a leaf may stand for, most likely first.

    ``Plan.pdf.md`` -> ``Plan.pdf`` (the text of a PDF), then ``Plan.pdf.md``
    (a real Markdown file of that name); the bare ``Plan.pdf`` -> ``Plan.pdf``;
    a text file's own name -> itself.
    """
    name = nfc(leaf).strip()
    out: list[str] = []
    if name.lower().endswith(".md"):
        stem = name[:-3]
        if "." in stem.rsplit("/", 1)[-1]:
            out.append(stem)
    out.append(name)
    return list(dict.fromkeys(out))


def action_place(path: str | None) -> dict[str, str]:
    """Where a path-based call looked, as its Herleitung row carries it (ADR-0132): ``mount`` and ``target``.

    The reader's words for a mount are the frontend's (``thinking.work.place.*``),
    so the row carries the mount and the folder *inside* it, never the path: no
    path, or ``/``, is ``estate`` (every place the person may see); a mount root
    has no ``target``. A path that names no place, or is refused, gives nothing:
    the row then says „einen Ordner“, never ``drafts › .. › project``. Pure.
    """
    raw = (path or "").strip()
    try:
        parsed = parse_estate_path(raw, directory=True)
    except PathRefused:
        return {}
    if parsed.path == "/":
        return {"mount": "estate"}
    if parsed.path == "/law/":
        return {"mount": "law"}
    if parsed.mount is None or parsed.mount in ("drafts", "skills"):
        return {}
    folder = "" if parsed.mount == "law" else parsed.folder
    return {"mount": parsed.mount, **({"target": folder} if folder else {})}


def asked_document(path: str | None) -> str:
    """The document a ``read_file`` path asks for, as a row names it: the leaf without the ``.md`` its text is
    served under (``Plan.pdf.md`` -> ``Plan.pdf``); ``""`` for a path that names a folder. The model's own
    words, so a row of a read that resolved nothing confirms nothing."""
    text = nfc((path or "").strip())
    if not text or text.endswith("/"):
        return ""
    leaf = text.rsplit("/", 1)[-1]
    return file_name_candidates(leaf)[0] if leaf else ""
