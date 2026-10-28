"""One run of the Erfassungs-Agent against the fixture project, with a live model.

The agent is the production graph (``ProjectIntakeAgent``: its prompt, its own
tools, its middleware and its budgets), and its model is built the way the
research worker builds it: the config's ``research_llm`` through NAT and
``get_langchain_llm`` (``runner._create_llm_provider``), pinned to zero data
retention with ``openrouter.pin_chat_model`` (ADR-0074), so every call takes a
provider-limiter slot (ADR-0081). The decision model the record tool consults
for select values goes through its own seam (``common/decisions``), as live.

Faked, and nothing else: the project's documents and the three shared reading
tools (``fixture.py``), the intake route (``bff.py``), and the run's signed
envelope (a placeholder the fake route never checks). No database, no BFF, no
network beyond OpenRouter.

What a run costs is read off the wire: every OpenRouter response is recorded
in-process (the ``turn_census`` recorder's technique) for its billed tokens and
``usage.cost``.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
from collections.abc import Iterator
from typing import Any

import httpx
import yaml
from langchain_core.callbacks import AsyncCallbackHandler

from .bff import JOB_ID
from .bff import FakeIntakeBff
from .bff import FakeIntakeRoute
from .bff import Gate
from .fixture import REPO_ROOT
from .fixture import Fixture
from .fixture import page_fetcher_for
from .fixture import project_documents_for
from .fixture import shared_tools

CONFIG = REPO_ROOT / "configs" / "config_oib_openrouter.yml"
#: The longest tool output a transcript keeps; the full text is what the model saw, this is for reading.
MAX_TRANSCRIPT_OUTPUT = 6000


# ── The config, as the worker reads it ───────────────────────────────────────


def _expand(value: Any) -> Any:
    """``${NAME:-default}`` as NAT expands it."""
    if not isinstance(value, str):
        return value
    return re.sub(r"\$\{(\w+)(?::-([^}]*))?\}", lambda m: os.environ.get(m.group(1)) or (m.group(2) or ""), value)


def intake_config() -> tuple[dict[str, Any], dict[str, Any]]:
    """``(the project_intake_agent function's config, the LLM config it names)``, env expanded."""
    config = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    function = config["functions"]["project_intake_agent"]
    llm = {key: _expand(value) for key, value in config["llms"][function["llm"]].items()}
    return function, llm


def boot_model() -> str:
    """The model the intake runs on in a process with no BFF to ask: the config's boot fallback."""
    return str(intake_config()[1]["model_name"])


# ── Recording what the provider billed ───────────────────────────────────────


def _usage_from_text(text: str) -> dict[str, Any] | None:
    """The last ``usage`` object in a JSON body or an SSE stream."""
    usage = None
    for line in text.splitlines() or [text]:
        line = line.strip().removeprefix("data:").strip()
        if not line or line == "[DONE]":
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            usage = obj.get("usage") or (obj.get("response") or {}).get("usage") or usage
    return usage


class ModelCallRecorder:
    """Every OpenRouter call in this process, with its status, seconds and billed usage."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def _entry(self, request: httpx.Request) -> dict[str, Any] | None:
        if "openrouter.ai" not in (request.url.host or ""):
            return None
        return {"url": str(request.url), "started": time.time()}

    def _finish(self, entry: dict[str, Any], response: httpx.Response | None, text: str, error: str = "") -> None:
        entry.update(seconds=round(time.time() - entry["started"], 3), error=error or None)
        if response is not None:
            entry["status"] = response.status_code
            entry["usage"] = _usage_from_text(text)
        self.calls.append(entry)

    @contextlib.contextmanager
    def recording(self) -> Iterator[ModelCallRecorder]:
        original_async, original_sync = httpx.AsyncClient.send, httpx.Client.send
        recorder = self

        async def send_async(client, request, *args, **kwargs):
            entry = recorder._entry(request)
            if entry is None:
                return await original_async(client, request, *args, **kwargs)
            try:
                response = await original_async(client, request, *args, **kwargs)
                await response.aread()
            except Exception as exc:
                recorder._finish(entry, None, "", repr(exc))
                raise
            recorder._finish(entry, response, response.text)
            return response

        def send_sync(client, request, *args, **kwargs):
            entry = recorder._entry(request)
            if entry is None:
                return original_sync(client, request, *args, **kwargs)
            try:
                response = original_sync(client, request, *args, **kwargs)
                response.read()
            except Exception as exc:
                recorder._finish(entry, None, "", repr(exc))
                raise
            recorder._finish(entry, response, response.text)
            return response

        httpx.AsyncClient.send, httpx.Client.send = send_async, send_sync
        try:
            yield self
        finally:
            httpx.AsyncClient.send, httpx.Client.send = original_async, original_sync


# ── The run's transcript ─────────────────────────────────────────────────────


def _text(content: Any) -> str:
    from agent.common.message_utils import content_to_text

    return content_to_text(getattr(content, "content", content))


class Transcript(AsyncCallbackHandler):
    """The model's turns and every tool call with its arguments and what it returned, in order."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self._open: dict[Any, dict[str, Any]] = {}

    async def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs) -> None:
        call = {
            "type": "tool",
            "name": (serialized or {}).get("name") or kwargs.get("name"),
            "args": inputs or input_str,
        }
        self._open[run_id] = call
        self.events.append(call)

    async def on_tool_end(self, output, *, run_id, **kwargs) -> None:
        call = self._open.pop(run_id, None)
        if call is not None:
            call["output"] = _text(output)

    async def on_tool_error(self, error, *, run_id, **kwargs) -> None:
        call = self._open.pop(run_id, None)
        if call is not None:
            call["output"] = f"error: {error!r}"

    async def on_llm_end(self, response, *, run_id, **kwargs) -> None:
        for generations in response.generations:
            for generation in generations:
                message = getattr(generation, "message", None)
                text = _text(message) if message is not None else generation.text
                calls = [c.get("name") for c in getattr(message, "tool_calls", None) or []]
                if text.strip() or calls:
                    self.events.append({"type": "model", "text": text.strip(), "tool_calls": calls})

    @property
    def tool_calls(self) -> list[dict[str, Any]]:
        return [event for event in self.events if event["type"] == "tool"]

    def attempted_values(self) -> list[dict[str, Any]]:
        """Every value the model passed to ``record_values``, sent or not."""
        values = []
        for call in self.tool_calls:
            if call["name"] != "record_values" or not isinstance(call["args"], dict):
                continue
            for item in call["args"].get("values") or []:
                values.append(item.model_dump() if hasattr(item, "model_dump") else dict(item))
        return values

    def for_report(self) -> list[dict[str, Any]]:
        def cut(event: dict[str, Any]) -> dict[str, Any]:
            output = str(event.get("output", ""))
            if len(output) > MAX_TRANSCRIPT_OUTPUT:
                output = output[:MAX_TRANSCRIPT_OUTPUT] + f"… [{len(output) - MAX_TRANSCRIPT_OUTPUT} more characters]"
            return {**event, "output": output} if event["type"] == "tool" else event

        return [cut(event) for event in self.events]


# ── The world the agent runs in ──────────────────────────────────────────────


@contextlib.contextmanager
def fixture_world(fixture: Fixture, bff: FakeIntakeBff) -> Iterator[None]:
    """The fixture's pages behind ``read_document``, the fake route behind the client, a placeholder envelope."""
    from agent import project_context
    from agent.agents.intake import client
    from agent.agents.intake import reading

    route = FakeIntakeRoute(**bff.answers())
    patches = [
        (reading, "project_documents", project_documents_for(fixture)),
        (reading, "fetch_document_pages", page_fetcher_for(fixture)),
        (client._opener, "open", route),
        (project_context, "get_request_envelope_from_context", lambda: ("intake-eval-envelope", "intake-eval")),
    ]
    environment = {"INTERNAL_API_TOKEN": "intake-eval", "FRONTEND_INTERNAL_URL": "http://intake-eval.invalid"}
    saved = [(target, name, getattr(target, name)) for target, name, _ in patches]
    saved_env = {name: os.environ.get(name) for name in environment}
    for target, name, value in patches:
        setattr(target, name, value)
    os.environ.update(environment)
    try:
        yield
    finally:
        for target, name, value in saved:
            setattr(target, name, value)
        for name, value in saved_env.items():
            os.environ.pop(name, None) if value is None else os.environ.__setitem__(name, value)


async def _model(builder: Any, llm_config: dict[str, Any], model: str) -> Any:
    """``research_llm`` as the worker builds it, on ``model``, pinned to zero data retention."""
    import nat.plugins.langchain.llm  # noqa: F401 — registers NAT's LangChain wrapper for the OpenAI provider
    from agent.common import get_langchain_llm
    from agent.common.openrouter import ZERO_DATA_RETENTION
    from agent.common.openrouter import pin_chat_model
    from nat.llm.openai_llm import OpenAIModelConfig

    fields = {key: value for key, value in llm_config.items() if key != "_type"}
    await builder.add_llm("research_llm", OpenAIModelConfig(**{**fields, "model_name": model}))
    return pin_chat_model(await get_langchain_llm(builder, "research_llm"), ZERO_DATA_RETENTION)


async def run_once(fixture: Fixture, model: str) -> dict[str, Any]:
    """One reading of the fixture project: what the route took, the profile after it, the transcript and the bill."""
    from langchain_core.messages import HumanMessage

    from agent.agents.intake.agent import ProjectIntakeAgent
    from agent.agents.intake.models import IntakeAgentState
    from agent.common import AgentGroup
    from agent.common import LLMProvider
    from nat.builder.workflow_builder import WorkflowBuilder

    function, llm_config = intake_config()
    gate = Gate()
    bff = FakeIntakeBff(fixture, gate)
    recorder, transcript = ModelCallRecorder(), Transcript()
    started = time.monotonic()
    try:
        with fixture_world(fixture, bff), recorder.recording():
            async with WorkflowBuilder() as builder:
                provider = LLMProvider()
                provider.set_default(await _model(builder, llm_config, model), group=AgentGroup.RESEARCH)
                agent = ProjectIntakeAgent(
                    provider,
                    tools=shared_tools(fixture),
                    callbacks=[transcript],
                    max_tool_steps=int(function["max_tool_steps"]),
                    max_run_seconds=float(function["max_run_seconds"]),
                    job_id=JOB_ID,
                )
                state = IntakeAgentState(messages=[HumanMessage(content=fixture.instruction)], organization_id=None)
                result = await agent.run(state)
    finally:
        gate.close()
    return {
        "model": model,
        "seconds": round(time.monotonic() - started, 1),
        "outcome": result.outcome,
        "summary": (bff.finish_body or {}).get("summary") or "",
        "records": bff.records,
        "need_labels": sorted(bff.need_labels),
        "profile": bff.profile,
        "transcript": transcript,
        "model_calls": recorder.calls,
    }
