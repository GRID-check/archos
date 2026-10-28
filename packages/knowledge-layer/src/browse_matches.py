"""The matches an exact search found, grouped per file and per passage, and the distinct wording of them."""

from __future__ import annotations

import re
import time
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from agent.common.source_kinds import canonical_shelf_value

from .browse_text import _pages_label
from .browse_text import _shorten
from .browse_text import fold
from .chunk_positions import OwnText
from .chunk_positions import own_matches
from .chunk_positions import own_texts

#: How many chunks one exact search reads per collection. A bound
#: against a phrase that is on every page, not a relevance budget: past it the
#: count is stated as a floor.
MAX_MATCH_CHUNKS = 500

#: How many matching passages travel as citable evidence. The per-file table
#: covers every match; these are the text to quote from.
MAX_MATCH_PASSAGES = 8

#: Distinct matched strings a regex search lists before it counts the rest, and the characters of one.
MAX_DISTINCT_MATCHES = 20

MAX_DISTINCT_CHARS = 60

#: Files and pages named beside one distinct match, and distinct strings one file is tracked for.
MAX_DISTINCT_FILES = 3

MAX_DISTINCT_PAGES = 5

MAX_TRACKED_STRINGS = 200


def _occurrences(body: str, pattern: Any, timeout: float | None = None) -> int:
    """Non-empty, non-overlapping matches: one place in the text counts once, whichever alternative found it."""
    if timeout is None:
        return sum(1 for match in pattern.finditer(body) if match.end() > match.start())
    return sum(1 for match in pattern.finditer(body, timeout=timeout) if match.end() > match.start())


def _matched_strings(own: OwnText, pattern: Any, timeout: float | None = None) -> list[str]:
    """Every match that is the chunk's own, whitespace collapsed (a match across a line break reads as one line)."""
    return [" ".join(match.group().split()) for match in own_matches(own, pattern, timeout)]


@dataclass
class FileMatches:
    """Every matching chunk of one file."""

    file_name: str
    shelf: str | None
    collection: str
    chunks: list[Any] = field(default_factory=list)
    occurrences: int = 0
    #: A regex search only: per distinct matched string (case-folded), ``[spelling, count, pages]``.
    strings: dict[str, list[Any]] = field(default_factory=dict)
    #: True once the file had more distinct strings than :data:`MAX_TRACKED_STRINGS`.
    strings_cut: bool = False
    #: Per chunk id, the text its matches were counted on (``chunk_positions.own_text``).
    own: dict[str, OwnText] = field(default_factory=dict)

    def note_strings(self, found: Sequence[str], page: int | None) -> None:
        for text in found:
            entry = self.strings.get(fold(text))
            if entry is None:
                if len(self.strings) >= MAX_TRACKED_STRINGS:
                    self.strings_cut = True
                    continue
                entry = self.strings[fold(text)] = [text, 0, set()]
            entry[1] += 1
            if page:
                entry[2].add(page)

    @property
    def pages(self) -> list[int]:
        return sorted({chunk.page_number for chunk in self.chunks if getattr(chunk, "page_number", None)})


def _add_match(groups: dict[tuple[str, str], FileMatches], chunk: Any, own: str, count: int, found: list[str]) -> None:
    """Record one chunk's ``count`` matches in its file's group, opening the group on the file's first chunk."""
    metadata = getattr(chunk, "metadata", None) or {}
    collection = str(metadata.get("collection") or "")
    key = (collection, chunk.file_name)
    group = groups.get(key)
    if group is None:
        group = groups[key] = FileMatches(
            chunk.file_name,
            canonical_shelf_value(str(metadata["shelf"])) if metadata.get("shelf") else None,
            collection,
        )
    group.chunks.append(chunk)
    group.own[chunk.chunk_id] = own
    group.occurrences += count
    if found:
        group.note_strings(found, getattr(chunk, "page_number", None))


def group_matches(
    chunks: Iterable[Any],
    pattern: Any,
    *,
    timeout: float | None = None,
    store_decides: bool = False,
    deadline: float | None = None,
    collect_strings: bool = False,
) -> list[FileMatches]:
    """Chunks the :func:`phrase_pattern` really matches, grouped per file, most occurrences first.

    The same pattern the store filtered with, compiled here: what the store
    returned and what is counted cannot disagree about what a match is. A
    person's regex arrives compiled, with the timeout it ran under.

    ``store_decides`` (a stemmed search) keeps every chunk the store returned:
    the stemmed index matched it, so it counts at least once even where the
    counting pattern's approximation of the stem finds no place in it.

    ``deadline`` (a ``time.monotonic()`` instant, with ``timeout``) bounds the
    whole count: each chunk's timeout shrinks to what is left, and
    ``TimeoutError`` is raised once nothing is.

    ``collect_strings`` (a regex search) also records each distinct matched string per file, for
    :func:`distinct_matches`.

    One place in the document is one match (``chunk_positions``): a chunk's breadcrumb is not
    matched, its own heading counts on its first part only, and a match inside the overlap it
    repeats from the returned chunk before it is that chunk's. A chunk left with no match of its
    own is no passage either.
    """
    compiled = pattern if hasattr(pattern, "finditer") else re.compile(pattern)
    groups: dict[tuple[str, str], FileMatches] = {}
    chunks = list(chunks)
    for chunk, own in zip(chunks, own_texts(chunks), strict=True):
        if deadline is not None and timeout is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("the count ran out of time")
            timeout = min(timeout, remaining)
        found: list[str] = _matched_strings(own, compiled, timeout) if collect_strings else []
        count = len(found) if collect_strings else sum(1 for _ in own_matches(own, compiled, timeout))
        if store_decides and not count and not _occurrences(getattr(chunk, "content", "") or "", compiled, timeout):
            # The stemmed index matched a form the counting pattern does not know: once. A chunk whose
            # match the pattern does find, but only in its breadcrumb or overlap, is not its own match.
            count = 1
        if not count:
            continue
        _add_match(groups, chunk, own, count, found)
    # The reader's own files first: „wo steht EI 90" is about the project, and
    # the OIB corpus says EI 90 on a hundred pages.
    ordered = sorted(
        groups.values(), key=lambda group: (group.shelf == "base", -group.occurrences, fold(group.file_name))
    )
    for group in ordered:
        group.chunks.sort(key=lambda chunk: (getattr(chunk, "page_number", None) or 0, chunk.chunk_id))
    return ordered


def pick_passages(groups: Sequence[FileMatches], limit: int = MAX_MATCH_PASSAGES) -> list[Any]:
    """Round-robin over the files, best-covered first: the first match of each, then the second."""
    picked: list[Any] = []
    depth = 0
    while len(picked) < limit and any(depth < len(group.chunks) for group in groups):
        for group in groups:
            if depth < len(group.chunks) and len(picked) < limit:
                picked.append(group.chunks[depth])
        depth += 1
    return picked


def distinct_matches(groups: Sequence[FileMatches]) -> tuple[list[tuple[str, int, list[str], list[int]]], bool]:
    """Each distinct matched string over all files: ``(spelling, count, files, pages)``, most frequent first.

    ``files`` is in the order of the match table, ``pages`` ascending. The flag says a file had more
    distinct strings than it tracks, so the aggregate may miss some.
    """
    merged: dict[str, list[Any]] = {}
    cut = False
    for group in groups:
        cut = cut or group.strings_cut
        for key, (text, count, pages) in group.strings.items():
            entry = merged.setdefault(key, [text, 0, [], set()])
            entry[1] += count
            entry[2].append(group.file_name)
            entry[3].update(pages)
    ranked = sorted(merged.values(), key=lambda entry: (-entry[1], fold(entry[0])))
    return [(text, count, files, sorted(pages)) for text, count, files, pages in ranked], cut


def _distinct_lines(groups: Sequence[FileMatches]) -> list[str]:
    """The "Distinct matches" aggregate of a regex search: each different string with its count and places."""
    ranked, cut = distinct_matches(groups)
    if not ranked:
        return []
    floor = "at least " if cut else ""
    lines = [f"Distinct matches: {floor}{len(ranked)} (each different matched string, with its count):"]
    for text, count, files, pages in ranked[:MAX_DISTINCT_MATCHES]:
        names = ", ".join(files[:MAX_DISTINCT_FILES]) + (
            f" … (+{len(files) - MAX_DISTINCT_FILES} files)" if len(files) > MAX_DISTINCT_FILES else ""
        )
        where = _pages_label(pages, MAX_DISTINCT_PAGES)
        lines.append(f"- `{_shorten(text, MAX_DISTINCT_CHARS)}`: {count}× in {names}{where}")
    if len(ranked) > MAX_DISTINCT_MATCHES:
        lines.append(f"… and {len(ranked) - MAX_DISTINCT_MATCHES} more distinct strings, the rarest.")
    return lines
