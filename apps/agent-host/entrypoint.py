"""Launch the web server for the chat and api roles, or hand off to a worker module."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import MutableMapping

#: The values of ``PROCESS_ROLE``; the two web roles both start ``start_web.py``.
ROLES = ("chat", "api", "worker", "ingest-worker")

#: The prefixes the variables carried before they lost the product's name,
#: newest first: ``GRID_X``, then ``AIQ_X``, is read as ``X`` for one release,
#: then this fallback goes. Mirrored, with ``RENAMED``, in
#: ``apps/workspace/scripts/legacy-env-names.cjs`` for the UI image's processes.
LEGACY_PREFIXES = ("GRID_", "AIQ_")

#: Where the bare name would collide with a variable a library or the platform
#: already reads (``ROLE``, ``VERBOSE``, the ``LANGFUSE_`` namespace), or would
#: still carry the product's name, the variable got a name of its own.
RENAMED = {
    "ROLE": "PROCESS_ROLE",
    "VERBOSE": "AGENT_VERBOSE",
    "LANGFUSE_TRACE_RETENTION_DAYS": "TRACE_RETENTION_DAYS",
    "PILOTI_ASK_MAX_SECONDS": "AGENT_ASK_MAX_SECONDS",
}

#: Every reader reads the new names, so an old one is worth a warning.
WARN = True


def current_name(legacy: str) -> str | None:
    """The name ``legacy`` is read as now (`GRID_MAX_ACTIVE_JOBS_PER_ORG` → `MAX_ACTIVE_JOBS_PER_ORG`), or None."""
    for prefix in LEGACY_PREFIXES:
        rest = legacy.removeprefix(prefix)
        if rest != legacy and rest:
            return RENAMED.get(rest, rest)
    return None


def _warn(line: str) -> None:
    if WARN:
        print(line, file=sys.stderr, flush=True)


def adopt_legacy_names(environ: MutableMapping[str, str]) -> list[str]:
    """Copy each old name onto its current one where that is unset, warning once per name.

    The one place an old name is still read: every process of the image starts
    here and inherits the result, so no reader in the code knows the old names.
    A name already set wins over ``GRID_X``, which wins over ``AIQ_X``. Returns
    the current names it set.
    """
    adopted = []
    for prefix in LEGACY_PREFIXES:
        for legacy in sorted(name for name in environ if name.startswith(prefix)):
            name = current_name(legacy)
            if name is None:
                continue
            if name in environ:
                _warn(f"WARNING: {legacy} is deprecated and ignored, {name} is set")
                continue
            environ[name] = environ[legacy]
            adopted.append(name)
            _warn(f"WARNING: {legacy} is deprecated; rename it to {name}")
    return adopted


def _terminate_process(proc: subprocess.Popen[str] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main() -> int:
    adopt_legacy_names(os.environ)
    if len(sys.argv) > 1:
        os.execvp(sys.argv[1], sys.argv[1:])

    # One image, one process type per job (ADR-0082): `chat` and `api` are the web
    # roles (the plugin mounts what each serves, `agent_host.roles`), `worker` and
    # `ingest-worker` claim jobs from the database. There is no default: a
    # process that does not say what it is stops here rather than guess.
    role = os.getenv("PROCESS_ROLE", "").strip().lower()
    if role not in ROLES:
        raise SystemExit(f"PROCESS_ROLE={role!r} is not a role of this image: set it to one of {', '.join(ROLES)}")
    # A dedicated worker container runs the DB-claimed research worker — no web
    # server (ADR-0021).
    if role == "worker":
        print("Starting DB-claimed research worker (PROCESS_ROLE=worker)...", flush=True)
        os.execvp("python", ["python", "-m", "agent_host.jobs.worker"])
    # The ingestion tier (ADR-0076): claims from the durable ingest queue, fairly
    # across organisations. No web server; scaled on the queue's depth.
    if role == "ingest-worker":
        print("Starting DB-claimed ingest worker (PROCESS_ROLE=ingest-worker)...", flush=True)
        os.execvp("python", ["python", "-m", "agent_host.jobs.ingest_worker"])

    config_file = os.getenv(
        "CONFIG_FILE",
        "/app/configs/config_oib_openrouter.yml",
    )
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    print("============================================", flush=True)
    print("Agent web tier", flush=True)
    print(f"Config: {config_file}", flush=True)
    print(f"API:    http://{host}:{port}", flush=True)
    print("============================================", flush=True)

    # The base corpus is not synced from here: it lives in object storage and a
    # table (ADR-0082), and one sync cycle runs as the base-corpus housekeeping
    # route, on a schedule outside this process.
    web_proc = subprocess.Popen(["python", "/app/apps/agent-host/start_web.py"])

    def _handle_web_signal(_signum: int, _frame: object) -> None:
        print("Shutting down...", flush=True)
        _terminate_process(web_proc)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_web_signal)
    signal.signal(signal.SIGINT, _handle_web_signal)
    return web_proc.wait()


if __name__ == "__main__":
    sys.exit(main())
