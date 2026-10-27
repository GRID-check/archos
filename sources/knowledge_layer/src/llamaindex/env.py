"""Environment knobs for the knowledge layer, read so that a typo degrades to the default.

A module-scope ``float(os.environ[...])`` makes a misspelt variable raise at import
time and takes the whole knowledge layer with it. Every knob in ``llamaindex`` is
read through these three instead.
"""

import logging
import math
import os

logger = logging.getLogger(__name__)


#: Sentinel for "strictly positive", which is not expressible as a `minimum`
#: float: 0 must be rejectable for a timeout and accepted for a count.
_POSITIVE = float("-inf")


def env_float(name: str, fallback: float, *, minimum: float = _POSITIVE) -> float:
    """Read a finite float from the environment, failing open to ``fallback``.

    A module-scope ``float(os.environ[...])`` makes a typo'd env var raise at IMPORT
    time, taking down the whole knowledge layer. A misconfiguration must degrade to
    the default, not to an unimportable module.

    ``minimum`` defaults to "strictly positive", which is right for a timeout or a
    batch size but WRONG for a count whose zero means "off": rejecting
    ``GRID_MAX_RENDERED_PAGES=0`` silently restored the default of 20 and the
    deployment paid VLM cost it had explicitly opted out of. Pass ``minimum=0``
    for those.
    """
    raw = os.environ.get(name, "")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        if raw:
            logger.warning("%s=%r is not a number; using %s", name, raw, fallback)
        return fallback
    if not math.isfinite(value):
        logger.warning("%s=%r must be finite; using %s", name, raw, fallback)
        return fallback
    if minimum is _POSITIVE:
        if value <= 0:
            logger.warning("%s=%r must be positive and finite; using %s", name, raw, fallback)
            return fallback
    elif value < minimum:
        logger.warning("%s=%r must be >= %s; using %s", name, raw, minimum, fallback)
        return fallback
    return value


def env_int(name: str, fallback: int, *, minimum: float = _POSITIVE) -> int:
    """Integer half of :func:`env_float`: garbage degrades to ``fallback``.

    Truncates (never rounds up) so a fractional value cannot exceed the stated
    budget. Clamping stays at the call site, where the existing ``max(1, ...)``
    guards already live.
    """
    return int(env_float(name, float(fallback), minimum=minimum))


#: The values that switch an extraction capability off. Nothing else does.
_OFF_VALUES = frozenset({"false", "0", "no", "off"})


def env_switch(name: str) -> bool:
    """An extraction capability that is ON unless the environment switches it off.

    Every capability defaults on in code, so a deployment that forgets a flag
    gets the full index rather than a silently degraded one. Only an explicit
    ``false``/``0``/``no``/``off`` turns it off; unset, empty or anything else
    leaves it on.
    """
    return os.environ.get(name, "").strip().lower() not in _OFF_VALUES
