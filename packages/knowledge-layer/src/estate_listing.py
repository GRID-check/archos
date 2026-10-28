"""``ls``, ``glob`` and the folder card ``README.md`` over the estate (ADR-0133 slice 3).

Pure renderers over the turn's listable files (``estate.EstateBackend.listable_files``),
so a restricted folder's document is never named, counted or carded here: the
rows they read never held one (listing is not use, ADR-0088). Everything here is
an INDEX: a row proves a file exists, not what it says, so nothing renders a
grounding block and nothing is cited.

The folder card is the tier-0 card ``list_files(view="tree")`` already builds
(``browse.folder_cards``) with the tier-1 abstract the folder-card worker wrote
(ADR-0127), served as ``README.md`` in every folder. A real document of that name
wins: then the card is only inline in ``ls``.
"""

from __future__ import annotations

from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from agent.common.estate_paths import ESTATE_MOUNTS
from agent.common.estate_paths import MOUNT_ROOTS
from agent.common.estate_paths import EstatePath
from agent.common.estate_paths import Mount

from .browse import _card_lines
from .browse import fold
from .browse import folder_cards
from .estate import EstateFile
from .estate import glob_files

#: The folder card's leaf.
README = "README.md"

#: File rows one ``ls`` shows, and the most a ``glob`` returns.
MAX_LS_FILES = 40
MAX_GLOB_FILES = 100

#: The deepest tree ``ls(depth=…)`` draws, ``list_files(view="tree")``'s limit.
MAX_DEPTH = 4

#: What each mount is, for the root listing.
MOUNT_LABELS: dict[Mount, str] = {
    "project": "this project",
    "office": "the Büroablage, the office's shelf",
    "chat": "files dropped into this conversation",
    "law": "the OIB-Richtlinien",
}

INDEX_NOTE = "An index, not a source: `read_file` to read, `grep` for wording, `knowledge_search` for meaning."


@dataclass(frozen=True)
class Listing:
    """What one listing call produced: the text, and its counts for the Herleitung row."""

    text: str
    files: int | None = None
    folders: int | None = None
    #: No such folder (a restricted one answers the same): an error for the model, „nicht gefunden“ on the row.
    error: bool = False


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"


def _relative_folder(file: EstateFile) -> str:
    """The folder below the mount, as the inventory spells it ("" at the mount root, always "" for the law)."""
    return "" if file.mount == "law" else file.row.folder


def in_folder(files: Sequence[EstateFile], mount: Mount, folder: str) -> list[EstateFile]:
    """The files of ``mount`` filed in ``folder`` or below it (folded compare). Pure."""
    wanted = fold(folder)
    out = []
    for file in files:
        if file.mount != mount:
            continue
        here = fold(_relative_folder(file))
        if not wanted or here == wanted or here.startswith(wanted + "/"):
            out.append(file)
    return out


def stored_folder(files: Sequence[EstateFile], mount: Mount, folder: str) -> str | None:
    """``folder`` in its stored spelling (``Plaene`` finds ``Pläne``), or ``None`` when no listable file is there."""
    wanted = fold(folder)
    if not wanted:
        return ""
    for file in files:
        if file.mount != mount:
            continue
        parts = _relative_folder(file).split("/") if _relative_folder(file) else []
        for depth in range(1, len(parts) + 1):
            candidate = "/".join(parts[:depth])
            if fold(candidate) == wanted:
                return candidate
    return None


def has_real_readme(files: Sequence[EstateFile], mount: Mount, folder: str) -> bool:
    """Whether a real document named ``README.md`` is filed directly in this folder; it then keeps the name."""
    return any(
        file.mount == mount and fold(_relative_folder(file)) == fold(folder) and fold(file.leaf) == fold(README)
        for file in files
    )


def _file_line(file: EstateFile) -> str:
    """One file row: its leaf, then pages, Dokumentart, Plankopf Index, its own date, and what replaced it."""
    from agent.knowledge.title_block import title_block_label

    row = file.row
    bits: list[str] = []
    if row.display_title and fold(row.display_title) != fold(row.file_name):
        bits.append(f'"{row.display_title}"')
    if row.page_count:
        bits.append(f"{row.page_count} pp")
    if row.doc_class:
        bits.append(row.doc_class)
    plankopf = title_block_label(row.revision_facts)
    if plankopf:
        bits.append(f"Plankopf {plankopf}")
    date = row.document_date or row.added_at
    if date:
        bits.append(date)
    if row.superseded_by:
        bits.append(f"ersetzt durch {row.superseded_by}")
    return f"{file.leaf:<34} {' · '.join(bits)}".rstrip()


def _subfolders(files: Sequence[EstateFile], folder: str) -> list[tuple[str, int]]:
    """``(name, documents below it)`` of each folder directly in ``folder``, by name."""
    prefix = f"{folder}/" if folder else ""
    counts: dict[str, int] = {}
    for file in files:
        here = _relative_folder(file)
        if folder and not (here == folder or here.startswith(prefix)):
            continue
        rest = here[len(prefix) :] if folder else here
        if not rest or here == folder:
            continue
        name = rest.split("/", 1)[0]
        counts[name] = counts.get(name, 0) + 1
    return sorted(counts.items(), key=lambda item: fold(item[0]))


def render_root(files: Sequence[EstateFile], *, drafts: bool) -> Listing:
    """``ls("/")``: the mounts the person may see, each with its documents counted."""
    lines = ["/  the office's documents, by where they are filed (read-only), and this conversation's drafts"]
    shown = 0
    for mount in ESTATE_MOUNTS:
        count = sum(1 for file in files if file.mount == mount)
        if not count:
            continue
        shown += 1
        lines.append(f"{MOUNT_ROOTS[mount]:<12} {_count(count, 'document')} · {MOUNT_LABELS[mount]}")
    if drafts:
        lines.append(
            f"{MOUNT_ROOTS['drafts']:<12} this conversation's drafts: written with `write_file`, never evidence"
        )
    if not shown:
        lines.append("No document of the office is readable in this conversation.")
    lines.append("Next: `ls` a mount, `glob` by name, `grep` for wording, `read_file` to read.")
    # The row counts what the places hold (every document, every place), as a folder's row does.
    return Listing(text="\n".join(lines), files=len(files), folders=shown)


def render_folder(
    files: Sequence[EstateFile],
    parsed: EstatePath,
    *,
    abstracts: Mapping[str, Sequence[str]] | None = None,
    in_flight: Sequence[str] = (),
    depth: int = 1,
) -> Listing:
    """``ls(path, depth)``: one folder's subfolders and files, or (``depth`` > 1) its tree as folder cards."""
    mount = parsed.mount
    if mount is None:
        return Listing(text=f'No folder "{parsed.path}". `ls("/")` lists the places there are.', error=True)
    asked = "" if mount == "law" else parsed.folder
    folder = stored_folder(files, mount, asked)
    if folder is None:
        return Listing(text=f'No folder "{parsed.path}". `ls("{MOUNT_ROOTS[mount]}")` lists what is there.', error=True)
    selected = in_folder(files, mount, folder)
    root = MOUNT_ROOTS[mount] + (f"{folder}/" if folder else "")
    if depth > 1:
        return _render_tree(selected, root, folder, depth, abstracts or {}, in_flight)
    subfolders = _subfolders(selected, folder)
    here = sorted(
        (file for file in selected if fold(_relative_folder(file)) == fold(folder)), key=lambda f: fold(f.leaf)
    )
    head = f"{root}  {_count(len(selected), 'document')}"
    if subfolders:
        head += f" in {_count(len(subfolders) + (1 if here else 0), 'folder')}"
    lines = [head]
    for about in (abstracts or {}).get(folder, ()):
        lines.append(f"  {about} (folder card; an index, not a source)")
    if not has_real_readme(files, mount, folder):
        lines.append(f"{README:<34} the folder card")
    for name, count in subfolders:
        lines.append(f"{name + '/':<34} {_count(count, 'document')}")
    for file in here[:MAX_LS_FILES]:
        lines.append(_file_line(file))
    left = len(here) - MAX_LS_FILES
    if left > 0:
        lines.append(f"… {_count(left, 'more file')} here, not listed: `glob` by name or `ls` a subfolder.")
    if in_flight:
        lines.append(f"Not listed here: files still being read ({len(in_flight)}).")
    lines.append("Restricted folders are not listed.")
    lines.append("Next: `ls` a folder, `glob` by name, `grep` for wording, `read_file` to read.")
    # Everything the folder holds, its subfolders' documents too, as its head line, the tree and the folder card
    # count it; not what the text had room for.
    return Listing(text="\n".join(lines), files=len(selected), folders=len(subfolders))


def _render_tree(
    selected: Sequence[EstateFile],
    root: str,
    folder: str,
    depth: int,
    abstracts: Mapping[str, Sequence[str]],
    in_flight: Sequence[str],
) -> Listing:
    rows = [file.row for file in selected]
    cards = folder_cards(rows, root=folder or None, depth=min(depth, MAX_DEPTH))
    lines = [f"{root}  {_count(len(rows), 'document')}, as folder cards (folder paths below {root.split('/')[1]}/):"]
    for card in cards:
        lines.extend(_card_lines(card, abstracts.get(card.path, ())))
    if in_flight:
        lines.append(f"Not listed here: files still being read ({len(in_flight)}).")
    lines.append("Restricted folders are not listed. " + INDEX_NOTE)
    # The folder's own subfolders, as `ls` at depth 1 and its README.md count them: not every card in the tree.
    own = next((card for card in cards if card.path == (folder or "")), None)
    return Listing(text="\n".join(lines), files=len(rows), folders=len(own.subfolders) if own else 0)


def render_readme(
    files: Sequence[EstateFile], parsed: EstatePath, *, abstracts: Mapping[str, Sequence[str]] | None = None
) -> Listing | None:
    """``read_file(<folder>/README.md)``: that folder's card; ``None`` when no listable file is filed there."""
    mount = parsed.mount
    if mount is None:
        return None
    folder = stored_folder(files, mount, "" if mount == "law" else parsed.folder)
    if folder is None:
        return None
    selected = [file.row for file in in_folder(files, mount, folder)]
    if not selected:
        return None
    cards = [card for card in folder_cards(selected, root=folder or None, depth=1) if card.path == folder]
    if not cards:
        return None
    root = MOUNT_ROOTS[mount] + (f"{folder}/" if folder else "")
    lines = [f"{root}README.md, the folder card: what the folder holds, counted from its files.", ""]
    lines.extend(_card_lines(cards[0], (abstracts or {}).get(folder, ())))
    lines.append("")
    lines.append("A folder card is an index, not a source: never cite it; a key fact is read back from its document.")
    return Listing(text="\n".join(lines), files=cards[0].total, folders=len(cards[0].subfolders))


def render_glob(files: Sequence[EstateFile], pattern: str, path: str | None) -> Listing:
    """``glob(pattern, path)``: the matching files' absolute paths, one row each, capped."""
    matched = glob_files(files, pattern, path)
    where = (path or "").rstrip("/") or "every place"
    searched = len(files) if not path else len([f for f in files if fold(f.path).startswith(fold(path.rstrip("/")))])
    if not matched:
        return Listing(
            text=f'No file matches "{pattern}" in {where} ({_count(searched, "file")} searched). '
            "A name says nothing of the content: `grep` for wording, `knowledge_search` for meaning.",
            files=0,
        )
    lines = [f'{_count(len(matched), "file")} match "{pattern}" in {where} ({searched} searched):']
    for file in matched[:MAX_GLOB_FILES]:
        bits = [f"{file.row.page_count} pp"] if file.row.page_count else []
        if file.row.doc_class:
            bits.append(file.row.doc_class)
        lines.append(f"{file.path}   {' · '.join(bits)}".rstrip())
    if len(matched) > MAX_GLOB_FILES:
        lines.append(f"… {len(matched) - MAX_GLOB_FILES} more not shown: narrow the pattern or the path.")
    lines.append(INDEX_NOTE)
    return Listing(text="\n".join(lines), files=len(matched))


def collections_of(files: Sequence[EstateFile]) -> list[str]:
    return sorted({file.row.collection for file in files if file.row.collection})


def abstracts_by_folder(found: Mapping[tuple[str, str], Any]) -> dict[str, list[str]]:
    """The written abstracts' ``About:`` lines by folder path (``browse.abstract_lines``)."""
    from .browse import abstract_lines

    return abstract_lines(found)
