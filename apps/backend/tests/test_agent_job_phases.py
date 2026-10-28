"""``run_agent_job`` as its phases: what each one decides, and that the terminal paths always run.

Module under test: ``agent_host.jobs.agent_job`` (claim, run, release),
``agent_job_setup`` (prepare) and ``job_outcome`` (persist, finish, failure).
"""

from __future__ import annotations

import base64
import inspect
import json
from dataclasses import fields
from types import SimpleNamespace
from typing import Any

import pytest

from agent_host.jobs import agent_job
from agent_host.jobs import agent_job_setup
from agent_host.jobs import job_outcome
from agent_host.jobs.agent_job import JobRequest
from agent_host.jobs.agent_job import run_agent_job


def _request(**overrides: Any) -> JobRequest:
    base = {
        "db_url": "sqlite://",
        "config_file_path": "config.yml",
        "job_id": "job-1",
        "input_text": "Wie hoch darf das Gebäude sein?",
        "agent_class_path": "pkg.Agent",
        "agent_config_name": "deep_research_agent",
    }
    return JobRequest(**{**base, **overrides})


def test_the_request_carries_exactly_the_payload_keys():
    """A parameter added to ``run_agent_job`` and not to ``JobRequest`` would fail every job at its first line."""
    params = set(inspect.signature(run_agent_job).parameters) - agent_job._PROCESS_KNOBS
    assert params == {f.name for f in fields(JobRequest)}


def test_the_request_reads_who_the_job_runs_for():
    request = _request(usage_context={"identity": {"organization_id": "org-a", "project_id": "p-1"}}, run_id="r-1")

    assert (request.organization_id, request.identity["project_id"], request.expect_run) == ("org-a", "p-1", True)
    assert _request().identity == {} and _request().expect_run is False


@pytest.fixture
def statuses(monkeypatch) -> list[str]:
    """The job store's guarded status writes, answered "already terminal" when the list starts with one."""
    written: list[str] = []

    async def update(_store, _job_id, status, **_kwargs):
        written.append(status.value)
        return written[0] != "refused"

    for module in (agent_job, job_outcome):
        monkeypatch.setattr(module, "_update_status_if_not_terminal", update)

    async def not_lost(*_args):
        return False

    monkeypatch.setattr(job_outcome, "_lost_claim", not_lost)
    monkeypatch.setattr("nat.front_ends.fastapi.async_jobs.job_store.JobStore", lambda **_kw: object())
    return written


@pytest.fixture
def released(monkeypatch) -> list[str]:
    """Record the release and the checkpoint purge, which run on every path."""
    seen: list[str] = []

    async def purge(_db_url, job_id, _owner):
        seen.append(f"purge:{job_id}")
        return True

    monkeypatch.setattr(agent_job, "_purge_deep_checkpoint_unless_reclaimed", purge)
    monkeypatch.setattr(agent_job.AgentEventCallback, "cleanup_job_urls", lambda job_id: seen.append(f"urls:{job_id}"))
    return seen


def _payload(**overrides: Any) -> dict[str, Any]:
    return {
        "configure_logging": False,
        "log_level": 20,
        "db_url": "sqlite://",
        "config_file_path": "config.yml",
        "job_id": "job-1",
        "input_text": "q",
        "agent_class_path": "pkg.Agent",
        "agent_config_name": "deep_research_agent",
        **overrides,
    }


@pytest.mark.asyncio
async def test_a_job_already_terminal_is_never_prepared(monkeypatch, statuses, released):
    statuses.append("refused")

    def must_not_load(_path):
        raise AssertionError("a refused claim loaded the config")

    monkeypatch.setattr("nat.runtime.loader.load_config", must_not_load)

    await run_agent_job(**_payload())

    assert statuses == ["refused", "running"]
    assert released == ["urls:job-1", "purge:job-1"]


@pytest.mark.asyncio
async def test_a_failure_in_prepare_is_recorded_and_the_job_released(monkeypatch, statuses, released):
    stored: list[dict] = []
    notified: list[str] = []
    monkeypatch.setattr("nat.runtime.loader.load_config", lambda _path: (_ for _ in ()).throw(OSError("gone")))
    monkeypatch.setattr(job_outcome, "BatchingEventStore", lambda _store: SimpleNamespace(store=stored.append))
    monkeypatch.setattr(job_outcome, "EventStore", lambda *_args: None)

    async def should(**_kwargs):
        return True

    async def notify(**kwargs):
        notified.append(kwargs["status"])

    async def notice(**_kwargs):
        return None

    monkeypatch.setattr(job_outcome, "_should_write_notice", should)
    monkeypatch.setattr(job_outcome, "_should_notify_outcome", should)
    monkeypatch.setattr(job_outcome, "notify_job_outcome", notify)
    monkeypatch.setattr(job_outcome, "write_job_notice", notice)

    await run_agent_job(**_payload(auth_token="tok"))

    from agent_host.jobs._auth_context import job_auth_token

    assert statuses == ["running", "failure"]
    assert notified == ["failure"]
    assert [event["type"] for event in stored] == ["job.error"]
    assert stored[0]["data"]["error_type"] == "OSError"
    assert job_auth_token.get() is None, "the job's token outlived the job"
    assert released == ["urls:job-1", "purge:job-1"]


class _Provider:
    """A provider whose every dial returns a new provider, recording the order."""

    def __init__(self, applied: tuple[str, ...] = ()) -> None:
        self.applied = applied

    def _with(self, dial: str) -> _Provider:
        return _Provider((*self.applied, dial))

    def with_model_overrides(self, overrides):
        return self._with(f"overrides:{sorted(overrides)}")

    def with_reasoning_efforts(self, _efforts):
        return self._with("efforts")

    def with_credential(self, credential):
        return self._with(f"byok:{credential}")

    def with_zdr(self, zdr):
        return self._with(f"zdr:{zdr}")

    def get(self, role):
        return ("llm", self.applied)


@pytest.mark.asyncio
async def test_the_models_get_every_dial_in_order_and_the_llm_follows_the_last(monkeypatch):
    builder = SimpleNamespace(get_function_config=lambda _name: SimpleNamespace(type="research_agent"))

    async def create(_builder, _fn_config):
        return _Provider(), ("llm", ())

    monkeypatch.setattr(agent_job_setup, "_create_llm_provider", create)
    monkeypatch.setattr("agent.common.get_reasoning_efforts", lambda: {})
    monkeypatch.setattr("agent.common.resolve_org_llm_credential", lambda org: f"key-{org}")
    monkeypatch.setattr("agent.common.sanitize_model_overrides", lambda overrides: overrides)
    monkeypatch.setattr("agent.common.openrouter.data_policy_for", lambda _org: SimpleNamespace(zdr=True))
    request = _request(model_overrides={"research": "m"}, usage_context={"identity": {"organization_id": "org-a"}})

    models = await agent_job_setup.prepare_models(builder, request)

    assert models.provider.applied == ("overrides:['research']", "efforts", "byok:key-org-a", "zdr:True")
    assert models.llm == ("llm", models.provider.applied)
    assert (models.org_credential, models.zdr) == ("key-org-a", True)


def _decoded(value: str) -> str:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()


def test_the_scope_headers_are_base64url_so_german_text_survives(monkeypatch):
    injected: dict[str, str] = {}
    monkeypatch.setattr(agent_job_setup, "_inject_worker_headers", lambda _state, headers: injected.update(headers))
    request = _request(collection_scope=["p_1"], project_context="Bauvorhaben „Hof“ — 3 Geschosse")

    agent_job_setup._inject_scope_headers(object(), request, SimpleNamespace(type="deep_research_agent"))

    assert json.loads(_decoded(injected["x-grid-collection-scope"])) == ["p_1"]
    assert "„Hof“" in _decoded(injected["x-grid-project-context"])


class _Store:
    """An event store that keeps what it is given."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def store(self, event: dict) -> None:
        self.events.append(event)

    def flush(self) -> None:
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_type", ["research_agent", "deep_research_agent"])
async def test_a_job_runs_its_phases_to_a_success_and_one_thread_turn(monkeypatch, statuses, released, agent_type):
    """The happy path end to end, with only NAT's config and builder and the agent itself faked."""
    from contextlib import asynccontextmanager

    from agent.agents.deep_researcher.anatomy import ReportAnatomy
    from agent.cards.generate import CardGenerationResult
    from agent_host.jobs.agent_job_setup import JobModels

    store = _Store()
    builder = SimpleNamespace(_telemetry_exporters={})
    seen: dict[str, Any] = {}

    @asynccontextmanager
    async def from_config(config):
        yield builder

    async def models(_builder, _request):
        return JobModels(
            fn_config=SimpleNamespace(type=agent_type), provider=None, llm=None, org_credential=None, zdr=True
        )

    async def tools(*_args):
        return []

    async def run_agent(**kwargs):
        seen["run"] = kwargs
        return "Die Traufhöhe beträgt 9 m."

    async def passes(**kwargs):
        seen["passes"] = kwargs
        return CardGenerationResult(cards=None), ReportAnatomy(), None

    async def turn(**kwargs):
        seen["turn"] = kwargs
        return "msg-1"

    async def notify(**kwargs):
        seen["notify"] = kwargs["status"]

    monkeypatch.setattr("nat.runtime.loader.load_config", lambda _path: SimpleNamespace(workflow=None))
    monkeypatch.setattr("nat.builder.workflow_builder.WorkflowBuilder.from_config", from_config)
    monkeypatch.setattr(agent_job, "_load_agent_class", lambda _path: type("Agent", (), {}))
    monkeypatch.setattr(agent_job, "prepare_models", models)
    monkeypatch.setattr(agent_job, "prepare_tools", tools)
    monkeypatch.setattr(agent_job, "_create_agent_instance", lambda **kwargs: object())
    monkeypatch.setattr(agent_job, "_run_agent", run_agent)
    monkeypatch.setattr(agent_job, "BatchingEventStore", lambda _raw: store)
    monkeypatch.setattr(agent_job, "EventStore", lambda *_args: None)
    monkeypatch.setattr(job_outcome, "_run_report_passes", passes)
    monkeypatch.setattr(job_outcome, "write_job_turn", turn)
    monkeypatch.setattr(job_outcome, "notify_job_outcome", notify)

    await run_agent_job(**_payload(agent_config_name="research_agent", run_id="run-1", parent_conversation_id="c-1"))

    assert statuses == ["running", "success"]
    assert seen["run"]["input_text"] == "q"
    assert seen["passes"]["report"] == "Die Traufhöhe beträgt 9 m."
    assert (seen["turn"]["conversation_id"], seen["turn"]["answer"]) == ("c-1", "Die Traufhöhe beträgt 9 m.")
    assert seen["notify"] == "success"
    assert released == ["urls:job-1", "purge:job-1"]
    # Deep research closes its phase progress before the status changes.
    assert (agent_type == "deep_research_agent") == any(e.get("type") == "job.phase" for e in store.events)
