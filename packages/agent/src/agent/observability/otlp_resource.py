"""Where a signal goes and who sent it: the two rules every OTLP exporter in this process shares.

Pulumi injects ``OTEL_EXPORTER_OTLP_ENDPOINT`` as the collector's full traces
path (``http://otel-collector:4318/v1/traces``), because the agent-runtime span exporter
posts to an explicit endpoint as-is (ADR-0029). Logs and metrics are its
siblings on the same collector.

The resource names the tier (``service.name``), the build (``service.version``,
the commit both Dockerfiles stamp as ``GIT_SHA``) and the process
(``service.instance.id``, the pod; ``process.pid``). The process matters most to
metrics: a cumulative counter from two replicas under one identity reads as one
series jumping between their totals.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT"
SERVICE_NAME_ENV = "OTEL_SERVICE_NAME"
#: The agent-runtime exporter's ``project`` default in ``configs/config_oib_openrouter.yml``,
#: so every signal from an unnamed process sits under the chat turns' service.
DEFAULT_SERVICE_NAME = "backend-chat"

Signal = Literal["traces", "logs", "metrics"]
_SIGNALS: tuple[Signal, ...] = ("traces", "logs", "metrics")


def signal_endpoint(endpoint: str, signal: Signal) -> str:
    """The OTLP/HTTP path for ``signal`` on the collector ``endpoint`` names, bare or with a signal path."""
    base = endpoint.strip().rstrip("/")
    for known in _SIGNALS:
        suffix = f"/v1/{known}"
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return f"{base}/v1/{signal}"


def resource_attributes(env: Mapping[str, str], pid: int | None = None) -> dict[str, str | int]:
    """The resource every exported span, record and reading carries; blank values are left out."""
    attributes: dict[str, str | int] = {
        "service.name": env.get(SERVICE_NAME_ENV, "").strip() or DEFAULT_SERVICE_NAME,
        "process.pid": os.getpid() if pid is None else pid,
    }
    sha = env.get("GIT_SHA", "").strip()
    if sha:
        attributes["service.version"] = sha
    instance = env.get("HOSTNAME", "").strip()
    if instance:
        attributes["service.instance.id"] = instance
    return attributes
