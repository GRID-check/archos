"""Launch the web server for the chat and api roles, or hand off to a worker module."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import MutableMapping

#: The values of ``GRID_ROLE``; the two web roles both start ``start_web.py``.
ROLES = ("chat", "api", "worker", "ingest-worker")

#: The prefix the variables carried before they took the house prefix ``GRID_``.
#: Read for one release, then this fallback goes (ADR-0145 row 10b).
LEGACY_PREFIX = "AIQ_"
PREFIX = "GRID_"


def adopt_legacy_names(environ: MutableMapping[str, str]) -> list[str]:
    """Copy each ``AIQ_X`` onto ``GRID_X`` where that is unset, warning once per name.

    The one place an old name is still read: every process of the image starts
    here and inherits the result, so no reader in the code knows the old names.
    Returns the new names it set.
    """
    adopted = []
    for legacy in sorted(name for name in environ if name.startswith(LEGACY_PREFIX)):
        name = PREFIX + legacy.removeprefix(LEGACY_PREFIX)
        if name in environ:
            print(f"WARNING: {legacy} is deprecated and ignored, {name} is set", file=sys.stderr, flush=True)
            continue
        environ[name] = environ[legacy]
        adopted.append(name)
        print(f"WARNING: {legacy} is deprecated; rename it to {name}", file=sys.stderr, flush=True)
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
    # roles (the plugin mounts what each serves, `aiq_api.roles`), `worker` and
    # `ingest-worker` claim jobs from the database. There is no default: a
    # process that does not say what it is stops here rather than guess.
    role = os.getenv("GRID_ROLE", "").strip().lower()
    if role not in ROLES:
        raise SystemExit(f"GRID_ROLE={role!r} is not a role of this image: set it to one of {', '.join(ROLES)}")
    # A dedicated worker container runs the DB-claimed research worker — no web
    # server (ADR-0021).
    if role == "worker":
        print("Starting DB-claimed research worker (GRID_ROLE=worker)...", flush=True)
        os.execvp("python", ["python", "-m", "aiq_api.jobs.worker"])
    # The ingestion tier (ADR-0076): claims from the durable ingest queue, fairly
    # across organisations. No web server; scaled on the queue's depth.
    if role == "ingest-worker":
        print("Starting DB-claimed ingest worker (GRID_ROLE=ingest-worker)...", flush=True)
        os.execvp("python", ["python", "-m", "aiq_api.jobs.ingest_worker"])

    config_file = os.getenv(
        "CONFIG_FILE",
        "/app/configs/config_oib_openrouter.yml",
    )
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    print("============================================", flush=True)
    print("Grid agent web tier", flush=True)
    print(f"Config: {config_file}", flush=True)
    print(f"API:    http://{host}:{port}", flush=True)
    print("============================================", flush=True)

    # The base corpus is not synced from here: it lives in object storage and a
    # table (ADR-0082), and one sync cycle runs as the base-corpus housekeeping
    # route, on a schedule outside this process.
    web_proc = subprocess.Popen(["python", "/app/deploy/start_web.py"])

    def _handle_web_signal(_signum: int, _frame: object) -> None:
        print("Shutting down...", flush=True)
        _terminate_process(web_proc)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_web_signal)
    signal.signal(signal.SIGINT, _handle_web_signal)
    return web_proc.wait()


if __name__ == "__main__":
    sys.exit(main())
