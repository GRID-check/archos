"""What a call to a retired name is answered with on Piloti's chat binding (ADR-0133 slice 6).

Piloti reads the estate with ``ls``, ``glob``, ``grep`` and ``read_file``. Three
older spellings left its binding: ``read_passage``, ``list_files`` with listing
arguments (it keeps ``revisions_of`` and ``compare_to``), and
``knowledge_search(match="exact"|"regex")``. A conversation that held one, or a
model trained on it, still calls it. NAT would answer an unbound name with an
unknown-tool error and drop an argument the schema no longer has without a word,
which turns a literal search into a ranked one. So the call is answered before it
runs, as an error that names the exact replacement call (vendor guidance: an
error says what to try next; for a near-miss name, state the exact expected
name). The deep-research and intake bindings keep the old names, so the notice
applies only when the replacement is bound and the old spelling is not what the
binding offers.

Pure: a function of the call, the bound names and the paths this turn's results
named, so it composes into the round's guards (``piloti.agent._withheld_calls``)
the way ``data_sources.disabled_source_notice`` does, and ports unchanged.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from collections.abc import Mapping
from typing import Any

from aiq_agent.common.estate_paths import MOUNT_ROOTS
from aiq_agent.common.estate_paths import SHELF_MOUNTS
from aiq_agent.common.estate_paths import estate_path

#: The retired spellings whose answer names a path from this turn's results (:func:`known_paths`).
NEEDS_PATHS = frozenset({"read_passage"})

#: The literal modes ``knowledge_search`` no longer has on Piloti's binding.
LITERAL_MODES = ("exact", "regex")

#: The Langfuse trace tag of a turn that called a retired spelling: how often the old names still come.
RETIRED_CALL_TAG = "retired-call"


class RetiredNotice(str):
    """A retired call's answer: sent as an error result (``status="error"``), never as data."""


#: A ``Path:`` header line of a grounding block: the path ``read_file`` opens a hit by.
_PATH_LINE = re.compile(r"^Path: (/\S.*)$", re.MULTILINE)


def _quoted(value: Any) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _call(name: str, args: Mapping[str, Any]) -> str:
    rendered = ", ".join(f"{key}={_quoted(value)}" for key, value in args.items() if value not in (None, ""))
    return f"`{name}({rendered})`"


def _fold(name: str) -> str:
    return str(name or "").strip().casefold()


def known_paths(texts: Iterable[str]) -> dict[str, str]:
    """``file name -> path`` for every ``Path:`` line in ``texts`` (tool results), keyed case-folded.

    A path's leaf is the file name, with ``.md`` appended to a document served as its text, so both spellings
    key it.
    """
    paths: dict[str, str] = {}
    for text in texts:
        for match in _PATH_LINE.finditer(text or ""):
            path = match.group(1).strip()
            leaf = path.rstrip("/").rsplit("/", 1)[-1]
            paths.setdefault(_fold(leaf), path)
            if leaf.lower().endswith(".md"):
                paths.setdefault(_fold(leaf[:-3]), path)
    return paths


def _read_passage_notice(args: Mapping[str, Any], paths: Mapping[str, str]) -> str:
    document = str(args.get("document") or "").strip()
    pages = args.get("pages") or args.get("page")
    wanted = {"clause": args.get("clause"), "pages": pages}
    path = paths.get(_fold(document)) if document else None
    if path:
        return f"`read_passage` is retired: call {_call('read_file', {'file_path': path, **wanted})}."
    found = f'"{document}"' if document else "the document"
    finder = _call("glob", {"pattern": f"*{document}*"}) if document else "`glob`"
    return (
        f"`read_passage` is retired: call {_call('read_file', {'file_path': '<its path>', **wanted})} with the "
        f"`Path:` line of the hit that named {found}, or find the path with {finder}."
    )


def _list_files_notice(args: Mapping[str, Any]) -> str:
    folder = str(args.get("folder") or "").strip().strip("/")
    mount = SHELF_MOUNTS.get(str(args.get("shelf") or "").strip().lower(), "project")
    root = MOUNT_ROOTS[mount]
    name = str(args.get("name_contains") or "").strip()
    if name:
        exact = _call("glob", {"pattern": f"*{name}*", "path": f"{root}{folder}/" if folder else None})
    else:
        exact = _call("ls", {"path": f"{root}{folder}/" if folder else root, "depth": None})
    return (
        f"`list_files` lists only Fassungen now (`revisions_of=…`): call {exact}. "
        "`ls(path)` lists a folder, `glob(pattern)` finds a file by name."
    )


#: ``knowledge_search``'s ``shelf`` values, as the shelf wire values the mounts are keyed by.
_SEARCH_SHELVES = {"office": "office_shelf", "archiv": "office_shelf"}


def _scope_path(args: Mapping[str, Any]) -> str | None:
    """The path ``folder``, ``shelf`` and ``file_name`` of a ``knowledge_search`` call name; ``path`` wins."""
    if str(args.get("path") or "").strip():
        return str(args["path"]).strip()
    shelf = str(args.get("shelf") or "").strip().lower()
    shelf = _SEARCH_SHELVES.get(shelf, shelf)
    folder = str(args.get("folder") or "").strip().strip("/")
    file_name = str(args.get("file_name") or "").strip()
    if not (shelf or folder or file_name):
        return None
    mount = SHELF_MOUNTS.get(shelf or "project")
    if mount is None:
        return None
    if file_name:
        return estate_path(shelf or "project", folder or None, file_name)
    return MOUNT_ROOTS[mount] + (f"{folder}/" if folder and mount != "law" else "")


def _literal_search_notice(args: Mapping[str, Any], mode: str) -> str:
    replacement = {
        "pattern": args.get("query"),
        "mode": mode,
        "path": _scope_path(args),
        "stemmed": "true" if args.get("stemmed") else None,
    }
    call = _call("grep", replacement).replace('stemmed="true"', "stemmed=true")
    return f"`knowledge_search` has no `match=` mode: call {call}."


def retired_call_notice(
    name: str, args: Any, bound: Iterable[str], paths: Mapping[str, str] | None = None
) -> str | None:
    """The error a call to a retired spelling is answered with on this binding; ``None`` to run it.

    ``bound`` is the binding's tool names: a spelling is retired only where its replacement is bound and the
    old one is not on offer. ``paths`` (:func:`known_paths`) lets a ``read_passage`` of a document a hit named
    be answered with its exact path.
    """
    names = frozenset(bound)
    args = args if isinstance(args, Mapping) else {}
    if name == "read_passage" and "read_file" in names and "read_passage" not in names:
        return RetiredNotice(_read_passage_notice(args, paths or {}))
    if name == "list_files" and {"ls", "glob"} <= names and not str(args.get("revisions_of") or "").strip():
        return RetiredNotice(_list_files_notice(args))
    if name == "knowledge_search" and "grep" in names:
        mode = str(args.get("match") or "").strip().lower()
        if mode in LITERAL_MODES:
            return RetiredNotice(_literal_search_notice(args, mode))
    return None
