"""A chat model the agent runtime itself builds, resolved the way the agent resolves one."""

from __future__ import annotations

from agent.common.llm_factory import get_langchain_llm


async def _resolved_through_nat(**llm_config):
    """`get_langchain_llm` on a client the agent runtime itself builds from an `_type: openai` block."""
    import nat.plugins.langchain.llm  # noqa: F401 - registers the agent runtime's LangChain clients
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.llm.openai_llm import OpenAIModelConfig

    config = OpenAIModelConfig(
        model_name="openai/gpt-5.6-luna",
        api_key="test-key",  # pragma: allowlist secret
        **llm_config,
    )
    async with WorkflowBuilder() as builder:
        await builder.add_llm("llm", config)
        return await get_langchain_llm(builder, "llm")
