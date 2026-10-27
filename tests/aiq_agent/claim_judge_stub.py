"""A deterministic stand-in for the claim judge (``common/claim_judge.py``) in unit tests.

The real judge is a model; what a test checks is the plumbing around it: what
evidence reaches it, and what the level does with its answer. The stub says
``supported`` for every sentence with evidence and ``not_addressed`` without,
and reads the kind off a few words. A test that probes a judgement passes it
explicitly (``overrides``: a substring of the sentence and the judgement).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from collections.abc import Sequence

from aiq_agent.common.claim_judge import JudgeFn
from aiq_agent.common.claim_judge import Judgement

_VERDICT_RE = re.compile(
    r"\b(?:muss|müssen|darf|dürfen|zulässig|unzulässig|erfüllt|erforderlich|eingehalten|einschlägig|nötig|"
    r"gefordert|bewilligungsfähig|bewilligt werden|gilt\s+§|vorzulegen)\b",
    re.IGNORECASE,
)
_NEXT_STEP_RE = re.compile(r"^\s*(?:ob\b|welche|als nächstes|ich kann|nicht gelesen|nicht geprüft|bitte)", re.I)


def stub_judge(overrides: Mapping[str, Judgement] | None = None, *, calls: list | None = None) -> JudgeFn:
    """A judge that answers without a model; ``calls`` collects each batch it was asked."""

    async def judge(items: Sequence[tuple[str, str]]) -> list[Judgement]:
        if calls is not None:
            calls.append(list(items))
        found = []
        for sentence, evidence in items:
            override = next((j for key, j in (overrides or {}).items() if key in sentence), None)
            if override is not None:
                found.append(override)
                continue
            kind = (
                "next_step" if _NEXT_STEP_RE.search(sentence) else "verdict" if _VERDICT_RE.search(sentence) else "fact"
            )
            found.append(Judgement("supported" if evidence.strip() else "not_addressed", kind))
        return found

    return judge


async def failing_judge(items: Sequence[tuple[str, str]]) -> None:
    """A judge that could not run (a timeout, a refusal): every evidenced claim is ``unavailable``."""
    return None
