"""No new path or package name carries a brand (ADR-0145, rule 5).

Code and infrastructure names stay neutral: not `aiq` (the blueprint this repo
was forked from), not `grid` (the company), not `piloti` (the product, which is
due a rebrand). A name with a brand in it has to move the day the brand does.

A ratchet, not a ban. `ci/brand_names_baseline.json` counts, per name, the
tracked paths that end in a component with a brand word in it, plus each
`pyproject.toml` and `package.json` distribution name. It is keyed by the name,
not by the path, so a directory move leaves it alone. A count may only fall: a
name over its count fails, and so does one under it, so the baseline follows
every rename. Rerun with UPDATE_BRAND_NAMES=1.

Exempt as history, whose file names say what was true then: accepted ADRs,
`releasenotes/`, `docs/audit/` and migrations, which are never renamed.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tomllib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = ROOT / "ci" / "brand_names_baseline.json"
BRAND = re.compile(r"aiq|grid|piloti", re.IGNORECASE)
#: `grid` the CSS layout is a word, not the company. A new layout name goes here.
NOT_A_BRAND = frozenset(
    {"document-grid", "file-grid.tsx", "grid-tile.tsx", "projects-grid.spec.tsx", "projects-grid.tsx"}
)
HISTORY = re.compile(r"^(docs/adr|docs/audit|releasenotes)/|(^|/)(drizzle|migrations)/")


def brand_names(paths: list[str]) -> Counter[str]:
    """Each path component with a brand word, counted once per distinct path that ends in it."""
    ends = {
        "/".join(parts[: index + 1])
        for path in paths
        if not HISTORY.search(path)
        for parts in [path.split("/")]
        for index, part in enumerate(parts)
        if BRAND.search(part) and part not in NOT_A_BRAND
    }
    return Counter(end.rsplit("/", 1)[-1] for end in ends)


def _distribution(path: str) -> str | None:
    text = (ROOT / path).read_text(encoding="utf-8")
    if path.endswith("package.json"):
        return json.loads(text).get("name")
    return tomllib.loads(text).get("project", {}).get("name")


def package_names(paths: list[str]) -> Counter[str]:
    manifests = [path for path in paths if path.rsplit("/", 1)[-1] in {"package.json", "pyproject.toml"}]
    names = [name for path in manifests if (name := _distribution(path)) and BRAND.search(name)]
    return Counter(f"package:{name}" for name in names)


def _current() -> dict[str, int]:
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True, check=True)
    paths = [path for path in listed.stdout.split("\0") if path and (ROOT / path).exists()]
    return dict(sorted((brand_names(paths) + package_names(paths)).items()))


def test_a_name_is_counted_once_wherever_it_moves():
    paths = [
        "src/aiq_agent/__init__.py",
        "src/aiq_agent/agents/piloti/graph.py",
        "tests/aiq_agent/test_x.py",
        "apps/site/public/piloti-mark.svg",
        "releasenotes/notes/piloti-launch.yaml",
        "frontends/ui/drizzle/0081_grid_agents.sql",
        "apps/site/src/neutral.ts",
        "apps/workspace/ui/file-grid.tsx",
    ]

    assert brand_names(paths) == {"aiq_agent": 2, "piloti": 1, "piloti-mark.svg": 1}
    assert brand_names([path.replace("src/", "packages/agent/src/") for path in paths[:2]]) == {
        "aiq_agent": 1,
        "piloti": 1,
    }


def test_no_new_path_or_package_name_carries_a_brand():
    current = _current()
    if os.environ.get("UPDATE_BRAND_NAMES"):
        BASELINE_PATH.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    baseline: dict[str, int] = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))

    grown = {name: (baseline.get(name, 0), count) for name, count in current.items() if count > baseline.get(name, 0)}
    assert not grown, (
        "a new name carries aiq, grid or piloti (name: baseline -> now). Name it after its job "
        f"(ADR-0145, rule 5). A CSS layout `grid` belongs in NOT_A_BRAND: {grown}"
    )
    shrunk = {name: (count, current.get(name, 0)) for name, count in baseline.items() if current.get(name, 0) < count}
    assert not shrunk, f"a brand name went away; lower the baseline with UPDATE_BRAND_NAMES=1: {shrunk}"
