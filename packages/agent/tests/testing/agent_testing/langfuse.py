"""The OTel collector exporter the Langfuse trace suites configure."""

from __future__ import annotations

from agent.observability.otel_header_redaction_exporter import OtelCollectorRedactionTelemetryExporter

ENDPOINT = "http://otel-collector:4318/v1/traces"


def _make_config() -> OtelCollectorRedactionTelemetryExporter:
    return OtelCollectorRedactionTelemetryExporter(
        _type="otelcollector_redaction", project="backend-chat", endpoint=ENDPOINT
    )
