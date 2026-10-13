"""The adapter's reads from Qdrant, in the adapter's terms: one logical collection per call.

``LlamaIndexRetriever`` keeps its contract (``retrieve(query, collection)``,
``find_text(collection, pattern)``) and, under ``AIQ_VECTOR_BACKEND=qdrant``,
answers from here. Nothing returned carries a ``qdrant_client`` type.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from qdrant_client import models

from .schema import TEXT_FIELD
from .search import Hit
from .search import exact_term
from .search import grouped_search
from .search import hybrid_search
from .store import get_store


def search(
    scope: str,
    *,
    vector: Sequence[float],
    lexical_text: str,
    top_k: int,
    filters: dict[str, Any] | None,
    exact_terms: Sequence[str],
    identity: Mapping[str, str],
) -> list[Hit]:
    """The fused hybrid ranking over one logical collection; refuses a foreign embedder."""
    store = get_store(identity)
    store.check_identity(scope)
    return hybrid_search(
        store,
        [scope],
        vector=vector,
        lexical_text=lexical_text,
        limit=top_k,
        filters=filters,
        exact_terms=exact_terms,
        candidates=top_k,
    )


def search_grouped(
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    groups: int,
    group_size: int,
    identity: Mapping[str, str],
) -> list[tuple[str, list[Hit]]]:
    """One fused ranking over many logical collections, grouped per collection, best group first."""
    if not scopes:
        return []
    store = get_store(identity)
    store.check_identity(scopes[0])
    return grouped_search(
        store,
        scopes,
        vector=vector,
        lexical_text=lexical_text,
        group_by="scope",
        groups=groups,
        group_size=group_size,
    )


def term_frequencies(scope: str, terms: Sequence[str]) -> tuple[int, dict[str, int]]:
    """How many chunks ``scope`` holds, and how many contain each exact term (``search.exact_term``)."""
    store = get_store()
    total = store.count(scope)
    return total, {term: store.count(scope, None, exact_term(term)) for term in terms}


#: A character class standing between words in a ``browse.phrase_pattern``:
#: whitespace and dashes, at least one of them.
_SEPARATOR_CLASS = re.compile(r"\[((?:\\s|[^\]\w\\])+)\]\+")
_PLAIN_TOKEN = re.compile(r"[a-z0-9]+")


def _pieces(alternative: str) -> list[tuple[str, str]] | None:
    """One alternative of the pattern as ``(kind, text)`` pieces, or None for a construct not read here.

    Kinds: ``sep`` (a separator class, or ``\\b``: the text has a non-word
    character or an edge there), ``group`` (an umlaut alternation, a word
    character of unknown spelling) and ``char`` (one literal character).
    """
    pieces: list[tuple[str, str]] = []
    index = 0
    while index < len(alternative):
        rest = alternative[index:]
        separator = _SEPARATOR_CLASS.match(rest)
        if separator:
            pieces.append(("sep", ""))
            index += separator.end()
        elif rest.startswith("\\b"):
            pieces.append(("sep", ""))
            index += 2
        elif rest.startswith("(?:"):
            close = rest.find(")")
            if close < 0 or "(" in rest[3:close]:
                return None
            pieces.append(("group", ""))
            index += close + 1
        elif rest[0] == "\\" and len(rest) > 1 and not rest[1].isalnum():
            pieces.append(("char", rest[1]))
            index += 2
        elif rest[0] in "\\.^$*+?{}()[]|":
            return None
        else:
            pieces.append(("char", rest[0]))
            index += 1
    return pieces


def _bounded_words(pieces: list[tuple[str, str]]) -> list[str]:
    """The plain ASCII words of an alternative that its text must hold as whole tokens.

    A word counts only with a separator, ``\\b`` or a non-word literal on BOTH
    sides: an unbounded edge matches inside a longer word (the pattern for
    „Fluchtstiege“ finds „Hauptfluchtstiegen“), whose token is not the word.
    A word with an umlaut group in it has no single spelling, so it never counts.
    """
    words: list[str] = []
    run: list[tuple[str, str]] = []
    left_bounded = False
    for kind, char in [*pieces, ("end", "")]:
        if kind == "group" or (kind == "char" and (char.isalnum() or char == "_")):
            run.append((kind, char))
            continue
        bounded_right = kind == "sep" or (kind == "char" and not (char.isalnum() or char == "_"))
        word = "".join(char for _, char in run)
        if run and left_bounded and bounded_right and all(k == "char" for k, _ in run) and _PLAIN_TOKEN.fullmatch(word):
            words.append(word)
        run = []
        left_bounded = bounded_right
    return words


def _alternatives(body: str) -> list[str]:
    """``body`` split at its top-level ``|``: never inside a group or a character class."""
    parts, start, depth, in_class, index = [], 0, 0, False, 0
    while index < len(body):
        char = body[index]
        if char == "\\":
            index += 2
            continue
        if in_class:
            in_class = char != "]"
        elif char == "[":
            in_class = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "|" and depth == 0:
            parts.append(body[start:index])
            start = index + 1
        index += 1
    parts.append(body[start:])
    return parts


def literal_tokens(pattern: str) -> list[list[str]] | None:
    """Per alternative of a ``browse.phrase_pattern``, the words its matches hold as whole tokens; None if one has none.

    A chunk matching the pattern matches one alternative and therefore holds
    all of that alternative's words as tokens of the ``word``-tokenized text
    index (lowercased, ASCII-folded; ``schema.TEXT_INDEX``). A full-text
    condition over them can only drop chunks the regex would drop too. An
    alternative without such a word (a single word longer than three
    characters, which matches inside longer words) leaves no safe condition,
    and the caller reads every chunk.
    """
    body = pattern.removeprefix("(?i)")
    alternatives: list[list[str]] = []
    for alternative in _alternatives(body):
        pieces = _pieces(alternative)
        words = _bounded_words(pieces) if pieces is not None else []
        if not words:
            return None
        alternatives.append(list(dict.fromkeys(words)))
    return alternatives


def _text_prefilter(scope: str, pattern: str) -> list[models.Filter]:
    """The server-side narrowing for :func:`find_text`, or nothing when no safe one exists."""
    tokens = literal_tokens(pattern)
    if not tokens or not get_store().text_index_sound(scope):
        return []
    return [
        models.Filter(
            should=[
                models.FieldCondition(key=TEXT_FIELD, match=models.MatchText(text=" ".join(words))) for words in tokens
            ]
        )
    ]


def find_text(scope: str, pattern: str, filters: dict[str, Any] | None, limit: int) -> list[Hit]:
    """Every chunk of ``scope`` whose text matches the regex ``pattern``, up to ``limit``.

    Qdrant has no regex filter. The pattern ``browse.phrase_pattern`` builds is
    written to mean the same in Rust's ``regex`` and Python's ``re`` (it was
    always re-checked in Python), so it is applied here over the chunk text,
    read by scroll. The scroll is narrowed on the server by the words every
    match must hold as tokens (:func:`literal_tokens`), and reads the whole
    scope only when the pattern names no such word. Both scrolls run in
    point-id order, so the first ``limit`` matches are the same either way.
    """
    compiled = re.compile(pattern)
    hits: list[Hit] = []
    for record in get_store().scroll(scope, filters, *_text_prefilter(scope, pattern)):
        payload = dict(record.payload or {})
        text = str(payload.get("text") or "")
        if compiled.search(text):
            hits.append(Hit(str(payload.get("chunk_id") or record.id), text, payload, 0.0, 1.0))
            if len(hits) >= limit:
                break
    return hits


def healthy() -> bool:
    """True when Qdrant answers."""
    return get_store().health()
