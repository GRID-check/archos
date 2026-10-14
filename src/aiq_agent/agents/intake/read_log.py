"""What the Erfassungs-Agent read in this run, so a quote it records can be checked against it.

A value the intake records carries a quote, and the quote is the proof a person
checks on the review. Code therefore checks it rather than trusting it (the
rule ADR-0096 set for the closed-project reading, ``project_experience``): a
quote that does not stand in text a tool returned to the model in THIS run, in
THAT file, never leaves the process (``record_values`` refuses it, and says to
read the page first).

Every reading tool logs what it showed: ``read_document`` page by page, and
``knowledge_search`` / ``read_passage`` hit by hit (``reading.py``). Only what
the model was shown is logged, never more of the page than the tool returned.

Per run, never per process: a :class:`~contextvars.ContextVar` bound and reset
by ``ProjectIntakeAgent.run`` (the per-turn state rule in
``src/aiq_agent/AGENTS.md``). Two intake runs on one worker read two projects
of possibly two tenants; a module-level log would let one's quote pass on the
other's text.
"""

from __future__ import annotations

import bisect
import re
from contextvars import ContextVar
from contextvars import Token
from dataclasses import dataclass
from typing import Literal

from aiq_agent.knowledge.project_experience import folded_for_quote

#: What :meth:`IntakeReadLog.contains` answers when the quote is not in the file's text.
NOT_FOUND: Literal[False] = False
#: The longest passage :meth:`IntakeReadLog.closest` offers back.
MAX_CLOSEST_CHARS = 200
#: The share of the quote's words a passage must hold to be offered as the closest.
MIN_CLOSEST_OVERLAP = 0.4

_WORD = re.compile(r"\w+")


@dataclass(frozen=True)
class Closest:
    """The passage of what was read that comes closest to a quote that was not found: its page and words."""

    page: int | None
    text: str


@dataclass(frozen=True)
class LoggedText:
    """One stretch of text a tool showed the model: a page, or a passage that starts on one."""

    page: int | None
    text: str
    folded: str


def _name_key(file_name: str) -> str:
    return folded_for_quote(file_name)


class IntakeReadLog:
    """File name → the text read from it, in the order it was read; and which files were opened."""

    def __init__(self) -> None:
        self._texts: dict[str, list[LoggedText]] = {}
        self._names: dict[str, str] = {}
        self._opened: dict[str, str] = {}

    def log(self, file_name: str, page: int | None, text: str) -> None:
        """Note that the model was shown ``text`` of ``file_name`` (on ``page``, when known)."""
        name = (file_name or "").strip()
        body = (text or "").strip()
        if not name or not body:
            return
        key = _name_key(name)
        self._names.setdefault(key, name)
        entries = self._texts.setdefault(key, [])
        folded = folded_for_quote(body)
        if any(entry.folded == folded and entry.page == page for entry in entries):
            return
        entries.append(LoggedText(page=page, text=body, folded=folded))

    def mark_opened(self, file_name: str) -> None:
        """Note that the model opened this file to read it (``read_document``, ``read_passage``)."""
        name = (file_name or "").strip()
        if name:
            key = _name_key(name)
            self._names.setdefault(key, name)
            self._opened.setdefault(key, self._names[key])

    def canonical_name(self, file_name: str) -> str | None:
        """The file's name as the tools spelled it, for a name the model wrote; None when nothing of it was read."""
        return self._names.get(_name_key(file_name or ""))

    def has_text(self, file_name: str) -> bool:
        return bool(self._texts.get(_name_key(file_name or "")))

    @property
    def documents_read(self) -> list[str]:
        """The files the model opened, in the order it opened them."""
        return list(self._opened.values())

    @property
    def files_seen(self) -> list[str]:
        """Every file some text was shown of, a search hit included."""
        return [self._names[key] for key in self._texts]

    def contains(self, file_name: str, quote: str, page: int | None = None) -> int | None | Literal[False]:
        """The page ``quote`` stands on in what was read of ``file_name``; None when found without a page.

        :data:`NOT_FOUND` (``False``) when it is not there. NFC, whitespace and
        case are folded on both sides (:func:`folded_for_quote`). ``page`` is the
        page the model named: when the quote stands there too, that page wins,
        so a sentence printed on two pages is filed where the model found it.
        A quote that runs across a page break is found in the pages joined in
        order, and filed under the page it starts on.
        """
        wanted = folded_for_quote(quote or "")
        entries = self._texts.get(_name_key(file_name or ""))
        if not wanted or not entries:
            return NOT_FOUND
        hits = [entry for entry in entries if wanted in entry.folded]
        if hits:
            named = next((entry for entry in hits if page is not None and entry.page == page), None)
            return (named or hits[0]).page
        return _across_pages(entries, wanted)

    def closest(self, file_name: str, quote: str, page: int | None = None) -> Closest | None:
        """The run of words read of ``file_name`` that shares most words with ``quote``; None when none comes close.

        For a refusal the model can act on: what WAS read there, as words it can
        copy (the passage's own words joined by single spaces, which the quote
        check accepts), at most :data:`MAX_CLOSEST_CHARS`. The page the model
        named wins a tie.
        """
        wanted = {word.casefold() for word in _WORD.findall(folded_for_quote(quote or ""))}
        entries = self._texts.get(_name_key(file_name or ""))
        if not wanted or not entries:
            return None
        best: tuple[float, bool, int | None, str] | None = None
        for entry in entries:
            found = _best_window(entry.text, wanted, len(_WORD.findall(quote or "")))
            if found is None:
                continue
            score, text = found
            candidate = (score, entry.page == page and page is not None, entry.page, text)
            if best is None or candidate[:2] > best[:2]:
                best = candidate
        if best is None or best[0] < MIN_CLOSEST_OVERLAP:
            return None
        return Closest(page=best[2], text=best[3])


def _across_pages(entries: list[LoggedText], wanted: str) -> int | None | Literal[False]:
    ordered = sorted(entries, key=lambda entry: (entry.page is None, entry.page or 0))
    starts: list[int] = []
    parts: list[str] = []
    offset = 0
    for entry in ordered:
        starts.append(offset)
        parts.append(entry.folded)
        offset += len(entry.folded) + 1
    found = " ".join(parts).find(wanted)
    if found < 0:
        return NOT_FOUND
    return ordered[bisect.bisect_right(starts, found) - 1].page


def _best_window(text: str, wanted: set[str], length: int) -> tuple[float, str] | None:
    """The window of ``length`` words of ``text`` holding most of ``wanted``: (share of wanted, its words)."""
    words = text.split()
    if not words:
        return None
    # A few words of context either side of the quote's length, so the passage reads as a sentence.
    size = max(1, min(length + max(2, length // 2), len(words)))
    keys = [{token.casefold() for token in _WORD.findall(word)} for word in words]
    best_score, best_start = -1.0, 0
    for start in range(0, len(words) - size + 1):
        held = set().union(*keys[start : start + size]) & wanted
        score = len(held) / len(wanted)
        if score > best_score:
            best_score, best_start = score, start
    passage = " ".join(words[best_start : best_start + size])
    return best_score, passage[:MAX_CLOSEST_CHARS].rstrip()


_READ_LOG: ContextVar[IntakeReadLog | None] = ContextVar("grid_intake_read_log", default=None)


def bind_read_log(log: IntakeReadLog | None = None) -> tuple[IntakeReadLog, Token]:
    """Start a run's log. Pair with :func:`reset_read_log` in a ``finally``."""
    bound = log if log is not None else IntakeReadLog()
    return bound, _READ_LOG.set(bound)


def reset_read_log(token: Token) -> None:
    _READ_LOG.reset(token)


def current_read_log() -> IntakeReadLog | None:
    """The bound run's log; None outside an intake run, where no quote can be checked and none is accepted."""
    return _READ_LOG.get()
