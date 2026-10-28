"""The process's one MeterProvider: OTLP metrics to the collector, which forwards them to PostHog Metrics.

Every ``grid.*`` instrument (``grid.queue.*``, ``grid.provider.*``,
``grid.boot.*``) measures through the OpenTelemetry API and records into
whatever global provider exists. ``install`` sets it once per process and
nothing here ever stops it: the research worker builds a workflow per job,
OpenTelemetry sets the global provider once, and a provider stopped with the
first workflow left every later job recording into a dead one
(``docs/contributing/gotchas.md``, "Overriding of current MeterProvider is not
allowed"). The SDK flushes it at interpreter exit through its own ``atexit``
hook.

Same capability doctrine as the logs and traces (ADR-0029): no collector
endpoint, no provider, and the instruments stay no-ops.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Mapping

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider

from agent.observability.otlp_resource import ENDPOINT_ENV
from agent.observability.otlp_resource import resource_attributes
from agent.observability.otlp_resource import signal_endpoint

logger = logging.getLogger(__name__)

#: How often readings leave the process. PostHog charts at minute resolution,
#: and the collector's own scrapes run every 30 s.
EXPORT_INTERVAL_MS = 30_000

_provider: MeterProvider | None = None
_lock = threading.Lock()


def install(endpoint: str, env: Mapping[str, str] | None = None) -> MeterProvider:
    """Make the global MeterProvider export to the collector at ``endpoint``; later calls return the first one."""
    global _provider
    with _lock:
        if _provider is None:
            _provider = _build(endpoint, os.environ if env is None else env)
            metrics.set_meter_provider(_provider)
        return _provider


def install_from_env(env: Mapping[str, str] | None = None) -> MeterProvider | None:
    """``install`` from the collector endpoint the deployment injects; None (no provider) without one.

    For a process that reports before it builds a workflow: the research
    worker observes its queue from start, but builds a workflow per job.
    """
    env = os.environ if env is None else env
    endpoint = env.get(ENDPOINT_ENV, "").strip()
    return install(endpoint, env) if endpoint else None


def _build(endpoint: str, env: Mapping[str, str]) -> MeterProvider:
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource

    url = signal_endpoint(endpoint, "metrics")
    reader = PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=url), export_interval_millis=EXPORT_INTERVAL_MS)
    logger.info("otlp_metrics: exporting OTLP metrics to %s", url)
    return MeterProvider(resource=Resource.create(resource_attributes(env)), metric_readers=[reader])
