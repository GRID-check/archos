"""One BFF client: no second redirect guard, base-URL read or token header outside ``common/bff_http.py``.

Ten copies of the redirect guard and eighteen of the base-URL read grew one
"not lifted yet" comment at a time, each fallback chain a little different.
This ratchet holds the line where the lift left it. ``ALLOWED`` names every
file still carrying its own copy, with the count it carries; the count may only
fall. Porting a file means deleting its entry, and a stale entry (a count
higher than the file's) fails too, so the list never claims more than is true.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SEAM = Path("packages/agent/src/agent/common/bff_http.py")
#: The inbound twin: the one check of the internal token a service receives (ADR-0149).
INBOUND_SEAM = Path("packages/agent/src/agent/common/envelope_auth.py")

#: Where the agent tier calls the BFF from. ``knowledge_layer`` is its own
#: package, imported by the ingest worker, and must not depend on ``agent``;
#: ``agent_host`` is the API host, whose ``internal_api.py`` persists messages.
TREES = ("packages/agent/src/agent", "packages/knowledge-layer/src", "apps/agent-host/src")

PATTERNS = {
    # A private redirect guard: the seam's opener is the one that refuses redirects.
    "redirect_guard": re.compile(r"class \w+\([^)]*HTTPRedirectHandler"),
    # The base-URL read, whatever fallback chain it spells.
    "base_url": re.compile(r"FRONTEND_INTERNAL_URL"),
    # The service-token header, in any case. Held only in the agent package, where the
    # inbound check has one home, `common/envelope_auth.py` (INBOUND_SEAM), shared by
    # agent_host and the geometry service (ADR-0149).
    "token_header": re.compile(r"x-(?:grid-)?internal-token", re.IGNORECASE),
}
TOKEN_HEADER_TREES = ("packages/agent/src/agent",)

#: Each remaining copy, by pattern, with its count today. Why each is not ported:
#: - httpx callers (skills resolver, model overrides, LLM credentials, platform
#:   lessons, retrieval and reasoning settings, permit records, corpus store)
#:   are a second transport; porting them means giving the seam an async/httpx
#:   form or moving them to urllib. The last two fail closed on an empty
#:   ``FRONTEND_INTERNAL_URL`` on purpose (no default host for a write of the
#:   corpus or a permit record), which the seam's fallback chain would change.
#: - knowledge_layer must not import agent (see TREES).
#: - agent_host's internal_api.py returns None without either URL (it skips
#:   persisting rather than guessing a host).
ALLOWED: dict[str, dict[str, int]] = {
    "base_url": {
        "packages/agent/src/agent/skills/resolver.py": 1,
        "packages/agent/src/agent/common/model_overrides.py": 1,
        "packages/agent/src/agent/common/llm_credentials.py": 2,
        "packages/agent/src/agent/common/platform_lessons.py": 1,
        "packages/agent/src/agent/common/retrieval_settings.py": 1,
        "packages/agent/src/agent/common/reasoning_settings.py": 1,
        "packages/agent/src/agent/corpus_store.py": 4,
        "packages/agent/src/agent/knowledge/permit_records_client.py": 3,
        "packages/knowledge-layer/src/llamaindex/image_store.py": 3,
        "packages/knowledge-layer/src/llamaindex/document_presence.py": 3,
        "packages/knowledge-layer/src/llamaindex/page_text_store.py": 3,
        "packages/knowledge-layer/src/view_image.py": 4,
        "apps/agent-host/src/agent_host/internal_api.py": 2,
    },
    "token_header": {
        "packages/agent/src/agent/skills/resolver.py": 1,
        "packages/agent/src/agent/common/model_overrides.py": 1,
        "packages/agent/src/agent/common/llm_credentials.py": 2,
        "packages/agent/src/agent/common/platform_lessons.py": 1,
        "packages/agent/src/agent/common/retrieval_settings.py": 1,
        "packages/agent/src/agent/common/reasoning_settings.py": 1,
        "packages/agent/src/agent/corpus_store.py": 1,
        "packages/agent/src/agent/knowledge/permit_records_client.py": 1,
    },
    "redirect_guard": {},
}


def _counts(pattern_name: str) -> dict[str, int]:
    trees = TOKEN_HEADER_TREES if pattern_name == "token_header" else TREES
    pattern = PATTERNS[pattern_name]
    found: dict[str, int] = {}
    for tree in trees:
        for path in sorted((ROOT / tree).rglob("*.py")):
            relative = path.relative_to(ROOT)
            if relative == SEAM or (pattern_name == "token_header" and relative == INBOUND_SEAM):
                continue
            hits = len(pattern.findall(path.read_text(encoding="utf-8")))
            if hits:
                found[relative.as_posix()] = hits
    return found


@pytest.mark.parametrize("pattern_name", sorted(PATTERNS))
def test_no_new_copy_of_the_bff_client(pattern_name: str) -> None:
    found = _counts(pattern_name)
    allowed = ALLOWED[pattern_name]
    grown = {path: hits for path, hits in found.items() if hits > allowed.get(path, 0)}
    assert not grown, (
        f"{pattern_name}: go through agent.common.bff_http instead of a copy of your own "
        f"(internal_base_url, send/get_json/post_json, BffError). New or grown: {grown}"
    )


@pytest.mark.parametrize("pattern_name", sorted(PATTERNS))
def test_the_allowlist_only_falls(pattern_name: str) -> None:
    found = _counts(pattern_name)
    stale = {
        path: (hits, found.get(path, 0)) for path, hits in ALLOWED[pattern_name].items() if found.get(path, 0) < hits
    }
    assert not stale, f"{pattern_name}: lower or delete these entries in ALLOWED (allowed, found): {stale}"


def test_the_seam_itself_is_seen() -> None:
    """The scan reads the files it claims to: the seam carries each pattern it exempts."""
    text = (ROOT / SEAM).read_text(encoding="utf-8")
    assert all(pattern.search(text) for pattern in PATTERNS.values())
