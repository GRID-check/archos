"""The base every card model shares, and why every text field on a card is plain text.

No card renderer parses markup. The frontend sets each string into JSX, where
React escapes it, so a field holding ``[text](url)`` puts those brackets on
screen. :class:`CardModel` removes the delimiters at validation time, on every
emission path, so a card cannot display raw markup. The enforcement does NOT
live in the renderer: a card is the part that gets screenshotted into an
Einreichung, and a renderer that parsed markdown in a field nobody declared as
markdown would hand the model a way to put an arbitrary link into a legal
citation."""

import re
from typing import Any

from pydantic import BaseModel
from pydantic import field_validator

# The three inline constructs that are UNAMBIGUOUSLY markup: a link or image
# target, a doubled emphasis delimiter, and a code span. Each is meaningless as
# literal text in an Austrian legal citation, and each is something an LLM writes
# into a JSON string without noticing that the string is not prose.
#
# What is deliberately NOT here is the ambiguous half of markdown. Single `*`
# and `_` emphasis, a leading `- ` or `#`, and `<https://…>` autolinks all occur
# for their own reasons in the text these fields carry — footnote markers in an
# OIB table, a dash inside „§ 3 - Abs. 1“, a heading character in a Bescheid
# reference. `original_text` is documented as a LITERAL excerpt from the source,
# and mangling a verbatim legal quotation is a worse defect than an asterisk.
# Doubled delimiters have no such second reading, which is why the line is drawn
# there rather than at "everything CommonMark would call emphasis".
_MD_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*<?([^)\s]*)>?(?:\s+\"[^\"\n]*\")?\s*\)")


_MD_STRONG = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.DOTALL)


_MD_CODE = re.compile(r"`+([^`\n]+)`+")


def _unwrap_link(match: re.Match[str]) -> str:
    """Render a markdown link as the text a reader would have seen, plus its target.

    The URL is KEPT, as literal text. Dropping it would be the one thing a
    sanitiser of a legal citation must not do — silently delete part of what the
    citation asserted — and keeping it as text is not a link: nothing downstream
    turns a bare URL in a card field into an anchor. So the reader loses the
    brackets and nothing else.
    """
    label = match.group(1).strip()
    target = match.group(2).strip()
    if not target or target == label:
        return label
    if not label:
        return target
    return f"{label} ({target})"


def flatten_card_markup(value: str) -> str:
    """Strip inline markdown delimiters from one card text value.

    Idempotent, and a no-op on text that carries no markup — which is almost all
    of it, so the common case costs three failed regex scans.
    """
    flattened = _MD_LINK.sub(_unwrap_link, value)
    flattened = _MD_STRONG.sub(lambda m: m.group(2), flattened)
    return _MD_CODE.sub(lambda m: m.group(1), flattened)


def _flatten_markup_deep(value: Any) -> Any:
    """Apply :func:`flatten_card_markup` to a string, or to the strings in a list.

    Recurses through lists because ``TypedTableCard.rows`` is ``list[list[str]]``
    — a table cell is as much on-screen text as a title is. Nested card models
    are left alone here: they are :class:`CardModel` subclasses and have already
    flattened their own fields by the time the parent validates. Anything else
    (numbers, enums, dicts) passes through untouched.
    """
    if isinstance(value, str):
        return flatten_card_markup(value)
    if isinstance(value, list):
        return [_flatten_markup_deep(item) for item in value]
    return value


class CardModel(BaseModel):
    """Base for every card and every building block inside one.

    Carries the plain-text guarantee described in the module docstring, in the
    one place that covers all of it: a wildcard field validator, inherited by
    every subclass, so a card type added next sprint is covered by BEING a card
    rather than by someone remembering to annotate its fields. There are 177
    free-text fields across 71 models here; an ``Annotated[str, …]`` per field
    would be 177 chances to forget one.

    It runs on EVERY emission path, because all of them go through
    ``grid_card_adapter`` or :func:`validate_cards` — the ``emit_card`` tool, the
    post-hoc batch generator, Piloti's DSML path, project memory
    and surfaced documents. Identifier-shaped fields (IFC GlobalIds, model file
    names, JSON-pointer paths) inherit it too and are unaffected: none of the
    three constructs can occur in one.
    """

    @field_validator("*", mode="after")
    @classmethod
    def _flatten_text_markup(cls, value: Any) -> Any:
        return _flatten_markup_deep(value)
