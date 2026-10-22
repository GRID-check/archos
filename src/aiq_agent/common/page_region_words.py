"""A region of a page in the words a person uses: „oben links“, „25 %“.

The frame is ``look``'s, the canvas's and an Anmerkung's: ``x``, ``y``, ``w``,
``h`` as shares of the page as shown, origin top left. German, because the
words are domain text the reader sees (the Herleitung step a look leaves);
``where_on_the_page_en`` is the same place for text the model reads. Pure.
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


def where_on_the_page_en(region: Any) -> str:
    """The box's place in English words, by its centre, for text the model reads: "top left", "page centre"."""
    cx, cy = region.x + region.w / 2, region.y + region.h / 2
    row = "top" if cy < 1 / 3 else ("bottom" if cy > 2 / 3 else "")
    column = "left" if cx < 1 / 3 else ("right" if cx > 2 / 3 else "")
    if row and column:
        return f"{row} {column}"
    if row:
        return f"{row} centre"
    return f"centre {column}" if column else "page centre"


def percent(share: float) -> str:
    """A share of the page as a whole percent, never below 1 %."""
    return f"{max(1, round(share * 100))} %"
