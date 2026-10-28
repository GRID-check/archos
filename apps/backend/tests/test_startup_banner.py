"""The boot line's format, pinned on the Python side.

Same table as ``apps/workspace/tests/lib/boot.test.ts``. The two services print
the same line so one ``grep '^\\[boot\\]'`` over a deployment answers "what is
this running, and where do its flags come from" for both tiers at once; that
only holds if both sides agree on the format down to the rule that reads
``REQUIRE_AUTH``, which is what these cases assert. The cases are duplicated rather than shared through a
fixture on purpose — a fixture would pin the format to itself, and what needs
pinning is the *rendered line*, which is what an operator actually greps.
"""

from __future__ import annotations

import logging

import pytest

from agent_host.startup_banner import UNKNOWN_SHA
from agent_host.startup_banner import boot_line
from agent_host.startup_banner import deployed_sha
from agent_host.startup_banner import flag_source
from agent_host.startup_banner import format_boot_line
from agent_host.startup_banner import log_boot_line

# (name, env, expected line) — byte-identical to the TypeScript spec's table.
CASES = [
    (
        "an unstamped image with nothing configured — the compose defaults",
        {},
        "[boot] sha=unknown flags=defaults",
    ),
    (
        "a published image that signs people in",
        {
            "GIT_SHA": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",  # pragma: allowlist secret
            "REQUIRE_AUTH": "true",
        },
        "[boot] sha=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c flags=workos",  # pragma: allowlist secret
    ),
    (
        "REQUIRE_AUTH=false is the anonymous deployment, not WorkOS",
        {"GIT_SHA": "abc1234", "REQUIRE_AUTH": "false"},
        "[boot] sha=abc1234 flags=defaults",
    ),
    (
        'only the exact word true signs people in — "1" does not',
        {"REQUIRE_AUTH": "1"},
        "[boot] sha=unknown flags=defaults",
    ),
    (
        "case is ignored and the sha is trimmed, as an env_file produces them",
        {"GIT_SHA": "  deadbeef  ", "REQUIRE_AUTH": "TRUE"},
        "[boot] sha=deadbeef flags=workos",
    ),
    (
        "a padded REQUIRE_AUTH is anonymous, because isAuthRequired reads it so",
        {"REQUIRE_AUTH": " true "},
        "[boot] sha=unknown flags=defaults",
    ),
    (
        "an empty GIT_SHA is an unstamped image, not an empty sha",
        {"GIT_SHA": ""},
        "[boot] sha=unknown flags=defaults",
    ),
]


@pytest.mark.parametrize(("name", "env", "expected"), CASES, ids=[c[0] for c in CASES])
def test_the_line_renders_the_same_as_the_bff_does(name: str, env: dict, expected: str) -> None:
    assert boot_line(env) == expected
    assert format_boot_line(deployed_sha(env), flag_source(env)) == expected


def test_an_unstamped_image_is_named_rather_than_left_blank() -> None:
    # "sha=" in a log reads as a truncation; "unknown" reads as the fact.
    assert deployed_sha({}) == UNKNOWN_SHA
    assert f"sha={UNKNOWN_SHA}" in boot_line({})


@pytest.mark.parametrize(("name", "env", "expected"), CASES, ids=[c[0] for c in CASES])
def test_it_is_one_line_because_an_operator_greps_for_it(name: str, env: dict, expected: str) -> None:
    line = boot_line(env)
    assert "\n" not in line
    assert line.startswith("[boot] ")


def test_log_boot_line_emits_at_info_and_returns_what_it_logged(caplog, monkeypatch) -> None:
    monkeypatch.delenv("GIT_SHA", raising=False)
    monkeypatch.setenv("REQUIRE_AUTH", "true")

    with caplog.at_level(logging.INFO, logger="agent_host.startup_banner"):
        line = log_boot_line()

    assert line == boot_line(dict(__import__("os").environ))
    assert any(record.getMessage() == line for record in caplog.records)


def test_build_app_prints_it_before_anything_else_registers() -> None:
    """The line is worthless if a crash during route registration precedes it.

    Reading the source rather than building the app: ``build_app`` pulls the
    whole NAT front-end stack, which this suite cannot stand up, and what
    matters here is ORDER — that ``log_boot_line()`` sits ahead of
    ``super().build_app()``, so a container that fails to come up has still
    said which build failed.
    """
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "src/agent_host/plugin.py").read_text(encoding="utf-8")
    assert "log_boot_line()" in source, "plugin.py no longer emits the boot line"
    assert source.index("log_boot_line()") < source.index("app = super().build_app()")
