"""Finding estate paths: resolving a name inside the estate, the did-you-mean suggestions, the children of a
folder and the glob over the file names.
"""

from __future__ import annotations

import difflib
from collections.abc import Sequence

from aiq_agent.common.estate_paths import ESTATE_MOUNTS
from aiq_agent.common.estate_paths import MOUNT_ROOTS
from aiq_agent.common.estate_paths import EstatePath
from aiq_agent.common.estate_paths import PathRefused
from aiq_agent.common.estate_paths import file_name_candidates
from aiq_agent.common.estate_paths import parse_estate_path

from .browse import fold
from .estate_constants import MAX_SUGGESTIONS
from .estate_constants import SUGGESTION_CUTOFF
from .estate_files import EstateFile
from .estate_files import Resolution


def _names_of(file: EstateFile) -> set[str]:
    names = {fold(file.leaf), fold(file.row.file_name), fold(file.row.file_name.rsplit("/", 1)[-1])}
    if file.row.display_title:
        names.add(fold(file.row.display_title))
    return names


def resolve_in(files: Sequence[EstateFile], parsed: EstatePath) -> Resolution:
    """:meth:`EstateBackend.resolve` over a given list of files. Pure."""
    if parsed.mount is None or parsed.leaf is None:
        return Resolution(file=None)
    wanted = {fold(name) for name in file_name_candidates(parsed.leaf)} | {fold(parsed.leaf)}
    in_mount = [file for file in files if file.mount == parsed.mount]
    matches = [file for file in in_mount if _names_of(file) & wanted]
    folder = fold(parsed.folder)
    same_folder = [file for file in matches if parsed.mount == "law" or fold(file.row.folder) == folder]
    listable = [file for file in matches if not file.restricted]
    chosen = (same_folder or listable or [None])[0]
    if chosen is None:
        return Resolution(file=None, suggestions=_suggestions(in_mount, parsed))
    note = ""
    if parsed.mount != "law" and fold(chosen.row.folder) != folder and folder:
        note = f"Moved: {parsed.path} is now {chosen.path}."
    return Resolution(file=chosen, note=note)


def _suggestions(files: Sequence[EstateFile], parsed: EstatePath) -> list[str]:
    """Up to three listable paths whose leaf is close to the asked one; never a restricted document's."""
    wanted = fold(parsed.leaf or "")
    scored: list[tuple[float, str]] = []
    for file in files:
        if file.restricted:
            continue
        ratio = difflib.SequenceMatcher(None, wanted, fold(file.leaf)).ratio()
        if ratio >= SUGGESTION_CUTOFF:
            scored.append((ratio, file.path))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [path for _ratio, path in scored[:MAX_SUGGESTIONS]]


def children(files: Sequence[EstateFile], path: str | None) -> list[str]:
    """The entries directly below ``path``: subfolders (ending in ``/``) and files, sorted. Pure."""
    try:
        parsed = parse_estate_path(path, directory=True)
    except PathRefused:
        return []
    if parsed.mount is None:
        return [MOUNT_ROOTS[mount] for mount in ESTATE_MOUNTS if any(file.mount == mount for file in files)]
    prefix = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
    out: set[str] = set()
    for file in files:
        if file.mount != parsed.mount or not fold(file.path).startswith(fold(prefix)):
            continue
        rest = file.path[len(prefix) :]
        head, _, tail = rest.partition("/")
        out.add(prefix + head + ("/" if tail else ""))
    return sorted(out)


def _glob_flags() -> int:
    """The glob dialect: ``*`` ``**`` ``?`` ``[abc]`` ``{a,b}``, as the stock ``glob`` tool reads it.

    Deep Agents matches with wcmatch too, so a pattern means here what it means
    to the stock tool. Case is folded by :func:`fold` on both sides, so no
    IGNORECASE flag is needed.
    """
    from wcmatch import glob as wcglob

    return wcglob.GLOBSTAR | wcglob.BRACE | wcglob.DOTGLOB


def glob_files(files: Sequence[EstateFile], pattern: str, path: str | None = None) -> list[EstateFile]:
    """The files ``pattern`` matches below ``path`` (default: every estate mount), in path order. Pure.

    A pattern without ``/`` matches the file's name at any depth, as the stock
    tool's does; one with ``/`` matches the path below the search root, and an
    absolute one (``/project/**/*.pdf``) the whole path. Names compare folded
    (case, NFC, ä/ae, ß/ss), and a document matches by its served leaf
    (``Plan.pdf.md``) or its file name (``Plan.pdf``), so ``*.pdf`` finds PDFs.
    """
    from wcmatch import glob as wcglob

    wanted = fold((pattern or "").strip())
    if not wanted:
        return []
    try:
        root = parse_estate_path(path, directory=True) if path else None
    except PathRefused:
        return []
    prefix = fold(root.path) if root is not None and root.mount is not None else ""
    flags = _glob_flags()
    out: list[EstateFile] = []
    for file in files:
        full = fold(file.path)
        if prefix and not full.startswith(prefix):
            continue
        names = {fold(file.leaf), fold(file.row.file_name.rsplit("/", 1)[-1])}
        stem = full[: -len(fold(file.leaf))]
        if "/" not in wanted:
            candidates = names
        elif wanted.startswith("/"):
            candidates = {stem + name for name in names}
        else:
            relative_stem = stem[len(prefix) :] if prefix else stem.lstrip("/")
            candidates = {relative_stem + name for name in names}
        if any(wcglob.globmatch(candidate, wanted, flags=flags) for candidate in candidates):
            out.append(file)
    return sorted(out, key=lambda file: file.path)
