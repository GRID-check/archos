"""Text helpers the listing, the search and the match rendering share: the case and umlaut fold, and the
shortening of a long label.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def _words(text: str) -> list[str]:
    return [word for word in re.split(r"[^0-9a-z]+", fold(text)) if word]


def fold(text: str) -> str:
    """Lowercase, NFC, umlauts transliterated: how two spellings of a name compare."""
    return unicodedata.normalize("NFC", text or "").lower().translate(_FOLD)


def _shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _pages_label(pages: Sequence[int], limit: int = 12) -> str:
    if not pages:
        return ""
    shown = ", ".join(str(page) for page in pages[:limit])
    more = f" … (+{len(pages) - limit})" if len(pages) > limit else ""
    return f", p. {shown}{more}"
