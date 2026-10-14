"""The Erfassungs-Agent: Piloti sets a project up from its documents (ADR-0111).

A run of agent type ``project_intake`` on the research worker
(``aiq_api/registry.py``), started by the BFF when a finished upload batch lands
on a project with an intake, or by a person's click. It acts as that person
through the signed envelope the run carries (ADR-0108), and reads only the
project's main collection, the scope the BFF signed.

The model is given a goal, the rules a value must meet, the tools and its
budget, and chooses its own way through the documents: the prompt prescribes
no sequence (the product owner's direction for this agent: tools, not a
graph). It runs as a LangChain ``create_agent`` graph (the ReAct agent the deep
researcher's workers are built on) with the three intake tools (``tools.py``),
``read_document`` (``reading.py``) and the shared ``list_files``,
``knowledge_search`` and ``read_passage`` the runner resolves from the config.
How each tool is used lives in its description (ADR-0060). The opening message
is the project's state (its needs, unread files, description and the last
reading's summary), given as context to save a first call, not as an order of
work.

Three guarantees hold in code, not in the prompt:

* **Every quote was read.** The run's read log (``read_log.py``) is bound for
  the run; ``record_values`` refuses a quote that does not stand in it.
* **The run is bounded**: ``max_tool_steps`` tool calls (then only
  ``finish_intake`` runs), a recursion limit behind it, and ``max_run_seconds``
  of wall clock. Both are fields of ``ProjectIntakeAgentConfig``
  (``register.py``), which the runner hands to the constructor; the defaults
  below are the config's.
* **The run always finishes.** When the model stops without ``finish_intake``,
  runs out of budget or fails, the run finishes in code with a short summary, so
  the intake leaves ``reading`` on the BFF without waiting for its reconciler.

The run writes no report (``produces_report = False``): its output is values on
the profile, and the job's output is the summary.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.common.message_utils import content_to_text
from aiq_agent.common.prompt_utils import load_prompt
from aiq_agent.common.prompt_utils import render_prompt_template

from . import client
from .models import IntakeAgentState
from .read_log import bind_read_log
from .read_log import current_read_log
from .read_log import reset_read_log
from .reading import IntakeToolMiddleware
from .reading import make_read_document_tool
from .tools import FINISH_INTAKE_TOOL
from .tools import IntakeSession
from .tools import finish_intake
from .tools import make_intake_tools
from .tools import render_needs

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"

#: Tool calls one run may make before only ``finish_intake`` still runs.
DEFAULT_MAX_TOOL_STEPS = 80
#: Wall clock for one run. The BFF reconciles a reading older than 30 minutes; this ends well before.
DEFAULT_MAX_RUN_SECONDS = 20 * 60
#: The BFF's instruction text, carried into the first message, bounded.
MAX_INSTRUCTION_CHARS = 500


def _context_job_id() -> str | None:
    """The job this run is: the worker sets NAT's ``workflow_run_id`` to it at claim."""
    try:
        from nat.plugin_api import Context

        value = Context.get().workflow_run_id
    except Exception:  # noqa: BLE001 — outside a NAT context there is no job
        return None
    return str(value) if value else None


def system_prompt(max_steps: int = DEFAULT_MAX_TOOL_STEPS, max_run_seconds: float = DEFAULT_MAX_RUN_SECONDS) -> str:
    """The prompt: who Piloti is, the goal, the rules, the tools and the budget. No procedure."""
    return render_prompt_template(
        load_prompt(PROMPTS_DIR, "system.j2"),
        max_steps=max_steps,
        max_minutes=max(1, round(max_run_seconds / 60)),
        document_inventory="",
    )


def first_message(instruction: str, needs_body: dict[str, Any]) -> str:
    """The project's state as the run starts: why it runs, the last reading's note, the needs and unread files.

    Context, not instructions: it is the ``intake_needs`` answer the model would
    otherwise ask for first, with the BFF's occasion and the previous reading's
    own summary (``previousSummary``) beside it, so a reading of new documents
    does not start blind.
    """
    lines = ["The project as it stands now (the same answer intake_needs gives, so you need not ask for it first)."]
    instruction = " ".join((instruction or "").split())[:MAX_INSTRUCTION_CHARS]
    if instruction:
        lines.append(f"Occasion: {instruction}")
    previous = " ".join(str(needs_body.get("previousSummary") or "").split())[: client.MAX_SUMMARY_CHARS]
    if previous:
        lines.append(f"What the last reading found (its own summary): {previous}")
    lines.append("")
    lines.append(render_needs(needs_body))
    return "\n".join(lines)


def current_documents_read() -> list[str]:
    log = current_read_log()
    return log.documents_read if log is not None else []


def _instruction(state: IntakeAgentState) -> str:
    human = next((message for message in state.messages if isinstance(message, HumanMessage)), None)
    return content_to_text(human.content) if human is not None else ""


def _last_words(messages: list[Any]) -> str:
    """The model's own last text, when it stopped by writing instead of calling ``finish_intake``."""
    for message in reversed(messages or []):
        if isinstance(message, AIMessage) and not message.tool_calls:
            return " ".join(content_to_text(message.content).split())
    return ""


_ENDINGS = {
    "step_limit": "Die Erfassung wurde nach dem Schrittbudget beendet.",
    "time_budget": "Die Erfassung wurde nach dem Zeitbudget beendet.",
    "error": "Die Erfassung wurde nach einem Fehler beendet.",
    "no_model": "Die Erfassung konnte nicht starten: kein Modell konfiguriert.",
    "model": "Piloti hat die Erfassung ohne eigene Zusammenfassung beendet.",
}


def fallback_summary(ended: str, session: IntakeSession, documents_read: int, last_words: str = "") -> str:
    """The summary the run finishes with when the model did not write one. German: a person reads it."""
    if ended == "model" and last_words:
        return last_words[: client.MAX_SUMMARY_CHARS]
    proposed = sum(session.outcomes.values())
    return (
        f"{_ENDINGS.get(ended, _ENDINGS['error'])} {documents_read} Dokument(e) gelesen, "
        f"{proposed} Wert(e) vorgeschlagen; was offen ist, steht in der Prüfung."
    )


class ProjectIntakeAgent:
    """Reads a new project's documents and suggests its profile values, each with the page it is on."""

    #: The runner builds this state from the job (``_get_agent_state_class``).
    state_model = IntakeAgentState
    #: The run writes values to the profile, not a report: no post-report passes.
    produces_report = False

    def __init__(
        self,
        llm_provider: Any,
        tools: list[Any] | None = None,
        verbose: bool = False,
        callbacks: list[Any] | None = None,
        *,
        max_tool_steps: int = DEFAULT_MAX_TOOL_STEPS,
        max_run_seconds: float = DEFAULT_MAX_RUN_SECONDS,
        job_id: str | None = None,
    ) -> None:
        self.llm_provider = llm_provider
        self.tools = list(tools or [])
        self.verbose = verbose
        self.callbacks = list(callbacks or [])
        self.max_tool_steps = max_tool_steps
        self.max_run_seconds = max_run_seconds
        self._job_id = job_id

    def _model(self) -> Any:
        from aiq_agent.common import LLMRole

        if self.llm_provider is None:
            return None
        try:
            return self.llm_provider.get(LLMRole.ORCHESTRATOR)
        except ValueError:
            return None

    def _graph(self, model: Any, session: IntakeSession) -> Any:
        from langchain.agents import create_agent

        own = [*make_intake_tools(session), make_read_document_tool()]
        names = {tool.name for tool in own}
        shared = [tool for tool in self.tools if getattr(tool, "name", "") not in names]
        return create_agent(
            model=model,
            tools=[*own, *shared],
            system_prompt=system_prompt(self.max_tool_steps, self.max_run_seconds),
            middleware=[IntakeToolMiddleware(max_steps=self.max_tool_steps, finish_tool=FINISH_INTAKE_TOOL)],
            name="project_intake",
        )

    async def _loop(self, model: Any, session: IntakeSession, opening: str) -> tuple[str, list[Any]]:
        """Run the model's loop; how it ended, and its messages."""
        from langgraph.errors import GraphRecursionError

        config: dict[str, Any] = {"recursion_limit": 2 * (self.max_tool_steps + 5) + 1}
        if self.callbacks:
            config["callbacks"] = self.callbacks
        graph = self._graph(model, session)
        try:
            result = await asyncio.wait_for(
                graph.ainvoke({"messages": [HumanMessage(content=opening)]}, config=config),
                timeout=self.max_run_seconds,
            )
        except GraphRecursionError:
            logger.warning("Project intake %s hit its step limit", session.job_id)
            return "step_limit", []
        except TimeoutError:
            logger.warning("Project intake %s hit its time budget", session.job_id)
            return "time_budget", []
        except Exception:  # noqa: BLE001 — the run still finishes, with what it recorded
            logger.exception("Project intake %s failed", session.job_id)
            return "error", []
        return "model", list((result or {}).get("messages") or [])

    async def _read(self, state: IntakeAgentState, session: IntakeSession) -> tuple[str, str]:
        """The run; ``(how it ended, the summary it ended with)``."""
        if not session.job_id:
            return "no_job", "Die Erfassung konnte nicht starten: der Lauf hat keine Job-ID."
        reply = await client.call_intake("needs", client.needs_request(session.job_id))
        if not reply.ok:
            # No identity, an identity the BFF refused, or no longer the current reading:
            # nothing this run sends would be taken, finish included.
            if reply.reason == "no_envelope" or reply.stale or reply.status in (401, 403):
                session.stale = reply.stale
                return "refused", reply.refusal
            await finish_intake(session, fallback_summary("error", session, 0))
            return "error", session.summary
        session.remember_needs(reply.body)
        model = self._model()
        if model is None:
            ended, messages = "no_model", []
        else:
            ended, messages = await self._loop(model, session, first_message(_instruction(state), reply.body))
        if not session.finished and not session.stale:
            read = len(current_documents_read())
            await finish_intake(session, fallback_summary(ended, session, read, _last_words(messages)))
            ended = ended if ended != "model" else "model_without_finish"
        return ended, session.summary or fallback_summary(ended, session, len(current_documents_read()))

    async def run(self, state: IntakeAgentState | dict[str, Any]) -> IntakeAgentState:
        """Read the project, record what its documents state, and finish. Never raises but on cancellation."""
        from aiq_agent.common.grounding_block import begin_grounding_capture
        from aiq_agent.common.grounding_block import end_grounding_capture

        if not isinstance(state, IntakeAgentState):
            state = IntakeAgentState.model_validate(state)
        session = IntakeSession(job_id=self._job_id or _context_job_id() or "", organization_id=state.organization_id)
        log, log_token = bind_read_log()
        capture_token = begin_grounding_capture()
        try:
            ended, summary = await self._read(state, session)
        finally:
            end_grounding_capture(capture_token)
            reset_read_log(log_token)
        outcome = _outcome(ended, session, log.documents_read)
        _record_trace(outcome)
        return state.model_copy(
            update={"messages": [*state.messages, AIMessage(content=summary)], "outcome": outcome},
        )


def _outcome(ended: str, session: IntakeSession, documents_read: list[str]) -> dict[str, Any]:
    return {
        "ended": ended,
        "finished": session.finished,
        "finish_status": session.finish_status,
        "mode": session.mode,
        "documents_read": len(documents_read),
        "suggested": session.outcomes.get("suggested", 0),
        "corroborated": session.outcomes.get("corroborated", 0),
        "contradictions": session.outcomes.get("contradiction", 0),
        "refusals": dict(session.refusals),
        "decisive_open": session.decisive_open,
    }


def _record_trace(outcome: dict[str, Any]) -> None:
    """The run's facts as trace metadata on its ``research-job`` trace (ADR-0089). Never raises."""
    from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

    refusals = ",".join(f"{reason}={count}" for reason, count in sorted(outcome["refusals"].items()))
    record_trace_metadata(
        intake_ended=outcome["ended"],
        intake_mode=outcome["mode"],
        intake_documents_read=outcome["documents_read"],
        intake_suggested=outcome["suggested"],
        intake_corroborated=outcome["corroborated"],
        intake_contradictions=outcome["contradictions"],
        intake_refusals=refusals or None,
        intake_decisive_open=outcome["decisive_open"],
    )
