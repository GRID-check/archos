"""What this process is, in one line, at startup — the Python half.

The BFF twin is ``frontends/ui/src/lib/boot.ts``; read its header for why this
exists at all. In short: a pilot reported that a feature did not work, and
nobody could say which build they were running or whether that feature was
switched on for them, so "broken" and "never enabled" looked identical from
outside.

The line's SHAPE is deliberately identical on both services::

    [boot] sha=<sha> flags=<workos|defaults>

so one ``grep '^\\[boot\\]'`` over a pod log answers the question for the whole
deployment, and the two tiers' answers can be compared without re-reading two
formats. ``tests/test_startup_banner.py`` pins the format against the same
table the TypeScript spec uses.

``flags`` says where feature-flag answers come from, not what any one flag
says: every feature is a WorkOS flag per organization, decided by the BFF, so
there is no process-wide value to print. ``workos`` wherever people sign in
(``REQUIRE_AUTH=true``); ``defaults`` in a deployment that authenticates nobody,
where the BFF turns every rollout on and every entitlement off
(``frontends/ui/src/lib/authz/feature-flags.ts``).

**The value is what THIS process can see, and that is the point.** A boot log
that showed another container's environment would be inventing it; which
service a value came from is the first thing a flag investigation needs, so
each service reports its own.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

#: What the line says when nothing stamped a commit into the image.
UNKNOWN_SHA = "unknown"


def deployed_sha(env: dict[str, str] | None = None) -> str:
    """The commit this image was built from, or ``unknown``.

    ``GRID_GIT_SHA`` is stamped as a build arg and re-exported as an env var by
    ``deploy/Dockerfile``. There is no ``.git`` in the image, so this is the
    only place the answer can come from.
    """
    source = os.environ if env is None else env
    return (source.get("GRID_GIT_SHA") or "").strip() or UNKNOWN_SHA


def flag_source(env: dict[str, str] | None = None) -> str:
    """``workos`` where people sign in, else ``defaults``.

    The BFF's rule exactly (``isAuthRequired``): case-insensitive and NOT
    trimmed, so the line cannot claim WorkOS for a value the gate reads as
    anonymous.
    """
    source = os.environ if env is None else env
    return "workos" if (source.get("REQUIRE_AUTH") or "").lower() == "true" else "defaults"


def format_boot_line(sha: str, flags: str) -> str:
    """The boot line itself — one line, fixed key order, greppable."""
    return f"[boot] sha={sha} flags={flags}"


def boot_line(env: dict[str, str] | None = None) -> str:
    """:func:`format_boot_line` for this process's environment."""
    return format_boot_line(deployed_sha(env), flag_source(env))


def log_boot_line() -> str:
    """Emit the boot line and return it (so a caller can assert on it)."""
    line = boot_line()
    logger.info("%s", line)
    return line
