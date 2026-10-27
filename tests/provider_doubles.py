"""Model doubles the backend tests share: the provider-contract chat model and NAT's LangChain client shape.

A module of its own, not part of ``tests/conftest.py``: every test loads the
conftest, and these need LangChain and NAT, which most tests never touch
(docs/audit/blast-radius-2026-10.md). Import them where they are used.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.outputs import ChatResult
from pydantic import Field

from nat.llm.openai_llm import OpenAIModelConfig


def nat_langchain_client(model: Any) -> Any:
    """What NAT 1.9's ``builder.get_llm(ref, wrapper_type=LANGCHAIN)`` returns:
    the chat model inside its ``RunnableConfigurableFields``, which
    ``get_langchain_llm`` takes it out of. A fake builder returns this, and
    answers ``get_llm_config`` with :data:`NAT_LLM_CONFIG`."""
    return SimpleNamespace(default=model)


NAT_LLM_CONFIG = OpenAIModelConfig(model_name="test-model")

# ── provider-contract test double ────────────────────────────────────────────
#
# Every LLM double in this suite used to be a bare ``MagicMock``, which accepts
# any message sequence it is handed. That is why a whole family of production
# 400s (issues #291-#294, #333, #335, #336, #340 — "Requests ending with a model
# turn are not supported") was invisible in CI: the tests exercised our graph
# logic correctly and never once asserted that what we put on the wire is a
# request a real provider would accept.
#
# ``StrictProviderChatModel`` closes that gap. It is a real ``BaseChatModel``
# that enforces the wire contract the strictest provider we route to (Google,
# via OpenRouter) enforces, so a graph that assembles an illegal request fails
# in CI the same way it fails in production.


class ProviderContractError(RuntimeError):
    """Raised by :class:`StrictProviderChatModel` for a request a provider would reject."""


class StrictProviderChatModel(BaseChatModel):
    """A chat model that rejects requests real providers reject.

    Enforced invariants, each mirroring an observed production 400:

    - a request must not end on an assistant turn (Google:
      ``Requests ending with a model turn are not supported``);
    - an assistant turn carrying ``tool_calls`` must be followed by its tool
      results (the OpenAI-compatible tool-loop contract);
    - a request must contain at least one message.

    ``responses`` is a queue of replies to hand back in order; the last one is
    reused once exhausted. ``received`` records every request the model was
    asked to serve, so tests can assert on the exact wire payload.
    """

    responses: list[Any] = Field(default_factory=list)
    received: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "strict-provider"

    def bind_tools(self, tools, **kwargs):
        """Bind tools the way a real provider integration does.

        ``BaseChatModel.bind_tools`` raises by default; agents in this repo call
        it on every model they resolve, so the double has to support it or it
        cannot stand in for a production model.
        """
        return self.bind(tools=list(tools), **kwargs)

    def _validate(self, messages: list[Any]) -> None:
        if not messages:
            raise ProviderContractError("Request contains no messages")

        for earlier, following in zip(messages, messages[1:], strict=False):
            if getattr(earlier, "type", None) == "ai" and getattr(earlier, "tool_calls", None):
                if getattr(following, "type", None) != "tool":
                    raise ProviderContractError(
                        "An assistant turn with tool_calls must be followed by its tool results"
                    )

        last = messages[-1]
        if getattr(last, "type", None) == "ai":
            raise ProviderContractError("Requests ending with a model turn are not supported.")

    def _next_response(self) -> AIMessage:
        if not self.responses:
            return AIMessage(content="ok")
        reply = self.responses[0] if len(self.responses) == 1 else self.responses.pop(0)
        return AIMessage(content=reply) if isinstance(reply, str) else reply

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=self._next_response())])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=self._next_response())])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        yield ChatGenerationChunk(message=AIMessageChunk(content=self._next_response().content))
