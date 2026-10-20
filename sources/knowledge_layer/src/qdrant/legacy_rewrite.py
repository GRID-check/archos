"""What the operator rewrite of payload keys changes on one point (``schema.LEGACY_FIELDS``).

Points written before the English rename hold ``punkt_id``, ``richtlinie``, ``chunking: "punkt"`` and a
``project_facts`` object with German keys and tokens. :func:`rewrite_payload` says what to write and
what to delete so the point reads exactly as a freshly ingested one. It is pure; the batching, the
dry run and the verification live in ``scripts/qdrant_rename_payload_keys.py``, and the procedure is
``docs/deployment/qdrant-payload-rename-runbook.md``.

Delete this module, the script and the runbook section with the read fallback once the rewrite has run on
every collection.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from aiq_agent.profile_names import normalize_profile_token

from .schema import FACT_KEYS
from .schema import LEGACY_CHUNKING
from .schema import LEGACY_FIELDS
from .schema import PROJECT_FACTS_FIELD

_FACTS_PREFIX = f"{PROJECT_FACTS_FIELD}."


@dataclass(frozen=True)
class PayloadRewrite:
    """Fields to set on a point, then top-level keys to delete from it (in that order, so a crash keeps both)."""

    set: dict[str, Any]
    delete: tuple[str, ...]

    @property
    def fields(self) -> tuple[str, ...]:
        """The names this rewrite touches, for a dry run's tally."""
        return (*self.set, *self.delete)


def _english_token(key: str, value: Any) -> Any:
    if isinstance(value, str):
        return normalize_profile_token(key, value)
    if isinstance(value, list):
        return [_english_token(key, item) for item in value]
    return value


def _facts(facts: Mapping[str, Any]) -> dict[str, Any] | None:
    """The ``project_facts`` object under its English keys and tokens; None when it already is."""
    legacy_leaves = {
        new: old.removeprefix(_FACTS_PREFIX) for new, old in LEGACY_FIELDS.items() if old.startswith(_FACTS_PREFIX)
    }
    if not any(old in facts for old in legacy_leaves.values()):
        return None
    rebuilt: dict[str, Any] = {}
    for key in FACT_KEYS:
        old = legacy_leaves[f"{_FACTS_PREFIX}{key}"]
        if key in facts:
            rebuilt[key] = facts[key]
        elif old in facts:
            rebuilt[key] = _english_token(key, facts[old])
    return rebuilt


def rewrite_payload(payload: Mapping[str, Any]) -> PayloadRewrite | None:
    """The rewrite that brings ``payload`` to the English spelling, or None when it already is.

    The English key wins over a legacy one on the same point (a re-ingest wrote it after the rename), and
    the legacy key is deleted either way. Running it twice changes nothing the second time.
    """
    to_set: dict[str, Any] = {}
    to_delete: list[str] = []
    for new, old in LEGACY_FIELDS.items():
        if old.startswith(_FACTS_PREFIX) or old not in payload:
            continue
        if new not in payload:
            to_set[new] = payload[old]
        to_delete.append(old)
    inverse = {old: new for new, old in LEGACY_CHUNKING.items()}
    if payload.get("chunking") in inverse:
        to_set["chunking"] = inverse[payload["chunking"]]
    facts = payload.get(PROJECT_FACTS_FIELD)
    rebuilt = _facts(facts) if isinstance(facts, Mapping) else None
    if rebuilt is not None:
        to_set[PROJECT_FACTS_FIELD] = rebuilt
    if not to_set and not to_delete:
        return None
    return PayloadRewrite(set=to_set, delete=tuple(to_delete))
