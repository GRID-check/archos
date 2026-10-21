"""Locus agreement: a § or Punkt written beside ``[N]`` must occur in the passage ``[N]`` resolves to.

``verify_citations`` proves that a cited SOURCE is real. It never asked whether
the place the sentence names is in it: „§ 5 Abs. 2 [1]" passed as long as
``[1]`` was some passage of the cited file, even when that passage is § 12 and
§ 5 is nowhere in the turn. A reader who opens the chip finds a different
section than the one the sentence promises, which is the misgrounded citation
the Stanford audit counts as a hallucination and a pointer check alone misses.

So the locus written immediately before a marker is held to the cited entry:

- ``Punkt 3.5.2`` / ``Pkt. 3.5.2``: the entry's own ``clause`` agrees (equal,
  or one is a prefix of the other on a dot boundary, since a passage of 3.5 may
  carry 3.5.2), or ``3.5.2`` stands in its text or title.
- ``§ 5`` / ``§§ 5``: ``§ 5`` (not ``§ 50``) stands in its text, title or key,
  or the RIS URL names ``Paragraf=5``.

Fail-open in the one direction the quote check is: an entry with neither
passage text nor a clause (a URL-only web hit) cannot be checked and passes.
Only the CLOSEST locus before the marker counts, and only within the marker's
own clause: a sentence that names § 3 and then cites § 5 with [2] is about two
places, and only the second is [2]'s promise.

Pure: text and entries in, verdicts out.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

#: What ends the stretch a locus may stand in before its marker: a sentence end,
#: a semicolon, a line break, or another marker. A period ends a sentence only
#: before a capital, so „§ 5 Abs. 2 [1]" and „Pkt. 3.2 [1]" stay one stretch.
_CLAUSE_END_RE = re.compile(r"(?<!\d)\.(?=\s+[A-ZÄÖÜ„\"])|[;!?\n]|\[\d+\]")

#: How far back from the marker a locus is looked for. A locus further away is
#: the sentence's subject, not the marker's address.
_LOOKBACK_CHARS = 80

_PUNKT_RE = re.compile(r"\b(?:Punkt|Pkt\.?|Pt\.)\s*(\d+(?:\.\d+)+)\b", re.IGNORECASE)
_PARAGRAPH_RE = re.compile(r"§§?\s*(\d+[a-z]?)\b", re.IGNORECASE)
_INLINE_MARKER_RE = re.compile(r"\[(\d+)\]")


class LocusEntry(Protocol):
    """The fields of a registry entry the check reads (``citation_verification.SourceEntry``)."""

    chunk_text: str | None
    clause: str | None
    title: str | None
    citation_key: str | None
    url: str | None


@dataclass(frozen=True)
class Locus:
    """One locus the prose wrote beside a marker."""

    kind: str  # "punkt" or "paragraph"
    value: str

    def __str__(self) -> str:
        return f"Punkt {self.value}" if self.kind == "punkt" else f"§ {self.value}"


@dataclass(frozen=True)
class LocusMismatch:
    """One marker occurrence whose locus is not in the entry it resolves to."""

    number: int
    locus: Locus
    start: int
    end: int


def locus_before(text: str, marker_start: int) -> Locus | None:
    """The locus closest before the marker at ``marker_start``, within its clause; None when there is none."""
    window_start = max(0, marker_start - _LOOKBACK_CHARS)
    window = text[window_start:marker_start]
    ends = list(_CLAUSE_END_RE.finditer(window))
    if ends:
        window = window[ends[-1].end() :]
    found: list[tuple[int, Locus]] = []
    found += [(match.start(), Locus("punkt", match.group(1))) for match in _PUNKT_RE.finditer(window)]
    found += [(match.start(), Locus("paragraph", match.group(1).lower())) for match in _PARAGRAPH_RE.finditer(window)]
    if not found:
        return None
    return max(found, key=lambda item: item[0])[1]


def _clause_agrees(clause: str, value: str) -> bool:
    clause = clause.strip().rstrip(".")
    if not clause:
        return False
    return clause == value or value.startswith(clause + ".") or clause.startswith(value + ".")


def locus_in_entry(locus: Locus, entry: LocusEntry) -> bool | None:
    """Whether ``entry`` holds ``locus``; None when the entry has nothing to check against."""
    text = " ".join(part for part in (entry.chunk_text, entry.title, entry.citation_key) if part)
    if not (entry.chunk_text or entry.clause):
        return None
    if locus.kind == "punkt":
        if entry.clause and _clause_agrees(entry.clause, locus.value):
            return True
        return re.search(rf"(?<![\d.]){re.escape(locus.value)}(?![\d]|\.\d)", text) is not None
    if re.search(rf"§§?\s*{re.escape(locus.value)}(?![\d])", text, re.IGNORECASE):
        return True
    url = entry.url or ""
    return re.search(rf"[?&]Paragraf={re.escape(locus.value)}(?![\d])", url, re.IGNORECASE) is not None


def locus_mismatches(body: str, entries: Mapping[int, LocusEntry]) -> list[LocusMismatch]:
    """Every marker in ``body`` whose closest locus is not in the entry its number resolves to.

    ``entries`` maps each VALID citation number to its registry entry; a marker
    of any other number is somebody else's business (it is removed as
    unresolvable) and is skipped here.
    """
    mismatches: list[LocusMismatch] = []
    for match in _INLINE_MARKER_RE.finditer(body):
        number = int(match.group(1))
        entry = entries.get(number)
        if entry is None:
            continue
        locus = locus_before(body, match.start())
        if locus is None or locus_in_entry(locus, entry) is not False:
            continue
        mismatches.append(LocusMismatch(number, locus, match.start(), match.end()))
    return mismatches
