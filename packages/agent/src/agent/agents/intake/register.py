"""Agent-runtime registration of the Erfassungs-Agent's config (``_type: project_intake_agent``).

The agent never runs as an agent-runtime function. The research worker reads this config
by name (``builder.get_function_config("project_intake_agent")``), builds the
model from ``llm`` and the reading tools from ``tools``, and constructs
:class:`~agent.agents.intake.agent.ProjectIntakeAgent` itself
(``agent_host/jobs/agent_job.py``), handing it the run's budgets from this config
(``_create_agent_instance``, as it hands deep research its own). The agent runtime still
builds every function the YAML names for
every workflow, so the function yields a no-op, as the deep researcher's
config-only functions do.

The intake's own tools (``intake_needs``, ``record_values``, ``finish_intake``,
``read_document``) are not agent-runtime functions: they exist only for this agent and are
built per run, bound to the run's session (``tools.py``, ``reading.py``).
"""

from pydantic import ConfigDict
from pydantic import Field

from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import LLMFrameworkEnum
from nat.plugin_api import LLMRef
from nat.plugin_api import register_function

from .agent import DEFAULT_MAX_RUN_SECONDS
from .agent import DEFAULT_MAX_TOOL_STEPS


class ProjectIntakeAgentConfig(FunctionBaseConfig, name="project_intake_agent"):
    """The Erfassungs-Agent: its model and the shared reading tools it binds."""

    model_config = ConfigDict(extra="forbid")

    llm: LLMRef = Field(..., description="The tool-calling model the intake loop runs on (the chat model's group).")
    tools: list[FunctionRef] = Field(
        default_factory=list,
        description=(
            "The shared reading tools: list_files, knowledge_search, read_passage. Name them explicitly; an empty "
            "list makes the worker inherit every data source, which the intake must not read."
        ),
    )
    verbose: bool = Field(default=False)
    max_tool_steps: int = Field(
        default=DEFAULT_MAX_TOOL_STEPS,
        ge=1,
        description=(
            "Tool calls one reading may make; after them only finish_intake runs. The prompt states it to the model "
            "as information, not as a plan."
        ),
    )
    max_run_seconds: int = Field(
        default=DEFAULT_MAX_RUN_SECONDS,
        ge=1,
        description=(
            "Wall clock for one reading, in seconds. Below the BFF's 30-minute reconciliation of a reading "
            "(STALE_READING_AFTER_MS), so a run finishes itself before the BFF gives up on it."
        ),
    )


@register_function(config_type=ProjectIntakeAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def project_intake_agent(config: ProjectIntakeAgentConfig, builder: Builder):
    """Config-only: the research worker runs the agent from this config."""

    async def _noop(query: str) -> str:
        """Project intake config placeholder."""
        return "The project intake runs as a background run on the research worker, not as a function."

    yield FunctionInfo.from_fn(_noop, description="Project intake config-only function.")
