#!/usr/bin/env python3

"""A test that reads a repo file as source runs whenever that file changes.

`.github/filters.yml` decides which test jobs a change runs, by path. Many
tests read another area's source to hold both sides of a contract to one name
or number: a Pulumi spec reads the env names a Python module reads, a backend
test reads a constant from the BFF. When the file it reads changes in a pull
request that touches nothing else of the test's tier, the job is skipped, the
pull request merges green, and the next pull request that runs the job fails
on code it never touched. #1392 and #1395 were that, twice in one day.

The check: every test file belongs to the tiers whose filter matches it. Each
repo file it names by path must be matched by one of those tiers too. A path is
a string literal naming a tracked file, or a chain of literals joined by `/`
or `,` (`ROOT / "a" / "b.py"`, `read("a", "b.py")`, `join(repoRoot, "a",
"b.ts")`), or such a chain under a directory another chain in the same file
names (`UI_LIB / "documents" / "x.ts"`). A directory a test scans whole is left
out: covering it would run the tier on every change there.

Usage: python scripts/check_ci_filter_reads.py. Exit 1 lists each file a test
reads that its tier's filter does not name.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import tokenize
from pathlib import Path
from pathlib import PurePosixPath

import yaml
from wcmatch import glob

ROOT = Path(__file__).resolve().parents[1]
FILTERS = ROOT / ".github" / "filters.yml"
FLAGS = glob.GLOBSTAR | glob.DOTGLOB
TIERS = ("backend", "workspace", "site", "infra", "packages", "migrations")
HARNESS_TASK = ROOT / "taskfiles" / "backend.yml"
BEGIN = "  # Read as source by this tier's tests (scripts/check_ci_filter_reads.py --fix writes it):"
END = "  # End of the files this tier's tests read."
TEST_NAME = re.compile(r"(^test_.*\.py$|_test\.py$|\.(spec|test)\.[cm]?[jt]sx?$)")
# One token per match, no nested quantifiers: a string literal on one line, a
# joining operator, or any other single non-space character (which ends a chain).
TOKEN = re.compile(r"\"[^\"\n]*\"|'[^'\n]*'|`[^`\n]*`|[/,]|\S")


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [path for path in out.split("\0") if path]


def harness_tests() -> set[str]:
    """The tests `be:test:harness` runs: CI's Repo checks runs them on every pull request, unfiltered."""
    task = yaml.safe_load(HARNESS_TASK.read_text(encoding="utf-8"))["tasks"]["be:test:harness"]
    return {word for command in task["cmds"] for word in str(command).split() if word.endswith(".py")}


def tier_patterns() -> dict[str, list[str]]:
    filters = yaml.safe_load(FILTERS.read_text(encoding="utf-8"))
    return {tier: filters[tier] for tier in TIERS}


def python_tokens(source: str) -> list[str]:
    """String literals (docstrings and f-strings aside) and the `/` `,` operators, comments dropped."""
    tokens: list[str] = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.STRING and token.string.lstrip("rbuRBU").startswith(('"""', "'''")):
                tokens.append(";")  # a docstring is prose: it names paths, it does not open them
            elif token.type == tokenize.STRING:
                prefix = token.string[: len(token.string) - len(token.string.lstrip("rbuRBU"))]
                tokens.append(f'"{token.string[len(prefix) + 1 : -1]}"')
            elif token.type == tokenize.OP:
                tokens.append(token.string)
            elif token.type not in (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT):
                tokens.append(token.string)
    except (tokenize.TokenError, SyntaxError):
        return []
    return tokens


def opens_string(before: str) -> bool:
    """Whether a quote after `before` starts a string, not an apostrophe in JSX text or a regex."""
    before = before.rstrip()
    return not before or before[-1] in "(,=:[!&|?{};+" or before.endswith(("=>", "return", "case"))


def script_tokens(source: str) -> list[str]:
    """The same for JavaScript and TypeScript: comments are stripped first, outside strings."""
    code: list[str] = []
    index, quote = 0, ""
    while index < len(source):
        char = source[index]
        if quote:
            code.append(char)
            if char == "\\":
                code.append(source[index + 1 : index + 2])
                index += 1
            elif char == quote:
                quote = ""
        elif char == "`" or char in "\"'" and opens_string("".join(code[-80:])):
            quote = char
            code.append(char)
        elif source.startswith("//", index):
            index = source.find("\n", index)
            index = len(source) if index < 0 else index
            continue
        elif source.startswith("/*", index):
            end = source.find("*/", index + 2)
            index = len(source) if end < 0 else end + 2
            continue
        else:
            code.append(char)
        index += 1
    return [match.group() for match in TOKEN.finditer("".join(code))]


def chains(tokens: list[str]) -> list[str]:
    """Each run of string literals joined by `/` or `,`, as one slash-joined path."""
    found: list[str] = []
    parts: list[str] = []
    joined = False
    for token in tokens:
        if len(token) > 1 and token[0] in "\"'`" and token[-1] == token[0]:
            literal = token[1:-1]
            if parts and not joined:
                found.append("/".join(parts))
                parts = []
            if "${" in literal or not literal.strip("/"):
                parts, joined = [], False
                continue
            parts.append(literal.strip("/"))
            joined = False
        elif token in ("/", ",") and parts:
            joined = True
        else:
            if parts:
                found.append("/".join(parts))
            parts, joined = [], False
    if parts:
        found.append("/".join(parts))
    return found


def files_read(test: str, source: str, files: set[str], directories: set[str]) -> set[str]:
    """The tracked files `source` names, directly or under a directory it names."""
    tokens = python_tokens(source) if test.endswith(".py") else script_tokens(source)
    # Every leading run of a chain, so an argument after the path (`_ts_number(LIB / "a.ts", "NAME")`)
    # does not hide it. A path has a directory in it: a bare name (`'README.md'` as test data) is not one.
    candidates = {
        "/".join(parts[:end])
        for chain in chains(tokens)
        for parts in [PurePosixPath(chain).parts]
        for end in range(1, len(parts) + 1)
    }
    bases = [chain for chain in candidates if chain in directories]
    read = {chain for chain in candidates if "/" in chain and chain in files}
    for chain in candidates:
        read.update(f"{base}/{chain}" for base in bases if f"{base}/{chain}" in files)
    return read


def reads_by_test(patterns: dict[str, list[str]]) -> dict[str, tuple[list[str], set[str]]]:
    """For each filtered test file: the tiers that run it and the tracked files it reads."""
    paths = tracked()
    files = set(paths)
    directories = {str(parent) for path in paths for parent in PurePosixPath(path).parents if str(parent) != "."}
    exempt = harness_tests()
    found: dict[str, tuple[list[str], set[str]]] = {}
    for test in paths:
        if test in exempt or not TEST_NAME.search(PurePosixPath(test).name):
            continue
        tiers = [tier for tier, globs in patterns.items() if glob.globmatch(test, globs, flags=FLAGS)]
        if tiers:
            source = (ROOT / test).read_text(encoding="utf-8", errors="replace")
            found[test] = (tiers, files_read(test, source, files, directories) - {test})
    return found


def missing(patterns: dict[str, list[str]]) -> dict[str, dict[str, str]]:
    """Per tier, each file one of its tests reads that no tier running that test names, and the test."""
    gaps: dict[str, dict[str, str]] = {}
    for test, (tiers, reads) in sorted(reads_by_test(patterns).items()):
        for path in sorted(reads):
            if not any(glob.globmatch(path, patterns[tier], flags=FLAGS) for tier in tiers):
                gaps.setdefault(tiers[0], {}).setdefault(path, test)
    return gaps


def generated(text: str, tier: str) -> list[str]:
    """The paths in `tier`'s generated block of filters.yml, in order."""
    lines = text.splitlines()
    start = lines.index(f"{tier}:")
    block: list[str] = []
    inside = False
    for line in lines[start + 1 :]:
        if line and not line.startswith(" "):
            break
        if line == BEGIN:
            inside = True
        elif line == END:
            break
        elif inside:
            block.append(line.strip()[3:-1])
    return block


def hand_patterns(text: str) -> dict[str, list[str]]:
    """Each tier's patterns without its generated block: what a person chose to watch.

    Tier membership and coverage are both decided on these, so a test file that
    another tier's block names does not join that tier.
    """
    filters = yaml.safe_load(text)
    return {tier: [p for p in filters[tier] if p not in set(generated(text, tier))] for tier in TIERS}


def write_blocks(needed: dict[str, dict[str, str]]) -> None:
    """Rewrite each tier's generated block to exactly its needed reads, at the tier's end."""
    text = FILTERS.read_text(encoding="utf-8")
    for tier in TIERS:
        lines = text.splitlines()
        start = lines.index(f"{tier}:")
        end = next((i for i in range(start + 1, len(lines)) if lines[i] and not lines[i].startswith(" ")), len(lines))
        body = lines[start + 1 : end]
        if BEGIN in body:
            body = body[: body.index(BEGIN)] + body[body.index(END) + 1 :]
        while body and not body[-1].strip():
            body.pop()
        paths = sorted(needed.get(tier, {}))
        if paths:
            body += [BEGIN, *(f"  - '{path}'" for path in paths), END]
        text = "\n".join([*lines[: start + 1], *body, *lines[end:]]) + "\n"
    FILTERS.write_text(text, encoding="utf-8")


def drift() -> tuple[dict[str, dict[str, str]], dict[str, list[str]]]:
    """The reads the generated blocks lack, and the entries they hold that no test reads any more."""
    text = FILTERS.read_text(encoding="utf-8")
    needed = missing(hand_patterns(text))
    absent = {
        tier: {p: t for p, t in reads.items() if p not in generated(text, tier)} for tier, reads in needed.items()
    }
    stale = {tier: [p for p in generated(text, tier) if p not in needed.get(tier, {})] for tier in TIERS}
    return {k: v for k, v in absent.items() if v}, {k: v for k, v in stale.items() if v}


def main(argv: list[str] | None = None) -> int:
    if "--fix" in (sys.argv[1:] if argv is None else argv):
        write_blocks(missing(hand_patterns(FILTERS.read_text(encoding="utf-8"))))
    absent, stale = drift()
    if not absent and not stale:
        print("CI filter reads: every file a test reads as source is in its tier's filter.")
        return 0
    print("CI filter reads FAILED: .github/filters.yml does not match what the tests read.", file=sys.stderr)
    for tier, reads in absent.items():
        for path, test in reads.items():
            print(f"  - {tier} lacks {path} (read by {test})", file=sys.stderr)
    for tier, paths in stale.items():
        for path in paths:
            print(f"  - {tier} still lists {path}, which no test of its reads now", file=sys.stderr)
    print("Run `python scripts/check_ci_filter_reads.py --fix` to rewrite the generated blocks.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
