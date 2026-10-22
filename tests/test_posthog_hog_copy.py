"""The PostHog destinations under `deploy/posthog/` speak German to the team in
Slack, but their code is English like the rest of the repo: every word a person
reads comes from the destination's `copy` input, whose values live in
`copy.de.json` beside the code. These checks keep German out of the `.hog`
source and every key the code reads present in the dictionary.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = ROOT / "deploy" / "posthog" / "support"
GERMAN_LETTERS = re.compile(r"[äöüÄÖÜß]")
COPY_KEY = re.compile(r"\bcopy\.([a-z_]+)")


def _code_lines(path: Path) -> list[tuple[int, str]]:
    return [
        (number, line)
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if not line.lstrip().startswith("//")
    ]


def _hog_files() -> list[Path]:
    files = sorted(SUPPORT.glob("*.hog"))
    assert files, f"no .hog files under {SUPPORT}"
    return files


def test_no_destination_code_carries_german_words():
    offending = [
        f"{path.relative_to(ROOT)}:{number}: {line.strip()}"
        for path in _hog_files()
        for number, line in _code_lines(path)
        if GERMAN_LETTERS.search(line)
    ]
    assert not offending, "German belongs in copy.de.json, not in the code:\n" + "\n".join(offending)


def test_every_copy_key_the_code_reads_is_in_the_dictionary():
    dictionary = json.loads((SUPPORT / "copy.de.json").read_text(encoding="utf-8"))
    used = {key for path in _hog_files() for _, line in _code_lines(path) for key in COPY_KEY.findall(line)}
    assert used, "no destination reads its copy input"
    assert not used - set(dictionary), f"keys missing from copy.de.json: {sorted(used - set(dictionary))}"
