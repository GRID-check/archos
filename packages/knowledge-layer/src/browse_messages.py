"""The passages an exact search shows: the snippets around each match, and the messages for a search that found
nothing or failed.
"""

from __future__ import annotations

import bisect
import re
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from .browse_matches import MAX_MATCH_CHUNKS
from .browse_matches import FileMatches
from .browse_matches import _distinct_lines
from .browse_patterns import WHOLE_WORD_MAX_CHARS
from .browse_rows import _SHELF_LABELS
from .browse_scope import _TOLERATED
from .browse_scope import _TOLERATED_REGEX
from .browse_scope import ShelfScope
from .browse_scope import _candidate_lines
from .browse_scope import _collection_names
from .browse_scope import _failed_note
from .browse_scope import _scope_statement
from .browse_scope import _shelf_lines
from .browse_scope import _wanted
from .browse_text import _pages_label
from .chunk_positions import OwnText
from .chunk_positions import own_matches
from .chunk_positions import own_text

#: Lines of context around a hit (``context=``), and the lines the whole index may print.
MAX_CONTEXT_LINES = 3

MAX_SNIPPET_LINES = 40


def match_table(
    groups: Sequence[FileMatches],
    phrases: Sequence[str],
    *,
    truncated: bool,
    failed: Sequence[str] = (),
    regex_mode: bool = False,
    candidates: Mapping[str, int] | None = None,
    scopes: Sequence[ShelfScope] = (),
) -> str:
    """The per-file answer to "where does this appear": every file, not the top three.

    ``scopes`` adds the scope statement and one line per shelf, so „0 matches in 12 files“ on the
    project is visible beside 40 hits in the Basiswissen corpus.
    """
    wanted = _wanted(phrases, regex_mode)
    floor = "at least " if truncated else ""
    tolerated = _TOLERATED_REGEX if regex_mode else _TOLERATED
    lines = [
        f"## Matches for {wanted}",
        f"{floor}{sum(group.occurrences for group in groups)} occurrence(s) in {len(groups)} file(s), {tolerated}:",
    ]
    if scopes:
        lines.append(_scope_statement(scopes))
        lines.extend(_shelf_lines(groups, scopes))
    for group in groups:
        shelf = f" ({_SHELF_LABELS[group.shelf]})" if group.shelf in _SHELF_LABELS else ""
        lines.append(f"- {group.file_name}{shelf}: {group.occurrences}×{_pages_label(group.pages)}")
    if regex_mode:
        lines.extend(_distinct_lines(groups))
    if truncated:
        lines.append(
            f"The search stopped after {MAX_MATCH_CHUNKS} matching passages in a collection: the counts above are "
            "lower bounds and the list may miss files. Narrow it with `folder=` or `file_name=`."
        )
        lines.extend(_candidate_lines(candidates, {group.file_name: group.occurrences for group in groups}))
    if failed:
        lines.append(_failed_note(failed))
    lines.append(
        "The table is an index; only the passages above are citable. Open another match with "
        "`read_passage(document=…, page=…)`."
    )
    return "\n".join(lines)


def _line_spans(own: OwnText, pattern: Any, timeout: float | None) -> list[tuple[int, int]]:
    """``(first line, last line)`` of every match that is the chunk's own, counting from 0."""
    starts = [0]
    starts.extend(match.end() for match in re.finditer("\n", own.text))
    matches = own_matches(own, pattern, timeout)

    def line_of(offset: int) -> int:
        return max(0, bisect.bisect_right(starts, offset) - 1)

    return [(line_of(m.start()), line_of(max(m.start(), m.end() - 1))) for m in matches]


def _context_ranges(spans: Sequence[tuple[int, int]], context: int, last: int) -> list[tuple[int, int]]:
    """The line ranges around ``spans``, ``context`` lines each side, overlapping ones joined."""
    ranges: list[tuple[int, int]] = []
    for first, end in sorted(spans):
        low, high = max(0, first - context), min(last, end + context)
        if ranges and low <= ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], high))
        else:
            ranges.append((low, high))
    return ranges


def _chunk_snippets(own: OwnText, where: str, pattern: Any, context: int, room: int, timeout: float | None):
    """One chunk's ``(lines, cut)``: its hit ranges, at most ``room`` lines, ``cut`` when it had to stop."""
    lines = own.text.split("\n")
    spans = _line_spans(own, pattern, timeout)
    hit_lines = {number for first, end in spans for number in range(first, end + 1)}
    out: list[str] = []
    for low, high in _context_ranges(spans, context, len(lines) - 1):
        left = room - len(out) - 1  # one line is the header
        if left < 1:
            return out, True
        shown = min(high, low + left - 1)
        out.append(f"{where}:")
        out.extend(f"{'>' if number in hit_lines else ' '} {lines[number].strip()}" for number in range(low, shown + 1))
        if shown < high:
            return out, True
    return out, False


def match_snippets(groups: Sequence[FileMatches], pattern: Any, context: int, *, timeout: float | None = None) -> str:
    """The lines around every match, ``context`` each side: grep ``-C`` over the files, as an index.

    Per hit ``file, p.N:`` and its lines (``>`` marks a line the pattern matched), at most
    :data:`MAX_SNIPPET_LINES` lines in all; it says when it stopped. Pure.
    """
    out: list[str] = []
    cut = False
    chunks = [(group, chunk) for group in groups for chunk in group.chunks]
    for group, chunk in chunks:
        page = getattr(chunk, "page_number", None)
        where = f"{group.file_name}, p.{page}" if page else group.file_name
        own = group.own.get(chunk.chunk_id) or own_text(chunk)
        found, cut = _chunk_snippets(own, where, pattern, context, MAX_SNIPPET_LINES - len(out), timeout)
        out.extend(found)
        if cut:
            break
    if not out:
        return ""
    if cut:
        out.append(f"… the lines stop at {MAX_SNIPPET_LINES}; narrow with `folder=` or `file_name=` for the rest.")
    out.append("This is an index: cite the passages above, not these lines.")
    return "\n".join(["## Lines around the matches", *out])


def no_match_message(
    phrases: Sequence[str],
    searched: int,
    failed: Sequence[str] = (),
    *,
    regex_mode: bool = False,
    scopes: Sequence[ShelfScope] = (),
) -> str:
    """``No match`` over the ``searched`` collections that ANSWERED; never a "no" over one that failed."""
    wanted = _wanted(phrases, regex_mode)
    short = "" if regex_mode else " | ".join(f'"{phrase}"' for phrase in phrases if len(phrase) <= WHOLE_WORD_MAX_CHARS)
    whole_word = f" {short} was searched as a whole word only, not inside longer words." if short else ""
    tolerated = _TOLERATED_REGEX if regex_mode else _TOLERATED
    head = f"No match for {wanted} in {searched} collection(s), {tolerated}.{whole_word}"
    if scopes:
        head = "\n".join([head, _scope_statement(scopes), *_shelf_lines([], scopes)])
    if failed:
        return f"{head} {_failed_note(failed)} For those collections this is NOT a no."
    return (
        f"{head} That is a solid no for the WORDING, not for the topic: `knowledge_search` without `match` "
        "finds another phrasing. Scanned pages without a text layer and files still being processed are not "
        "searchable."
    )


def search_failed_message(phrases: Sequence[str], failed: Sequence[str], *, regex_mode: bool = False) -> str:
    """Every collection failed: there is no answer, and in particular no Nein."""
    wanted = _wanted(phrases, regex_mode)
    return (
        f"The full-text search for {wanted} could not run: none of the {len(failed)} collection(s) answered "
        f"({_collection_names(failed)}). This is NOT a result, neither a hit nor a no. Tell the reader the search "
        "was not possible just now, or try `knowledge_search` without `match`."
    )


def _context_lines(value: Any) -> tuple[int | None, str]:
    """``context=`` as a count of lines (0 to :data:`MAX_CONTEXT_LINES`), None for none, or a refusal."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, ""
    try:
        lines = int(str(value).strip())
    except ValueError:
        lines = -1
    if not 0 <= lines <= MAX_CONTEXT_LINES:
        return None, f"`context` is a number of lines from 0 to {MAX_CONTEXT_LINES}, got {value!r}."
    return lines, ""
