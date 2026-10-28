"""The process's MeterProvider, installed from the environment by a process that reports before any workflow."""

from opentelemetry import metrics as otel_metrics

from agent.observability import otlp_metrics


def test_no_provider_without_a_collector(monkeypatch):
    calls: list[object] = []
    monkeypatch.setattr(otel_metrics, "set_meter_provider", calls.append)
    monkeypatch.setattr(otlp_metrics, "_provider", None)

    assert otlp_metrics.install_from_env({"OTEL_EXPORTER_OTLP_ENDPOINT": "  "}) is None
    assert otlp_metrics.install_from_env({}) is None
    assert calls == []


def test_the_injected_endpoint_installs_the_one_provider(monkeypatch):
    calls: list[object] = []
    monkeypatch.setattr(otel_metrics, "set_meter_provider", calls.append)
    monkeypatch.setattr(otlp_metrics, "_provider", None)
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel-collector:4318/v1/traces"}

    first = otlp_metrics.install_from_env(env)
    # The workflow the first job builds installs again through the logging method.
    second = otlp_metrics.install(env["OTEL_EXPORTER_OTLP_ENDPOINT"], env)

    assert first is second
    assert calls == [first]
    first.shutdown()
