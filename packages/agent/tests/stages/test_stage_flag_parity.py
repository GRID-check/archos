"""A stage's runtime switch is a WIRE CONTRACT, so both ends must agree on it.

Which post-answer stages run for an organization is decided by the BFF and read
by the backend per turn (`GET /api/internal/stages` → `resolve_enabled_stages`).
The backend declares each stage's `id` and `flag_slug`; the BFF's
`POST_ANSWER_STAGE_FLAGS` decides on exactly those two values. Nothing else
checks that they are the same two values.

Drift is silent in both directions, and both directions have already been
described in a comment asking the next person to keep the sets in step —
`feature-flags.ts` says "a stage the backend declares but this registry omits can
never be switched on". This is that comment, enforced, the same way
`test_agent_group_parity` enforces the `AgentGroup` mirror:

- a stage the backend declares and the BFF omits is never in the served set, so
  it is `disabled / flag_off` on every turn forever, with nothing logged and no
  way for an operator to switch it on;
- a slug that differs between the two ends means the WorkOS flag an operator
  turns on is not the flag that gets evaluated.

Parsed rather than exported, for the same reason as the agent-group mirror: a
generated file would be one more thing to keep in sync, and a mismatch here is a
one-line fix on whichever side is behind.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agent.stages import iter_stages

_MIRROR = Path("apps/workspace/bff/workos/feature-flags.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


def _mirrored_stages(source: str) -> dict[str, str]:
    """``{id: flag}`` from the BFF's stage-flag registry.

    ``flag`` is written as a quoted slug, which the BFF types as a registry slug
    (``KnownFeatureFlag``), so a misspelling there fails ``tsc`` and one here
    fails this test.
    """
    block = re.search(
        r"POST_ANSWER_STAGE_FLAGS:\s*readonly PostAnswerStageFlag\[\]\s*=\s*\[(.*?)\n\]", source, re.DOTALL
    )
    assert block, "the POST_ANSWER_STAGE_FLAGS registry was not found in the frontend mirror"
    entries = re.findall(r"id:\s*'([^']+)',\s*\n(?:\s*//[^\n]*\n)*\s*flag:\s*'([^']+)'", block.group(1))
    return dict(entries)


def test_every_declared_stage_can_be_switched_on(mirror_source: str):
    assert set(_mirrored_stages(mirror_source)) == {spec.id for spec in iter_stages()}


def test_each_stage_is_gated_by_the_slug_it_declares(mirror_source: str):
    mirrored = _mirrored_stages(mirror_source)
    assert {spec.id: spec.flag_slug for spec in iter_stages()} == mirrored


def test_the_mirror_actually_parses(mirror_source: str):
    """Guards the guard: a regex that stopped matching would compare two empty
    collections and pass over nothing at all."""
    mirrored = _mirrored_stages(mirror_source)
    assert len(mirrored) >= 2
    assert all(mirrored.values())
