"""Where each OTLP signal goes, and the resource that says who sent it."""

import pytest

from aiq_agent.observability.otlp_resource import resource_attributes
from aiq_agent.observability.otlp_resource import signal_endpoint


@pytest.mark.parametrize(
    "configured",
    [
        "http://otel-collector:4318/v1/traces",  # what Pulumi injects
        "http://otel-collector:4318/v1/traces/",
        "http://otel-collector:4318/v1/logs",
        "http://otel-collector:4318",
        " http://otel-collector:4318/ ",
    ],
)
@pytest.mark.parametrize("signal", ["traces", "logs", "metrics"])
def test_every_signal_is_a_sibling_on_the_same_collector(configured, signal):
    assert signal_endpoint(configured, signal) == f"http://otel-collector:4318/v1/{signal}"


def test_the_resource_names_the_tier_the_build_and_the_process():
    # service.version tells a regression from a pod still running the old
    # image; the instance keeps two replicas' cumulative counters apart.
    env = {"OTEL_SERVICE_NAME": "grid-agent-worker", "GRID_GIT_SHA": " abc123 ", "HOSTNAME": "agent-worker-7f9c-x2"}
    assert resource_attributes(env, pid=7) == {
        "service.name": "grid-agent-worker",
        "service.version": "abc123",
        "service.instance.id": "agent-worker-7f9c-x2",
        "process.pid": 7,
    }


def test_blank_values_are_left_out_and_the_name_falls_back_to_the_chat_service():
    assert resource_attributes({"OTEL_SERVICE_NAME": " ", "GRID_GIT_SHA": "", "HOSTNAME": ""}, pid=7) == {
        "service.name": "backend-chat",
        "process.pid": 7,
    }
