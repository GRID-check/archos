#!/usr/bin/env python3

"""Keep giant source files and giant Python functions from being added or growing.

Why this exists
---------------

The repo grew files of three to seven thousand lines (`adapter.py`, the chat
composer, the documents service) and Python functions that run for hundreds of
lines (`run_agent_job`, 962). Every split that brings one down is undone by the
next change that finds it easier to add a branch than a module, unless
something refuses the growth. Code review did not: each of those files passed
it one reasonable hunk at a time.

What it checks
--------------

A ratchet, in the style of `tests/test_english_names.py`: limits for everything
new, and a baseline (`ci/size_baseline.json`) holding what was already over them
when the check arrived.

- A source file (`.py`, `.ts`, `.tsx`) may have at most ``FILE_LIMIT`` lines.
- A Python function may span at most ``FUNCTION_LIMIT`` lines, from its `def`
  to its last line (``end_lineno - lineno + 1``), the bar
  `docs/contributing/code-conventions.md` sets ("Sixty lines is long").
- A file or function in the baseline may not grow past its recorded count.
- A baseline entry above its file's or function's current size fails too: the
  baseline only moves down. ``--update`` lowers and removes entries; it never
  raises one or adds one.

Generated code, tests, fixtures, migrations and copy (the i18n dictionaries,
the site's content data) are not checked (``EXCLUDED``): their length follows
their input, not a design choice.

Usage:
    python scripts/check_file_size.py              # check, exit 1 on a finding
    python scripts/check_file_size.py --update     # ratchet the baseline down
    python scripts/check_file_size.py --rebaseline # rewrite it from the tree

``--rebaseline`` is for a move or rename that re-keys entries (a conflict on the
baseline after files moved): it records the tree as it is, growth included, so
its diff is the thing to review.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

FILE_LIMIT = 600
FUNCTION_LIMIT = 60
BASELINE = Path("ci/size_baseline.json")
SUFFIXES = (".py", ".ts", ".tsx")

# Matched against the repo-relative POSIX path. Each line says what it is and
# why its length is not a design choice.
EXCLUDED = re.compile(
    "|".join(
        (
            r"(^|/)generated\.ts$",  # card schemas, rendered from cards/models.py
            r"\.generated\.",  # wire-v2.generated.ts and its kind
            r"\.d\.ts$",  # type declarations
            r"(^|/)(tests?|__tests__|e2e|_?fixtures|__fixtures__|test-utils)/",  # suites and their data
            r"(^|/)i18n/dictionaries/|^frontends/web/src/(i18n|data)/",  # copy: its length is the copy's
            r"(^|/)(test_[^/]*|[^/]*_test|conftest)\.py$",
            r"\.(spec|test)\.tsx?$",
            r"(^|/)migrations/",  # Alembic and Drizzle history, written once
        )
    )
)


@dataclass
class Sizes:
    """Line counts over the limits: files by path, functions by `path::Qual.name`."""

    files: dict[str, int] = field(default_factory=dict)
    functions: dict[str, int] = field(default_factory=dict)


def is_checked(path: str) -> bool:
    """Whether ``path`` is a source file this check governs."""
    return path.endswith(SUFFIXES) and not EXCLUDED.search(path)


def tracked_sources(root: Path) -> list[str]:
    """Every checked file git tracks (staged included), so a new file is seen at commit time."""
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout
    return [path for path in out.splitlines() if is_checked(path) and (root / path).is_file()]


def function_lengths(source: str) -> dict[str, int]:
    """Each function's span in lines, keyed by its qualified name (`Class.method`, `outer.inner`).

    Two definitions under one name (a property's getter and setter, a
    conditional `def`) keep the longer one.
    """
    lengths: dict[str, int] = {}

    def visit(node: ast.AST, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
                visit(child, prefix)
                continue
            name = f"{prefix}{child.name}"
            if not isinstance(child, ast.ClassDef):
                span = (child.end_lineno or child.lineno) - child.lineno + 1
                lengths[name] = max(span, lengths.get(name, 0))
            visit(child, f"{name}.")

    visit(ast.parse(source), "")
    return lengths


def measure(root: Path, paths: list[str]) -> Sizes:
    """Everything in ``paths`` that is over a limit."""
    sizes = Sizes()
    for path in paths:
        source = (root / path).read_text(encoding="utf-8", errors="replace")
        lines = len(source.splitlines())
        if lines > FILE_LIMIT:
            sizes.files[path] = lines
        if not path.endswith(".py"):
            continue
        try:
            spans = function_lengths(source)
        except SyntaxError:
            continue  # ruff reports it; a size is meaningless for a file that does not parse
        for name, span in spans.items():
            if span > FUNCTION_LIMIT:
                sizes.functions[f"{path}::{name}"] = span
    return sizes


def load_baseline(path: Path) -> Sizes:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return Sizes(files=data.get("files", {}), functions=data.get("functions", {}))


def write_baseline(path: Path, sizes: Sizes) -> None:
    data = {"files": dict(sorted(sizes.files.items())), "functions": dict(sorted(sizes.functions.items()))}
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def compare(current: dict[str, int], baseline: dict[str, int], limit: int, what: str) -> list[str]:
    """Findings for one kind (files or functions): new or grown, and entries the baseline should lower."""
    findings = []
    for key, size in sorted(current.items()):
        allowed = baseline.get(key)
        if allowed is None:
            findings.append(f"{key}: {size} lines, over the {limit}-line {what} limit. Split it.")
        elif size > allowed:
            findings.append(f"{key}: grew from {allowed} to {size} lines. Split it, do not grow it.")
    for key, allowed in sorted(baseline.items()):
        size = current.get(key)
        if size is None:
            findings.append(f"{key}: under the limit or gone, so remove its baseline entry (run --update).")
        elif size < allowed:
            findings.append(f"{key}: down from {allowed} to {size} lines, so lower its baseline entry (run --update).")
    return findings


def check(current: Sizes, baseline: Sizes) -> list[str]:
    return compare(current.files, baseline.files, FILE_LIMIT, "file") + compare(
        current.functions, baseline.functions, FUNCTION_LIMIT, "function"
    )


def tightened(current: Sizes, baseline: Sizes) -> Sizes:
    """The baseline lowered to the tree wherever the tree is smaller; nothing new, nothing raised."""

    def lower(now: dict[str, int], then: dict[str, int]) -> dict[str, int]:
        return {key: min(size, now[key]) for key, size in then.items() if key in now}

    return Sizes(files=lower(current.files, baseline.files), functions=lower(current.functions, baseline.functions))


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: check (or ratchet) the size baseline and return an exit code."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--update", action="store_true", help="Lower and remove baseline entries; never raise one.")
    mode.add_argument("--rebaseline", action="store_true", help="Record the tree as it is, growth included.")
    args = parser.parse_args(argv)

    root = Path.cwd()
    current = measure(root, tracked_sources(root))
    baseline = load_baseline(root / BASELINE)
    if args.rebaseline:
        write_baseline(root / BASELINE, current)
        print(f"Size baseline rewritten: {len(current.files)} file(s), {len(current.functions)} function(s).")
        return 0
    if args.update:
        baseline = tightened(current, baseline)
        write_baseline(root / BASELINE, baseline)

    findings = check(current, baseline)
    if findings:
        print(f"Size check FAILED ({len(findings)} finding(s)):", file=sys.stderr)
        for finding in findings:
            print(f"  - {finding}", file=sys.stderr)
        print("Why and how to split: docs/contributing/code-conventions.md#size-limits", file=sys.stderr)
        return 1

    print(
        f"Size check passed: {len(baseline.files)} file(s) and {len(baseline.functions)} function(s) held at baseline."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
