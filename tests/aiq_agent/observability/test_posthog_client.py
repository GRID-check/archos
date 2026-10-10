"""The one PostHog client the Python tiers capture through (ADR-0098).

What these cases hold in place: the client is off until both settings arrive
and is then built once; a system event never mints a person; a failing SDK
never reaches the caller; and the client is built with the defaults the module
header promises (no GeoIP, no exception autocapture, the URL scrubber).
"""

from __future__ import annotations

from typing import Any

import pytest

from aiq_agent.observability import posthog_client


class FakePosthog:
    instances: list[FakePosthog] = []

    def __init__(self, token: str, **options: Any) -> None:
        self.token = token
        self.options = options
        self.captured: list[tuple[str, dict[str, Any]]] = []
        self.exceptions: list[tuple[BaseException, dict[str, Any]]] = []
        self.fail = False
        self.shut_down = 0
        FakePosthog.instances.append(self)

    def capture(self, event: str, **kwargs: Any) -> None:
        if self.fail:
            raise RuntimeError("queue full")
        self.captured.append((event, kwargs))

    def capture_exception(self, exception: BaseException, **kwargs: Any) -> None:
        if self.fail:
            raise RuntimeError("queue full")
        self.exceptions.append((exception, kwargs))

    def shutdown(self) -> None:
        self.shut_down += 1


@pytest.fixture
def fake_sdk(monkeypatch: pytest.MonkeyPatch) -> type[FakePosthog]:
    import posthog

    FakePosthog.instances = []
    monkeypatch.setattr(posthog, "Posthog", FakePosthog)
    monkeypatch.setattr(posthog_client.atexit, "register", lambda _fn: None)
    posthog_client.reset_for_tests()
    yield FakePosthog
    posthog_client.reset_for_tests()


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch, fake_sdk: type[FakePosthog]) -> type[FakePosthog]:
    monkeypatch.setenv(posthog_client.HOST_ENV, "https://eu.i.posthog.com/")
    monkeypatch.setenv(posthog_client.PROJECT_TOKEN_ENV, "phc_test")
    return fake_sdk


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


def test_builds_one_client_with_the_promised_defaults(configured: type[FakePosthog]) -> None:
    first = posthog_client.get_client()
    second = posthog_client.get_client()

    assert first is second
    assert len(configured.instances) == 1
    client = configured.instances[0]
    assert client.token == "phc_test"
    assert client.options["host"] == "https://eu.i.posthog.com"
    assert client.options["disable_geoip"] is True
    assert client.options["enable_exception_autocapture"] is False
    assert client.options["before_send"] is posthog_client._scrub_event


def test_a_user_event_names_the_user(configured: type[FakePosthog]) -> None:
    assert posthog_client.capture("job_run_finished", distinct_id="user_1", properties={"status": "ok"}) is True

    event, kwargs = configured.instances[0].captured[0]
    assert event == "job_run_finished"
    assert kwargs["distinct_id"] == "user_1"
    assert kwargs["properties"] == {"status": "ok"}
    assert "groups" not in kwargs


def test_a_system_event_mints_no_person(configured: type[FakePosthog]) -> None:
    properties = {"status": "ok"}
    assert posthog_client.capture("ingest_finished", distinct_id=None, properties=properties) is True

    _event, kwargs = configured.instances[0].captured[0]
    assert kwargs["properties"]["$process_person_profile"] is False
    assert properties == {"status": "ok"}, "the caller's dict must not be mutated"


def test_an_exception_without_a_user_mints_no_person(configured: type[FakePosthog]) -> None:
    error = ValueError("boom")
    assert posthog_client.capture_exception(error, properties={"logger": "x"}) is True

    captured, kwargs = configured.instances[0].exceptions[0]
    assert captured is error
    assert kwargs["properties"] == {"logger": "x", "$process_person_profile": False}


def test_a_failing_sdk_never_reaches_the_caller(configured: type[FakePosthog]) -> None:
    client = posthog_client.get_client()
    assert client is not None
    client.fail = True

    assert posthog_client.capture("x", distinct_id="user_1") is False
    assert posthog_client.capture_exception(ValueError("x"), distinct_id="user_1") is False


def test_shutdown_flushes_once_built_and_is_safe_before(configured: type[FakePosthog]) -> None:
    posthog_client.shutdown()  # nothing built yet: a no-op, not an error
    posthog_client.get_client()
    posthog_client.shutdown()

    assert configured.instances[0].shut_down == 1
