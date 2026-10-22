"""Polarity agreement: a quote that changes what the passage negates or restricts is not verbatim.

The quote matcher (``citation_verification._quote_coverage``) already refuses a
quote that skips or inserts a whole word. What it cannot see is an edit INSIDE
a word, because it is calibrated to forgive sub-word noise (a hyphen, a swapped
letter, an inflection): „keine Genehmigung" quoted as „eine Genehmigung"
differs by one letter, „unzulässig" quoted as „zulässig" by two. Both turn a
prohibition into a permission and both scored as verbatim (T2-CIT1, the open
half). No length budget can tell them from OCR noise; a word list can, because
the words that flip or narrow a legal sentence are few and closed:

    nicht, nichts, kein…, nie, niemals, weder, ohne, nur, außer/ausser
    not, no, never, without, only, except
    un- as a prefix of a longer word (unzulässig, unbrennbar)

The rule is symmetric and structural: the quote and the stretch of the passage
it aligns to must carry the same multiset of these tokens. Eliding one,
inserting one, or swapping „kein" for „ein" disqualifies the quote; which word
moved is not judged.

Pure.
"""

from __future__ import annotations

import re
from collections import Counter

#: Whole words that negate, exclude or restrict.
_POLARITY_WORDS = frozenset(
    {
        "nicht",
        "nichts",
        "kein",
        "keine",
        "keinen",
        "keinem",
        "keiner",
        "keines",
        "nie",
        "niemals",
        "weder",
        "ohne",
        "nur",
        "außer",
        "ausser",
        "not",
        "no",
        "never",
        "without",
        "only",
        "except",
    }
)

#: Words that start with „un" and are not a negation of something.
_UN_WORDS = ("und", "uns", "unser", "unter", "ungefähr", "ungefaehr")

_WORD_RE = re.compile(r"[^\W\d_]+")

#: A negating prefix only counts on a word long enough to be a negated stem.
_MIN_PREFIXED_LENGTH = 6


def polarity_tokens(text: str) -> Counter[str]:
    """The negating and restricting tokens of ``text`` (already casefolded or not), counted."""
    tokens: Counter[str] = Counter()
    for word in _WORD_RE.findall(text.casefold()):
        if word in _POLARITY_WORDS:
            tokens[word] += 1
        elif word.startswith("un") and len(word) >= _MIN_PREFIXED_LENGTH and not word.startswith(_UN_WORDS):
            tokens["un-"] += 1
    return tokens


def polarity_agrees(quote: str, passage_stretch: str) -> bool:
    """Whether ``quote`` negates and restricts exactly what ``passage_stretch`` does."""
    return polarity_tokens(quote) == polarity_tokens(passage_stretch)
