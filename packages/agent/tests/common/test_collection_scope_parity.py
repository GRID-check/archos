"""The qualifier strings are a WIRE CONTRACT, so both ends must agree.

The legacy qualifier strings are embedded in citation keys that got persisted in
messages. The backend writes them and the frontend parses them back, so a change
on one side alone silently stops every qualified citation from resolving — the
exact class of drift this identity model exists to remove.

The collection-PREFIX parity test that used to live here is gone with
``_COLLECTION_SCOPE_PREFIXES`` (ADR-0047): it policed the agreement of two
guesses rather than removing the guess. The shelf now travels as data, and the
round-trip contract test (``tests/knowledge_layer_tests/test_citation_key_scope.py``
plus ``packages/agent/tests/knowledge/test_scoping.py``) drives that seam instead.

The kinds and the shelves are generated into the UI from ``source_kinds.py``
(``scripts/generate_vocabularies.py``) and need no check here. What is left is
still parsed: the qualifier pairs, the lane→kind table, the agent-authored lane
and the fail-open kind, which carry structure the generator does not emit yet.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.common.source_kinds import _LANE_KIND_PREFIXES
from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE
from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE_LABEL
from aiq_agent.common.source_kinds import DEFAULT_SOURCE_KIND
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import shelf_for_qualifier

_MIRROR = Path("apps/workspace/bff/source-kinds.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


def test_the_legacy_qualifier_strings_resolve_to_the_same_shelf(mirror_source: str):
    """Every legacy qualifier the frontend parses must resolve, on this side, to
    the SAME shelf — those strings are frozen inside keys already persisted.

    One-directional (mirror ⊆ backend): the two runtimes deploy separately, so
    a qualifier the backend knows and the frontend has not learned yet is not a
    contract break. A DISAGREEMENT on a shared string is, and fails here.
    """
    block = re.search(
        r"CITATION_KEY_QUALIFIERS:[^=]*=\s*\[(.*?)\]\n",
        mirror_source,
        re.DOTALL,
    )
    assert block, "CITATION_KEY_QUALIFIERS not found in the frontend mirror"
    mirrored = re.findall(r"\['([^']*)',\s*'([^']*)'\]", block.group(1))
    assert mirrored, "the frontend mirror declares no legacy qualifiers"
    for label, shelf in mirrored:
        assert shelf_for_qualifier(label) == Shelf(shelf), f"{label!r} disagrees across the two runtimes"
    # The persisted vocabulary: keys already written into messages must keep
    # parsing on both ends whatever else either side adds.
    # „Büroarchiv" is the archiv shelf's name before 6 Oct 2026, retired but still read.
    assert {label for label, _ in mirrored} >= {"Büroablage", "Büroarchiv", "Projektwissen", "Basiswissen"}


# ---------------------------------------------------------------------------
# The taxonomy itself
# ---------------------------------------------------------------------------
#
# The test above guards the strings DERIVED from the source-kind model. The set
# of kinds itself (and of shelves) is no longer mirrored: the UI's tuple is
# generated from `SOURCE_KINDS` (`scripts/generate_vocabularies.py`), so there is
# nothing to compare. The lane→kind table that assigns a kind to every retrieval
# hit is still a mirror, and adding a lane family on one side alone would leave
# the other silently falling open to `web`, so it is checked below.


def test_the_lane_kind_prefixes_match(mirror_source: str):
    block = re.search(
        r"LANE_KIND_PREFIXES:[^=]*=\s*\[(.*?)\]\n",
        mirror_source,
        re.DOTALL,
    )
    assert block, "LANE_KIND_PREFIXES not found in the frontend mirror"
    mirrored = tuple(re.findall(r"\['([^']*)',\s*'([^']*)'\]", block.group(1)))
    assert mirrored == _LANE_KIND_PREFIXES


def test_the_agent_authored_lane_matches(mirror_source: str):
    """The lane key is a wire value and its label is what the chip shows.

    Declared on both sides because neither runtime imports the other's; a lane
    key that disagrees renders as an unknown sub-label, and a label that
    disagrees tells the reader two different things about the same document
    depending on which surface they are looking at.
    """
    key = re.search(r"AGENT_AUTHORED_LANE = '([^']+)'", mirror_source)
    label = re.search(r"AGENT_AUTHORED_LANE_LABEL = '([^']+)'", mirror_source)
    assert key and label, "the agent-authored lane was not found in the frontend mirror"
    assert key.group(1) == AGENT_AUTHORED_LANE
    assert label.group(1) == AGENT_AUTHORED_LANE_LABEL
    # And the mirror's own lane→kind table places it in the office family
    # without a row of its own: the ``office`` prefix already covers it.
    assert AGENT_AUTHORED_LANE.startswith("office_")


def test_the_lane_fallback_kinds_match(mirror_source: str):
    """Both classifiers fail open, so they must fail open to the SAME kind."""
    block = re.search(r"export const kindForLane =(.*?)\n\}", mirror_source, re.DOTALL)
    assert block, "kindForLane not found in the frontend mirror"
    fallback = re.search(r"return '([^']+)'\s*$", block.group(1).strip())
    assert fallback, "kindForLane's fail-open return was not found"
    assert fallback.group(1) == DEFAULT_SOURCE_KIND
