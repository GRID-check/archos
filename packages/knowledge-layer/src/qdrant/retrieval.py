"""The adapter's reads from Qdrant, in the adapter's terms: one logical collection per call.

``LlamaIndexRetriever`` keeps its contract (``retrieve(query, collection)``,
``find_text(collection, pattern)``) and answers from here. Nothing returned
carries a ``qdrant_client`` type.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Mapping
from collections.abc import MutableMapping
from collections.abc import Sequence
from typing import Any

import regex
from qdrant_client import models

from .boost import parse_boost
from .payload import project_payload
from .schema import TEXT_FIELD
from .schema import TEXT_STEM_FIELD
from .scope import scope_filter
from .search import Hit
from .search import _alias as search_alias
from .search import exact_term
from .search import grouped_search
from .search import hybrid_search
from .store import get_store

#: The German stopwords spelled with an umlaut or ß (Snowball's list, the one
#: Postgres' ``german`` config and Qdrant's German BM25 both use). Qdrant folds
#: before it drops stopwords, so with ``ascii_folding`` „über“ reaches the
#: index and the query as ``uber``, a term on 18% of the OIB corpus: „was
#: weißt du über die oib 1“ ranked every chunk with an „über“ (measured,
#: ``qdrant-gates-2026-10.md``, "Ranking sweep"). The rest of the list Qdrant
#: drops itself, as Postgres drops all of it.
BM25_FOLDED_STOPWORDS = frozenset({"daß", "für", "können", "könnte", "über", "während", "würde", "würden"})

#: A file name typed into a question: a word with a document extension.
_FILE_NAME = re.compile(
    r"[\w.-]+\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|md|csv|dwg|dxf|ifc|png|jpe?g|tiff?|eml|msg|zip)\b",
    re.IGNORECASE,
)


def bm25_candidates(query: str, extra_terms: Sequence[str] = ()) -> list[str]:
    """The terms of ``query`` the BM25 channel may be asked for, before pricing.

    ``german_text.query_terms``, less what carries no lexical signal here:
    the stopwords Qdrant's folding lets through, and the pieces of a file
    name. A file name is an identifier, not prose: split at ``-``, ``_`` and
    ``.``, „oib-rl_5_ausgabe_mai_2023.pdf“ asked BM25 for „ausgabe mai 2023“,
    which every Richtlinie's front matter holds, and pushed the named file out
    of the 60-chunk pool the dense channel alone puts it in.
    """
    from aiq_agent.common import german_text

    prose = _FILE_NAME.sub(" ", query)
    return [
        term for term in german_text.query_terms(prose, extra_terms=extra_terms) if term not in BM25_FOLDED_STOPWORDS
    ]


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
    filters: dict[str, Any] | None = None,
    boost: Mapping[str, Any] | None = None,
    exact_terms: Sequence[str] = (),
) -> list[tuple[str, list[Hit]]]:
    """One fused ranking over many logical collections, grouped per collection, best group first.

    ``filters`` is the backend-neutral filter grammar (``scope.translate``);
    ``boost`` is ``{"facts": {...}, "weights": {...}}`` (``boost.parse_boost``).
    """
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
        filters=filters,
        boost=parse_boost(boost),
        exact_terms=exact_terms,
    )


def set_project_facts(scope: str, facts: Mapping[str, Any] | None, status: str) -> bool:
    """Mirror a project's facts and status onto every point of ``scope``; False when no collection holds it yet."""
    return get_store().set_scope_payload(scope, project_payload(facts, status))


def term_frequencies(
    scopes: str | Sequence[str],
    terms: Sequence[str],
    cache: MutableMapping[tuple[str, int, str], int] | None = None,
) -> tuple[int, dict[str, int]]:
    """How many chunks ``scopes`` hold together, and how many contain each exact term (``search.exact_term``).

    Over several scopes (cross-project search) both counts are over their
    union: the corpus the BM25 channel's IDF is computed over
    (``search._prefetches``), so a term is judged selective where it is ranked.

    ``cache`` keeps a count per ``(scopes, total, term)``, the scopes joined
    sorted: a corpus that has not changed size answers a recurring term without
    a round trip, and any write that changes the count invalidates it.
    """
    names = [scopes] if isinstance(scopes, str) else list(dict.fromkeys(scopes))
    store = get_store()
    if not names or not store.exists(names[0]):
        return 0, dict.fromkeys(terms, 0)
    alias = search_alias(store, names)

    def count(*extra: models.Condition) -> int:
        return store.client.count(alias, count_filter=scope_filter(names, None, *extra), exact=True).count

    total = count()
    label = ",".join(sorted(names))
    counts: dict[str, int] = {}
    for term in dict.fromkeys(terms):
        key = (label, total, term)
        if cache is not None and key in cache:
            counts[term] = cache[key]
            continue
        counts[term] = count(exact_term(term))
        if cache is not None:
            cache[key] = counts[term]
    return total, counts


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


#: Seconds one chunk may take a person's regex. A chunk is a few thousand characters, so a
#: pattern that needs longer is backtracking catastrophically, and the whole search stops.
USER_REGEX_TIMEOUT = 0.2

#: Seconds the whole scan of one collection may take with a person's regex, reading included.
#: The per-chunk limit alone does not bound it: a pattern that costs 0.15 s on each of 10 000
#: chunks naming a common word passes every chunk's limit and holds a worker for 25 minutes.
USER_REGEX_SCAN_SECONDS = 3.0

#: Chunks one scan with a person's regex may read. Past it the pattern narrows too little to
#: answer in one search, whatever each chunk costs.
USER_REGEX_SCAN_CHUNKS = 20_000

logger = logging.getLogger(__name__)


class PatternTooCostly(ValueError):
    """A person's regex is too costly to finish: it ran past :data:`USER_REGEX_TIMEOUT` on one chunk
    (``scan`` False), or the scan ran past :data:`USER_REGEX_SCAN_SECONDS` or
    :data:`USER_REGEX_SCAN_CHUNKS` (``scan`` True). Either way the search did not run to its end.
    """

    def __init__(self, pattern: str, *, scan: bool = False) -> None:
        super().__init__(pattern)
        self.scan = scan


def compile_user_regex(pattern: str) -> regex.Pattern[str]:
    """A person's pattern in Python syntax, case-insensitive, with the ``regex`` module's match timeout."""
    return regex.compile(pattern, regex.IGNORECASE)


def _user_pieces(alternative: str) -> list[tuple[str, str]] | None:
    """One top-level alternative of a person's regex as ``(kind, text)`` pieces (the kinds of :func:`_pieces`).

    Conservative: anything that is not a plain literal, an escaped punctuation mark, ``\\b``, ``^``
    or ``$`` becomes a ``group`` (a character of unknown spelling, which spoils the word beside
    it), and so does any piece a quantifier follows (it may repeat or vanish). None when the
    alternative sets inline flags this reader does not model (``(?x)`` reads the text differently).
    """
    pieces: list[tuple[str, str]] = []
    index, size = 0, len(alternative)
    while index < size:
        char = alternative[index]
        end = index + 1
        kind, text = "char", char.lower()
        if char == "\\":
            end = index + 2
            escaped = alternative[index + 1 : index + 2]
            if escaped == "b":
                kind, text = "sep", ""
            elif not escaped or escaped.isalnum() or escaped == "_":
                kind, text = "group", ""
            else:
                text = escaped
        elif char == "[":
            end = _class_end(alternative, index)
            kind, text = "group", ""
        elif char == "(":
            end = _group_end(alternative, index)
            if alternative.startswith("(?i)", index):
                index = end
                continue
            if alternative.startswith("(?", index) and re.match(r"\(\?[a-zA-Z-]+[:)]", alternative[index:]):
                return None
            kind, text = "group", ""
        elif char in "^$":
            kind, text = "sep", ""
        elif char in ".)":
            kind, text = "group", ""
        elif not char.isascii() and char.isalnum():
            kind, text = "group", ""
        if end < size and alternative[end] in "*+?{":
            kind, text = "group", ""
            end = _after_quantifier(alternative, end)
        pieces.append((kind, text))
        index = end
    return pieces


def _class_end(body: str, start: int) -> int:
    """Index after the ``]`` that closes the character class opened at ``start``."""
    index = start + 1
    if body[index : index + 1] == "^":
        index += 1
    if body[index : index + 1] == "]":
        index += 1
    while index < len(body):
        if body[index] == "\\":
            index += 2
            continue
        if body[index] == "]":
            return index + 1
        index += 1
    return len(body)


def _group_end(body: str, start: int) -> int:
    """Index after the ``)`` that closes the group opened at ``start``."""
    depth, index = 0, start
    while index < len(body):
        char = body[index]
        if char == "\\":
            index += 2
            continue
        if char == "[":
            index = _class_end(body, index)
            continue
        depth += {"(": 1, ")": -1}.get(char, 0)
        index += 1
        if depth == 0:
            return index
    return len(body)


def _after_quantifier(body: str, start: int) -> int:
    """Index after the quantifier at ``start`` (``*``, ``+``, ``?`` or ``{m,n}``) and its lazy or possessive mark."""
    if body[start] == "{":
        close = body.find("}", start)
        index = close + 1 if close >= 0 else start + 1
    else:
        index = start + 1
    return index + 1 if body[index : index + 1] in ("?", "+") else index


def user_literal_tokens(pattern: str) -> list[list[str]] | None:
    """Per top-level alternative of a person's regex, the words every match holds as whole tokens; None if one has none.

    The same contract as :func:`literal_tokens` (a full-text condition over these words can only
    drop chunks the regex would drop too), read from a pattern nobody wrote for this reader.
    When in doubt there is no word: ``MA ?37/\\d{6}`` has none (``37`` may follow ``MA``
    directly), ``Brandabschnitt BA-03\\b`` has ``brandabschnitt`` and ``ba``.
    """
    alternatives: list[list[str]] = []
    for alternative in _alternatives(pattern):
        pieces = _user_pieces(alternative)
        words = _bounded_words(pieces) if pieces is not None else []
        if not words:
            return None
        alternatives.append(list(dict.fromkeys(words)))
    return alternatives


def _text_prefilter(scope: str, pattern: str, *, user_regex: bool = False) -> list[models.Filter]:
    """The server-side narrowing for :func:`find_text`, or nothing when no safe one exists."""
    tokens = user_literal_tokens(pattern) if user_regex else literal_tokens(pattern)
    if not tokens or not get_store().text_index_sound(scope):
        return []
    return [
        models.Filter(
            should=[
                models.FieldCondition(key=TEXT_FIELD, match=models.MatchText(text=" ".join(words))) for words in tokens
            ]
        )
    ]


def stem_condition(phrases: Sequence[str]) -> models.Filter:
    """Chunks holding any of ``phrases`` in some inflected form: the German-stemmed index on :data:`TEXT_STEM_FIELD`.

    A phrase of one word is a token match, of several a phrase match; both are
    analysed with the index's stemmer, so „Fluchtwegbreiten“ matches „Fluchtwegbreite“.
    """
    conditions = []
    for phrase in dict.fromkeys(" ".join(str(phrase).split()) for phrase in phrases):
        if not phrase:
            continue
        match = models.MatchPhrase(phrase=phrase) if " " in phrase else models.MatchText(text=phrase)
        conditions.append(models.FieldCondition(key=TEXT_STEM_FIELD, match=match))
    if not conditions:
        raise ValueError("A stemmed search needs at least one phrase")
    return models.Filter(should=conditions)


def _stemmed_hits(scope: str, phrases: Sequence[str], filters: dict[str, Any] | None, limit: int) -> list[Hit]:
    """Every chunk of ``scope`` the stemmed index says holds an inflected form of ``phrases``, up to ``limit``."""
    hits: list[Hit] = []
    for record in get_store().scroll(scope, filters, stem_condition(phrases)):
        payload = dict(record.payload or {})
        hits.append(Hit(str(payload.get("chunk_id") or record.id), str(payload.get("text") or ""), payload, 0.0, 1.0))
        if len(hits) >= limit:
            break
    return hits


def find_text(
    scope: str,
    pattern: str,
    filters: dict[str, Any] | None,
    limit: int,
    *,
    user_regex: bool = False,
    stem_phrases: Sequence[str] | None = None,
) -> list[Hit]:
    """Every chunk of ``scope`` whose text matches the regex ``pattern``, up to ``limit``.

    Qdrant has no regex filter. The pattern ``browse.phrase_pattern`` builds is
    written to mean the same in Rust's ``regex`` and Python's ``re`` (it was
    always re-checked in Python), so it is applied here over the chunk text,
    read by scroll. The scroll is narrowed on the server by the words every
    match must hold as tokens (:func:`literal_tokens`), and reads the whole
    scope only when the pattern names no such word. Both scrolls run in
    point-id order, so the first ``limit`` matches are the same either way.

    ``user_regex`` is a person's own pattern (``match="regex"``): compiled by
    :func:`compile_user_regex`, narrowed by :func:`user_literal_tokens`, and
    stopped with :class:`PatternTooCostly` when one chunk outruns the timeout, or the whole
    scan outruns :data:`USER_REGEX_SCAN_SECONDS` or :data:`USER_REGEX_SCAN_CHUNKS`.

    ``stem_phrases`` (``match="exact"`` with ``stemmed``) adds every chunk the
    German-stemmed index says holds an inflected form of a phrase
    (:func:`stem_condition`) ahead of the regex's matches: the stemmed result
    is the literal one and more, and a chunk written before the stemmed field
    existed is still found literally.
    """
    if stem_phrases:
        stemmed = _stemmed_hits(scope, stem_phrases, filters, limit)
        seen = {hit.chunk_id for hit in stemmed}
        literal = [
            hit for hit in find_text(scope, pattern, filters, limit, user_regex=user_regex) if hit.chunk_id not in seen
        ]
        return (stemmed + literal)[:limit]
    compiled = compile_user_regex(pattern) if user_regex else re.compile(pattern)
    hits: list[Hit] = []
    deadline = time.monotonic() + USER_REGEX_SCAN_SECONDS
    records = get_store().scroll(scope, filters, *_text_prefilter(scope, pattern, user_regex=user_regex))
    for scanned, record in enumerate(records, start=1):
        payload = dict(record.payload or {})
        text = str(payload.get("text") or "")
        found = _user_search(compiled, text, pattern, scope, deadline, scanned) if user_regex else compiled.search(text)
        if found:
            hits.append(Hit(str(payload.get("chunk_id") or record.id), text, payload, 0.0, 1.0))
            if len(hits) >= limit:
                break
    return hits


def _user_search(compiled: Any, text: str, pattern: str, scope: str, deadline: float, scanned: int) -> Any:
    """A person's regex over one chunk, inside the scan's deadline; raises :class:`PatternTooCostly` past it.

    The chunk's own limit shrinks to what is left of the scan's, so the scan as a
    whole ends near :data:`USER_REGEX_SCAN_SECONDS` however the time is spread.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0 or scanned > USER_REGEX_SCAN_CHUNKS:
        logger.warning("regex search in %s stopped after %d chunks: the scan ran out of time", scope, scanned - 1)
        raise PatternTooCostly(pattern, scan=True)
    timeout = min(USER_REGEX_TIMEOUT, remaining)
    try:
        return compiled.search(text, timeout=timeout)
    except TimeoutError:
        logger.warning("regex search in %s stopped: a chunk took longer than %.3fs", scope, timeout)
        raise PatternTooCostly(pattern, scan=timeout < USER_REGEX_TIMEOUT) from None


def candidate_counts(
    scope: str, pattern: str, filters: dict[str, Any] | None, *, user_regex: bool = False
) -> dict[str, int] | None:
    """``file_name -> chunks that hold the pattern's words``, one facet; None when the pattern names no word.

    The scroll of :func:`find_text` stops at its limit; this is what is left to say then. A chunk
    that holds the words may still not match the regex, so each count is an upper bound for that
    file, and the matches the scroll did count are the lower one.
    """
    tokens = user_literal_tokens(pattern) if user_regex else literal_tokens(pattern)
    prefilter = _text_prefilter(scope, pattern, user_regex=user_regex)
    if not tokens or not prefilter:
        return None
    return get_store().facet_counts(scope, "file_name", filters, *prefilter)


def healthy() -> bool:
    """True when Qdrant answers."""
    return get_store().health()
