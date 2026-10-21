"""A region of a page in the words a person uses: „oben links“, „25 %“.

The frame is ``look``'s, the canvas's and an Anmerkung's: ``x``, ``y``, ``w``,
``h`` as shares of the page as shown, origin top left. German, because the
words are domain text the reader sees (the Fokusbereich block, and the
Herleitung step a look leaves). Pure.
"""

from __future__ import annotations

from typing import Any


def where_on_the_page(region: Any) -> str:
    """The box's place in words, by its centre: „oben links“, „in der Seitenmitte“, „unten rechts“."""
    cx, cy = region.x + region.w / 2, region.y + region.h / 2
    row = "oben" if cy < 1 / 3 else ("unten" if cy > 2 / 3 else "")
    column = "links" if cx < 1 / 3 else ("rechts" if cx > 2 / 3 else "")
    if row and column:
        return f"{row} {column}"
    if row:
        return f"{row} in der Mitte"
    return f"in der Mitte {column}" if column else "in der Seitenmitte"


def percent(share: float) -> str:
    """A share of the page as a whole percent, never below 1 %."""
    return f"{max(1, round(share * 100))} %"
