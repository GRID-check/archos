"""Every bound tool can run in every context it is bound into.

A tool declares what it needs from the request context
(`agent.project_context.TOOL_CONTEXT_REQUIREMENTS`); each entry path that
binds it must supply that. The chat path sets the headers on the WebSocket
upgrade; the job worker injects them from the run's identity, and the signed
envelope from the one the run carries (ADR-0108). These tests
read the shipped config and the two declarations as data — wiring, never
behaviour. `remember` sat outside this contract for weeks: bound to the deep
researcher, run by a worker that injected nothing, answering "no project in
scope" on every unattended run.
"""

from pathlib import Path

import pytest
import yaml

from agent.project_context import ORGANIZATION_ID_HEADER
from agent.project_context import PROJECT_ID_HEADER
from agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from agent.project_context import TOOL_CONTEXT_REQUIREMENTS
from agent_host.jobs.run_envelope import envelope_headers_for_run
from agent_host.jobs.runner import WORKER_ENVELOPE_HEADERS
from agent_host.jobs.runner import WORKER_IDENTITY_HEADERS

ENVELOPE = (REQUEST_CONTEXT_ENVELOPE_HEADER, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER)

#: Everything the worker can put on a run's tool context. The envelope counts
#: only because the worker injects it whenever the run CARRIES one the BFF
#: signed for its requester; it never makes one up (see the tests below, and
#: `apps/agent-host/tests/test_run_envelope.py`).
WORKER_SUPPLIED_HEADERS = WORKER_IDENTITY_HEADERS + WORKER_ENVELOPE_HEADERS

CONFIG = Path(__file__).resolve().parents[3] / "configs" / "config_oib_openrouter.yml"


@pytest.fixture(scope="module")
def config() -> dict:
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


def _bound_tool_types(config: dict, agent: str) -> dict[str, str]:
    """Bound tool name -> its agent-runtime function type, the identity the contract is keyed by."""
    declared = {**config["functions"], **(config.get("function_groups") or {})}
    return {name: declared[name]["_type"] for name in config["functions"][agent]["tools"] if name in declared}


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_the_worker_supplies_what_every_bound_tool_needs(config: dict, agent: str):
    """The deep researcher runs unattended on the job worker; the shallow one
    can too (`output: chat` jobs). Either way the worker's identity headers
    must cover every tool the agent binds."""
    missing = {
        name: [header for header in TOOL_CONTEXT_REQUIREMENTS.get(kind, ()) if header not in WORKER_SUPPLIED_HEADERS]
        for name, kind in _bound_tool_types(config, agent).items()
    }
    missing = {name: headers for name, headers in missing.items() if headers}
    assert missing == {}, f"{agent} binds tools the job worker cannot serve: {missing}"


def test_the_delegation_tool_declares_its_project_scope_and_its_person():
    """A task hangs off a project (`tasks.project_id` is NOT NULL and carries the
    tenant predicate), and it is pinned to the person the envelope names, so a
    run without either can only refuse."""
    assert set(TOOL_CONTEXT_REQUIREMENTS["create_task"]) == {PROJECT_ID_HEADER, *ENVELOPE}


@pytest.mark.parametrize(
    "kind", ["propose_file_change", "file_draft", "create_task", "project_lookup", "document_canvas"]
)
def test_every_tool_that_acts_as_a_person_declares_the_envelope(kind: str):
    """The tools that echo `get_request_envelope_from_context()` to the BFF."""
    assert set(ENVELOPE) <= set(TOOL_CONTEXT_REQUIREMENTS[kind])


def test_the_worker_envelope_headers_are_the_ones_the_context_reads():
    assert set(WORKER_ENVELOPE_HEADERS) == set(ENVELOPE)


async def test_the_worker_supplies_the_envelope_only_from_one_the_run_carries():
    """Honesty of the table above: no carried envelope, no envelope headers.

    The worker cannot satisfy an envelope requirement on its own. A run that
    carries nothing gets nothing, whatever its identity, and the person-acting
    tools then refuse as they always did.
    """
    identity = {"organization_id": "org-1", "user_id": "user-1", "project_id": "proj-1"}
    assert await envelope_headers_for_run(None, run_id="run-1", job_id="job-1", identity=identity) == {}


def test_the_memory_tool_declares_its_project_scope():
    """The one requirement that has already bitten, stated as data."""
    assert set(TOOL_CONTEXT_REQUIREMENTS["project_memory_remember"]) == {PROJECT_ID_HEADER, ORGANIZATION_ID_HEADER}


def test_every_declared_requirement_names_a_function_type_the_config_binds(config: dict):
    """A requirement for a type nobody binds is a typo that would guard nothing."""
    declared = [*config["functions"].values(), *(config.get("function_groups") or {}).values()]
    bound_types = {entry.get("_type") for entry in declared if isinstance(entry, dict)}
    unknown = [kind for kind in TOOL_CONTEXT_REQUIREMENTS if kind not in bound_types]
    assert unknown == [], unknown
