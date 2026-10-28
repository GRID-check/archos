"""Everything Piloti's workspace client tells the model is English (AGENTS.md, "Industry standard first").

The workspace tools are the in-product half of the agent surface (ADR-0122): their descriptions,
their refusals, the truncation note and the error prefix are what the model reads, the same
surface an external agent reads from ``/api/mcp`` in English. The BFF half is
``apps/workspace/bff/agent-api/english-only.spec.ts``; both read the words in
``ci/german_stems.json``.

Every string constant in the modules below is checked, docstrings included (they are English too,
and a German one would be the first step back). Domain data is allowed only through
``DOMAIN_DATA``, each entry with its reason.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from aiq_agent.tools.workspace import client
from aiq_agent.tools.workspace import register

ROOT = Path(__file__).resolve().parents[5]
WORDS = json.loads((ROOT / "ci" / "german_stems.json").read_text(encoding="utf-8"))
STEM = re.compile("|".join(WORDS["stems"]))
PROSE_WORDS = frozenset(WORDS["prose_words"])
UMLAUT = re.compile(r"[äöüÄÖÜß]")

#: What the model reads from the workspace: the client, the tool group, the card, and the backend's
#: read-tool route whose messages reach an outside agent through the BFF.
MODULES = [
    ROOT / "packages" / "agent" / "src" / "aiq_agent" / "tools" / "workspace" / "client.py",
    ROOT / "packages" / "agent" / "src" / "aiq_agent" / "tools" / "workspace" / "register.py",
    ROOT / "packages" / "agent" / "src" / "aiq_agent" / "tools" / "workspace" / "cards.py",
    ROOT / "apps" / "backend" / "src" / "aiq_api" / "routes" / "internal_tools.py",
]

#: German that is domain data, not a word the model is taught: (text, reason). None yet.
DOMAIN_DATA: list[tuple[str, str]] = []


def german_words(text: str) -> list[str]:
    """The German words of ``text``: an umlaut or ß, a stem, or a word of the prose list."""
    for data, _reason in DOMAIN_DATA:
        text = text.replace(data, "")
    words = re.findall(r"[^\W\d_]+", text)
    return [w for w in words if UMLAUT.search(w) or STEM.search(w.lower()) or w.lower() in PROSE_WORDS]


def _constants(path: Path) -> list[tuple[str, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        (f"{path.relative_to(ROOT)}:{node.lineno}", node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    ]


def test_the_detector_tells_german_from_english() -> None:
    assert german_words("Read the project record") == []
    assert german_words("Fehler beim Zugriff auf den Arbeitsbereich") == ["Fehler", "Arbeitsbereich"]
    assert german_words("the Büroablage") == ["Büroablage"]


@pytest.mark.parametrize("path", MODULES, ids=lambda path: path.name)
def test_every_string_the_model_can_read_is_english(path: Path) -> None:
    hits = [(where, german_words(text)) for where, text in _constants(path)]
    found = [f"{where}: {', '.join(sorted(set(words)))}" for where, words in hits if words]
    assert found == []


def test_the_texts_the_model_reads_at_run_time_are_english() -> None:
    texts = [
        *register.DESCRIPTIONS.values(),
        register._NO_ENVELOPE,
        register._PROPOSED_WITHOUT_CARD,
        register.RATE_LIMITED,
        client.ERROR_PREFIX,
    ]
    assert [text for text in texts if german_words(text)] == []
