"""Text helpers for the briefing: metres, plurals, shortening and wrapping, and the coverage line."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ifc_spatial.briefing_constants import WRAP_WIDTH
from ifc_spatial.briefing_records import Coverage


def _coverage_line(coverage: Coverage) -> str:
    """Render one ``n of m`` fact.

    The three branches are the whole point. An empty population, an unresolved
    population and a partly resolved one are three different findings, and only
    the third is about the building.
    """
    if coverage.of == 0:
        return f"{coverage.what}: dieser Export enthält keine solchen Elemente"
    if coverage.n == 0:
        return (
            f"{coverage.what}: 0 von {coverage.of} — dieser Export schreibt kein {coverage.relation} "
            "(Aussage über den Export, nicht über das Gebäude)"
        )
    percent = round(coverage.n / coverage.of * 100)
    rest = f", {coverage.of - coverage.n} ohne" if coverage.n < coverage.of else ""
    return f"{coverage.what}: {coverage.n} von {coverage.of} ({percent} %{rest}, {coverage.relation})"


def _metres(value: float) -> str:
    """``+2.85`` / ``±0.00`` / ``−2.60``, matching the layout in §8.1.

    ``±0.00`` rather than ``+0.00`` because a storey at datum is the reference
    every other elevation is read against, and the plan convention says so.
    """
    if abs(value) < 0.005:
        return "±0.00"
    return f"{'+' if value > 0 else '−'}{abs(value):.2f}"


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def _shorten(value: Any) -> str:
    text = str(value)
    return f"{text[:17]}…" if len(text) > 18 else text


def _wrap(cells: Sequence[str], separator: str, tail: str | None) -> list[str]:
    lines: list[str] = []
    current = ""
    for cell in cells:
        candidate = cell if not current else f"{current}{separator}{cell}"
        if len(candidate) > WRAP_WIDTH and current:
            lines.append(current)
            current = cell
        else:
            current = candidate
    if current:
        lines.append(current)
    if tail:
        lines.append(tail)
    return lines
