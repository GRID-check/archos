"""What each ``[N]`` of an answer with no source list names: a passage of THIS turn, by content (ADR-0139).

Piloti's model never sees the registry numbered, and it often writes ``[1]``,
``[2]`` without a Quellen list. Read as positions in the conversation's
cumulative registry, those numbers cited project drawings to OIB passages of
the turn before, and „Punkt 12" to OIB-RL 2.1 p.4. So the writer-facing list
``verify_citations`` synthesises the source section from is built here: per
number, the passage of this turn that carries most of the sentences citing it.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import _entry_from_hit
from aiq_agent.common.citation_verification import _inline_citation_numbers
from aiq_agent.common.citation_verification import get_grounding_block

_RESULT_HEADER_RE = re.compile(r"^--- Result (\d+) ---$", re.MULTILINE)


def turn_passages(results: Sequence[tuple[str, Any, Any]]) -> dict[int, list[SourceEntry]]:
    """This turn's passages by the „Result N" each block printed them under; a number two blocks printed holds both.

    ``results`` are the turn's tool results as ``(tool name, content,
    artifact)``. Every block numbers from 1, and the model's own numbers follow
    no block reliably, so the number is only a tie-break for
    :func:`resolve_unlisted_numbers`.
    """
    from aiq_agent.common.citation_collector import hits_from_artifact

    numbered: dict[int, list[SourceEntry]] = {}
    for tool_name, content, artifact in results:
        hits = hits_from_artifact(artifact)
        text = content if isinstance(content, str) else ""
        if hits is None:
            block = get_grounding_block(text) if text else None
            hits = block.hits if block is not None else None
        if not hits:
            continue
        printed = [int(number) for number in _RESULT_HEADER_RE.findall(text)]
        numbers = printed if len(printed) == len(hits) else list(range(1, len(hits) + 1))
        for number, hit in zip(numbers, hits, strict=True):
            entry = _entry_from_hit(hit, tool_name)
            held = numbered.setdefault(number, [])
            if all(other.citation_key != entry.citation_key or other.chunk_text != entry.chunk_text for other in held):
                held.append(entry)
    return numbered


_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")
_HOLD_WORD_RE = re.compile(r"[^\W\d_][^\W_]{3,}")
_HOLD_NUMBER_RE = re.compile(r"(?<![\w-])\d+(?:[.,]\d+)?(?!\w)")


def _holds(sentence: str, entry: SourceEntry) -> bool:
    """Whether ``entry``'s text carries the sentence: every number it states and half its key words.

    A choice between passages, never a judgement of support: whether the
    passage says what the sentence says is the answer check's
    (``common/claim_judge.py``). The file the sentence names is left out: a
    page's text rarely prints its own file name.
    """
    text = (entry.chunk_text or "").casefold()
    if not text.strip():
        return False
    named = entry.citation_key.split(", ")[0].casefold()
    plain = re.sub(r"\[\d+\]", " ", sentence.casefold()).replace(named, " ")
    if not set(_HOLD_NUMBER_RE.findall(plain)) <= set(_HOLD_NUMBER_RE.findall(text)):
        return False
    words = set(_HOLD_WORD_RE.findall(plain))
    held = set(_HOLD_WORD_RE.findall(text))
    return bool(words) and len(words & held) * 2 >= len(words)


def _carrying(text: str, number: int) -> list[str]:
    return [part for part in _SENTENCE_RE.split(text) if f"[{number}]" in part]


def resolve_unlisted_numbers(text: str, numbered: dict[int, list[SourceEntry]]) -> list[SourceEntry | None]:
    """What each ``[N]`` of an answer with no source list names, at position N-1; None where nothing does.

    By content, never by position: ``[N]`` names the passage of this turn
    that carries most of the sentences citing it (:func:`_holds`), each
    sentence counted on its own; the printed „Result N" breaks a tie, then the
    turn's order. A number no passage carries is labelled. The model's numbers
    follow neither the registry nor any one block: read as positions they
    cited Punkt 12 to OIB-RL 2.1 p.4 and drawings to OIB pages (ADR-0139).
    """
    every = [entry for held in numbered.values() for entry in held]
    resolved: dict[int, SourceEntry] = {}
    for number in sorted(_inline_citation_numbers(text)):
        carrying = _carrying(text, number)
        counts = [(sum(_holds(sentence, entry) for sentence in carrying), entry) for entry in every]
        best = max((count for count, _ in counts), default=0)
        if best == 0:
            continue
        tied = [entry for count, entry in counts if count == best]
        printed = [entry for entry in tied if entry in numbered.get(number, [])]
        resolved[number] = (printed or tied)[0]
    if not resolved:
        return []
    return [resolved.get(position) for position in range(1, max(resolved) + 1)]


def writer_numbering(text: str, turn: Sequence[Any]) -> list[SourceEntry | None]:
    """The writer-facing list ``verify_citations`` reads an answer's ``[N]`` against: this turn's passages."""
    from langchain_core.messages import ToolMessage

    results = [(m.name or "", m.content, getattr(m, "artifact", None)) for m in turn if isinstance(m, ToolMessage)]
    return resolve_unlisted_numbers(text, turn_passages(results))
