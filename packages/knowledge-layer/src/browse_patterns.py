"""The phrase patterns the exact search finds a phrase with: umlaut and case spellings, inflection stems, the
separators a line break or hyphen counts as, and the anchor rules for a pattern.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from typing import Any

import regex

from .browse_matches import MAX_MATCH_CHUNKS

#: A single character matches noise. Two and three characters („EG“, „T30“)
#: are real search terms and match as whole words (:data:`WHOLE_WORD_MAX_CHARS`).
MIN_PHRASE_CHARS = 2

#: A person's regex is a pattern, not a document: longer than this is refused.
MAX_USER_PATTERN_CHARS = 300

#: Alternatives in one exact search. „BA-03 | BA 03 | Brandabschnitt 3“
#: is one question asked three ways; ten is a runaway.
MAX_ALTERNATIVES = 6

#: What stands between two words in extracted text: whitespace (a line break,
#: a double space, NBSP — ``\s`` is Unicode-aware in Python's ``re`` and in
#: Rust's ``regex`` alike), a hyphen, a non-breaking hyphen, an en dash, a soft
#: hyphen. A run of any of them in the phrase matches a run of any of them in
#: the text, so „OIB Richtlinie“ finds „OIB-Richtlinie“ and „Brandabschnitt 3“
#: finds „Brandabschnitt⏎3“. The ``-`` stands last so neither dialect reads a range.
_SEPARATOR_CHARS = "\u00ad\u2010\u2011\u2013-"

_SEPARATOR = f"[\\s{_SEPARATOR_CHARS}]+"

#: One German letter and its ASCII transliteration are one letter to a reader.
#: Either spelling in the phrase matches both in the text (and a decomposed
#: umlaut, ``a`` + U+0308, which some PDF text layers carry). Case is the
#: pattern's ``(?i)``, so „AE“ and „Ä“ are covered by the same group.
_EQUIVALENT = {
    "ä": "(?:ä|a\u0308|ae)",
    "ö": "(?:ö|o\u0308|oe)",
    "ü": "(?:ü|u\u0308|ue)",
    "ß": "(?:ß|ss)",
}

#: A phrase is read left to right as separator runs, transliteration digraphs
#: and single characters; ``ae`` wins over ``a`` + ``e``.
_TOKEN = re.compile(f"[\\s{_SEPARATOR_CHARS}]+|ae|oe|ue|ss|.", re.DOTALL)

#: A phrase this short matches as a whole word only: „EG“ is inside „Weg“,
#: „Steg“ and „Regel“, and a count of those is not an answer to „wo steht EG“.
#: Four characters („BA03“, „T30-2“) are specific enough to match inside a word.
#: The boundary goes only on an edge that is a word character, so „§ 5“ still
#: matches after a space. ``\b`` is Unicode-aware in both dialects.
WHOLE_WORD_MAX_CHARS = 3

#: A bound on the pattern the store compiles. A phrase expands about fourfold
#: (every umlaut and separator becomes a group), so this admits six
#: alternatives of well over a hundred characters: a sentence, not a phrase.
MAX_PATTERN_CHARS = 4000


def _phrase_pattern(phrase: str) -> str:
    """One phrase as a regex body: separators, umlaut spellings, whole word when short."""
    text = unicodedata.normalize("NFC", phrase).lower()
    body = "".join(
        _SEPARATOR if token[0].isspace() or token[0] in _SEPARATOR_CHARS else _EQUIVALENT.get(token, re.escape(token))
        for token in _TOKEN.findall(text)
    )
    if len(text) > WHOLE_WORD_MAX_CHARS:
        return body
    start = "\\b" if re.match(r"\w", text[0]) else ""
    end = "\\b" if re.match(r"\w", text[-1]) else ""
    return f"{start}{body}{end}"


#: German inflectional endings :func:`inflection_stem` strips, longest first.
_INFLECTION_ENDINGS = ("ern", "nen", "en", "er", "es", "em", "e", "n", "s")

#: Words shorter than this keep their form: a code, an abbreviation, a short word is matched as written.
_INFLECTED_MIN_CHARS = 5

#: What a stripped word must keep.
_STEM_MIN_CHARS = 4


def inflection_stem(phrase: str) -> str:
    """``phrase`` with each long word's inflectional ending removed: the stem the count and the context lines look for.

    A Python approximation of the stemmed index's Snowball German, for counting
    and showing the matches that index found („Fluchtwegbreiten“ → „Fluchtwegbreit“,
    which the substring pattern then finds in „Fluchtwegbreite“ and „Fluchtwegbreiten“).
    Which chunks match is decided by the index, never by this.
    """
    words = []
    for word in phrase.split():
        stem = word
        if len(word) >= _INFLECTED_MIN_CHARS and word.isalpha():
            for ending in _INFLECTION_ENDINGS:
                if word.lower().endswith(ending) and len(word) - len(ending) >= _STEM_MIN_CHARS:
                    stem = word[: -len(ending)]
                    break
        words.append(stem)
    return " ".join(words)


def stemmed_pattern(phrases: Sequence[str]) -> str | None:
    """The counting pattern of a stemmed search: each phrase and its stem (the phrases alone when too long)."""
    stems = [inflection_stem(phrase) for phrase in phrases]
    return phrase_pattern([*phrases, *stems]) or phrase_pattern(phrases)


def phrase_pattern(phrases: Sequence[str]) -> str | None:
    """The ONE case-insensitive regex that finds any of ``phrases``, or None when it is too long.

    It is written to mean the same in Rust's ``regex`` and Python's ``re``
    (``qdrant.retrieval.find_text`` narrows by its literal words on the server
    and applies it in Python), so it keeps to what both dialects read alike:
    ``(?i)`` at the start, non-capturing groups, classes, ``\\s``, ``\\b``,
    escaped literals; no lookaround, no backreference. Longest phrase
    first, so at one position „Brandschutzplan“ is taken before „Brandschutz“
    and a match is counted once however many alternatives it satisfies.
    """
    ordered = sorted(dict.fromkeys(phrases), key=len, reverse=True)
    pattern = "(?i)" + "|".join(_phrase_pattern(phrase) for phrase in ordered)
    return pattern if len(pattern) <= MAX_PATTERN_CHARS and ordered else None


def split_alternatives(text: str) -> list[str]:
    """``"BA-03 | BA 03"`` → ``["BA-03", "BA 03"]``; empty, too-short and letterless parts dropped.

    A part without a letter or digit („--“) would match every separator run.
    """
    parts = [" ".join(part.split()) for part in unicodedata.normalize("NFC", text or "").split("|")]
    kept = [part for part in dict.fromkeys(parts) if len(part) >= MIN_PHRASE_CHARS and re.search(r"\w", part)]
    return kept[:MAX_ALTERNATIVES]


def user_pattern(text: str) -> tuple[Any | None, str]:
    """A person's regex, compiled; ``(None, refusal)`` when it cannot run, with the line that teaches the fix.

    Python syntax, case-insensitive. Refused: longer than :data:`MAX_USER_PATTERN_CHARS`, not a valid
    pattern, and a pattern that matches the empty string (it would match every passage). Catastrophic
    backtracking is stopped at match time, by the timeout the store scan runs under.
    """
    from .qdrant.retrieval import compile_user_regex

    pattern = text.strip()
    if len(pattern) < MIN_PHRASE_CHARS:
        return None, f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the regex to find."
    if len(pattern) > MAX_USER_PATTERN_CHARS:
        return None, (
            f"`query` is too long for a regex ({len(pattern)} characters, at most {MAX_USER_PATTERN_CHARS}). "
            "Shorten it to the part that identifies the passage."
        )
    try:
        compiled = compile_user_regex(pattern)
    except (regex.error, RecursionError, OverflowError) as error:
        return None, (
            f"`query` is not a valid regex (Python syntax): {error}. Escape a literal ( ) [ ] {{ }} . * + ? | \\ "
            "with a backslash, or search literally for a literal word."
        )
    if compiled.search(""):
        return None, (
            "`query` matches the empty string, so it would match every passage. Add the text that must be there."
        )
    return compiled, ""


#: What a regex with no literal word and no narrowing is told: it would read every passage of every file.
_NEEDS_A_ANCHOR = (
    "A regex needs something to narrow the search with: one literal whole word or number it must contain, or a "
    "`folder=`, `file_name=` or `doc_class=` to read in. This pattern has no such word: a word followed by `?`, "
    "`*`, `\\w` or a class does not count, and neither does a character class or a digit run alone. Rewrite it "
    "so one word is written out in full (`MA ?37/\\d{6}` becomes `MA 37/\\d{6}`; `T\\d+` becomes `\\bT30-\\d+`), "
    'keep that word and give `folder=`, or use `match="exact"` for a literal.'
)

#: What a regex that outran its time limit is told.
_TOO_COSTLY = (
    "`query` is too costly: the regex backtracks on a passage of the files (nested repetition such as `(a+)+`, or "
    "overlapping alternatives under a `*`), and the search was stopped. This is NOT a result, neither a hit nor "
    'a no. Rewrite it without nested repetition, or use `match="exact"` for a literal word.'
)

#: What a regex whose whole scan outran its deadline is told: too costly, and not a result.
_TOO_COSTLY_SCAN = (
    "`query` is too costly: reading this regex over every passage that holds its words takes longer than one "
    "search may, and the search was stopped. This is NOT a result, neither a hit nor a no. Narrow it with "
    '`folder=`, `file_name=` or `doc_class=`, add a rarer literal word, or use `match="exact"` for a literal word.'
)

#: A capped scan whose passages all held the match only in a heading breadcrumb or an overlap.
_CAPPED_WITHOUT_OWN_MATCH = (
    f"The search stopped after {MAX_MATCH_CHUNKS} matching passages, and in those the words stood only in "
    "headings restated from elsewhere or in text repeated from the passage before. What lies past that limit was "
    "not read: this is NOT a no. Narrow it with `folder=`, `file_name=` or `doc_class=`."
)
