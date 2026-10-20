"""No new German identifier in Python (AGENTS.md: every name in code is English).

A ratchet, not a ban: `ci/english_names_baseline_py.json` holds how many German
identifiers each file had when this check arrived, and a file may only go down.
A file over its count fails: rename the new name. A file under its count fails
too, so the baseline follows every cleanup: rerun with UPDATE_ENGLISH_NAMES=1.

Only identifiers are read (Python's own tokenizer), split into their words; a
string, a comment or a docstring is never checked, so German copy, document
names and legal citations stay as they are. The stems are in
`ci/german_stems.json`, shared with the TypeScript check.
"""

from __future__ import annotations

import io
import json
import keyword
import os
import re
import subprocess
import tokenize
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STEMS = json.loads((ROOT / "ci" / "german_stems.json").read_text(encoding="utf-8"))["stems"]
BASELINE_PATH = ROOT / "ci" / "english_names_baseline_py.json"
GERMAN = re.compile("|".join(STEMS))
_WORDS = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")


def german_words(identifier: str) -> list[str]:
    """The words of ``identifier`` that carry a German stem (`federal_state` → [], `bundesland_id` → ['bundesland'])."""
    words = [word.lower() for part in identifier.split("_") for word in _WORDS.findall(part)]
    return [word for word in words if GERMAN.search(word)]


def _python_files() -> list[str]:
    listed = subprocess.run(["git", "ls-files", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [path for path in listed.stdout.split() if (ROOT / path).is_file()]


def _count(path: str) -> int:
    source = (ROOT / path).read_text(encoding="utf-8", errors="replace")
    count = 0
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.NAME and not keyword.iskeyword(token.string) and german_words(token.string):
                count += 1
    except (tokenize.TokenError, SyntaxError):
        return 0
    return count


def _current() -> dict[str, int]:
    return {path: count for path in _python_files() if (count := _count(path))}


def test_the_word_split_reads_identifiers_not_substrings():
    assert german_words("bundesland_source") == ["bundesland"]
    assert german_words("GebaeudeklasseInput") == ["gebaeudeklasse"]
    assert german_words("federal_state") == []
    # `archiv` is German, `archive` is English: the soft-delete names stay legal.
    assert german_words("archived_at") == []
    assert german_words("archiv_scope") == ["archiv"]


def test_no_file_gains_a_german_identifier():
    current = _current()
    if os.environ.get("UPDATE_ENGLISH_NAMES"):
        BASELINE_PATH.write_text(json.dumps(dict(sorted(current.items())), indent=2) + "\n", encoding="utf-8")
    baseline: dict[str, int] = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    grown = {path: (baseline.get(path, 0), count) for path, count in current.items() if count > baseline.get(path, 0)}
    assert not grown, (
        "German identifiers added (file: baseline -> now). Name them in English (docs/glossary.md, "
        f"'German domain term, English code name'): {grown}"
    )


def test_the_baseline_follows_every_cleanup():
    current = Counter(_current())
    baseline: dict[str, int] = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    shrunk = {path: (count, current[path]) for path, count in baseline.items() if current[path] < count}
    assert not shrunk, (
        f"Fewer German identifiers than the baseline says: rerun with UPDATE_ENGLISH_NAMES=1 to lock it in: {shrunk}"
    )
