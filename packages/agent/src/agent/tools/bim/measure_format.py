"""Number and tolerance formatting for measured values, with the verb each figure keeps."""

import math
from typing import Any

# ── rendering ────────────────────────────────────────────────────────────────


def _decimals(tolerance: Any) -> int | None:
    """How many decimals a value carrying this tolerance may be shown to.

    One decade finer than the band and no more, so nothing the operator resolved
    is thrown away and nothing it did not is invented.

    This used to `ceil` the logarithm, which rounds a tolerance UP to the next
    decade before counting: ±0.005 m earned four decimals (0.1 mm — fifty times
    finer than the band) and ±3° earned one (0.1° — thirty times). Only exact
    powers of ten came out right, which is why it looked correct on ±0.01.

    `floor` makes the tolerance's own leading digit set the scale, so the shown
    resolution is always between one and ten times finer than the band: ±0.005 m
    earns three decimals (0.647 m), ±3° earns none (0°), ±0.15 m² earns one
    (15.4 m²). That last one is the change most likely to look like a
    regression and is the clearest case of the fix — a 15-centimetre band does
    not support a centimetre digit, and printing 15.42 claimed it did.
    """
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
        return None
    # NaN and inf reach here from a division in an operator, and `math.log10`
    # would raise on one and overflow the decimal count on the other.
    if not math.isfinite(tolerance) or tolerance <= 0:
        return None
    return min(6, max(0, math.floor(-math.log10(tolerance)) + 1))


def _num(value: Any, decimals: int | None = None) -> str:
    """A number as the engine produced it, to the precision it actually has.

    The rule used to be "never round", on the reasoning that a renderer which
    reshapes a value breaks the tool's only claim. That reasoning was right and
    the conclusion was wrong, and the battery showed why: `floorArea` rendered
    as „gemessen (±0.15416781250000042 m²): 15.41678125000004 m²“.

    Seventeen digits against a 15-centimetre band is not fidelity, it is a
    binary-float artifact wearing the costume of a measurement. It is LESS
    faithful than 15.42, because it asserts precision the operator explicitly
    disclaims — and the model reading it will quote the digits, because we told
    it that numbers come from the tool and are never to be re-rounded.

    So the value is shown to its tolerance and to nothing else. Where there is
    no tolerance — a `declared` figure, a confidence — the value is the file's
    own statement and is passed through untouched, which is the case the old
    rule was really protecting.
    """
    if isinstance(value, bool) or value is None:
        return str(value)
    if isinstance(value, float):
        if decimals is not None:
            return f"{value:.{decimals}f}"
        return repr(value)
    return str(value)


def _tolerance_text(tolerance: Any) -> str:
    """The band itself, at two significant figures.

    Its OWN rule, not the value's. Sharing `_decimals` meant the band was
    rounded to the precision it had just authorised for the value, so a
    tolerance of 0.154 m² printed as „±0.2 m²" — rounded UP by a third, and in
    the direction that overstates our own uncertainty. Two significant figures
    is what an error estimate can carry, and trailing zeros are stripped so
    ±0.005 stays ±0.005 rather than becoming ±0.0050.
    """
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
        return _num(tolerance)
    value = float(tolerance)
    if not math.isfinite(value) or value <= 0:
        return _num(tolerance)
    # Two significant figures: one decade past the leading digit.
    decimals = min(6, max(0, math.floor(-math.log10(value)) + 2))
    text = f"{value:.{decimals}f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _angle(value: Any) -> str:
    """An angle the CALLER supplied, echoed back as they wrote it.

    45.0° is not a measurement with a hundredth of a degree behind it; it is the
    number the clause states, round-tripped through a float. Printing it as „45"
    keeps the parameter distinguishable from everything else on the line, which
    is measured.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return str(value)
    return str(int(value)) if float(value).is_integer() else _num(float(value), 1)


#: Keys whose value is DIMENSIONLESS and must not inherit the answer's band.
#:
#: `_decimals` derives its precision from the answer's tolerance, which carries
#: the answer's UNIT. Applied to a ratio that is a different quantity entirely,
#: it destroys the number: `envelope/areaByOrientation` has a tolerance of
#: ±2.3 m², which earns zero decimals, and the window-to-wall ratios then
#: rendered `windowWallRatio=0` for north (0.193), south (0.405) and the
#: building as a whole (0.177). The WWR is the entire point of that operator,
#: and a facade reported at 0 reads as one with no glazing in it — a claim about
#: the building, made by a rounding rule, and false.
#:
#: Two decimals rather than the band's, because these are ratios in 0…1 and
#: their own resolution has nothing to do with how well an area was measured.
#:
#: Bare `ratio` is deliberately NOT in this set, and the exclusion is the whole
#: reason the set is a set rather than a regex on the name. Two operators return
#: a key called `ratio` and only one of them is unitless:
#: `lightEntryArea.ratio` is a fraction, but `compactness.ratio` is A/V in
#: **1/m** — the answer's own main value, whose ±0.021 1/m band is exactly the
#: right precision for it. Overriding that one would be this same bug pointed
#: the other way. `lightEntryArea` loses nothing by the omission: its headline
#: line already states the share as „**14.21 %**" at full precision.

_UNITLESS_KEYS = frozenset({"windowWallRatio", "percent", "confidence"})


def _value_text(value: Any, decimals: int | None = None) -> str:
    """The answer's value as one readable line."""
    if value is None:
        return "—"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _num(value, decimals)
    if isinstance(value, dict):
        # `extent`, `elevation`, `sillAndHead` — a handful of named numbers.
        # Nested one level (extent's `box`), the flat join produced
        # "box=min=[…], max=[…]", which reads as one key with two values.
        parts = []
        for key, inner in value.items():
            text = _value_text(inner, 2 if key in _UNITLESS_KEYS else decimals)
            parts.append(f"{key}=({text})" if isinstance(inner, dict) else f"{key}={text}")
        return ", ".join(parts)
    if isinstance(value, list):
        # A coordinate is a list of three numbers, and counting it — "centroid=3
        # entries" — throws away the only part anybody wanted.
        if value and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
            return "[" + ", ".join(_num(item, decimals) for item in value) + "]"
        # A renderer that substitutes into one template produces "1 entries".
        return "1 entry" if len(value) == 1 else f"{len(value)} entries"
    return str(value)
