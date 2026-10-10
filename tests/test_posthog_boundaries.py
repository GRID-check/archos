"""The two boundaries ADR-0099 draws around PostHog, held by something other than review.

1. **One client per runtime.** ``src/aiq_agent/observability/posthog_client.py``
   is the only Python module that imports the ``posthog`` SDK, and
   ``frontends/ui/src/lib/analytics/posthog-server.ts`` the only BFF module that
   imports ``posthog-node``. ``posthog-js`` is reached only through
   ``frontends/ui/src/lib/analytics/posthog.ts``. A second client is a second
   place deciding whether PostHog is on, which host it talks to and what it may
   send. That is how a privacy default gets lost. The one bought exception is
   ``@posthog/next``'s request-error capture, which builds its own posthog-node
   client: ``frontends/ui/src/lib/analytics/request-error.ts`` is the only module
   that imports it (and ``@posthog/core``'s rate limiter beside it), and it
   configures that client from ``posthog-server.ts``'s settings and scrubber.
2. **LLM data reaches PostHog through Langfuse.** Langfuse's PostHog
   integration exports observations and scores. Our code emits none of
   PostHog's AI-observability events. A ``$ai_generation`` captured from our code
   would double-count cost against the free tier and send model input past the
   Langfuse redaction and identity gates.

The scan is textual on purpose: it reads every file a contributor could add an
import to, with no build and no node_modules.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

PYTHON_ROOTS = ("src", "sources", "frontends/aiq_api/src", "scripts")
TS_ROOTS = ("frontends/ui/src", "frontends/ui/workers", "frontends/ui/purger", "frontends/ui/scheduler")
TS_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}

PYTHON_CLIENT = "src/aiq_agent/observability/posthog_client.py"
BROWSER_CLIENT = "frontends/ui/src/lib/analytics/posthog.ts"
SERVER_CLIENT = "frontends/ui/src/lib/analytics/posthog-server.ts"
REQUEST_ERRORS = "frontends/ui/src/lib/analytics/request-error.ts"

_PY_IMPORT = re.compile(r"^\s*(?:from\s+posthog(?:\.\w+)*\s+import|import\s+posthog\b)", re.MULTILINE)
_TS_IMPORT = re.compile(
    r"""(?:from\s+|require\(\s*|import\(\s*)['"](posthog-js|posthog-node|@posthog/[\w-]+)(?:/[^'"]*)?['"]"""
)

#: PostHog's AI-observability event names (https://posthog.com/docs/ai-observability/surfaces/api).
AI_EVENTS = ("$ai_generation", "$ai_trace", "$ai_span", "$ai_embedding", "$ai_metric", "$ai_feedback")
_AI_EVENT = re.compile(r"""['"](\$ai_(?:generation|trace|span|embedding|metric|feedback))['"]""")


def _is_test(path: Path) -> bool:
    name = path.name
    return (
        ".spec." in name
        or ".test." in name
        or name.startswith("test_")
        or "__tests__" in path.parts
        or "tests" in path.parts
    )


def _files(roots: tuple[str, ...], suffixes: set[str]) -> list[Path]:
    found: list[Path] = []
    for root in roots:
        base = REPO_ROOT / root
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix in suffixes and "node_modules" not in path.parts and not _is_test(path):
                found.append(path)
    return found


def _rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def test_only_the_python_client_imports_the_posthog_sdk() -> None:
    offenders = [
        _rel(path)
        for path in _files(PYTHON_ROOTS, {".py"})
        if _rel(path) != PYTHON_CLIENT and _PY_IMPORT.search(path.read_text(encoding="utf-8", errors="ignore"))
    ]
    assert offenders == [], f"import PostHog through {PYTHON_CLIENT}, not directly: {offenders}"


def test_only_the_two_ts_clients_import_posthog_packages() -> None:
    allowed = {
        "posthog-js": BROWSER_CLIENT,
        "posthog-node": SERVER_CLIENT,
        "@posthog/next": REQUEST_ERRORS,
        "@posthog/core": REQUEST_ERRORS,
    }
    offenders: list[str] = []
    for path in _files(TS_ROOTS, TS_SUFFIXES):
        rel = _rel(path)
        for package in _TS_IMPORT.findall(path.read_text(encoding="utf-8", errors="ignore")):
            if allowed.get(package) != rel:
                offenders.append(f"{rel} imports {package}")
    assert offenders == [], f"reach PostHog through {BROWSER_CLIENT} or {SERVER_CLIENT}: {offenders}"


def test_no_code_emits_posthog_ai_observability_events() -> None:
    offenders: list[str] = []
    for path in _files(PYTHON_ROOTS, {".py"}) + _files(TS_ROOTS, TS_SUFFIXES):
        for event in _AI_EVENT.findall(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(f"{_rel(path)}: {event}")
    assert offenders == [], f"LLM data reaches PostHog through Langfuse's integration (ADR-0099): {offenders}"


def test_the_scanners_see_what_they_guard(tmp_path: Path) -> None:
    """The regexes fire on the shapes they exist to catch, so a green run means something."""
    assert _PY_IMPORT.search("from posthog import Posthog")
    assert _PY_IMPORT.search("import posthog")
    assert not _PY_IMPORT.search("from aiq_agent.observability import posthog_client")
    assert _TS_IMPORT.findall("import { PostHog } from 'posthog-node'") == ["posthog-node"]
    assert _TS_IMPORT.findall('import posthog from "posthog-js/react"') == ["posthog-js"]
    assert _TS_IMPORT.findall("import { useThumbSurvey } from '@posthog/react'") == ["@posthog/react"]
    assert _AI_EVENT.findall("capture('$ai_generation', {})") == ["$ai_generation"]
    assert not _AI_EVENT.findall("properties['$ai_trace_id'] = trace_id")
    assert set(AI_EVENTS) >= {"$ai_generation", "$ai_metric"}
