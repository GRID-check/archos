"""Caught exceptions reach PostHog error tracking from one logging handler (ADR-0100).

The SDK is never built here: ``posthog_client.capture_exception`` is replaced by
a recorder, and the one test that needs the real client's ``before_send`` swaps
the SDK class for a fake that keeps the constructor arguments.
"""

from __future__ import annotations

import logging
import sys
import uuid

import pytest

from agent.common.budget_guard import RunBudgetExceededError
from agent.common.cost_tracking import BudgetExceededError
from agent.observability import otlp_logging_method as otlp
from agent.observability import posthog_client
from agent.observability import posthog_exceptions
from agent.observability.otlp_logging_method import OtlpLoggingMethodConfig
from agent.observability.posthog_exceptions import FINGERPRINT_BURST
from agent.observability.posthog_exceptions import FINGERPRINT_REFILL_SECONDS
from agent.observability.posthog_exceptions import GLOBAL_BURST
from agent.observability.posthog_exceptions import PosthogExceptionHandler
from agent.observability.turn_trace import pinned_trace


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def _posthog_env(monkeypatch):
    monkeypatch.setenv("POSTHOG_HOST", "https://eu.i.posthog.com")
    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_test")  # pragma: allowlist secret
    for name in ("GIT_SHA", "APP_ENV", "OTEL_SERVICE_NAME"):
        monkeypatch.delenv(name, raising=False)
    posthog_client.reset_for_tests()
    yield
    posthog_client.reset_for_tests()


@pytest.fixture
def sent(monkeypatch):
    """Every ``capture_exception`` the handler makes, as ``(exception, properties)``."""
    calls: list[tuple[BaseException, dict]] = []

    def record(exception, *, distinct_id=None, properties=None):
        calls.append((exception, properties or {}))
        return True

    monkeypatch.setattr(posthog_client, "capture_exception", record)
    return calls


@pytest.fixture
def clock():
    return _Clock()


@pytest.fixture
def log(clock):
    """A logger of its own with the handler installed, so nothing leaks into the root logger."""
    logger = logging.getLogger(f"test.posthog_exceptions.{uuid.uuid4().hex}")
    logger.propagate = False
    logger.addHandler(PosthogExceptionHandler(clock=clock))
    return logger


def _fail(log: logging.Logger, message: str = "step failed", error: Exception | None = None) -> None:
    try:
        raise error or RuntimeError("boom")
    except RuntimeError:
        log.exception(message)


def test_a_logged_exception_is_captured_with_its_context(sent, log, monkeypatch):
    monkeypatch.setenv("GIT_SHA", "abc1234")
    monkeypatch.setenv("APP_ENV", "Staging")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "grid-agent-worker")
    trace_id = uuid.uuid4().int

    with pinned_trace(trace_id):
        _fail(log, "ingest of %s failed")

    assert len(sent) == 1
    exception, properties = sent[0]
    assert isinstance(exception, RuntimeError)
    assert properties["logger"] == log.name
    assert properties["log_message"] == "ingest of %s failed"
    assert properties["log_level"] == "ERROR"
    # The client carries these on every event (super properties, $release_id).
    assert {"release", "environment", "service"}.isdisjoint(properties)
    assert properties["$ai_trace_id"] == properties["langfuse_trace_id"] == f"{trace_id:032x}"


@pytest.mark.parametrize("error", [BudgetExceededError("organization"), RunBudgetExceededError(100, 120)])
def test_an_exhausted_budget_is_an_outcome_not_an_issue(sent, log, error):
    _fail(log, "run failed", error)

    assert sent == []


def test_outside_a_traced_run_there_is_no_trace_id(sent, log):
    _fail(log)

    assert "$ai_trace_id" not in sent[0][1]
    assert "langfuse_trace_id" not in sent[0][1]


def test_the_message_is_scrubbed_of_presigned_urls(sent, log):
    url = "https://s3.example/b/k?X-Amz-Signature=deadbeef&X-Amz-Credential=c"  # pragma: allowlist secret
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        log.exception("download of %s failed", url)

    assert "deadbeef" not in sent[0][1]["log_message"]


def test_only_error_records_with_an_exception_count(sent, log):
    log.error("an error with no exception")
    log.warning("a warning with an exception", exc_info=RuntimeError("boom"))
    log.info("fine")

    assert sent == []


def test_the_sdks_own_logger_and_this_package_are_never_reported(sent, clock):
    # The SDK logs its failures at ERROR with exc_info: reporting them reports the reporter.
    handler = PosthogExceptionHandler(clock=clock)
    for name in ("posthog", "posthog.consumer", posthog_exceptions.__name__, posthog_client.__name__):
        try:
            raise RuntimeError("boom")
        except RuntimeError:
            record = logging.LogRecord(name, logging.ERROR, __file__, 1, "x", (), sys.exc_info())
        handler.handle(record)

    assert sent == []


def test_a_failing_capture_never_raises_into_the_caller(log, monkeypatch):
    def broken(*args, **kwargs):
        raise OSError("posthog unreachable")

    monkeypatch.setattr(posthog_client, "capture_exception", broken)

    _fail(log)  # must not raise


def test_a_capture_that_logs_an_error_does_not_recurse(log, monkeypatch):
    # capture_exception failing inside the SDK logs on `posthog` at ERROR with exc_info,
    # through the same root handler chain.
    root = logging.getLogger()
    handler = PosthogExceptionHandler()
    root.addHandler(handler)
    calls = []

    def noisy(exception, *, distinct_id=None, properties=None):
        calls.append(exception)
        try:
            raise ValueError("sdk failure")
        except ValueError:
            logging.getLogger("posthog").exception("could not send")
        return True

    monkeypatch.setattr(posthog_client, "capture_exception", noisy)
    try:
        try:
            raise RuntimeError("boom")
        except RuntimeError:
            logging.getLogger("agent.test").exception("failed")
    finally:
        root.removeHandler(handler)

    assert len(calls) == 1


def test_a_hot_loop_is_capped_per_fingerprint(sent, log):
    for _ in range(500):
        _fail(log)

    assert len(sent) == FINGERPRINT_BURST


def test_a_fingerprint_earns_a_token_back_over_time(sent, log, clock):
    for _ in range(FINGERPRINT_BURST + 5):
        _fail(log)
    clock.now += FINGERPRINT_REFILL_SECONDS
    _fail(log)
    _fail(log)

    assert len(sent) == FINGERPRINT_BURST + 1


def test_different_exceptions_and_sites_have_their_own_budgets(sent, log):
    def from_here() -> None:
        _fail(log, error=RuntimeError("boom"))

    def from_there() -> None:
        try:
            raise KeyError("missing")
        except KeyError:
            log.exception("failed")

    for _ in range(10):
        from_here()
        from_there()
        try:
            raise ValueError("again")
        except ValueError:
            log.exception("failed")

    assert len(sent) == 3 * FINGERPRINT_BURST


def test_the_process_wide_cap_stops_many_fingerprints_failing_at_once(sent, clock):
    logger = logging.getLogger(f"test.posthog_exceptions.{uuid.uuid4().hex}")
    logger.propagate = False
    logger.addHandler(PosthogExceptionHandler(clock=clock))

    for index in range(GLOBAL_BURST * 3):
        # A distinct exception class per iteration is a distinct fingerprint.
        error_type = type(f"Failure{index}", (Exception,), {})
        try:
            raise error_type("boom")
        except Exception:
            logger.exception("failed")

    assert len(sent) == GLOBAL_BURST


def test_a_hot_loop_costs_one_event_per_refill_interval(sent, log, clock):
    # The free-tier arithmetic in the module header: a burst, then one per interval.
    for _ in range(12 * 60 + 1):  # an hour, failing every 5 seconds, both ends included
        _fail(log)
        clock.now += 5

    assert len(sent) == FINGERPRINT_BURST + 3600 // FINGERPRINT_REFILL_SECONDS


def test_install_is_off_while_posthog_is_not_configured(monkeypatch):
    monkeypatch.delenv("POSTHOG_HOST")
    logger = logging.getLogger(f"test.posthog_exceptions.{uuid.uuid4().hex}")

    assert posthog_exceptions.install(logger) is None
    assert logger.handlers == []


def test_install_is_idempotent(monkeypatch):
    logger = logging.getLogger(f"test.posthog_exceptions.{uuid.uuid4().hex}")

    first = posthog_exceptions.install(logger)
    second = posthog_exceptions.install(logger)

    assert first is second
    assert [h for h in logger.handlers if isinstance(h, PosthogExceptionHandler)] == [first]
    assert first.level == logging.ERROR


async def test_the_nat_logging_method_installs_it_even_without_a_collector(monkeypatch):
    installs: list[int] = []
    monkeypatch.setattr(posthog_exceptions, "install", lambda *a, **k: installs.append(1))

    async with otlp.otlp_logging_method(OtlpLoggingMethodConfig(), None) as handler:
        assert isinstance(handler, logging.NullHandler)

    assert installs == [1]


def test_the_client_scrubs_presigned_urls_out_of_exception_text(monkeypatch):
    built: dict = {}

    class FakePosthog:
        def __init__(self, token, **kwargs):
            built.update(kwargs)

    import posthog

    monkeypatch.setattr(posthog, "Posthog", FakePosthog)
    assert posthog_client.get_client() is not None

    url = "https://s3.example/b/k?X-Amz-Signature=deadbeef"  # pragma: allowlist secret
    event = {
        "properties": {
            "log_message": f"failed {url}",
            "$exception_list": [{"type": "HTTPStatusError", "value": f"Client error for url '{url}'"}],
        }
    }
    cleaned = built["before_send"](event)

    assert "deadbeef" not in str(cleaned)
    assert cleaned["properties"]["$exception_list"][0]["type"] == "HTTPStatusError"
