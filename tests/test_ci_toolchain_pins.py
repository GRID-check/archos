"""The versions CI tests against are production's, and the runner image agrees with CI.

Each pin below is written in more than one place, because each place has to be
readable on its own: the Pulumi program deploys production, the CI runner image
(`deploy/ci-runner/Dockerfile`, ADR-0119) carries binaries for the cluster's
runners, the test scripts fetch the same binaries anywhere else, and the
workflow pins what GitHub's runners use. Nothing but this file holds them
together, and the failure it prevents is quiet: the RLS suite ran on Postgres 16
for as long as production ran 17, because it took whatever server binaries the
runner image had.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "deploy" / "ci-runner" / "Dockerfile"


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def one(pattern: str, text: str, where: str) -> str:
    found = re.findall(pattern, text, flags=re.MULTILINE)
    assert len(found) == 1, f"expected one match for {pattern!r} in {where}, found {found}"
    return found[0]


def runner_arg(name: str) -> str:
    return one(rf"^ARG {name}=(\S+)$", DOCKERFILE.read_text(encoding="utf-8"), "deploy/ci-runner/Dockerfile")


def test_ci_tests_against_productions_qdrant():
    production = one(
        r'"qdrantImage"\) \?\? "qdrant/qdrant:v([0-9.]+)"', read("deploy/pulumi/src/config.ts"), "config.ts"
    )
    script = read("scripts/qdrant-test-server.sh")
    assert one(r'^QDRANT_VERSION="([0-9.]+)"$', script, "qdrant-test-server.sh") == production
    assert runner_arg("QDRANT_VERSION") == production
    for compose in ("deploy/compose/docker-compose.yaml", "deploy/compose/docker-compose.coolify.yaml"):
        assert one(r"QDRANT_IMAGE:-qdrant/qdrant:v([0-9.]+)\}", read(compose), compose) == production


def test_the_runner_image_carries_the_binary_the_script_would_download():
    script = read("scripts/qdrant-test-server.sh")
    linux = one(r"Linux-x86_64\) echo \"x86_64-unknown-linux-gnu ([a-f0-9]{64})\"", script, "qdrant-test-server.sh")
    assert runner_arg("QDRANT_SHA256") == linux


def test_ci_tests_against_productions_postgres_major():
    production = one(
        r'imageName: "ghcr\.io/cloudnative-pg/postgresql:(\d+)"',
        read("deploy/pulumi/src/data/postgres.ts"),
        "postgres.ts",
    )
    assert runner_arg("POSTGRES_MAJOR") == production


def test_the_runner_image_scanners_are_the_versions_ci_runs():
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    ci = read(".github/workflows/ci.yml")
    trivy = one(r'^\s+TRIVY_VERSION: "([0-9.]+)"$', ci, "ci.yml")
    assert one(r"^FROM aquasec/trivy:([0-9.]+)@sha256:[a-f0-9]{64} AS trivy$", dockerfile, "Dockerfile") == trivy
    gitleaks_script = ROOT / "ci" / "gitleaks.sh"
    if gitleaks_script.exists():
        gitleaks = one(r'^GITLEAKS_VERSION="([0-9.]+)"$', gitleaks_script.read_text(encoding="utf-8"), "ci/gitleaks.sh")
    else:
        gitleaks = one(r"zricethezav/gitleaks:v([0-9.]+)", ci, "ci.yml")
    assert (
        one(r"^FROM zricethezav/gitleaks:v([0-9.]+)@sha256:[a-f0-9]{64} AS gitleaks$", dockerfile, "Dockerfile")
        == gitleaks
    )


def test_the_runner_image_node_is_the_major_ci_sets_up():
    majors = set(re.findall(r'node-version: "(\d+)"', read(".github/workflows/ci.yml")))
    assert len(majors) == 1, f"ci.yml sets up more than one Node major: {majors}"
    assert runner_arg("NODE_VERSION").split(".")[0] == majors.pop()


def test_every_base_image_in_the_runner_image_is_pinned_by_digest():
    for line in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("FROM "):
            assert re.search(r"@sha256:[a-f0-9]{64}( AS \w+)?$", line), f"unpinned base image: {line}"
