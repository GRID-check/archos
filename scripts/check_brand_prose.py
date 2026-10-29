#!/usr/bin/env python3

"""Keep the retired product names out of everything people and agents read, and the current one out of code.

Why this exists
---------------

The product was AI-Q, then Grid, then Piloti, and is ARCHOS now (ADR-0148). The
owner's rule is one name everywhere and the next rename in one edit: the name is
copy, read from ``packages/brand/identity.json`` (``{productName}`` in the
dictionaries, ``{{ product_name }}`` in prompts, ``PRODUCT_NAME`` in code).
``scripts/check_brand_names.py`` keeps brands out of identifiers. This check is
its other half: the words a person or an agent reads. It is a ratchet like that
one, so the copy rename can land directory by directory.

What it counts
--------------

Over every text file git tracks:

- **A retired name** (``RETIRED``): ``piloti`` in any case as a word, ``AIQ``/``AI-Q``
  and ``GRID`` in capitals, ``Grid`` followed by OIB, platform, operates, agent or
  workspace, and ``grid-oib``. A bare ``grid`` never counts: it is CSS, Tailwind and
  the English layout noun.
- **The current name typed out** (``CURRENT``): ``ARCHOS`` or ``Archos`` as a word, in a
  file outside ``CURRENT_NAME_ALLOWED``. In code and the dictionaries the name is
  ``PRODUCT_NAME`` or ``{productName}``, so a literal is a string the next rename
  misses. URLs, e-mail addresses, the domain and the repository's own name
  (``archos-at/archos``) are not the name as copy and are left out.

Never counted: a host name under the old domain (``OLD_HOSTS``), which the domain cutover
moves; in the three legal notices (``LEGAL_CONTINUITY_FILES``), the former name
in exactly "(vormals Piloti)" or "(formerly Piloti)". A link to an ADR file (``0146-piloti-draws-….md``), whose filename
is history; and on a line carrying ``<!-- brand-history -->``, anything in
backticks, which is how a later record quotes an old name.

History is not rewritten
------------------------

A record of what was true then keeps the name it was written under:

- ADRs up to ``HISTORY_ADR_MAX`` (0147) and the ADR index; ``docs/audit/``.
- Migrations, the RLS harness that replays them, the ratchet baselines, these
  checkers and their tests.
- Every release note listed in ``ci/brand_history_manifest.txt`` (the notes that
  existed at the cutover, and the rename note itself), their German entries in
  ``releasenotes/translations/de.json`` and the weekly summaries up to the cutover
  week in ``releasenotes/summaries.yaml``.
- A file under ``docs/`` whose first line is ``<!-- history: YYYY-MM-DD -->`` with a
  date on or before ``CUTOVER_DATE``: a dated record, frozen.
- A legacy-compatibility module whose header says ``drop after release N``: it
  names the old names on purpose, for one release.

The ratchet
-----------

``ci/brand_prose_baseline.json`` holds each file's hits. A file over its entry
fails; one under it fails too until ``--update`` lowers the entry, so the baseline
only shrinks. The target is ``{}``. ``--rebaseline`` records the tree as it is,
for a move that re-keys entries; it refuses to raise the total, so a move can
re-key hits and never add one. Review its diff.

Usage:
    python scripts/check_brand_prose.py              # check, exit 1 on a finding
    python scripts/check_brand_prose.py --update     # ratchet the baseline down
    python scripts/check_brand_prose.py --rebaseline # rewrite it from the tree
    python scripts/check_brand_prose.py --summary    # the hits by directory, for planning
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from pathlib import PurePosixPath

import yaml

BASELINE = Path("ci/brand_prose_baseline.json")
MANIFEST = Path("ci/brand_history_manifest.txt")
CUTOVER_DATE = date(2026, 10, 29)
HISTORY_ADR_MAX = 147
TRANSLATIONS = "releasenotes/translations/de.json"
SUMMARIES = "releasenotes/summaries.yaml"

RETIRED = re.compile(
    "|".join(
        (
            r"(?i:\bpiloti\b)",
            r"\bAI-?Q\b",
            r"\bGRID\b",
            r"\bGrid(?=\s+(?i:OIB|platform|operates|agent|workspace)\b)",
            r"(?i:\bgrid-oib\b)",
        )
    )
)
# The name as copy is written ARCHOS (or Archos). Lowercase `archos` is the repository and its
# clone directory (`archos/scripts/…`), an identifier the brand-names check governs.
CURRENT = re.compile(r"\b(?:ARCHOS|Archos)\b")
NEEDLES = ("piloti", "aiq", "ai-q", "grid", "archos")  # lowercase; every pattern above contains one

# Where the current name may be written out: the brand's own file and package, the
# blog's prose, dated records, and the first-impression documents (VISION, README,
# the user guides), which introduce the product by its name.
CURRENT_NAME_ALLOWED = re.compile(
    "|".join(
        (
            r"(^|/)identity\.json$",
            # The literal copies sync.mjs writes from identity.json (packages/brand/name-copies.mjs).
            r"^apps/workspace/public/sw\.js$|^apps/workspace/app/icon\.svg$|^apps/(website|site)/public/favicon\.svg$",
            r"^packages/brand/",
            r"^apps/website/src/content/",
            r"^releasenotes/",
            r"^docs/adr/",
            r"^(README|VISION|CONTEXT|CONTRIBUTING|AGENTS|CLAUDE)\.md$",
            r"^docs/(user-guides|product)/",
            r"^docs/(glossary|README)\.md$",
        )
    )
)

# Whole files that are history, or lists of paths nobody reads as prose, by path. Each line says why.
HISTORY_PATHS = re.compile(
    "|".join(
        (
            r"^docs/adr/README\.md$",  # the index of dated records, under the titles they had
            r"^docs/audit/",  # audits: dated findings
            r"(^|/)migrations/",  # Alembic and Drizzle history, written once
            r"^scripts/rls-test-db\.sh$",  # replays the migrations under the names they had
            r"^ci/[^/]*baseline[^/]*\.json$|^ci/brand_history_manifest\.txt$",  # ratchet state
            r"^scripts/check_brand_(names|prose)\.py$|^tests/test_check_brand_(names|prose)\.py$",  # these checks
            r"^tests/\.test_durations$|^\.github/filters\.yml$",  # test timings and CI filters: paths, not prose
            r"^apps/website/redirects\.mjs$",  # old public addresses, kept in the spelling they were published under
            r"^apps/website/src/data/changelog\.json$",  # generated from releasenotes/, linted there
        )
    )
)
ADR = re.compile(r"^docs/adr/(\d{4})-")
HISTORY_MARKER = re.compile(r"\A<!-- history: (\d{4}-\d{2}-\d{2}) -->")
LEGACY_HEADER = re.compile(r"(?i)drop after release\s+\S+")
LINE_MARKER = "<!-- brand-history -->"
BACKTICKED = re.compile(r"`[^`\n]*`")

ADR_LINK = re.compile(r"\b\d{4}-[a-z0-9-]+\.md\b")

# Legal continuity (owner decision D23, ADR-0148): the privacy and legal notices name the
# former name beside the current one, so a reader who signed up under it can tell the
# notice covers them. Only in these files, and only as this exact parenthesis.
LEGAL_CONTINUITY_FILES = frozenset(
    {
        "apps/workspace/bff/legal/content/de.ts",
        "apps/workspace/bff/legal/content/en.ts",
        "apps/website/src/i18n/pages/privacy.ts",
    }
)
LEGAL_CONTINUITY = re.compile(r"\((?:vormals|formerly) Piloti\)")
URL = re.compile(r"\b(?:https?|git|ssh)://\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
OWN_NAMES = re.compile(r"(?i)\barchos-at(?:/archos)?\b|\b(?:[\w-]+\.)*archos\.tech\b")
# Host names under the old domain (and its test domain) are infrastructure: the domain moves
# by an operator's cutover (ADR-0148, owner decision D2), not by a copy edit.
OLD_HOSTS = re.compile(r"(?i)\b(?:[\w-]+\.)*piloti\.(?:at|test)\b")

BINARY_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf",
    ".pdf", ".mp4", ".webm", ".mov", ".mp3", ".zip", ".gz", ".tgz", ".lockb", ".ifc", ".docx", ".xlsx", ".pptx",
)  # fmt: skip
LOCKFILES = re.compile(r"(^|/)(uv\.lock|bun\.lockb?|package-lock\.json|apm\.lock\.yaml)$")


def name_lines(text: str) -> str:
    """Only the lines of ``text`` that could hold a name, found by plain substring search.

    The patterns below are costly over a whole file; the lines that hold a name are few.
    """
    lower = text.lower()
    starts: set[int] = set()
    for needle in NEEDLES:
        at = lower.find(needle)
        while at != -1:
            starts.add(lower.rfind("\n", 0, at) + 1)
            at = lower.find(needle, at + len(needle))
    return "\n".join(text[start : (text.find("\n", start) + 1 or len(text) + 1) - 1] for start in sorted(starts))


def scrub(text: str) -> str:
    """``text`` without what never counts: ADR filenames, and backticks on a marked line."""
    text = ADR_LINK.sub(" ", text)
    if LINE_MARKER not in text:
        return text
    return "\n".join(BACKTICKED.sub(" ", line) if LINE_MARKER in line else line for line in text.split("\n"))


def count_retired(text: str) -> int:
    return len(RETIRED.findall(OLD_HOSTS.sub(" ", scrub(text))))


def count_current(text: str) -> int:
    return len(CURRENT.findall(OWN_NAMES.sub(" ", URL.sub(" ", scrub(text)))))


def load_manifest(root: Path) -> set[str]:
    """The release-note files frozen as history: one repo-relative path a line, `#` comments."""
    path = root / MANIFEST
    if not path.exists():
        return set()
    lines = (line.split("#", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines())
    return {line for line in lines if line}


def is_history(path: str, text: str, manifest: set[str]) -> bool:
    """Whether the whole of ``path`` is a record that keeps the names it was written under."""
    if HISTORY_PATHS.search(path) or path in manifest:
        return True
    adr = ADR.match(path)
    if adr and int(adr.group(1)) <= HISTORY_ADR_MAX:
        return True
    marker = HISTORY_MARKER.match(text) if path.startswith("docs/") else None
    if marker and date.fromisoformat(marker.group(1)) <= CUTOVER_DATE:
        return True
    return bool(LEGACY_HEADER.search("\n".join(text.split("\n", 15)[:15])))


def _frozen_english(root: Path, manifest: set[str]) -> set[str]:
    """Every English text of the frozen notes and the frozen weekly summaries, whitespace-normalised."""
    summaries = yaml.safe_load((root / SUMMARIES).read_text(encoding="utf-8")) if (root / SUMMARIES).is_file() else {}
    texts = {" ".join(str(text).split()) for week, text in (summaries or {}).items() if _frozen_week(str(week))}
    for note in manifest:
        if not (root / note).is_file():
            continue
        data = yaml.safe_load((root / note).read_text(encoding="utf-8")) or {}
        for value in data.values() if isinstance(data, dict) else ():
            for item in value if isinstance(value, list) else [value]:
                if isinstance(item, str):
                    texts.add(" ".join(item.split()))
    return texts


def live_translations(text: str, frozen: set[str]) -> str:
    """The German entries whose English is not a frozen note's: the ones still to be read under the new name."""
    entries = json.loads(text)
    live = [entry for entry in entries if " ".join(str(entry.get("en", "")).split()) not in frozen]
    return json.dumps(live, ensure_ascii=False)


def _frozen_week(key: str) -> bool:
    """Whether ``key`` is an ISO week (``2026-W41``) that began on or before the cutover."""
    match = re.fullmatch(r"(\d{4})-W(\d{2})", key)
    return bool(match) and date.fromisocalendar(int(match.group(1)), int(match.group(2)), 1) <= CUTOVER_DATE


def live_summaries(text: str) -> str:
    """``summaries.yaml`` without the entries of weeks that began on or before the cutover."""
    kept: list[str] = []
    dropping = False
    for line in text.split("\n"):
        key = re.match(r"^([\w.-]+):", line)
        if key:
            dropping = _frozen_week(key.group(1))
        elif line and not line[0].isspace():
            dropping = False
        if not dropping:
            kept.append(line)
    return "\n".join(kept)


def is_text(path: str) -> bool:
    return not (path.lower().endswith(BINARY_SUFFIXES) or LOCKFILES.search(path))


def tracked_files(root: Path) -> list[str]:
    """Every text file git tracks (staged included)."""
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout
    return [path for path in out.splitlines() if is_text(path) and (root / path).is_file()]


def measure(root: Path, paths: list[str]) -> dict[str, int]:
    """The hits per file, zeros and history left out."""
    manifest = load_manifest(root)
    frozen: set[str] | None = None
    counts: Counter[str] = Counter()
    for path in paths:
        text = (root / path).read_text(encoding="utf-8", errors="replace")
        if "\0" in text or is_history(path, text, manifest):
            continue
        if path == TRANSLATIONS:
            frozen = _frozen_english(root, manifest) if frozen is None else frozen
            text = live_translations(text, frozen)
        elif path == SUMMARIES:
            text = live_summaries(text)
        if path in LEGAL_CONTINUITY_FILES:
            text = LEGAL_CONTINUITY.sub(" ", text)
        text = name_lines(text)
        counts[path] = count_retired(text)
        if not CURRENT_NAME_ALLOWED.search(path):
            counts[path] += count_current(text)
    return {key: count for key, count in counts.items() if count}


def stale_manifest(root: Path) -> list[str]:
    return sorted(path for path in load_manifest(root) if not (root / path).is_file())


def load_baseline(path: Path) -> dict[str, int]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_baseline(path: Path, counts: dict[str, int]) -> None:
    path.write_text(json.dumps(dict(sorted(counts.items())), indent=2) + "\n", encoding="utf-8")


def check(current: dict[str, int], baseline: dict[str, int]) -> list[str]:
    """New or grown files, and entries the baseline should lower."""
    findings = []
    for key, count in sorted(current.items()):
        allowed = baseline.get(key, 0)
        if count > allowed:
            findings.append(
                f"{key}: {count} hit(s), baseline {allowed}. Write {{productName}} or the role noun, not a name."
            )
    for key, allowed in sorted(baseline.items()):
        count = current.get(key, 0)
        if count < allowed:
            findings.append(f"{key}: down from {allowed} to {count}, so lower its baseline entry (run --update).")
    return findings


def tightened(current: dict[str, int], baseline: dict[str, int]) -> dict[str, int]:
    """The baseline lowered to the tree wherever the tree has fewer; nothing new, nothing raised."""
    return {key: min(allowed, current[key]) for key, allowed in baseline.items() if key in current}


def summary(counts: dict[str, int], depth: int = 2) -> list[tuple[str, int, int]]:
    """``(directory, hits, files)`` at ``depth`` path parts, most hits first."""
    hits: Counter[str] = Counter()
    files: Counter[str] = Counter()
    for path, count in counts.items():
        parts = PurePosixPath(path).parts
        key = "/".join(parts[:depth]) + ("/" if len(parts) > depth else "")
        hits[key] += count
        files[key] += 1
    return [(key, hits[key], files[key]) for key, _ in hits.most_common()]


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: check (or ratchet) the brand-prose baseline and return an exit code."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--update", action="store_true", help="Lower and remove baseline entries; never raise one.")
    mode.add_argument(
        "--rebaseline", action="store_true", help="Re-key the baseline to the tree; never raise its total."
    )
    mode.add_argument("--summary", action="store_true", help="Print the hits by directory and exit.")
    args = parser.parse_args(argv)

    root = Path.cwd()
    current = measure(root, tracked_files(root))
    if args.summary:
        for key, hits, files in summary(current):
            print(f"{hits:6d} hits {files:5d} files  {key}")
        print(f"{sum(current.values()):6d} hits {len(current):5d} files  (all)")
        return 0
    baseline = load_baseline(root / BASELINE)
    if args.rebaseline:
        if baseline and sum(current.values()) > sum(baseline.values()):
            print(
                f"Refusing to rebaseline: the tree has {sum(current.values())} hit(s), the baseline "
                f"{sum(baseline.values())}. A move re-keys hits; it never adds one. Remove the new ones first.",
                file=sys.stderr,
            )
            return 1
        write_baseline(root / BASELINE, current)
        print(f"Brand-prose baseline rewritten: {sum(current.values())} hit(s) in {len(current)} file(s).")
        return 0
    if args.update:
        baseline = tightened(current, baseline)
        write_baseline(root / BASELINE, baseline)

    findings = check(current, baseline)
    findings += [f"{MANIFEST}: {path} is listed but does not exist." for path in stale_manifest(root)]
    if findings:
        print(f"Brand-prose check FAILED ({len(findings)} finding(s)):", file=sys.stderr)
        for finding in findings:
            print(f"  - {finding}", file=sys.stderr)
        print("Why and what to write instead: docs/contributing/code-conventions.md#no-brand-names", file=sys.stderr)
        return 1

    print(f"Brand-prose check passed: {sum(baseline.values())} hit(s) in {len(baseline)} file(s) held at baseline.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
