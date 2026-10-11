"""The one PostHog client the Python tiers capture through (ADR-0100).

What these cases hold in place: the client is off until both settings arrive
and is then built once with the options the module header promises; and the
behaviour the module leaves to the SDK (personless system events, never
raising, super properties on every event) is checked against the real SDK, so
an upgrade that changes it fails here rather than in PostHog.

The real-SDK cases build the client with ``send=False``: the event runs the
SDK's whole enrichment path and ``before_send``, and nothing leaves the process.
"""

from __future__ import annotations

import functools
from typing import Any

import pytest

from aiq_agent.observability import posthog_client


class FakePosthog:
    instances: list[FakePosthog] = []

    def __init__(self, token: str, **options: Any) -> None:
        self.token = token
        self.options = options
        FakePosthog.instances.append(self)


@pytest.fixture
def fake_sdk(monkeypatch: pytest.MonkeyPatch) -> type[FakePosthog]:
    import posthog

    FakePosthog.instances = []
    monkeypatch.setattr(posthog, "Posthog", FakePosthog)
    posthog_client.reset_for_tests()
    yield FakePosthog
    posthog_client.reset_for_tests()


@pytest.fixture
def configured_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(posthog_client.HOST_ENV, "https://eu.i.posthog.com/")
    monkeypatch.setenv(posthog_client.PROJECT_TOKEN_ENV, "phc_test")
    monkeypatch.setenv("APP_ENV", "Staging")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "grid-agent-worker")


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch, configured_env: None) -> list[dict[str, Any]]:
    """Every event the real SDK hands to ``before_send``, after the scrubber ran."""
    import posthog

    events: list[dict[str, Any]] = []
    scrub = posthog_client._scrub_event

    def record(event: dict[str, Any]) -> dict[str, Any]:
        events.append(scrub(event))
        return event

    monkeypatch.setattr(posthog, "Posthog", functools.partial(posthog.Posthog, send=False))
    monkeypatch.setattr(posthog_client, "_scrub_event", record)
    posthog_client.reset_for_tests()
    yield events
    posthog_client.reset_for_tests()


@pytest.mark.parametrize(
    ("host", "token"),
    [("", ""), ("https://eu.i.posthog.com", ""), ("", "phc_test"), ("  ", "  ")],
)
def test_is_off_until_both_settings_arrive(
    monkeypatch: pytest.MonkeyPatch, fake_sdk: type[FakePosthog], host: str, token: str
) -> None:
    monkeypatch.setenv(posthog_client.HOST_ENV, host)
    monkeypatch.setenv(posthog_client.PROJECT_TOKEN_ENV, token)

    assert posthog_client.posthog_enabled() is False
    assert posthog_client.get_client() is None
    assert posthog_client.capture("x", distinct_id="user_1") is False
    assert posthog_client.capture_exception(ValueError("x")) is False
    assert fake_sdk.instances == []


def test_builds_one_client_with_the_promised_options(configured_env: None, fake_sdk: type[FakePosthog]) -> None:
    first = posthog_client.get_client()
    second = posthog_client.get_client()

    assert first is second
    assert len(fake_sdk.instances) == 1
    client = fake_sdk.instances[0]
    assert client.token == "phc_test"
    assert client.options == {
        "host": "https://eu.i.posthog.com",
        "disable_geoip": True,
        "enable_exception_autocapture": False,
        "before_send": posthog_client._scrub_event,
        "super_properties": {"environment": "staging", "service": "grid-agent-worker"},
        "in_app_modules": ["aiq_agent", "aiq_api"],
    }


def test_absent_super_properties_are_omitted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)

    assert posthog_client.super_properties() == {}


def test_a_user_event_names_the_user(sent: list[dict[str, Any]]) -> None:
    assert posthog_client.capture("job_run_finished", distinct_id="user_1", properties={"status": "ok"}) is True

    event = sent[0]
    assert event["event"] == "job_run_finished"
    assert event["distinct_id"] == "user_1"
    assert event["properties"]["status"] == "ok"
    assert "$process_person_profile" not in event["properties"]
    assert "$groups" not in event["properties"]


def test_a_system_event_mints_no_person(sent: list[dict[str, Any]]) -> None:
    properties = {"status": "ok"}
    assert posthog_client.capture("ingest_finished", distinct_id=None, properties=properties) is True

    assert sent[0]["properties"]["$process_person_profile"] is False
    assert properties == {"status": "ok"}, "the caller's dict must not be mutated"


def test_every_event_carries_the_super_properties_and_no_geoip(sent: list[dict[str, Any]]) -> None:
    posthog_client.capture("x", distinct_id="user_1")

    properties = sent[0]["properties"]
    assert properties["environment"] == "staging"
    assert properties["service"] == "grid-agent-worker"
    assert properties["$geoip_disable"] is True


def test_the_deploys_release_id_links_every_event(sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    # The deploy resolves the PostHog release and hands its id over in this
    # variable; the SDK reads it when the client is built (ci.md).
    monkeypatch.setenv("POSTHOG_RELEASE_ID", "0193f5a6-release")
    posthog_client.capture_exception(ValueError("x"))

    assert sent[0]["properties"]["$release_id"] == "0193f5a6-release"
    assert "release" not in sent[0]["properties"]


def test_an_exception_without_a_user_mints_no_person_and_marks_our_frames(sent: list[dict[str, Any]]) -> None:
    from aiq_agent.observability import trace_context

    try:
        trace_context.langfuse_environment(raw=42)  # type: ignore[arg-type] - raises inside aiq_agent
    except AttributeError as error:
        assert posthog_client.capture_exception(error, properties={"logger": "x"}) is True

    properties = sent[0]["properties"]
    assert properties["$process_person_profile"] is False
    assert properties["logger"] == "x"
    frames = properties["$exception_list"][0]["stacktrace"]["frames"]
    assert any(frame.get("in_app") for frame in frames)


def test_the_scrubber_runs_on_every_event(sent: list[dict[str, Any]]) -> None:
    url = "https://s3.example/b/k?X-Amz-Signature=deadbeef"  # pragma: allowlist secret
    error = RuntimeError(f"Client error for url '{url}'")
    posthog_client.capture_exception(error, properties={"message": f"failed {url}"})

    # The frames' source context is this file's code, which spells the URL out;
    # what is checked is the data the event carries.
    properties = sent[0]["properties"]
    assert "deadbeef" not in properties["message"]
    assert "deadbeef" not in properties["$exception_list"][0]["value"]


def test_a_failing_sdk_never_reaches_the_caller(sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    client = posthog_client.get_client()
    assert client is not None

    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("queue full")

    monkeypatch.setattr(client, "_enqueue", broken)

    assert posthog_client.capture("x", distinct_id="user_1") is False
    assert posthog_client.capture_exception(ValueError("x"), distinct_id="user_1") is False
