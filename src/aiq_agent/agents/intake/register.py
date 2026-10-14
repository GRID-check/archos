"""NAT registration of the Erfassungs-Agent's config (``_type: project_intake_agent``).

The agent never runs as a NAT function. The research worker reads this config
by name (``builder.get_function_config("project_intake_agent")``), builds the
model from ``llm`` and the reading tools from ``tools``, and constructs
:class:`~aiq_agent.agents.intake.agent.ProjectIntakeAgent` itself
(``aiq_api/jobs/runner.py``). NAT still builds every function the YAML names for
every workflow, so the function yields a no-op, as the deep researcher's
config-only functions do.

The intake's own tools (``intake_needs``, ``record_values``, ``finish_intake``,
``read_document``) are not NAT functions: they exist only for this agent and are
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


@register_function(config_type=ProjectIntakeAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def project_intake_agent(config: ProjectIntakeAgentConfig, builder: Builder):
    """Config-only: the research worker runs the agent from this config."""

    async def _noop(query: str) -> str:
        """Project intake config placeholder."""
        return "The project intake runs as a background run on the research worker, not as a function."

    yield FunctionInfo.from_fn(_noop, description="Project intake config-only function.")
