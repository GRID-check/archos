"""Tests for the ChatAgent."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from agent.agents.piloti.agent import ChatAgent
from agent.agents.piloti.models import ResearchAgentState
from agent.citations.entries import DROPPED_CITATION_MARKER
from agent.citations.entries import EmptySourceRegistryError
from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry
from agent.citations.session import reset_session_registry
from agent.citations.session import set_session_registry
from agent.common import LLMProvider
from agent.common import LLMRole
from agent.common.brand import PRODUCT_NAME
from agent.common.answer_envelope import render_envelope_response_format
from agent.common.data_source_registry import populate_from_config
from agent.common.data_source_registry import reset_registry
from agent.common.retrieval_rounds import assistant_checkpoint
from tests.fixtures.drafting_turns import COMMISSION
from tests.fixtures.drafting_turns import FILE
from tests.fixtures.drafting_turns import REVISE
from tests.fixtures.drafting_turns import SEEDED_DRAFT_PATH
from tests.fixtures.drafting_turns import assert_turn_shape
from tests.fixtures.drafting_turns import draft_cards
from tests.fixtures.drafting_turns import traced_tool_name


async def _run_with_captured_registry(agent, state):
    """Run the agent with a bound session registry and return (result, registry).

    Standalone runs use a fresh per-run registry (discarded afterwards) instead
    of the shared instance one, so tests observe source capture by binding a
    session registry for the duration of the run.
    """
    registry = SourceRegistry()
    token = set_session_registry(registry)
    try:
        result = await agent.run(state)
    finally:
        reset_session_registry(token)
    return result, registry


async def _run_with_bound_registry(agent, state, registry):
    """Run the agent with a caller-supplied (pre-populated) session registry.

    Lets a test seed the registry with prior-turn sources — mirroring the
    cumulative per-session registry hydrated from Redis — so the emission path's
    citation→SourceEntry resolution (entry_for_url / entry_for_citation_key)
    finds real entries.
    """
    token = set_session_registry(registry)
    try:
        result = await agent.run(state)
    finally:
        reset_session_registry(token)
    return result


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


@tool
def emit_card(card_json: str) -> str:
    """Render a rich UI card alongside your answer."""
    return f"Card will be shown with your answer: {card_json}"


@tool
def describe_card(card_types: str) -> str:
    """Return the exact JSON shape for one or more card types."""
    return f"Shapes for: {card_types}"


def _chat_prompt_source() -> str:
    """Piloti's bundled prompt as ONE template: the system prompt, then the turn context.

    The system prompt is `chat_static.md`, the bundled fallback for the
    platform prompt Langfuse serves; `piloti.j2` is the turn context, sent as
    its own message before the newest human message. Rendering them as one
    template lets these tests assert about everything the model reads in a
    turn rather than silently about one of the two messages.
    """
    from pathlib import Path

    from agent.agents.piloti import agent as chat_agent

    prompts = Path(chat_agent.__file__).parent / "prompts"
    static = (prompts / "chat_static.md").read_text(encoding="utf-8")
    return static + "\n" + (prompts / "piloti.j2").read_text(encoding="utf-8")


def _bundled_static_block() -> str:
    """The static half of Piloti's prompt, rendered the way the agent renders it.

    The prompt is two files now: `chat_static.md` (the bundled fallback for
    the platform prompt Langfuse serves) and `piloti.j2` (the dynamic half,
    which opens with `{{ static_block }}`). A test that renders the template
    directly has to supply the half the prompt store would have resolved.
    """
    from agent.agents.piloti.prompt import bundled_static_block
    from agent.agents.piloti.prompt import render_static_block

    return render_static_block(bundled_static_block().text)


def _bundled_prompt_text() -> str:
    """Both halves as bundled, for a test that asks what the prompt SAYS.

    `agent.system_prompt` is the dynamic template alone — everything above the
    KV-cache boundary is resolved per render — so asserting prompt content
    against it would silently stop seeing most of the prompt.
    """
    from agent.agents.piloti.prompt import bundled_static_block
    from agent.agents.piloti.prompt import system_prompt_template

    return bundled_static_block().text + "\n" + system_prompt_template()


class TestChatAgent:
    """Tests for the ChatAgent class."""

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        """Bypass citation verification for tests that don't test it.

        These tests mock the LLM to return AIMessage directly (no tool calls),
        so no tools execute and the source registry stays empty. Patching the
        pipeline avoids EmptySourceRegistryError in run().
        """
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
            patch("agent.agents.piloti.answer_pipeline.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM."""
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        """Create a mock LLM provider."""
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        """Create a real LangChain tool."""
        return web_search_tool

    def test_init_with_defaults(self, mock_llm_provider, real_tool):
        """Test ChatAgent initialization with defaults."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert agent.llm_provider == mock_llm_provider
        assert len(agent.tools) == 1
        assert agent.tool_iteration_ceiling == 5
        assert agent.max_tool_iterations == 5
        assert agent.callbacks == []
        assert agent.system_prompt is not None

    def test_init_with_custom_prompt(self, mock_llm_provider, real_tool):
        """Test ChatAgent initialization with custom system prompt."""
        custom_system = "Custom system prompt"
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            system_prompt=custom_system,
        )
        assert agent.system_prompt == custom_system

    def test_init_with_custom_limits(self, mock_llm_provider, real_tool):
        """The research budget IS the ceiling; nothing else bounds the loop."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_tool_iterations=3,
        )

        assert agent.max_tool_iterations == 3
        assert agent.tool_iteration_ceiling == 3

    def test_init_with_callbacks(self, mock_llm_provider, real_tool):
        """Test ChatAgent initialization with callbacks."""
        callbacks = [MagicMock()]
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=callbacks,
        )

        assert agent.callbacks == callbacks

    def test_init_with_empty_tools(self, mock_llm_provider):
        """Test ChatAgent initialization with empty tools."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[],
        )

        assert agent.tools == []
        assert agent.tools_info == []

    def test_build_tools_info(self, mock_llm_provider, real_tool):
        """Test _build_tools_info correctly extracts tool information."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert len(agent.tools_info) == 1
        assert agent.tools_info[0]["name"] == "web_search_tool"
        assert "Search the web" in agent.tools_info[0]["description"]

    def test_get_llm(self, mock_llm_provider, mock_llm, real_tool):
        """Test _get_llm returns LLM from provider."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        result = agent._get_llm()

        mock_llm_provider.get.assert_called_with(LLMRole.RESEARCHER)
        assert result == mock_llm

    def test_graph_property(self, mock_llm_provider, real_tool):
        """Test graph property returns compiled graph."""
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert agent.graph is not None
        assert agent.graph == agent._graph

    @pytest.mark.asyncio
    async def test_run_basic_query(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() with a basic query."""
        # Create a proper AI response for the agent node
        agent_response = AIMessage(content="CUDA is a parallel computing platform.")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])

        result = await agent.run(state)

        assert result is not None
        assert result.messages is not None

    @pytest.mark.asyncio
    async def test_run_with_callbacks(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() passes callbacks to config."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        mock_callback = MagicMock()
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=[mock_callback],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="Test")])

        await agent.run(state)

        # Agent should complete without errors

    @pytest.mark.asyncio
    async def test_run_extracts_and_strips_control_markers(self, mock_llm_provider, mock_llm, real_tool):
        """Both control markers are stripped before emit_final_report and in the returned message.

        The detected signals are carried as structured state fields.
        """
        from langchain_core.callbacks import BaseCallbackHandler

        agent_response = AIMessage(content="The answer body.\n[CONFIDENCE:high]\n[ESCALATE_TO_DEEP]")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        class _EmitCallback(BaseCallbackHandler):
            def __init__(self):
                self.reports = []

            def emit_final_report(self, content):
                self.reports.append(content)

        emit_callback = _EmitCallback()
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=[emit_callback],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state)

        # emit_final_report received marker-free content.
        assert len(emit_callback.reports) == 1
        emitted = emit_callback.reports[0]
        assert "[CONFIDENCE" not in emitted
        assert "[ESCALATE_TO_DEEP]" not in emitted

        # Returned message content is marker-free too.
        final_content = result.messages[-1].content
        assert "[CONFIDENCE" not in final_content
        assert "[ESCALATE_TO_DEEP]" not in final_content

        # Structured signals populated (escalation_requested is a bool, i.e. not
        # None, signalling extraction ran on a real answer message).
        assert result.escalation_requested is True
        assert result.answer_confidence_marker == "high"

    @pytest.mark.asyncio
    async def test_run_without_markers_sets_neutral_structured_signals(self, mock_llm_provider, mock_llm, real_tool):
        """A clean answer still marks extraction done, with neutral signals."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content="A clean grounded answer [1]."))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # Extraction ran on a real answer message → escalation_requested is the
        # bool False (not the None "not-extracted" sentinel); no markers present.
        assert result.escalation_requested is False
        assert result.answer_confidence_marker is None

    @pytest.mark.asyncio
    async def test_run_flattens_list_shaped_answer_content(self, mock_llm_provider, mock_llm, real_tool):
        """Reasoning models can return the answer as a list of content blocks.

        Regression: ``str(answer_msg.content)`` turned that list into a Python
        repr (``"[{'type': 'text', ...}]"``) as the answer text, which every
        downstream filter (marker extraction, citation checks) then no-oped on.
        The answer text must be the flattened block text, not the list repr.
        """
        agent_response = AIMessage(
            content=[
                {"type": "text", "text": "The flattened answer body [1]."},
                {"type": "text", "text": "[CONFIDENCE:high]"},
            ]
        )
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        # Flattened prose, not a Python list repr.
        assert "The flattened answer body" in final_content
        assert "'type'" not in final_content
        assert not final_content.startswith("[{")
        # The marker embedded in a separate block was still detected + stripped.
        assert "[CONFIDENCE" not in final_content
        assert result.answer_confidence_marker == "high"

    # ------------------------------------------------------------------
    # The answer envelope, END TO END: a scripted ```answer_json reply goes
    # into the real run() and the structured state comes out the other side —
    # extraction, control-field consumption (confidence, escalation), the
    # deterministic gates and the versioned answer_meta wire payload. The
    # parser has its own unit suite (test_answer_envelope.py); these tests
    # exist so a wiring regression anywhere along that chain fails HERE.
    # ------------------------------------------------------------------

    @staticmethod
    def _envelope_reply(*, fenced: bool = True, **overrides):
        """One contract-shaped envelope reply, long enough to earn takeaways."""
        import json as _json

        prose = (
            "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm, weil die "
            "Absturzhöhe unter 12 m liegt [1]. "
            + "Die Höhe wird vom fertigen Fußboden bis zur Oberkante der Umwehrung gemessen. "
            * 10
        )
        envelope = {
            "answer": prose + "\n\n## References\n- [1] https://example.com",
            "verdict": {
                "value": "100 cm",
                "subject": "Erforderliche Geländerhöhe",
                "reference": {"document": "OIB-Richtlinie 4", "section": "Punkt 2.1.1"},
            },
            "takeaways": [
                {"text": "Unter 12 m Absturzhöhe genügen 100 cm."},
                {"text": "Gemessen wird ab fertigem Fußboden.", "detail": "Aufkantungen zählen mit."},
            ],
            "callout": {"kind": "warning", "text": "Ab 12 m Absturzhöhe sind 110 cm erforderlich."},
            "confidence": {"level": "medium", "reason": "eine Fundstelle, nicht am Projekt gemessen"},
            "summary": "Die Terrasse ist damit ohne erhöhte Umwehrung einreichbar; Aufkantungen beim Aufmaß mitzählen.",
        }
        envelope.update(overrides)
        body = _json.dumps(envelope, ensure_ascii=False)
        return f"```answer_json\n{body}\n```" if fenced else body

    @pytest.mark.asyncio
    async def test_run_consumes_a_full_answer_envelope(self, mock_llm_provider, mock_llm, real_tool):
        """Envelope in → prose out, confidence consumed, anatomy gated onto state."""
        from langchain_core.callbacks import BaseCallbackHandler

        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))

        class _EmitCallback(BaseCallbackHandler):
            def __init__(self):
                self.reports = []

            def emit_final_report(self, content):
                self.reports.append(content)

        emit_callback = _EmitCallback()
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[emit_callback])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Geländerhöhe Terrasse?")]))

        # The reader gets the PROSE — the envelope apparatus never reaches them.
        final_content = result.messages[-1].content
        assert "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm" in final_content
        assert "```" not in final_content
        assert '"verdict"' not in final_content
        emitted = emit_callback.reports[-1]
        assert "```" not in emitted
        assert '"confidence"' not in emitted

        # The envelope's control fields were consumed, not just stripped.
        assert result.escalation_requested is False
        assert result.answer_confidence_marker == "medium"
        assert result.answer_confidence_marker_reason == "eine Fundstelle, nicht am Projekt gemessen"

        # The anatomy survived the gates and rides state as the versioned payload.
        assert result.answer_meta is not None
        assert result.answer_meta["v"] == 1
        assert result.answer_meta["verdict"]["value"] == "100 cm"
        assert result.answer_meta["summary"].startswith("Die Terrasse ist damit")
        assert result.answer_meta["verdict"]["reference"]["document"] == "OIB-Richtlinie 4"
        assert len(result.answer_meta["takeaways"]) == 2
        assert result.answer_meta["callout"]["kind"] == "warning"

    @pytest.mark.asyncio
    async def test_run_accepts_the_bare_object_json_mode_produces(self, mock_llm_provider, mock_llm, real_tool):
        """Provider JSON mode emits an UNFENCED object; the chain must not care."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(fenced=False)))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        assert "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm" in final_content
        assert not final_content.strip().startswith("{")
        assert result.answer_confidence_marker == "medium"
        assert result.answer_meta is not None and result.answer_meta["verdict"]["value"] == "100 cm"

    @pytest.mark.asyncio
    async def test_run_keeps_one_placed_callout_marker(self, mock_llm_provider, mock_llm, real_tool):
        """A surviving callout keeps its FIRST own-line `[[callout]]`, and only that."""
        prose = (
            "Die erforderliche Geländerhöhe beträgt 100 cm [1].\n\n"
            "[[callout]]\n\n"
            "Weitere Erläuterung.\n\n[[callout]]\n\n"
            "## References\n- [1] https://example.com"
        )
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(answer=prose)))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        assert final_content.count("[[callout]]") == 1
        assert result.answer_meta is not None and result.answer_meta["callout"]["kind"] == "warning"

    @pytest.mark.asyncio
    async def test_run_strips_the_marker_when_no_callout_survived(self, mock_llm_provider, mock_llm, real_tool):
        """A marker with nothing behind it must never reach the reader."""
        prose = "Die Antwort [1].\n\n[[callout]]\n\nMehr Text.\n\n## References\n- [1] https://example.com"
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(answer=prose, callout=None)))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        assert "[[callout]]" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_run_envelope_escalation_discards_the_anatomy(self, mock_llm_provider, mock_llm, real_tool):
        """`escalate_to_deep: true` sets the signal and drops the decoration."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(escalate_to_deep=True)))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # A shallow answer about to be superseded by deep research must not
        # ship a verdict for the discarded text.
        assert result.escalation_requested is True
        assert result.answer_meta is None
        assert result.answer_confidence_marker == "medium"

    # ------------------------------------------------------------------
    # Provider JSON mode for the envelope (`response_format: json_object`),
    # the OpenRouter-safe variant `cards/generate.py` established. Bound on
    # the tool-free forced-synthesis call; tool-bound iterations only by
    # explicit opt-in (`envelope_json_mode_with_tools`).
    # ------------------------------------------------------------------

    def _bindable(self, mock_llm, reply):
        """Configure `mock_llm.bind(...)` to return a working bound double."""
        bound = MagicMock()
        bound.ainvoke = AsyncMock(return_value=AIMessage(content=reply))
        mock_llm.bind = MagicMock(return_value=bound)
        return bound

    @pytest.mark.asyncio
    async def test_forced_synthesis_binds_json_mode_on_research_turns(self, mock_llm_provider, mock_llm, real_tool):
        """Budget exhausted on a research turn → the synthesis call requests JSON."""
        bound = self._bindable(mock_llm, self._envelope_reply(fenced=False))
        # Ceiling 0: the very first agent_node call is forced synthesis.
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_tool_iterations=0)

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # The strongest rung binds first: strict structured outputs, derived
        # from the envelope models themselves.
        mock_llm.bind.assert_called_once_with(response_format=render_envelope_response_format())
        bound.ainvoke.assert_awaited_once()
        # The JSON-mode response flowed through the same extraction chain.
        assert result.answer_confidence_marker == "medium"
        assert "```" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_json_mode_falls_back_to_a_plain_call(self, mock_llm_provider, mock_llm, real_tool):
        """A provider that rejects response_format degrades to prose, never fails."""
        bound = self._bindable(mock_llm, "")
        rejected = RuntimeError("response_format not supported")
        rejected.status_code = 400
        bound.ainvoke = AsyncMock(side_effect=rejected)
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_tool_iterations=0)

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # The whole ladder was tried in order — json_schema, then json_object —
        # before the plain call answered.
        formats = [call.kwargs["response_format"]["type"] for call in mock_llm.bind.call_args_list]
        assert formats == ["json_schema", "json_object"]
        mock_llm.ainvoke.assert_awaited()
        assert result.answer_confidence_marker == "medium"

    @pytest.mark.asyncio
    async def test_a_transport_error_is_not_retried_down_the_ladder(self, mock_llm_provider, mock_llm, real_tool):
        """Auth, quota and network faults fail the same way on every rung.

        Retrying them under a different ``response_format`` only logged the
        real error three times as "response_format failed" and tripled the
        latency of a turn that was already lost.
        """
        bound = self._bindable(mock_llm, "")
        bound.ainvoke = AsyncMock(side_effect=ConnectionError("upstream reset"))
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_tool_iterations=0)

        with pytest.raises(ConnectionError):
            await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        assert mock_llm.bind.call_count == 1
        mock_llm.ainvoke.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_tool_bound_iterations_bind_json_mode_only_by_opt_in(self, mock_llm_provider, mock_llm, real_tool):
        """Default OFF on tool-bound calls (silent tool-suppression risk); flag turns it on."""
        mock_llm.bind = MagicMock()
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))
        mock_llm.bind.assert_not_called()

        bound = self._bindable(mock_llm, self._envelope_reply())
        opted_in = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool], envelope_json_mode_with_tools=True)
        result = await opted_in.run(ResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        mock_llm.bind.assert_called_once_with(response_format=render_envelope_response_format())
        bound.ainvoke.assert_awaited_once()
        assert result.answer_confidence_marker == "medium"

    @pytest.mark.asyncio
    async def test_run_with_user_info(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() with user info in state."""
        agent_response = AIMessage(content="Personalized answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        # Use custom system_prompt that doesn't require email field
        custom_prompt = "You are an assistant. User: {{ user_info }}."
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            system_prompt=custom_prompt,
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            user_info={"name": "John", "role": "developer"},
        )

        result = await agent.run(state)

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_with_tools_info_in_state(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() uses tools_info from state if provided."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        custom_tools_info = [
            {"name": "custom_tool", "description": "A custom tool"},
        ]

        state = ResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tools_info=custom_tools_info,
        )

        result = await agent.run(state)

        assert result is not None

    def test_a_missing_prompt_is_a_boot_failure(self, mock_llm_provider, real_tool):
        """No stub prompt, ever: production must not run on three lines of filler."""
        from agent.agents.piloti import prompt as prompt_module
        from agent.common.prompt_utils import PromptError

        prompt_module.system_prompt_template.cache_clear()
        try:
            with (
                patch.object(prompt_module, "load_prompt", side_effect=PromptError("piloti.j2 missing")),
                pytest.raises(PromptError),
            ):
                ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        finally:
            prompt_module.system_prompt_template.cache_clear()

    def test_the_prompt_template_is_read_once_per_process(self, mock_llm_provider, real_tool):
        """Two agents, one disk read: the 43 KB template is cached by name."""
        from agent.agents.piloti import prompt as prompt_module

        prompt_module.system_prompt_template.cache_clear()
        try:
            with patch.object(prompt_module, "load_prompt", wraps=prompt_module.load_prompt) as reads:
                first = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])
                second = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        finally:
            prompt_module.system_prompt_template.cache_clear()

        # Count the template's own reads. The first construction also resolves
        # the static half (`resolve_static_block`), which reads its bundled file
        # unless an earlier test in this process already cached it, so a total
        # count depended on which tests ran first on the worker.
        template_reads = [c for c in reads.call_args_list if c.args[1] == prompt_module.PROMPT_NAME]
        assert len(template_reads) == 1
        assert first.system_prompt is second.system_prompt

    def test_default_prompt_requires_tool_result_references(self, mock_llm_provider, real_tool):
        """Default prompt tells the model to cite non-URL tool results by the tool's name."""
        ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert "a result with neither URL nor key is cited by the tool's name" in _bundled_prompt_text()
        assert "exactly as the tool returned it" in _bundled_prompt_text()

    def test_default_prompt_matches_user_language(self, mock_llm_provider, real_tool):
        """Default prompt instructs the model to answer in the user's language."""
        ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        text = _bundled_prompt_text()
        # The turn context is a human-role message right before the question
        # (`prompt.request_messages`) and mostly German project data; "the
        # request" read as including it answered an English question in German
        # (live QA 2026-10-27, "What is this project about?").
        assert "Write in the language of the person's newest message, not of the turn context or files" in text
        assert "language of the request" not in text
        # German questions get Austrian technical German.
        assert "German is Austrian technical German" in text

    def test_an_english_question_is_answered_in_english_in_the_examples(self, mock_llm_provider, real_tool):
        """Every example was German, so the examples taught German whatever the rule said.

        At least one example asks in English and answers in English, with the
        English sources label the CITATIONS rule names.
        """
        import re

        ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        examples = re.findall(r"<example type=\"[a-z]+\">\nUser: (.*?)\n(.*?)</example>", _bundled_prompt_text(), re.S)
        english = [body for question, body in examples if question.startswith(("What ", "How ", "Which "))]

        assert english, "no example asks in English"
        assert all("**References:**" in body and "**Quellen:**" not in body for body in english)

    def test_default_prompt_names_profile_facts_in_words(self, mock_llm_provider, real_tool):
        """The project context lists facts as `key=value`; a key copied into prose reached the reader.

        Live QA 2026-10-27: „max_building_height=3" stood in an answer, in the
        UI and over MCP alike.
        """
        ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        assert "Name a fact in words, never as its key" in _bundled_prompt_text()

    def test_default_prompt_keeps_escalate_marker_language_independent(self, mock_llm_provider, real_tool):
        """Language matching must NOT disturb the envelope's contract tokens.

        The legacy bracket grammar (`[ESCALATE_TO_DEEP]`) is still stripped by
        the parser but no longer taught: the envelope field is the one channel.
        """
        ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert "contract tokens: write them exactly, whatever the answer's language" in _bundled_prompt_text()
        assert "[ESCALATE_TO_DEEP]" not in _bundled_prompt_text()

    def _render_default_prompt(
        self,
        mock_llm_provider,
        real_tool,
        *,
        project_context: str | None = None,
    ) -> str:
        from agent.common import render_prompt_template

        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        # Both messages the turn sends besides the transcript: the system
        # prompt, then the turn context.
        return (
            _bundled_static_block()
            + "\n"
            + render_prompt_template(
                agent.system_prompt,
                user_info=None,
                current_datetime="2026-07-15",
                available_documents=[],
                project_context=project_context,
            )
        )

    def test_the_formatting_block_routes_a_diagram_to_a_drawing_card(self, mock_llm_provider, real_tool):
        """The model-side half of "a diagram printed as a shell listing".

        Asked for a diagram the model drew ASCII box art into a bare fence, and
        the answer promised a drawing and printed a listing. The formatting rule
        routes a drawing to a TAGGED mermaid fence (the envelope parser now
        survives one) or to the shaped card whose fields it needs, and keeps
        the ban on box art.
        """
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)
        formatting = rendered.split("<formatting>")[1].split("</formatting>")[0]
        assert "```mermaid" in formatting
        assert "not only when asked" in formatting
        assert "`:::procedure`" in formatting and "`:::cases`" in formatting
        assert "schematic card" in formatting
        # The box-art ban must survive the rewrite: the third field
        # transcript drew box-drawing characters where a diagram was asked.
        assert "are never a drawing" in formatting
        assert "flowchart TD" in formatting
        # And the consequence, so an edit that keeps the rule and drops the
        # reason still fails: a listing where a drawing was promised.
        assert "reach the reader as a listing" in formatting
        assert "│" in formatting

    def test_project_memory_is_framed_as_fallible_not_binding(self, mock_llm_provider, real_tool):
        """The digest rides inside <project_context>, whose "confirmed facts bind" rule is meant for
        CONFIRMED profile facts. Without an explicit carve-out, agent-authored `unverified` notes inherit
        that weight and the agent defends stale memory instead of accepting a correction. The legend
        renders in the turn context, beside the block, only when the block is there."""
        rendered = self._render_default_prompt(
            mock_llm_provider,
            real_tool,
            project_context=(
                "PROJECT_MEMORY v1\n"
                '- [derived_fact | high | unverified] "Für Bergsteiggasse ist OIB-RL 2.1 nicht anwendbar"'
            ),
        )

        assert "neither a confirmed fact nor law" in rendered
        assert "The current conversation outranks it" in rendered
        assert "never argue the person out of their own correction" in rendered
        # Memory must never be laundered into a legal citation.
        assert "never a source for a legal requirement" in rendered
        without = self._render_default_prompt(mock_llm_provider, real_tool, project_context="name: X")
        assert "PROJECT_MEMORY" not in without

    def test_research_turn_prompt_keeps_the_envelope_mandate(self, mock_llm_provider, real_tool):
        """The envelope contract is rendered on every turn; there is no suppression note."""
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)

        assert "<answer_envelope>" in rendered
        assert "Every researched answer carries `confidence`" in rendered
        # The schema the validator enforces is the one the model is taught —
        # injected by the renderer, never an empty block.
        assert "answer*: string" in rendered
        assert "escalate_to_deep" in rendered
        assert "classified as conversational / meta" not in rendered

    def test_the_confidence_marker_does_not_depend_on_having_sources(self, mock_llm_provider, real_tool):
        """A measured answer cites nothing, and used to drop the marker with it.

        On the first live run of this branch the marker was absent from 4 of 32
        real answers — and the split was not random. Every answer that produced
        a `**Quellen:**` section carried the marker (18/18); every answer that
        produced none dropped it 4 times in 14. The prompt therefore has to say
        that confidence stands alone, and to give a measurement somewhere to
        land among the levels.

        Nothing here makes the marker enforceable: a missing marker stays a
        soft degradation (no chip), never an error and never a retry.
        """
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)

        # Grounding is evidence, not sources alone — a measurement counts.
        assert "every answer that retrieved, measured or cites" in rendered
        assert "a measurement taken this turn" in rendered
        assert "a record or a measurement never stands in for one" in rendered
        # And WHY it matters, which is what the model was never told.
        assert "An answer that cites nothing still carries it" in rendered
        assert "there is no confidence chip" in rendered

    @pytest.mark.asyncio
    async def test_tool_iterations_incremented_on_tool_calls(self, mock_llm_provider, mock_llm, real_tool):
        """Test tool_iterations counter increments when LLM makes tool calls."""
        # First call returns tool calls, second call returns final answer
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "test"}, "id": "1"}],
        )
        final_response = AIMessage(content="Final answer")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=0,
        )

        result = await agent.run(state)

        # tool_iterations should have been incremented
        assert result.tool_iterations >= 1

    @pytest.mark.asyncio
    async def test_forced_synthesis_at_max_iterations(self, mock_llm_provider, mock_llm, real_tool):
        """Test that agent forces synthesis when max_tool_iterations is reached."""
        # Response would normally include tool calls, but should be overridden
        final_response = AIMessage(content="Forced synthesis response")
        mock_llm.ainvoke = AsyncMock(return_value=final_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_tool_iterations=3,
        )

        # Start with iterations already at max
        state = ResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=3,
        )

        result = await agent.run(state)

        assert result is not None
        # The unbounded LLM should have been called (without tools)
        mock_llm.ainvoke.assert_called()

    @pytest.mark.asyncio
    async def test_a_round_of_cards_costs_one_round(self, mock_llm_provider, mock_llm, real_tool):
        """The regression behind "an answer only ever carries one card".

        One search, then a shape lookup and two cards. Every tool CALL used to
        be charged to ``max_tool_iterations``, so three calls of the answer's
        own output channel ate three of the budget and the second card the
        doctrine allows was unreachable on any turn that had actually searched.
        Charging ROUNDS removes the problem at its cause rather than exempting
        the card channel: the whole card round is one, like the search before
        it, and no second currency has to be kept in step.
        """
        search_round = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "test"}, "id": "1"}],
        )
        # A shape lookup and both cards, the way the tool description asks for
        # them: one `describe_card` for the types the answer wants, then the
        # cards. Three calls, one decision, one round.
        card_round = AIMessage(
            content="",
            tool_calls=[
                {"name": "describe_card", "args": {"card_types": "verdict_header,typed_table"}, "id": "2"},
                {"name": "emit_card", "args": {"card_json": "{}"}, "id": "3"},
                {"name": "emit_card", "args": {"card_json": "{}"}, "id": "4"},
            ],
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[search_round, card_round, AIMessage(content="Final answer")])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool, emit_card, describe_card],
            max_tool_iterations=3,
        )

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Test query")]))

        # Two rounds: the search and the cards. The turn never reached its
        # ceiling and was never cut off, so both cards are emitted.
        assert result.tool_iterations == 2
        assert result.research_truncated is None
        assert sum(1 for message in result.messages if getattr(message, "name", None) == "emit_card") == 2

    def test_state_has_tool_iterations_field(self):
        """Test that ResearchAgentState has tool_iterations field."""
        state = ResearchAgentState(messages=[HumanMessage(content="Test")])
        assert hasattr(state, "tool_iterations")
        assert state.tool_iterations == 0

    def test_state_tool_iterations_default_value(self):
        """Test tool_iterations defaults to 0."""
        state = ResearchAgentState(messages=[HumanMessage(content="Test")])
        assert state.tool_iterations == 0

    def test_state_tool_iterations_can_be_set(self):
        """Test tool_iterations can be set to custom value."""
        state = ResearchAgentState(
            messages=[HumanMessage(content="Test")],
            tool_iterations=5,
        )
        assert state.tool_iterations == 5

    @pytest.mark.asyncio
    async def test_run_returns_updated_tool_iterations(self, mock_llm_provider, mock_llm, real_tool):
        """Test that run() returns state with updated tool_iterations."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="Test")],
            tool_iterations=0,
        )

        result = await agent.run(state)

        # Result should have tool_iterations field
        assert hasattr(result, "tool_iterations")

    @pytest.mark.asyncio
    async def test_forced_synthesis_adds_instruction_message(self, mock_llm_provider, mock_llm, real_tool):
        """Test that forced synthesis adds instruction to synthesize."""
        captured_messages = []

        async def capture_messages(messages):
            captured_messages.append(messages)
            return AIMessage(content="Synthesized response")

        mock_llm.ainvoke = AsyncMock(side_effect=capture_messages)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_tool_iterations=2,
        )

        # Start at max iterations to trigger forced synthesis
        state = ResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=2,
        )

        await agent.run(state)

        # Check that synthesis instruction was added
        last_call_messages = captured_messages[0]
        synthesis_instruction_found = any(
            "research limit" in str(msg.content).lower() for msg in last_call_messages if hasattr(msg, "content")
        )
        assert synthesis_instruction_found


# ---------------------------------------------------------------------------
# Integration tests — verify end-to-end source capture without bypasses
# ---------------------------------------------------------------------------


@tool
def web_search_with_urls(query: str) -> str:
    """Search the web and return results with URLs."""
    return (
        '<Document href="https://docs.nvidia.com/cuda/">\n'
        "<title>\nCUDA Toolkit Documentation\n</title>\n"
        "CUDA is a parallel computing platform.\n"
        "</Document>"
    )


@tool
def mcp_time__get_current_time(timezone: str = "UTC") -> str:
    """Get the current time for a timezone."""
    return "2026-05-11T14:30:00+09:00"


@tool
def weather_observation_tool(location: str) -> str:
    """Get current observed weather conditions."""
    return f"Current conditions for {location}: clear, 68F"


@tool
def empty_web_search_tool(query: str) -> str:
    """Search the web (returns no results)."""
    return ""


@tool
def project_lookup(action: str, query: str = "") -> str:
    """Look into the office's other projects (a search that matched nothing)."""
    return "Treffer aus anderen Projekten: 0 Passage(n) aus 0 Projekt(en); 7 von 7 Projekten durchsucht."


@tool
def remember_tool(fact: str) -> str:
    """Durably save a user preference, decision, or project fact."""
    return f"Saved: {fact}"


_SPY_SEARCH_EXECUTIONS: list[str] = []


@tool
def spy_search_tool(query: str) -> str:
    """Search the web (spy: records every actual execution)."""
    _SPY_SEARCH_EXECUTIONS.append(query)
    return f"Results for: {query}"


class TestChatSourceRegistryGating:
    """Tests that source capture is gated by data_source_registry."""

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        yield
        reset_registry()

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.mark.asyncio
    async def test_explicit_tool_not_declared_as_data_source_is_not_captured(self, mock_llm_provider, mock_llm):
        """Loaded agent tools are not enough; the tool must be in data_source_registry.

        A tool outside the registry captures no sources, and because no
        data-source lookup was attempted the answer is returned rather than
        rejected by the citation guard.
        """
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=("The current time was returned by the MCP tool.\n\n## Sources\n[1] mcp_time__get_current_time")
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result = await agent.run(state)

        assert result.verified_sources is None
        assert "current time" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_an_answer_that_looked_nothing_up_is_returned_as_is(self, mock_llm_provider, mock_llm):
        """A reply from project context calls no data-source tool. An empty
        registry then is not a failure — the answer is returned as it is, and
        the result says no source was consulted (which is what the chat node
        reads a direct reply from).
        """
        final_response = AIMessage(content="Your project **test 1** is a Neubau, Beherbergung, GK3 building.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="what do you know about my project")],
        )
        result = await agent.run(state)

        assert result.verified_sources is None
        assert "test 1" in result.messages[-1].content
        assert result.source_lookup_attempted is False

    @pytest.mark.asyncio
    async def test_a_greeting_keeps_the_full_binding(self, mock_llm_provider, mock_llm):
        """No turn is narrowed by a classification any more (ADR-0052): the
        greeting is answered from the same construction-time binding a
        Baurecht question uses, search tool included. Whether to call it is
        the model's decision, made with the tool in hand.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        final_response = AIMessage(content="Hallo! Bei mir läuft alles super.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool, remember_tool],
        )
        bound_at_construction = {getattr(t, "name", t) for t in mock_llm.bind_tools.call_args.args[0]}
        assert bound_at_construction == {"empty_web_search_tool", "remember_tool"}
        mock_llm.bind_tools.reset_mock()

        state = ResearchAgentState(messages=[HumanMessage(content="wie läufts so")])
        result = await agent.run(state)

        # No second, narrower binding was made for the turn.
        assert mock_llm.bind_tools.call_count == 0
        assert "läuft alles super" in result.messages[-1].content
        assert result.source_lookup_attempted is False

    @pytest.mark.asyncio
    async def test_a_search_the_model_calls_on_a_greeting_executes(self, mock_llm_provider, mock_llm):
        """The other half of the same rule: a tool the model decides to call
        runs, on any turn. The old meta partition returned an invalid-tool
        error here; that partition is what made "zeig mir die Grundrisse"
        answer that its tool was not available in this session.
        """
        _SPY_SEARCH_EXECUTIONS.clear()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["spy_search_tool"],
                }
            ],
        )
        search_call = AIMessage(
            content="",
            tool_calls=[{"name": "spy_search_tool", "args": {"query": "wie läufts so"}, "id": "1"}],
        )
        final_response = AIMessage(content="Hallo! Bei mir läuft alles super.")
        mock_llm.ainvoke = AsyncMock(side_effect=[search_call, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[spy_search_tool, remember_tool],
            repair_pass=False,
        )

        state = ResearchAgentState(messages=[HumanMessage(content="wie läufts so")])
        result = await agent.run(state)

        assert _SPY_SEARCH_EXECUTIONS == ["wie läufts so"]
        assert "läuft alles super" in result.messages[-1].content
        assert result.source_lookup_attempted is True

    @pytest.mark.asyncio
    async def test_research_turn_hallucinated_search_call_executes(self, mock_llm_provider, mock_llm):
        """A research question: the search tool is available and a tool call
        executes normally."""
        _SPY_SEARCH_EXECUTIONS.clear()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["spy_search_tool"],
                }
            ],
        )
        search_call = AIMessage(
            content="",
            tool_calls=[{"name": "spy_search_tool", "args": {"query": "OIB 2.2"}, "id": "1"}],
        )
        final_response = AIMessage(content="Answer [1].\n\n**References:**\n- [1] Results for: OIB 2.2")
        mock_llm.ainvoke = AsyncMock(side_effect=[search_call, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[spy_search_tool, remember_tool],
            # This test is about tool GATING. The answer's "[1]" resolves to
            # nothing, which is exactly what the repair pass re-searches for;
            # that second search is the repair's own tests' business.
            repair_pass=False,
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies?")],
        )
        await _run_with_captured_registry(agent, state)

        # On a research turn the search tool really runs.
        assert _SPY_SEARCH_EXECUTIONS == ["OIB 2.2"]

    @pytest.mark.asyncio
    async def test_research_turn_keeps_search_tools_bound(self, mock_llm_provider, mock_llm):
        """A research question uses the full construction-time binding, so the
        search tool remains available."""
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        final_response = AIMessage(content="Answer from context.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool, remember_tool],
        )
        mock_llm.bind_tools.reset_mock()

        state = ResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies to high-rise buildings?")],
        )
        await agent.run(state)

        # Research turns reuse the full binding made at construction; no
        # additional (narrowed) binding is created.
        assert mock_llm.bind_tools.call_count == 0

    @pytest.mark.asyncio
    async def test_a_failed_lookup_ships_the_answer_labelled_as_model_knowledge(self, mock_llm_provider, mock_llm):
        """A research turn that DID query a data source and captured nothing ships its answer, labelled.

        It used to raise EmptySourceRegistryError, and the reader got a canned
        „nothing retrieved" message instead of the answer (ADR-0125). The
        answer now carries the banner flag, and every sentence is the model's
        own knowledge; an [N] it wrote anyway is labelled, not shown as a source.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "empty_web_search_tool", "args": {"query": "OIB 2.2"}, "id": "1"}],
        )
        final_response = AIMessage(content="Hochhäuser regelt die OIB-RL 2.3 [1].\n\n## Quellen\n- [1] oib-rl_2.3.pdf")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool],
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies to high-rise buildings?")],
        )
        result = await agent.run(state)

        assert result.answer_lookup_found_nothing is True
        assert result.messages[-1].content == f"Hochhäuser regelt die OIB-RL 2.3 {DROPPED_CITATION_MARKER}."
        assert result.verified_sources is None

    @pytest.mark.asyncio
    async def test_a_ruling_whose_lookup_found_nothing_is_still_refused(self, mock_llm_provider, mock_llm):
        """A ruling exists to carry a copyable legal value; without a source it has nothing to show."""
        populate_from_config(
            [{"id": "web_search", "name": "Web Search", "description": "Web.", "tools": ["empty_web_search_tool"]}],
        )
        ruling = '```answer_json\n{"kind": "ruling", "answer": "Die Fluchtweglänge beträgt 40 m."}\n```'
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[{"name": "empty_web_search_tool", "args": {"query": "Fluchtweg GK 4"}, "id": "1"}],
                ),
                AIMessage(content=ruling),
            ]
        )
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[empty_web_search_tool])

        with pytest.raises(EmptySourceRegistryError):
            await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]))

    @pytest.mark.asyncio
    async def test_a_lookup_in_other_projects_that_found_nothing_keeps_its_honest_answer(
        self, mock_llm_provider, mock_llm
    ):
        """„Nichts Vergleichbares" is the answer, not a failed retrieval.

        A search over the office's projects that matched nothing, a listing and
        a brief register no passage; replacing the model's answer with the
        retry message told a planner to try again a question whose answer is
        „das hatten wir noch nie" (precedent eval, Oct 2026).
        """
        populate_from_config(
            [{"id": "knowledge_layer", "name": "Knowledge", "description": "Projects.", "tools": ["project_lookup"]}],
        )
        honest = "Eine Tiefgarage mit über 100 Stellplätzen hatten wir in keinem Referenzprojekt."
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "project_lookup", "args": {"action": "search", "query": "Tiefgarage"}, "id": "1"}
                    ],
                ),
                AIMessage(content=honest),
            ]
        )
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[project_lookup])

        result = await agent.run(
            ResearchAgentState(
                messages=[HumanMessage(content="Hatten wir schon eine Tiefgarage mit über 100 Stellplätzen?")]
            )
        )

        assert honest in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_an_empty_passage_search_beside_a_record_lookup_is_flagged(self, mock_llm_provider, mock_llm):
        """Only the record lookup is exempt: a norm search that came back empty still raises the banner."""
        populate_from_config(
            [
                {"id": "knowledge_layer", "name": "Knowledge", "description": "Projects.", "tools": ["project_lookup"]},
                {"id": "web_search", "name": "Web Search", "description": "Web.", "tools": ["empty_web_search_tool"]},
            ],
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "project_lookup", "args": {"action": "search", "query": "Tiefgarage"}, "id": "1"},
                        {"name": "empty_web_search_tool", "args": {"query": "OIB-RL 2.2 Garage"}, "id": "2"},
                    ],
                ),
                AIMessage(content="Die OIB-RL 2.2 verlangt …"),
            ]
        )
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[project_lookup, empty_web_search_tool])

        result = await agent.run(
            ResearchAgentState(messages=[HumanMessage(content="Was verlangt die OIB für Garagen?")])
        )

        assert result.answer_lookup_found_nothing is True

    @pytest.mark.asyncio
    async def test_research_turn_answered_from_context_returns_answer(self, mock_llm_provider, mock_llm):
        """A research-routed turn the agent answers from conversation/project
        context WITHOUT attempting any data-source lookup must return the
        answer, not raise. Regression for the misrouted-conversational-turn
        incident: the citation guard replaced a substantive answer with a
        misleading "search tools did not return any results" error even though
        no tool was ever called.
        """
        final_response = AIMessage(content="To fill in hohe_gebaeude_details I need the exact building height.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ResearchAgentState(
            messages=[HumanMessage(content="what do you need to know to fill that in?")],
        )
        result = await agent.run(state)

        assert result.verified_sources is None
        assert "building height" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_registered_group_tool_without_urls_is_captured(self, mock_llm_provider, mock_llm):
        """Registered group child tools without URLs can be non-URL citation sources."""
        populate_from_config(
            [
                {
                    "id": "mcp_time",
                    "name": "MCP Time",
                    "description": "Get current time and timezone information through MCP.",
                    "tools": ["mcp_time"],
                }
            ],
            group_names={"mcp_time"},
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=("The current time was returned by the MCP tool.\n\n## Sources\n[1] mcp_time__get_current_time")
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert sources[0].source_type == "tool_result"
        assert result.messages[-1].content.rstrip().endswith("[1] mcp_time__get_current_time")

    @pytest.mark.asyncio
    async def test_a_source_the_model_did_not_cite_is_never_appended(self, mock_llm_provider, mock_llm):
        """The single-source fallback is gone (ADR-0125): an uncited answer stays uncited, with no chip invented."""
        populate_from_config(
            [
                {
                    "id": "mcp_time",
                    "name": "MCP Time",
                    "description": "Get current time and timezone information through MCP.",
                    "tools": ["mcp_time"],
                }
            ],
            group_names={"mcp_time"},
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(content="It's currently 4:54 AM in Tokyo.")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result = await agent.run(state)

        assert result.messages[-1].content.rstrip() == "It's currently 4:54 AM in Tokyo."
        assert result.verified_sources is None
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_missing_citation_fallback_skips_ambiguous_multi_source_registry(self, mock_llm_provider, mock_llm):
        """Do not inject the first captured source when multiple sources exist."""
        populate_from_config(
            [
                {
                    "id": "mcp_time",
                    "name": "MCP Time",
                    "description": "Get current time and timezone information through MCP.",
                    "tools": ["mcp_time"],
                },
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web for real-time information.",
                    "tools": ["web_search_with_urls"],
                },
            ],
            group_names={"mcp_time"},
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[
                {"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"},
                {"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "2"},
            ],
        )
        final_response = AIMessage(content="CUDA is a parallel computing platform.")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time, web_search_with_urls],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What is CUDA? Also note the time.")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) >= 2
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert any(source.url == "https://docs.nvidia.com/cuda/" for source in sources)
        assert result.messages[-1].content == "CUDA is a parallel computing platform."

    @pytest.mark.asyncio
    async def test_registered_exact_data_source_tool_without_urls_is_captured(self, mock_llm_provider, mock_llm):
        """Any exact tool declared under data_sources can be a non-URL citation source."""
        populate_from_config(
            [
                {
                    "id": "weather_observations",
                    "name": "Weather Observations",
                    "description": "Current observed weather conditions.",
                    "tools": ["weather_observation_tool"],
                }
            ]
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "weather_observation_tool", "args": {"location": "San Francisco"}, "id": "1"}],
        )
        final_response = AIMessage(content="The weather is clear.\n\n## Sources\n[1] weather_observation_tool")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[weather_observation_tool],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What is the weather in San Francisco?")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "weather_observation_tool"
        assert sources[0].source_type == "tool_result"
        assert result.messages[-1].content.rstrip().endswith("[1] weather_observation_tool")


class TestChatSourceCaptureIntegration:
    """Integration tests verifying source capture through the full pipeline.

    These tests do NOT bypass the citation pipeline — they verify that
    tool_node_with_source_capture registers sources from real tool execution,
    and that verify_citations + sanitize_report run on the final output.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_web_search_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web for real-time information.",
                    "tools": ["web_search_with_urls"],
                }
            ]
        )
        yield
        reset_registry()

    @pytest.mark.asyncio
    async def test_source_registry_populated_from_tool_call(self, mock_llm_provider, mock_llm):
        """Tool execution populates the source registry with extracted URLs."""
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=(
                "CUDA is a parallel computing platform.\n\n"
                "## Sources\n"
                "[1] CUDA Toolkit Documentation: https://docs.nvidia.com/cuda/"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_with_urls],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
        result, registry = await _run_with_captured_registry(agent, state)

        # Source registry should have the URL from tool output
        sources = registry.all_sources()
        assert len(sources) >= 1
        assert any(s.url == "https://docs.nvidia.com/cuda/" for s in sources)

        # Final output should exist and have been processed
        assert result.messages[-1].content

    @pytest.mark.asyncio
    async def test_invalid_citation_removed_end_to_end(self, mock_llm_provider, mock_llm):
        """Citations not backed by registry sources are removed from output."""
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "1"}],
        )
        # LLM fabricates a citation [2] not in the registry
        final_response = AIMessage(
            content=(
                "CUDA is great [1]. Also see this [2].\n\n"
                "## Sources\n"
                "[1] CUDA Docs: https://docs.nvidia.com/cuda/\n"
                "[2] Fake Source: https://totally-fabricated.example.com/fake"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_with_urls],
        )

        state = ResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent.run(state)

        output = result.messages[-1].content
        # The fabricated URL should have been removed by verify_citations
        assert "totally-fabricated.example.com" not in output
        # The valid citation should survive
        assert "docs.nvidia.com/cuda" in output


# ---------------------------------------------------------------------------
# Session registry integration tests
# ---------------------------------------------------------------------------


class TestChatSessionRegistry:
    """Tests verifying session-scoped SourceRegistry integration.

    These tests do NOT use the _bypass_citation_pipeline fixture — they verify
    the actual ContextVar-based session registry behavior.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.mark.asyncio
    async def test_run_uses_session_registry_when_set(self, mock_llm_provider, mock_llm):
        """When session registry is set via ContextVar, run() uses it and doesn't raise."""
        from agent.citations.session import set_session_registry

        # Pre-populate a session registry with a source from a "prior turn"
        session_reg = SourceRegistry()
        session_reg.add(SourceEntry(url="https://prior-turn.example.com/article"))

        # LLM answers from memory (no tool calls) citing the prior-turn URL
        agent_response = AIMessage(
            content=(
                "Answer based on prior context [1].\n\n"
                "## Sources\n"
                "[1] Prior Article: https://prior-turn.example.com/article"
            )
        )
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_tool],
        )

        set_session_registry(session_reg)
        try:
            state = ResearchAgentState(messages=[HumanMessage(content="Follow-up question")])
            result = await agent.run(state)
            # Should NOT raise EmptySourceRegistryError because session registry has sources
            assert result is not None
            assert "prior-turn.example.com/article" in result.messages[-1].content
        finally:
            set_session_registry(None)

    @pytest.mark.asyncio
    async def test_standalone_runs_never_share_a_registry(self, mock_llm_provider, mock_llm):
        """Without a session registry every run gets a fresh one: a source the
        previous run captured must not be auto-appended as this run's citation."""
        from agent.citations.session import set_session_registry

        set_session_registry(None)  # Ensure no session registry
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["web_search_with_urls"],
                }
            ]
        )
        try:
            mock_llm.ainvoke = AsyncMock(
                side_effect=[
                    AIMessage(
                        content="", tool_calls=[{"name": "web_search_with_urls", "args": {"query": "q"}, "id": "1"}]
                    ),
                    AIMessage(content="Grounded [1].\n\n## Sources\n[1] https://docs.nvidia.com/cuda/"),
                    AIMessage(content="Answer without sources"),
                ]
            )
            agent = ChatAgent(llm_provider=mock_llm_provider, tools=[web_search_with_urls])

            first = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Q1")]))
            second = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Q2")]))
        finally:
            reset_registry()

        assert first.answer_citation_grounded is True
        assert "docs.nvidia.com" not in second.messages[-1].content
        assert second.verified_sources is None

    @pytest.mark.asyncio
    async def test_the_session_registry_is_left_bound_after_the_run(self, mock_llm_provider, mock_llm):
        """A run reads the session registry and never unbinds or replaces it."""
        from agent.citations.session import get_session_registry
        from agent.citations.session import set_session_registry

        session_reg = SourceRegistry()
        session_reg.add(SourceEntry(url="https://session.example.com/doc"))

        agent_response = AIMessage(content=("Answer [1].\n\n## Sources\n[1] Doc: https://session.example.com/doc"))
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_tool],
        )

        set_session_registry(session_reg)
        try:
            state = ResearchAgentState(messages=[HumanMessage(content="Q")])
            result = await agent.run(state)
            assert get_session_registry() is session_reg
            assert result.answer_citation_grounded is True
        finally:
            set_session_registry(None)


class TestChatAnswerGrounding:
    """The ``answer_citation_grounded`` overconfidence-guard signal set by run().

    This class deliberately does NOT inherit the citation-bypass autouse fixture
    of TestChatAgent: each test controls the verification outcome
    and registry contents itself.
    """

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        yield
        reset_registry()

    @staticmethod
    def _after_a_lookup(mock_llm, answer: str, *, query: str = "q") -> None:
        """Script one web search, then the answer.

        The single-source fallback grounds an answer in the one source THIS
        turn retrieved; a turn that looked nothing up gets no citation appended
        (or a greeting would inherit last turn's source). So the tests that
        exercise the fallback have to look something up first.
        """
        populate_from_config(
            [{"id": "web_search", "name": "Web Search", "description": "Search the web.", "tools": ["web_search_tool"]}]
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(content="", tool_calls=[{"name": "web_search_tool", "args": {"query": query}, "id": "1"}]),
                AIMessage(content=answer),
            ]
        )

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    def _agent(self, provider, **kwargs):
        # The fallback tests script exactly one search and one answer; the
        # repair pass would spend a third call and is not what they test.
        return ChatAgent(llm_provider=provider, tools=[web_search_tool], **kwargs)

    @pytest.mark.asyncio
    async def test_grounded_when_verification_keeps_valid_citation(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke.return_value = AIMessage(content="OIB-Richtlinie 2 regelt Brandschutz [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        # valid_citations must be dict-shaped (matching real verify_citations
        # output) so the emission path can resolve each cited citation back to
        # its registry SourceEntry.
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="OIB-Richtlinie 2 regelt Brandschutz [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Brandschutz?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is True

    @pytest.mark.asyncio
    async def test_not_grounded_when_no_citation_survives_beside_a_lone_source(self, mock_llm_provider, mock_llm):
        # No model citation survives and exactly one registry source exists:
        # the fallback appended it and called the answer grounded. Nothing is
        # appended any more, so nothing grounds it (ADR-0125).
        self._after_a_lookup(mock_llm, "Answer without any citation.")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Answer without any citation.",
                valid_citations=[],
                removed_citations=[{"number": 1, "line": "[1]", "reason": "unverifiable"}],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Q?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider, repair_pass=False), state)
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_not_grounded_when_all_citations_removed_and_many_sources(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke.return_value = AIMessage(content="Answer [1][2].")
        sources = [
            SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"),
            SourceEntry(url="https://example.com/b", title="B", tool_name="web_search_tool"),
        ]
        with (
            patch.object(SourceRegistry, "all_sources", return_value=sources),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Answer.",
                valid_citations=[],
                removed_citations=["[1]", "[2]"],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Q?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_not_grounded_when_registry_empty_and_nothing_was_looked_up(self, mock_llm_provider, mock_llm):
        # Empty registry, a greeting: nothing to cite → not grounded (a
        # self-report would be capped to "low" downstream).
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        state = ResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_an_unresolvable_citation_is_labelled_not_replaced(self, mock_llm_provider, mock_llm):
        # Inline [1] citation, NO Sources section written by the model, and a
        # registry whose one source the REAL verifier cannot resolve the [1]
        # to (``all_sources`` is patched; the URL index is not). The single-
        # source fallback used to attach that source in the [1]'s place; the
        # marker is now labelled where it stood and no source is attached
        # (ADR-0125). Uses the REAL verification/sanitization pipeline.
        self._after_a_lookup(mock_llm, "The building height limit is 12 m [1].")
        source = SourceEntry(url="https://example.gv.at/oib", title="OIB Richtlinie", tool_name="web_search_tool")
        with patch.object(SourceRegistry, "all_sources", return_value=[source]):
            state = ResearchAgentState(messages=[HumanMessage(content="What is the height limit?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider, repair_pass=False), state)

        answer = next(m for m in reversed(result.messages) if isinstance(m, AIMessage) and not m.tool_calls)
        assert answer.content == f"The building height limit is 12 m {DROPPED_CITATION_MARKER}."
        assert "OIB Richtlinie" not in answer.content
        assert result.answer_citation_grounded is False

    # --- verified_sources emission: only THIS turn's cited sources become chips ---

    @pytest.mark.asyncio
    async def test_verified_sources_empty_when_answer_cites_nothing(self, mock_llm_provider, mock_llm):
        # The reported bug: a per-session registry carries a prior turn's RIS
        # source, but this turn's answer cites nothing (e.g. a greeting routed
        # as research). No citation survives verification → NO chips are emitted
        # (must not re-emit the previous turn's source).
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                url="https://ris.bka.gv.at/prev",
                title="Prior RIS source",
                tool_name="ris_search",
            )
        )
        with patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Hallo! Wie kann ich helfen?",
                valid_citations=[],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="hallo wie gehts")])
            # Two registry sources would exist here in the real bug; add a second
            # so the single-source minimal-citation path does NOT fire.
            registry.add(
                SourceEntry(
                    url="https://ris.bka.gv.at/prev2",
                    title="Prior RIS source 2",
                    tool_name="ris_search",
                )
            )
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is None

    @pytest.mark.asyncio
    async def test_verified_sources_only_the_one_cited_of_many(self, mock_llm_provider, mock_llm):
        # Registry holds three sources; the answer cites exactly one → chips
        # contain only that one (the model's own relevance decision).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        registry = SourceRegistry()
        cited = SourceEntry(url="https://example.com/b", title="B", tool_name="web_search_tool")
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(cited)
        registry.add(SourceEntry(url="https://example.com/c", title="C", tool_name="web_search_tool"))
        with patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/b", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is not None
        assert [s["url"] for s in result.verified_sources] == ["https://example.com/b"]

    @pytest.mark.asyncio
    async def test_verified_sources_citation_key_resolves(self, mock_llm_provider, mock_llm):
        # A knowledge-layer citation (citation_key, no URL) resolves to its entry.
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(SourceEntry(citation_key="oib-richtlinie-2.pdf#p3", title="OIB 2", tool_name="kb_search"))
        with patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[
                    {
                        "number": 1,
                        "url": None,
                        "citation_key": "oib-richtlinie-2.pdf#p3",
                        "line": "[1]",
                    }
                ],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is not None
        assert [s["citation_key"] for s in result.verified_sources] == ["oib-richtlinie-2.pdf#p3"]

    @pytest.mark.asyncio
    async def test_a_lone_registry_source_is_not_emitted_when_nothing_was_cited(self, mock_llm_provider, mock_llm):
        # Exactly one registry source and no surviving model citation: the
        # single-source fallback emitted that source as the answer's chip. It
        # is gone (ADR-0125), so no chip is invented.
        self._after_a_lookup(mock_llm, "Answer without any citation.", query="https://example.com/only")
        registry = SourceRegistry()
        only = SourceEntry(url="https://example.com/only", title="Only", tool_name="web_search_tool")
        registry.add(only)
        with patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Answer without any citation.",
                valid_citations=[],
                removed_citations=[{"number": 1, "line": "[1]", "reason": "unverifiable"}],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Q?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider, repair_pass=False), state, registry)
        assert result.verified_sources is None

    @pytest.mark.asyncio
    async def test_verified_sources_empty_when_a_greeting_cites_nothing_from_a_populated_registry(
        self, mock_llm_provider, mock_llm
    ):
        # A greeting on a conversation whose registry still holds last turn's
        # source: nothing is cited and nothing was looked up this turn, so the
        # single-source fallback must not hand the greeting that source as its
        # citation, and no chip is emitted.
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://ris.bka.gv.at/prev", title="Prior RIS", tool_name="ris_search"))
        state = ResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is None

    # --- citation numbers: the [N] label each cited source carries in the prose ---

    @pytest.mark.asyncio
    async def test_verified_sources_carry_their_citation_number(self, mock_llm_provider, mock_llm):
        # The [N] → source binding exists only inside verify_citations. Emitting
        # it lets the frontend render ONE numbered provenance block instead of
        # the written source list plus an unnumbered chip row.
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1][2].")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(SourceEntry(citation_key="oib-rl_4.pdf, p.9", title="OIB 4", tool_name="kb_search"))
        with patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1][2].",
                valid_citations=[
                    {"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"},
                    {"number": 2, "url": None, "citation_key": "oib-rl_4.pdf, p.9", "line": "[2]"},
                ],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert [s["number"] for s in result.verified_sources] == [1, 2]

    @pytest.mark.asyncio
    async def test_citation_numbers_survive_the_sanitize_renumber(self, mock_llm_provider, mock_llm):
        # Real pipeline (no mocked verifier): the model cites [1] and [2], but
        # [1] is fabricated. verify_citations drops it, then sanitize_report
        # closes the gap so the surviving source becomes [1] in the prose. The
        # wire number must follow, or the chip is labelled [2] while the answer
        # points at [1] — and the inline marker's anchor leads nowhere.
        answer = (
            "Erfunden [1]. Belegt [2].\n\n"
            "**References:**\n"
            "- [1] Fake - https://not-in-registry.example/x\n"
            "- [2] Real - https://example.com/real\n"
        )
        mock_llm.ainvoke.return_value = AIMessage(content=answer)
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/real", title="Real", tool_name="web_search_tool"))

        state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
        result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)

        final_text = result.messages[-1].content
        assert "[2]" not in final_text  # the gap was closed
        assert "Belegt [1]" in final_text
        assert [s["number"] for s in result.verified_sources] == [1]
        assert [s["url"] for s in result.verified_sources] == ["https://example.com/real"]

    # --- citations_removed: transparency summary of dropped citations ---

    @pytest.mark.asyncio
    async def test_citations_removed_populated_when_verification_drops_citations(self, mock_llm_provider, mock_llm):
        # ≥1 citation removed → the result carries a {count, reasons} summary
        # (reasons deduplicated in first-seen order).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[
                    {"number": 2, "line": "[2] Bad: https://nope.example.com", "reason": "url_not_in_registry"},
                    {"number": 3, "line": "[3] Also bad", "reason": "url_not_in_registry"},
                    {"number": 4, "line": "[4] Mystery", "reason": "unverifiable"},
                ],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed == {
            "count": 3,
            "reasons": ["url_not_in_registry", "unverifiable"],
        }

    @pytest.mark.asyncio
    async def test_citations_removed_absent_when_nothing_removed(self, mock_llm_provider, mock_llm):
        # Nothing removed → citations_removed stays None (never null-spammed).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed is None

    @pytest.mark.asyncio
    async def test_citations_removed_absent_on_a_greeting_without_verification(self, mock_llm_provider, mock_llm):
        # A greeting with an empty registry: no verification runs, so
        # citations_removed is never populated.
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        state = ResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed is None


@tool
def knowledge_search(query: str) -> str:
    """Search the internal knowledge base (returns KB-format results)."""
    return (
        "Found 1 relevant document(s):\n\n"
        "--- Result 1 ---\n"
        "Source: OIB-330.pdf\n"
        "Collection: oib_knowledge\n"
        "Page: 12\n"
        "Citation: OIB-330.pdf, p.12\n"
        "Content Type: text\n"
        "Relevance Score: 0.88\n"
        "\n"
        "Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen.\n"
        "\n"
        "## Trace-Lanes\n"
        '{"lanes":[]}\n'
    )


class TestChatQuoteVerification:
    """Piloti annotates fabricated quotes and flips answer_quotes_verified."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_kb_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "oib_knowledge",
                    "name": "OIB Knowledge",
                    "description": "Search the internal OIB knowledge base.",
                    "tools": ["knowledge_search"],
                }
            ]
        )
        yield
        reset_registry()

    def _tool_call(self):
        return AIMessage(
            content="",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "Treppe"}, "id": "1"}],
        )

    @pytest.mark.asyncio
    async def test_fabricated_quote_annotated_and_flagged(self, mock_llm_provider, mock_llm):
        final = AIMessage(
            content=(
                "Die Richtlinie fordert „Treppen muessen mit einer automatischen "
                'Loeschanlage ausgestattet sein" [1].\n\n'
                "## Sources\n[1] OIB-330.pdf, p.12"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), final])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" in output
        # Fail-open: the fabricated sentence itself is preserved, never stripped.
        assert "automatische" in output.lower()
        assert result.answer_quotes_verified is False

    @pytest.mark.asyncio
    async def test_verbatim_quote_not_annotated_and_verified(self, mock_llm_provider, mock_llm):
        final = AIMessage(
            content=(
                "Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens "
                '2,10 m betragen" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), final])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" not in output
        # REGRESSION: without quote verification this stays at the default True,
        # so the assertion below only exercises the new path when a fabricated
        # quote is present (covered by the sibling test); here it must remain True.
        assert result.answer_quotes_verified is True

    def test_state_defaults_quotes_verified_true(self):
        state = ResearchAgentState(messages=[HumanMessage(content="hi")])
        assert state.answer_quotes_verified is True


class TestChatRepairPass:
    """The one repair (ADR-0067): a misremembered quote corrected in place against its passage."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_kb_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "oib_knowledge",
                    "name": "OIB Knowledge",
                    "description": "Search the internal OIB knowledge base.",
                    "tools": ["knowledge_search"],
                }
            ]
        )
        yield
        reset_registry()

    def _tool_call(self):
        return AIMessage(
            content="",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "Treppe"}, "id": "1"}],
        )

    FABRICATED = AIMessage(
        content=(
            "Die Richtlinie fordert „Treppen muessen mit einer automatischen "
            'Loeschanlage ausgestattet sein" [1].\n\n'
            "## Sources\n[1] OIB-330.pdf, p.12"
        )
    )
    VERBATIM = AIMessage(
        content=(
            "Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens "
            '2,10 m betragen" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
    )

    MISQUOTED = AIMessage(
        content=(
            "Vorweg: Treppen sind Fluchtwege. Es gilt: „Die lichte Durchgangshoehe bei Treppen muss "
            'wenigstens 2,10 m betragen" [1]. Danach folgt die Breite.\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
    )

    @pytest.fixture
    def patch_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen")
        )
        return llm

    @pytest.mark.asyncio
    async def test_a_misremembered_quote_is_corrected_in_place(self, mock_llm_provider, mock_llm, patch_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.MISQUOTED])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search], card_repair_llm=patch_llm)
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        # Only the words between the quotation marks moved: what the reader read
        # around them, the `[1]` included, is byte for byte what was written.
        assert output.startswith("Vorweg: Treppen sind Fluchtwege. Es gilt: „Die lichte Durchgangshoehe von Treppen")
        assert '2,10 m betragen" [1]. Danach folgt die Breite.' in output
        assert "[nicht wörtlich in der Quelle belegt]" not in output
        assert result.answer_quotes_verified is True
        # No second frontier call and no second search: one small call.
        assert mock_llm.ainvoke.await_count == 2
        assert patch_llm.ainvoke.await_count == 1

    @pytest.mark.asyncio
    async def test_a_quote_no_passage_comes_close_to_keeps_its_marker(self, mock_llm_provider, mock_llm, patch_llm):
        # Invented, not misremembered: "correcting" it would put the passage's
        # different claim in the model's mouth.
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.FABRICATED])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search], card_repair_llm=patch_llm)
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "Loeschanlage" in output
        assert "[nicht wörtlich in der Quelle belegt]" in output
        assert result.answer_quotes_verified is False
        assert patch_llm.ainvoke.await_count == 0

    @pytest.mark.asyncio
    async def test_a_correction_the_passage_does_not_hold_is_refused(self, mock_llm_provider, mock_llm, patch_llm):
        patch_llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="Die lichte Durchgangshoehe von Treppen muss mindestens 2,50 m betragen")
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.MISQUOTED])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search], card_repair_llm=patch_llm)
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "wenigstens 2,10 m" in output
        assert "2,50" not in output
        assert "[nicht wörtlich in der Quelle belegt]" in output

    @pytest.mark.asyncio
    async def test_a_clean_answer_costs_no_extra_call(self, mock_llm_provider, mock_llm, patch_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.VERBATIM])
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[knowledge_search], card_repair_llm=patch_llm)
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        await _run_with_bound_registry(agent, state, SourceRegistry())

        assert mock_llm.ainvoke.await_count == 2
        assert patch_llm.ainvoke.await_count == 0

    @pytest.mark.asyncio
    async def test_switched_off_ships_the_marker_as_before(self, mock_llm_provider, mock_llm, patch_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.MISQUOTED])
        agent = ChatAgent(
            llm_provider=mock_llm_provider, tools=[knowledge_search], repair_pass=False, card_repair_llm=patch_llm
        )
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        assert "[nicht wörtlich in der Quelle belegt]" in result.messages[-1].content
        assert patch_llm.ainvoke.await_count == 0

    @pytest.mark.asyncio
    async def test_without_a_small_model_the_repair_is_off(self, mock_llm_provider, mock_llm):
        # Switched on, but with no card model to run it on: the frontier model
        # is never borrowed for the patch, and the marker ships.
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.MISQUOTED])
        agent = ChatAgent(
            llm_provider=mock_llm_provider, tools=[knowledge_search], repair_pass=True, card_repair_llm=None
        )
        state = ResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        with patch("agent.agents.piloti.agent.quote_patcher") as patcher:
            result = await _run_with_bound_registry(agent, state, SourceRegistry())

        assert "[nicht wörtlich in der Quelle belegt]" in result.messages[-1].content
        assert "wenigstens 2,10 m" in result.messages[-1].content
        patcher.assert_not_called()
        assert mock_llm.ainvoke.await_count == 2


class TestClarificationGuidance:
    """Piloti must be told what to do with an under-specified query —
    on every turn, and independent of whether project_context is present.

    Regression: the only Rueckfrage/pushback guidance lived INSIDE the
    ``{% if project_context %}`` block, so a shallow turn with no project brief
    got zero clarification guidance and always answered straight through.
    The rule now sits in the static system prompt, which no condition renders.
    """

    def _render(self, *, project_context):

        from agent.common import render_prompt_template

        prompt = _chat_prompt_source()
        return render_prompt_template(
            prompt,
            user_info={"name": "Alex", "email": "a@example.com"},
            current_datetime="2026-07-23",
            available_documents=[],
            project_context=project_context,
            parcel_note=None,
        )

    def test_clarification_guidance_present_on_research_turn_without_project_context(self):
        """A turn with NO project context still gets the guidance — the core regression."""
        rendered = self._render(project_context=None)
        rules = rendered.split("<rules>")[1].split("</rules>")[0]
        # Both moves: answer under a stated assumption, or ask one question.
        assert "answer under a stated assumption" in rules
        assert "ask one short question first" in rules
        assert "`ask_user`" in rules

    def test_clarification_guidance_present_with_project_context_too(self):
        rendered = self._render(project_context="facts:\n  bundesland: unknown")
        assert "answer under a stated assumption" in rendered


class TestOffTopicDeclineShape:
    """Out-of-scope questions reach the assistant like every other turn, and
    the assistant must DECLINE + redirect them — not answer them from its own
    knowledge.

    Regression: the direct-reply shape said "answer from your own knowledge",
    so a clearly off-topic question (e.g. "how do I bake a cake") risked
    getting a cheerful full answer. The rules carve out an explicit decline.
    """

    def _render(self):

        from agent.common import render_prompt_template

        prompt = _chat_prompt_source()
        return render_prompt_template(
            prompt,
            user_info={"name": "Alex", "email": "a@example.com"},
            current_datetime="2026-07-23",
            available_documents=[],
            project_context=None,
            parcel_note=None,
        )

    def test_contract_has_explicit_off_topic_decline_shape(self):
        rendered = self._render()
        rules = rendered.split("<rules>")[1].split("</rules>")[0]
        # The decisive instruction: do not answer, decline + redirect.
        assert "decline without answering it, even when you know the answer" in rules
        assert "a redirect to what you can help with" in rules
        assert "no tool call" in rules

    def test_in_scope_conversational_shape_still_answers(self):
        """Guard against over-correction: genuine conversational/platform turns
        (greetings, capability questions) are still answered directly."""
        kinds = self._render().split("KINDS.")[1].split("FIELDS.")[0]
        assert "`direct`: a greeting, a question about you" in kinds


class TestADirectReplyMayStillEmitACard:
    """The direct-reply shape and the card contract must not contradict.

    Field case: „Wie läuft das Baubewilligungsverfahren in Wien ab?" was offered
    a deep-research plan, refused twice, then retyped in plain words — and the
    reply came as prose because the conversational shape said "no tool calls"
    while the card contract told the model to emit one. Every tool is bound on
    every turn (ADR-0052), so the contract says so, a plain-words building-law
    question is a walkthrough or a ruling, and a greeting has nothing to put on
    a card and emits none.
    """

    def _render(self):
        return TestOffTopicDeclineShape._render(self)

    def _kinds(self) -> str:
        return self._render().split("KINDS.")[1].split("FIELDS.")[0]

    def test_the_direct_reply_shape_has_every_tool(self):
        kinds = self._kinds()
        assert "Every tool is available on every turn" in kinds
        direct_shape = kinds.split("- `direct`")[1].split("- `walkthrough`")[0]
        assert "no tool calls" not in direct_shape
        assert "cited only for a retrieved passage" in direct_shape

    def test_the_off_topic_shape_still_forbids_every_tool_call(self):
        # The carve-out is for a turn that ANSWERS something. A decline has no
        # content, so nothing here is loosened for it.
        rules = self._render().split("<rules>")[1].split("</rules>")[0]
        assert "no tool call" in rules

    def test_the_direct_reply_shape_names_the_card_rule_and_its_limit(self):
        direct_shape = self._kinds().split("- `direct`")[1].split("- `walkthrough`")[0]
        assert "is a walkthrough or a ruling, not a direct reply" in direct_shape
        # ...and closed again for the turns with nothing to show.
        assert "no card" in direct_shape

    def test_the_hand_off_shape_escalates_a_commissioned_report_at_once(self):
        hand_off = self._kinds().split("- `handoff`")[1]
        assert "`escalate_to_deep`" in hand_off and "`escalation_reason`" in hand_off
        assert "a commissioned report needs no retrieval first" in hand_off
        assert "never handed off" in hand_off

    def test_the_card_contract_is_in_every_system_prompt(self):
        """The card contract is rendered from the catalog into the static half, so no turn can lack it."""
        from agent.agents.piloti.prompt import bundled_static_block
        from agent.agents.piloti.prompt import render_static_block

        system = render_static_block(bundled_static_block().text)
        assert "CARDS (the `cards` field)" in system
        assert "[[card:N]]" in system

    def test_the_contract_names_the_kinds_and_earns_a_ruling(self):
        """A workspace turn is not a researched Bescheid by default.

        The prompt has to name the kinds and keep ``verdict`` behind a
        copyable legal value, or every file walkthrough inherits the gavel.
        """
        kinds = self._kinds()
        for kind in ("direct", "walkthrough", "ruling", "handoff", "work"):
            assert f"`{kind}`" in kinds
        assert "copyable legal value" in kinds
        walkthrough = kinds.split("- `walkthrough`")[1].split("- `ruling`")[0]
        assert "carries no `verdict`" in walkthrough
        assert "summarising" in walkthrough and "organising" in walkthrough

    def test_walkthrough_examples_exist_and_carry_no_verdict(self):
        rendered = self._render()
        chunks = rendered.split('type="walkthrough"')
        assert len(chunks) >= 2, "need a walkthrough example"
        for chunk in chunks[1:]:
            example = chunk.split("</example>", 1)[0]
            assert '"verdict"' not in example

    def test_the_research_example_is_a_walkthrough_not_a_topic_gavel(self):
        """An overview question taught ``kind=ruling`` / ``value: Brandschutz``.

        Brandschutz is a topic, not a copyable legal value. The model copies
        the example.
        """
        rendered = self._render()
        overview = rendered.split('type="walkthrough"')[1].split("</example>", 1)[0]
        assert '"kind": "walkthrough"' in overview
        assert '"topic": "Fire safety"' in overview
        ruling = rendered.split('type="ruling"')[1].split("</example>", 1)[0]
        assert '"kind": "ruling"' in ruling
        assert '"value": "REI 60"' in ruling
        assert '"value": "Brandschutz"' not in rendered
        assert '"value": "Fire safety"' not in rendered

    def test_the_identity_does_not_reduce_the_job_to_oib_questions(self):
        rendered = self._render()
        assert "Ich beantworte Fragen zu OIB" not in rendered
        assert "OIB-Richtlinien, österreichischem Baurecht" not in rendered

    def test_the_research_rules_state_outcomes_not_a_procedure(self):
        """The rules say what must be true of a finished answer, never which
        tool to call next or how many times.

        A fetch the turn already ran is answered from the transcript, stated
        as the fact it is; the Herleitung checkpoint is the tool's own
        `conclusion` argument, described where it is passed.
        """
        rendered = self._render()
        assert "Grid OIB Research Agent" not in rendered
        assert "at most 2 calls" not in rendered
        assert "not every question is a legal question" in rendered
        assert "commit to it; re-plan only" not in rendered
        good = rendered.split("<good_answer>")[1].split("</good_answer>")[0]
        assert "evidence you saw this turn" in good
        rules = rendered.split("<rules>")[1].split("</rules>")[0]
        assert "A file you did not open is not described" in rules
        assert "„nicht gelesen“" in rules
        assert "Abdeckung: unzureichend" not in rules
        assert "`conclusion`" not in rules
        procedures = (
            "at most two searches",
            "ONE parallel round",
            "per member",
            "Choose sources in this order",
            "rewrite the user's question",
        )
        for procedure in procedures:
            assert procedure not in rendered, procedure


class TestKnowledgeInventoryIsNotCitable:
    """The corpus inventory in the prompt must not read as citable evidence.

    Every research turn renders the whole knowledge base — base OIB corpus
    included — as `file_name: summary` lines. Those filenames are the exact
    citation keys verification matches against, so a model that cites one it
    never retrieved produces citations that are all dropped
    (`citation_key_not_in_registry`) and an answer that ships with no source at
    all. The prompt used to forbid recalling URLs from memory but said nothing
    about document keys, while handing the model a list of them.
    """

    def _render(self, prompt: str, documents: list[dict]) -> str:
        from agent.common import render_prompt_template

        return render_prompt_template(
            prompt,
            tools=[{"name": "knowledge_search", "description": "Search the knowledge base"}],
            user_info=None,
            current_datetime="2026-07-28",
            available_documents=documents,
            project_context=None,
            ris_catalog=None,
            norm_doctrine=None,
            parcel_note=None,
            execution_enabled=False,
            jurisdiction_grounding=None,
            enable_source_router=False,
            max_research_concurrency=3,
        )

    @staticmethod
    def _prompt(path: str) -> str:
        """The prompt source at this path; for Piloti, both halves recombined."""
        from pathlib import Path

        import agent

        if path == "piloti/prompts/piloti.j2":
            return _chat_prompt_source()
        return (Path(agent.__file__).parent / "agents" / path).read_text(encoding="utf-8")

    DOCUMENTS = [{"file_name": "oib-rl_2_ausgabe_mai_2023.pdf", "summary": "Brandschutz.", "tags": []}]

    def test_chat_prompt_marks_the_inventory_as_not_a_source(self):
        rendered = self._render(self._prompt("piloti/prompts/piloti.j2"), self.DOCUMENTS)

        # The inventory still lists the file — the agent must know it exists.
        assert "oib-rl_2_ausgabe_mai_2023.pdf" in rendered
        # …but it is labelled an index, not evidence.
        assert "NOT sources" in rendered
        assert "not a citable source" in rendered
        # And the anti-memory rule covers document keys, not only URLs.
        citations = rendered.split("CITATIONS.")[1].split("EXAMPLES.")[0]
        assert "the citation key exactly as the tool returned it" in citations
        assert "Cite only what a tool returned" in citations

    def test_chat_prompt_asks_for_disagreement_between_sources_to_be_shown(self):
        """The everyday chat surface had no rule about contradictory sources.

        In a legal product a smoothed-over difference is the dangerous failure:
        an unqualified answer reads as a settled one, and gets built on.
        """
        source = self._prompt("piloti/prompts/piloti.j2")

        block = source.split("<building_law>")[1].split("</building_law>")[0]
        rule = block.split("When two sources disagree")[1].split("\n")[0]
        # Show the difference rather than silently choosing.
        assert "show both with their citations" in rule
        # Then resolve it by the precedence chain the same section teaches.
        assert "Resolve by the chain" in rule
        # And when the chain cannot resolve it, say so instead of inventing a winner.
        assert "say that they disagree" in rule
        # An unresolved conflict must not be reported as high confidence.
        assert "keep `confidence` below high" in rule

    def test_every_example_source_line_in_the_prompt_is_a_bare_locator(self):
        """The prompt's rule says `- [N] filename.pdf, p.X`; two of its examples
        wrote `- [1] OIB-Richtlinie 2 – oib-rl_2_….pdf, p.1`, and the model
        copies examples over rules. The BFF read that line as one long filename,
        met no wire document, and drew a second, dead chip for the same source
        under every answer. An example that contradicts the rule is a defect in
        the prompt, so every example entry is checked against the rule here."""
        import json
        import re

        source = self._prompt("piloti/prompts/piloti.j2")
        blocks = re.findall(r"```answer_json\n(\{.*?\})\n```", source, flags=re.DOTALL)
        assert blocks, "the prompt lost its answer_json examples"
        entries: list[str] = []
        for block in blocks:
            answer = json.loads(block).get("answer", "")
            for label in ("**Quellen:**", "**References:**"):
                if label in answer:
                    entries.extend(
                        line.strip() for line in answer.split(label, 1)[1].split("\n") if line.strip().startswith("- [")
                    )
        assert entries, "no example carries a sources section"
        bare_locator = re.compile(r"^- \[\d+\] (\S+\.\w{2,5}), p\.\d+$")
        titled_url = re.compile(r"^- \[\d+\] .+ - https?://\S+$")
        for entry in entries:
            assert bare_locator.match(entry) or titled_url.match(entry), entry

    def test_deep_researcher_prompt_marks_the_inventory_as_not_a_source(self):
        rendered = self._render(self._prompt("deep_researcher/prompts/researcher.j2"), self.DOCUMENTS)

        assert "oib-rl_2_ausgabe_mai_2023.pdf" in rendered
        assert "NOT sources" in rendered
        assert "not a citable source" in rendered

    def test_no_prompt_still_calls_the_base_corpus_a_user_upload(self):
        """The list mixes the platform's OIB corpus with project uploads, so
        "User Uploaded Documents" was also simply untrue — and a heading rename
        must not leave dangling references to the old one."""
        for path in (
            "piloti/prompts/piloti.j2",
            "deep_researcher/prompts/researcher.j2",
            "deep_researcher/prompts/orchestrator.j2",
            "deep_researcher/prompts/planner.j2",
            "deep_researcher/prompts/source_router.j2",
        ):
            source = self._prompt(path)
            assert "Uploaded Documents" not in source, path

    def test_chat_prompt_teaches_the_four_shelves(self):
        """The shelves themselves are taught where they are listed (the inventory block); the prompt names them."""
        source = self._prompt("piloti/prompts/piloti.j2")
        for mount, name in (("/project/", "Projektwissen"), ("/office/", "Büroablage"), ("/chat/", "Private Sitzung")):
            assert f"{mount} is {name}" in source or f"{mount} {name}" in source
        assert "/law/oib/ Basiswissen" in source
        rendered = self._render(source, self.DOCUMENTS)
        assert "Büroablage is never the OIB corpus" in rendered

    def test_grouped_inventory_does_not_mix_oib_into_office_shelf(self):
        documents = [
            {"file_name": "oib-rl_2.pdf", "summary": "Brandschutz.", "shelf": "base", "collection": "oib_knowledge"},
            {
                "file_name": "Buero-Standard.pdf",
                "summary": "Detail.",
                "shelf": "office_shelf",
                "collection": "archiv_org",
            },
        ]
        rendered = self._render(self._prompt("piloti/prompts/piloti.j2"), documents)
        office_shelf = rendered.split("### Büroablage", 1)[1].split("### ", 1)[0]
        assert "Buero-Standard.pdf" in office_shelf
        assert "oib-rl_2.pdf" not in office_shelf


class TestTheModelCardsAreActuallyAskedFor:
    """The five IFC cards had renderers and no instruction that named them.

    That instruction lives in ``ifc-spatial-reasoning``, because most turns
    never touch a model and the always-on prompt must not teach a minority
    path. The skill catalog in the turn context points at it; the skill keeps
    the card types and the id rule.
    """

    def _ifc_skill(self) -> str:
        from pathlib import Path

        import agent

        return (
            Path(agent.__file__).parent / "skills" / "builtin" / "bim" / "ifc-spatial-reasoning" / "SKILL.md"
        ).read_text(encoding="utf-8")

    def test_the_static_prompt_does_not_teach_the_model_cards(self):
        from agent.cards.catalog import MODEL_BACKED_CARD_TYPES

        static = _chat_prompt_source().split("<turn_context>")[0]
        for card_type in MODEL_BACKED_CARD_TYPES:
            assert card_type not in static, card_type

    def test_every_model_backed_card_is_named_in_the_skill(self):
        from agent.cards.catalog import MODEL_BACKED_CARD_TYPES

        body = self._ifc_skill()
        for card_type in MODEL_BACKED_CARD_TYPES:
            assert card_type in body, card_type

    def test_it_says_where_the_ids_must_come_from(self):
        # The one rule that keeps this from making things worse. An invented
        # GlobalId renders as an unresolved element, which tells the user their
        # model is broken when it is not.
        body = self._ifc_skill()
        assert "THIS turn" in body


# ---------------------------------------------------------------------------
# Measurements in the Herleitung — and the wall between them and the gate
# ---------------------------------------------------------------------------


#: One decidable, computed, quantity-shaped envelope answer — the shape the
#: engine returns for „wie hoch ist der Keller". Written out rather than built
#: through ``ifc_spatial.envelope`` because the backend CI job does not install
#: the spatial engine, and a module-level import of it takes this whole file
#: down at collection (see the fix in commit 3ec4a3b3). Every field here is a
#: field of ``ifc_spatial.envelope.Answer``; ``test_ifc_measure_tool.py`` is
#: where the two are pinned against each other.
_MEASURED_BASEMENT = {
    "value": 2.703,
    "unit": "m",
    "tolerance": 0.005,
    "provenance": "computed",
    "from": ["3xR9kQvB7Fp8sT2mW1nZdY"],
    "method": "clearHeight(space 3xR9kQvB7Fp8sT2mW1nZdY)",
    "decidable": True,
    "caveat": "Nur die Räume mit exportierter Geschoßebene.",
}

_MEASURED_MODEL = {"model": {"filename": "Institut.ifc", "schemaVersion": "IFC4", "elements": 12043}}


@tool
def ifc_measure(operation: str = "measure") -> str:
    """Measure the project's IFC/BIM model and report the provenance."""
    from agent.tools.bim.measure_register import _render

    return _render(
        "measure",
        dict(_MEASURED_BASEMENT),
        source=dict(_MEASURED_MODEL),
        handle="0f1e2d3c4b5a",  # pragma: allowlist secret - an IFC model handle, not a credential
        detail="clearHeight",
    )


class TestMeasurementSourcesDoNotGroundCitations:
    """A measurement reaches the Herleitung; it never reaches the citation gate.

    The reason this class exists is the mixed answer:

        (a) „Der Keller ist 2,70 m hoch"            — measured, reproducible
        (b) „…und erfüllt damit OIB 4 Punkt 2.1"    — a legal claim, uncited

    Giving measurements a derivation trail means they now travel on the citation
    WIRE, beside the retrieved sources. If that also put them in the
    ``SourceRegistry``, ``citation_grounded`` would flip true off (a), and the
    answer check would read the measurement as a passage that (b) could rest
    on. That is the laundering path ``source_kinds`` describes, and these tests
    are what keep the Herleitung from re-opening it.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    def _measuring_turn(self, mock_llm, answer: str, *, tools=None):
        """An agent whose one tool call is a measurement, then the given answer."""
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[{"name": "ifc_measure", "args": {"operation": "measure"}, "id": "m1"}],
                ),
                AIMessage(content=answer),
            ]
        )
        return tools or [ifc_measure]

    @staticmethod
    def _measurement_sources(result):
        return [s for s in (result.verified_sources or []) if s.get("kind") == "measurement"]

    # -- the property that must not regress -----------------------------------

    @pytest.mark.asyncio
    async def test_measured_answer_with_uncited_normative_claim_never_reaches_the_registry(
        self, mock_llm_provider, mock_llm
    ):
        """THE mixed case, after measurements appear in the Herleitung.

        Named so a reviewer looking for the laundering guard finds it: the
        measurement IS in the derivation trail and never in the registry, so it
        is no passage. Whether the verdict beside it is backed is the answer
        check's, told that a measurement never backs one (ADR-0139).
        """
        tools = self._measuring_turn(
            mock_llm,
            "Der Keller ist 2,70 m hoch und erfüllt damit die Mindestraumhöhe nach OIB-Richtlinie 4.",
        )
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, registry = await _run_with_captured_registry(agent, state)

        # The measurement really did reach the Herleitung…
        assert self._measurement_sources(result), "the measurement produced no Herleitung source"
        assert result.answer_measurement_grounded is True
        # …and the registry — the thing `citation_grounded` is derived from —
        # never saw it.
        assert registry.all_sources() == []
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_a_lone_measurement_is_never_a_citation(self, mock_llm_provider, mock_llm):
        """A measurement never reaches the registry, so nothing can hand it out as „[1]".

        The single-source fallback that once appended a lone registry source is
        gone (ADR-0125); the measurement stays out of the registry regardless,
        because the registry is what ``[N]`` resolves through.
        """
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, registry = await _run_with_captured_registry(agent, state)

        assert self._measurement_sources(result)
        assert registry.all_sources() == []
        assert result.answer_citation_grounded is False
        answer = next(m for m in reversed(result.messages) if isinstance(m, AIMessage) and not m.tool_calls)
        assert "[1]" not in answer.content

    @pytest.mark.asyncio
    async def test_failed_retrieval_is_still_reported_even_when_the_turn_measured(self, mock_llm_provider, mock_llm):
        """An empty retrieval keeps its meaning.

        The question is "did retrieval capture anything to cite?", asked of the
        registry. A measurement in it would answer with a value that was never
        retrieved, so a turn whose web search came back empty would quietly stop
        reporting the failure: no banner, no ``sources-empty``.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "ifc_measure", "args": {"operation": "measure"}, "id": "m1"},
                        {"name": "empty_web_search_tool", "args": {"query": "OIB 4 Raumhöhe"}, "id": "w1"},
                    ],
                ),
                AIMessage(content="Der Keller ist 2,70 m hoch."),
            ]
        )
        agent = ChatAgent(
            llm_provider=mock_llm_provider,
            tools=[ifc_measure, empty_web_search_tool],
        )
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, registry = await _run_with_captured_registry(agent, state)

        assert registry.all_sources() == []
        assert result.answer_lookup_found_nothing is True

    # -- what the card actually carries ---------------------------------------

    @pytest.mark.asyncio
    async def test_the_card_carries_the_audit_trail_the_envelope_had(self, mock_llm_provider, mock_llm):
        """Value, tolerance, German provenance, method, GlobalIds, model, caveat."""
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, _ = await _run_with_captured_registry(agent, state)

        (card,) = self._measurement_sources(result)
        assert card["lane"] == "measurement"
        assert card["title"] == "clearHeight"
        measurement = card["measurement"]
        assert measurement["provenance"] == "computed"
        # The renderer's own verb, so the card and the prose agree.
        assert measurement["provenance_label"] == "gemessen"
        assert measurement["value_text"] == "2.703 m"
        assert measurement["tolerance_text"] == "±0.005 m"
        assert measurement["method"] == _MEASURED_BASEMENT["method"]
        assert [e["global_id"] for e in measurement["elements"]] == _MEASURED_BASEMENT["from"]
        assert measurement["model"] == "Institut.ifc (IFC4, 12043 elements)"
        assert measurement["caveat"] == _MEASURED_BASEMENT["caveat"]

    @pytest.mark.asyncio
    async def test_the_measurement_does_not_count_as_a_cited_source(self, mock_llm_provider, mock_llm):
        """The citation-health ledger counts CITATIONS, not measurements.

        ``cited_count`` is measured against ``source_count`` — this turn's
        retrieval. A measurement appended to the wire and then counted as a
        citation would report one cited source out of zero retrieved.
        """
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        with patch("agent.agents.piloti.ledger.citation_events") as events:
            result, _ = await _run_with_captured_registry(agent, state)

        assert self._measurement_sources(result)
        assert events.record_turn.call_args.kwargs["cited_count"] == 0
        assert events.record_turn.call_args.kwargs["source_count"] == 0


# ---------------------------------------------------------------------------
# The research budget: what it counts, and what it must stop counting
# ---------------------------------------------------------------------------


class TestTheResearchBudgetIsOneNumber:
    """``max_tool_iterations`` is the whole ceiling, and every call is charged to it.

    It used to have a reserve on top, sized to the skills the deployment forced
    onto every turn: those calls were overhead the question never asked for, and
    charging them shortened every research chain in the product by one per
    published house skill. Nothing is forced now — a skill read is one
    the model chose, exactly like a search — so there is no overhead to
    compensate, and the number the config's traced floors measure is the number
    the turn gets.
    """

    def _agent(self, iterations: int = 3):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return (
            ChatAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=iterations),
            llm,
        )

    def test_the_ceiling_is_the_budget(self):
        agent, _ = self._agent(iterations=7)
        assert agent.max_tool_iterations == 7
        assert agent.tool_iteration_ceiling == 7

    def test_the_agent_takes_no_reserve_at_all(self):
        """Not "reserve zero": the knob is gone, so nothing can put one back."""
        import inspect

        assert "reserved_tool_iterations" not in inspect.signature(ChatAgent.__init__).parameters


class TestTruncationIsObservable:
    """Silent truncation is the worst failure this product has; make it countable.

    Hitting the ceiling means evidence-gathering was CUT OFF and the answer was
    written from whatever had been gathered by then. ``[CONFIDENCE:…]`` does not
    cover it — that grades whether the claims are sourced, not whether the
    search finished — so before this there was nothing anywhere that could
    answer "how often does this happen, and on which question shapes".
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as verify,
            patch("agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
        ):
            verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
                verified_report=content, removed_citations=[]
            )
            sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    async def _truncated_run(self):
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ChatAgent(
            llm_provider=provider,
            tools=[web_search_tool],
            max_tool_iterations=5,
        )
        # A run that already spent its whole ceiling: two skill loads and three
        # searches — the shape of an OIB measurement chain walking into the wall.
        history = [
            HumanMessage(content="Wie tief ist der Lichteinfall?"),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "read_file", "args": {"file_path": "/skills/office/piloti-voice/SKILL.md"}, "id": "s1"},
                    {"name": "read_file", "args": {"file_path": "/skills/office/piloti-cards/SKILL.md"}, "id": "s2"},
                ],
            ),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {}, "id": "k1"}]),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "find_elements", "args": {}, "id": "f1"},
                    {"name": "light_incidence", "args": {}, "id": "l1"},
                ],
            ),
        ]
        state = ResearchAgentState(messages=history, tool_iterations=5)
        await agent.run(state)

    @pytest.mark.asyncio
    async def test_the_log_says_what_was_cut_off_and_on_what_shape(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING, logger="agent.agents.piloti.agent"):
            await self._truncated_run()

        lines = [m for m in caplog.messages if "Forcing synthesis (rounds)" in m]
        assert lines, f"the turn was cut off and left no countable record of it; warnings logged were {caplog.messages}"
        line = lines[0]
        # The numbers that make "how often" answerable per deployment…
        assert "ceiling=5" in line
        assert "rounds_spent=5" in line
        # …and WHICH bound fired, because the other one is a cost stop and
        # counting the two together makes either unanswerable.
        assert "input_tokens=0/" in line
        assert "skill_calls=2" in line
        # …and the SHAPE, which is what makes "on which questions" answerable
        # without putting the reader's own words in a log line.
        assert "shape=read_skill>read_skill>knowledge_search>find_elements>light_incidence" in line
        assert "Lichteinfall" not in line

    @pytest.mark.asyncio
    async def test_the_turn_records_the_truncation_as_telemetry(self, emitted):
        await self._truncated_run()

        records = [step for step in emitted.steps if step.id == "status:budget"]
        assert records, (
            "evidence-gathering was cut off and the turn emitted no truncation telemetry — "
            f"nothing here can answer how often it happens; steps were {[step.id for step in emitted.steps]}"
        )
        record = records[0]
        # `spent` and `rounds` are the same number now: the budget is one unit
        # per ROUND, so a greedy parallel batch cannot outspend its own round.
        # Both stay on the record so one counted across the change reads the
        # same way. Nothing was reserved, so there is no such field to read.
        assert record.detail == {
            "truncated": True,
            "ceiling": 5,
            "research_budget": 5,
            "spent": 5,
            "rounds": 5,
            "tools": ["read_skill", "read_skill", "knowledge_search", "find_elements", "light_incidence"],
        }
        # Technical channel, and therefore no `key`: whether the READER is told
        # the answer stopped early is a product decision, and a live key would
        # make it silently.
        assert (record.channel, record.key) == ("technical", None)

    @pytest.mark.asyncio
    async def test_the_answer_carries_the_fact_out_of_the_graph(self):
        """The log is for us; this field is the half the reader gets.

        Telemetry answers "how often". It cannot put a line under the answer
        the reader is looking at, and that answer is the one place where "the
        search stopped early" changes what a person does next.
        """
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ChatAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=2)

        truncated = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie tief?")], tool_iterations=2))
        assert truncated.research_truncated is True

    @pytest.mark.asyncio
    async def test_an_answer_that_finished_its_research_claims_nothing(self):
        """Absent, not False: presence is the fact, so nothing has to read a default."""
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ChatAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=3)

        finished = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Kurz gefragt")]))
        assert finished.research_truncated is None

    @pytest.mark.asyncio
    async def test_a_turn_that_finishes_inside_its_budget_records_nothing(self, emitted):
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ChatAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=3)

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Kurz gefragt")]))

        assert [step for step in emitted.steps if step.id == "status:budget"] == []


class TestAssistantCheckpoint:
    """The Thought before a tool round is the Herleitung checkpoint.

    Empty content is the common tool-calling collapse — we keep the round as a
    layer and do not invent a conclusion. A fenced answer is the final reply,
    not a checkpoint.
    """

    def test_a_sentence_before_the_calls_is_the_checkpoint(self):
        message = AIMessage(
            content="OIB 3 Pkt. 3.4.2 verweist auf den lichten Einfallswinkel.",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "x"}, "id": "1"}],
        )
        assert assistant_checkpoint(message) == ("OIB 3 Pkt. 3.4.2 verweist auf den lichten Einfallswinkel.")

    def test_empty_content_is_not_invented(self):
        message = AIMessage(
            content="",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "x"}, "id": "1"}],
        )
        assert assistant_checkpoint(message) is None

    def test_a_fenced_answer_is_not_a_checkpoint(self):
        message = AIMessage(content='```answer_json\n{"answer": "x", "kind": "direct"}\n```')
        assert assistant_checkpoint(message) is None


def _render_researcher_prompt(*, drafting_enabled: bool = False) -> str:
    """The default prompt, rendered with the working directory on or off."""

    from agent.common import render_prompt_template

    prompt = _chat_prompt_source()
    return render_prompt_template(
        prompt,
        tools=[],
        user_info=None,
        current_datetime="2026-09-10",
        available_documents=[],
        project_context=None,
        parcel_note=None,
        drafting_enabled=drafting_enabled,
    )


def _drafts_block() -> str:
    return _render_researcher_prompt(drafting_enabled=True).split("<drafts>")[1].split("</drafts>")[0]


class TestTheWorkingDirectoryBlock:
    """What is LEFT in the prompt about drafting, after ADR-0060's amendment.

    Every verb's workflow is a tool's own contract and lives in the tool
    description that owns it (see ``TestTheDraftingRulesLiveInTheTools``). One
    sentence stays, because no tool description can carry it: what „mach
    daraus ein File" refers to. What happens without a project is the
    refusal ``file_draft`` returns, at the moment it matters.
    """

    def test_a_turn_without_the_tools_is_never_told_to_write(self):
        """A prompt describing a tool the model was not given is a promise it cannot keep."""
        assert "<drafts>" not in _render_researcher_prompt(drafting_enabled=False)

    def test_the_anaphora_resolves_against_the_previous_answer(self):
        """„kannst du daraus ein File machen" has an antecedent only the
        transcript holds, so no tool description can resolve it."""
        block = _drafts_block()
        assert "`daraus`/`davon`/`das`" in block
        assert "previous answer of this conversation" in block
        assert "without asking about format or content" in block

    def test_a_conversation_without_a_project_is_told_by_the_refusal(self):
        from pathlib import Path

        from agent.tools.documents import register as documents

        assert "There is no project in this conversation" in Path(documents.__file__).read_text(encoding="utf-8")
        assert "Without a project" not in _drafts_block()

    def test_the_workflow_the_tools_own_is_no_longer_in_the_prompt(self):
        """The cut itself. Each of these was a sentence about how to hold a
        tool, charged on every call of every turn (ADR-0060 (d))."""
        block = _drafts_block()
        for teaching in ("`write_file`", "`edit_file`", "`file_draft`", "`submit=true`", "`reviewer`"):
            assert teaching not in block, teaching

    def test_the_block_follows_the_tools_and_not_a_second_switch(self):
        """The flag is derived from what is bound, by the renderer itself."""
        from agent.agents.piloti.prompt import render_turn_context
        from agent.agents.piloti.prompt import system_prompt_template

        state = ResearchAgentState(messages=[HumanMessage(content="Schreib den Aktenvermerk")])
        with_tools = render_turn_context(
            system_prompt_template(),
            state,
            [{"name": "write_file", "description": "Schreibt ein NEUES Dokument"}],
        )
        without = render_turn_context(
            system_prompt_template(),
            state,
            [{"name": "web_search_tool", "description": "Search"}],
        )
        assert "<drafts>" in with_tools
        assert "<drafts>" not in without


class TestTheDraftingRulesLiveInTheTools:
    """Every rule the `<drafts>` block dropped, in the description that owns it.

    A tool owns its whole contract (ADR-0060 (d)), so a rule deleted from the
    prompt has to be findable in the schema the provider already sends. These
    are the receipts for that move, one assertion per deleted sentence.
    """

    @staticmethod
    def _draft_verbs() -> dict[str, str]:
        from agent.tools.documents.tools import _TOOL_DESCRIPTIONS

        return _TOOL_DESCRIPTIONS

    def test_write_file_says_a_commissioned_document_is_written_not_described(self):
        description = self._draft_verbs()["write_file"]
        for kind in ("Aktenvermerk", "Protokoll", "Checkliste", "Flächenaufstellung"):
            assert kind in description
        assert "rather than in the answer" in description
        # And the one sentence the answer owes the reader afterwards.
        assert "in one sentence" in description

    def test_a_revision_edits_the_file_it_already_wrote(self):
        verbs = self._draft_verbs()
        assert "an existing path is refused, and edit_file changes it" in verbs["write_file"]
        assert verbs["edit_file"].startswith("Changes part of a draft")

    def test_read_file_says_the_working_directory_is_not_a_source(self):
        """The one thing that must not blur: a draft cannot ground an answer.

        It sits on `read_file` because that is the verb whose output is text a
        model would otherwise cite. `ls` returns filenames, which nobody
        quotes.
        """
        verbs = self._draft_verbs()
        assert "the answer wrote itself" in verbs["read_file"]
        assert "source tools" in verbs["read_file"]
        assert "wrote itself" not in verbs["ls"]

    def test_file_draft_says_filing_happens_on_request(self):
        from agent.tools.documents.register import _FILE_DRAFT_DESCRIPTION

        for phrase in ("leg das ins Projekt", "ablegen", "abspeichern"):
            assert phrase in _FILE_DRAFT_DESCRIPTION
        assert "not on your own after every write" in _FILE_DRAFT_DESCRIPTION
        # And nothing filed may be called approved — the claim that reaches a Bauherr.
        assert "DRAFT" in _FILE_DRAFT_DESCRIPTION
        assert "nobody has approved it" in _FILE_DRAFT_DESCRIPTION

    def test_submitting_needs_an_explicit_request(self):
        """`submit_draft` merged into `file_draft(submit=true)`; its rules came with it."""
        from agent.tools.documents.register import _FILE_DRAFT_DESCRIPTION

        assert "Call with `submit=true` only when the user asks for approval" in _FILE_DRAFT_DESCRIPTION
        # „ablegen" alone must not flip the flag.
        assert "„ablegen“ alone is not such a request" in _FILE_DRAFT_DESCRIPTION
        # The reviewer name is passed through and never guessed…
        assert "unchanged" in _FILE_DRAFT_DESCRIPTION
        # …and without one the draft goes to the project's editors, which the
        # answer has to be able to say.
        assert "project's editors" in _FILE_DRAFT_DESCRIPTION


class TestTheDelegationRulesLiveInTheTool:
    """`<delegieren>` is gone; `create_task`'s description carries what it said."""

    @staticmethod
    def _description() -> str:
        from agent.tools.tasks.register import _CREATE_TASK_DESCRIPTION

        return _CREATE_TASK_DESCRIPTION

    def test_the_prompt_no_longer_teaches_delegation(self):
        assert "<delegieren>" not in _render_researcher_prompt(drafting_enabled=True)

    def test_it_names_the_delegatable_kinds(self):
        """All four kinds are delegatable: the retirement was the chat TOOL, not the kind.

        ``compliance_check`` was removed from the chat agent's tool list; it
        stays a durable task kind and runs as a delegated Normprüfung
        (`delegation.ts::TASK_ENGINES`, `docs/architecture/system-overview.md`).
        """
        description = self._description()
        for kind in ("compliance_check", "submission_check", "document", "revision"):
            assert f"`{kind}`" in description

    def test_it_names_the_requests_a_person_actually_makes(self):
        """So the model recognises the handoff instead of judging every long task one."""
        description = self._description()
        assert "Einreichcheck bis Freitag" in description
        assert f"@{PRODUCT_NAME} prüf das" in description

    def test_the_deadline_is_a_date_and_not_a_phrase(self):
        """A string nothing can compare is a deadline the scheduler never enforces."""
        description = self._description()
        assert "`YYYY-MM-DD`" in description
        assert "do not pass text" in description

    def test_the_answer_must_not_claim_the_work_is_done(self):
        """The sentence this whole tool exists to stop."""
        assert "CREATED, not done" in self._description()

    def test_delegating_is_not_a_way_out_of_answering(self):
        assert "not for a question that can be answered now" in self._description()

    def test_the_precondition_is_stated_where_the_model_reads_it(self):
        """Without a project no task is created — the fact the deleted block
        carried and the description did not."""
        description = self._description()
        assert "without a project in this conversation none is created" in description
        assert "instead of retrying" in description


class TestTheWorkingDirectoryBudget:
    """The file verbs cost one round like everything else — and cite nothing."""

    def test_the_recursion_limit_derives_from_the_ceiling_alone(self):
        """Nothing else moves when the ceiling does."""
        from agent.agents.piloti.agent import _recursion_limit

        assert _recursion_limit(5) == (5 * 2) + 10

    def test_a_draft_read_back_is_never_a_source(self):
        """The safety property: nothing in the working directory can be cited.

        ``read_file`` returns text the model wrote itself. Registering it would
        let a draft ground a legal statement, which is the laundering path the
        source registry exists to close — and the second gate
        (``get_source_id_for_tool``) is what actually holds, because the file
        verbs ARE in the turn's bound tool set.
        """
        from agent.agents.piloti.agent import _capture_sources

        registry = SourceRegistry()
        for verb in ("ls", "read_file", "write_file", "edit_file"):
            _capture_sources(verb, "# Aktenvermerk\n\nGebäudeklasse 4", frozenset({verb}), registry)
        assert list(registry.all_sources()) == []


class TestAFailedCallIsNotASource:
    """The round loop reads the message STATUS, never the error text.

    A retrieval call rejected by argument validation came back as pydantic's
    own message, and the ``https://errors.pydantic.dev/...`` line in it was
    mined as a URL: the Herleitung then showed a web card for a host nobody had
    searched, on a turn whose search had not run at all. The tool here is the
    web one on purpose, because that is the tool whose results are read for
    URLs at all.
    """

    @pytest.fixture(autouse=True)
    def _web_search_is_a_data_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["web_search_tool"],
                }
            ],
        )
        yield
        reset_registry()

    @staticmethod
    def _captured(message) -> list:
        from types import SimpleNamespace

        registry = SourceRegistry()
        binding = SimpleNamespace(source_tool_names=frozenset({"web_search_tool"}))
        state = ResearchAgentState(messages=[])
        # ``self`` is unread: the capture loop is a function of the four.
        ChatAgent._capture_round(None, [message], binding, registry, state)
        return list(registry.all_sources())

    def test_an_errored_result_registers_nothing(self):
        from langchain_core.messages import ToolMessage

        message = ToolMessage(
            content=(
                "Error: the call was rejected. query: Field required. "
                "For further information visit https://errors.pydantic.dev/2.13/v/missing"
            ),
            tool_call_id="call_1",
            name="web_search_tool",
            status="error",
        )

        assert self._captured(message) == []

    def test_a_result_that_succeeded_is_still_read(self):
        """The other half: the gate is the status, not the text and not the tool."""
        from langchain_core.messages import ToolMessage

        message = ToolMessage(
            content="Treffer: https://www.oib.or.at/richtlinie-2",
            tool_call_id="call_2",
            name="web_search_tool",
        )

        assert [entry.url for entry in self._captured(message)] == ["https://www.oib.or.at/richtlinie-2"]


def _bind_signed_turn(monkeypatch, *, conversation_id: str) -> None:
    """A project-scoped chat turn carrying a valid signed envelope, as the WS upgrade leaves it."""
    import base64
    import hashlib
    import hmac
    import json
    from types import SimpleNamespace

    from nat.plugin_api import Context

    secret = "graph-turn-secret"  # noqa: S105 - test fixture value  # pragma: allowlist secret
    payload = json.dumps(
        {
            "organizationId": "org_1",
            "userId": "user_1",
            "projectId": "3f8b0d2e-0000-4000-8000-000000000001",
            "conversationId": conversation_id,
            "issuedAt": 1_757_500_000_000,
        }
    )
    header = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    monkeypatch.setenv("INTERNAL_API_TOKEN", secret)

    class _Ctx:
        metadata = SimpleNamespace(
            headers={
                "x-grid-project-id": "3f8b0d2e-0000-4000-8000-000000000001",
                "x-grid-request-context": header,
                "x-grid-request-context-sig": signature,
            }
        )
        conversation_id = None

    _Ctx.conversation_id = conversation_id
    monkeypatch.setattr(Context, "get", staticmethod(lambda: _Ctx()))


class TestATurnThatWritesADraft:
    """The whole slice through the compiled graph: two file verbs, one document.

    The LLM is scripted the way the budget tests above script it — one
    ``AIMessage`` per round — while the tools are the REAL DeepAgents verbs over
    a real ``InMemoryStore``. What is asserted is the file that exists at the
    end, the cards the reader is shown, and what the turn was charged for.
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
            patch("agent.agents.piloti.answer_pipeline.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    @pytest.fixture
    def scripted_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def provider(self, scripted_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=scripted_llm)
        return provider

    @pytest.fixture
    def cards(self):
        from agent.cards.registry import CardRegistry
        from agent.cards.registry import reset_card_registry
        from agent.cards.registry import set_card_registry

        registry = CardRegistry()
        token = set_card_registry(registry)
        try:
            yield registry
        finally:
            reset_card_registry(token)

    @pytest.fixture
    def working_directory(self):
        from langgraph.store.memory import InMemoryStore

        from agent.tools.documents.draft_store import DraftBackend
        from agent.tools.documents.tools import draft_tools

        backend = DraftBackend(store=InMemoryStore(), conversation_id="conv-1")
        return backend, draft_tools(backend)

    @staticmethod
    def _call(name: str, args: dict, call_id: str) -> AIMessage:
        return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])

    @pytest.mark.asyncio
    async def test_write_then_edit_leaves_one_file_and_two_cards(
        self, provider, scripted_llm, cards, working_directory
    ):
        backend, tools = working_directory
        scripted_llm.ainvoke = AsyncMock(
            side_effect=[
                self._call(
                    "write_file",
                    {
                        "file_path": "/drafts/aktenvermerk.md",
                        "content": "# Aktenvermerk\n\nPunkt 3: Fluchtweg.\n",
                    },
                    "1",
                ),
                self._call(
                    "edit_file",
                    {
                        "file_path": "/drafts/aktenvermerk.md",
                        "old_string": "Punkt 3: Fluchtweg.",
                        "new_string": "Punkt 3: Fluchtweg, gekürzt.",
                    },
                    "2",
                ),
                AIMessage(content="Der Aktenvermerk ist geschrieben."),
            ]
        )

        agent = ChatAgent(
            llm_provider=provider,
            tools=[web_search_tool, *tools],
            max_tool_iterations=3,
        )

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Schreib den Aktenvermerk")]))

        stored = backend._get_store().get(("conversation", "conv-1", "drafts"), "/drafts/aktenvermerk.md")
        assert stored is not None, "the turn left no file"
        assert stored.value["content"] == "# Aktenvermerk\n\nPunkt 3: Fluchtweg, gekürzt.\n"

        assert [(card["type"], card["version"], card["title"]) for card in cards.snapshot()] == [
            ("document_draft", 1, "Aktenvermerk"),
            ("document_draft", 2, "Aktenvermerk"),
        ]

        # A write and a revision are two rounds and cost two, like any other
        # two rounds: there is no separate allowance for the file verbs and no
        # exemption either. The turn finished inside its budget.
        assert result.tool_iterations == 2
        assert result.research_truncated is None

    @pytest.mark.asyncio
    async def test_write_then_file_draft_files_once_and_the_card_names_the_document(
        self, provider, scripted_llm, cards, working_directory, monkeypatch
    ):
        """The whole filing slice through the graph: one write, one filing, one card that can act.

        Only the HTTP call is a double. The working directory, the draft store's
        filing record, the card registry and the budget accounting are the real
        ones, because what this test is for is that the three meet: the file the
        turn wrote is the bytes that go out, the answer the route gives back is
        what the card carries, and filing is charged to the interaction channel
        rather than to research.
        """
        from langchain_core.tools import StructuredTool

        from agent.tools.documents import register as filing_tools

        backend, tools = working_directory
        posted: list[dict] = []

        async def _same_backend(conversation_id: str, dsn: str | None = None):
            return backend

        monkeypatch.setattr(filing_tools, "get_draft_backend", _same_backend)
        monkeypatch.setattr(
            filing_tools,
            "post_document_version",
            lambda payload, envelope: (
                posted.append(payload),
                {"documentId": "doc-7", "version": {"id": "ver-7", "state": "draft", "contentHash": "h7"}},
            )[1],
        )
        _bind_signed_turn(monkeypatch, conversation_id="conv-1")

        # An agent-runtime function is bound as a plain tool here: the graph only
        # needs a `BaseTool` with the right NAME, and building the agent-runtime
        # wrapper would test the agent runtime rather than the turn.
        file_draft_tool = StructuredTool.from_function(
            coroutine=filing_tools.run_file_draft, name="file_draft", description="legt ab"
        )

        scripted_llm.ainvoke = AsyncMock(
            side_effect=[
                self._call(
                    "write_file",
                    {"file_path": "/drafts/aktenvermerk.md", "content": "# Aktenvermerk\n\nFluchtweg.\n"},
                    "1",
                ),
                self._call("file_draft", {"path": "/drafts/aktenvermerk.md"}, "2"),
                AIMessage(content="Der Aktenvermerk liegt als Entwurf im Projekt."),
            ]
        )

        agent = ChatAgent(
            llm_provider=provider,
            tools=[web_search_tool, *tools, file_draft_tool],
            max_tool_iterations=3,
        )
        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Leg das ins Projekt")]))

        assert [payload["op"] for payload in posted] == ["create"]
        assert posted[0]["content"] == "# Aktenvermerk\n\nFluchtweg.\n"

        drafts = [card for card in cards.snapshot() if card["type"] == "document_draft"]
        # Two cards: the write's, which knows no document, and the filing's,
        # which does. The reader sees the second one act.
        assert "document_id" not in drafts[0]
        assert (drafts[-1]["document_id"], drafts[-1]["version_id"], drafts[-1]["version_state"]) == (
            "doc-7",
            "ver-7",
            "draft",
        )

        # One write, one filing: two rounds, charged as two.
        assert result.tool_iterations == 2


# ---------------------------------------------------------------------------
# Tidying the workspace — the turn that PROPOSES instead of doing
# ---------------------------------------------------------------------------


def _file_verb_descriptions() -> dict[str, str]:
    from agent.tools.files import register as files_register

    # One tool since the merge; the rules below are what its description must
    # still carry for every operation it proposes.
    return {"propose_file_change": files_register._DESCRIPTION}


class TestTheTidyingRulesLiveInTheTools:
    """`<aufraeumen>` is gone; the tool's description carries what it said.

    The block taught the tidying verbs how to behave, in a paragraph charged on
    every call of every turn. A tool owns its whole contract (ADR-0060 (d)); the
    four verbs are one tool with an `operation` now, and the assertions below
    are what its description has to keep.
    """

    def test_the_prompt_no_longer_teaches_tidying(self):
        assert "<aufraeumen>" not in _render_researcher_prompt(drafting_enabled=True)

    def test_the_tool_says_it_changes_nothing(self):
        """The one failure this rule exists to prevent: „ist verschoben"."""
        for name, description in _file_verb_descriptions().items():
            assert "PROPOSES" in description, name
            assert "changes nothing itself" in description, name
            assert "card" in description, name

    def test_the_tool_says_the_user_decides(self):
        for name, description in _file_verb_descriptions().items():
            assert "the user accepts or dismisses" in description, name

    def test_it_is_asked_for_and_not_volunteered(self):
        """These answer a request; they are not a tidy-up nobody asked for."""
        for name, description in _file_verb_descriptions().items():
            assert "Propose only when the user asks for it" in description, name

    def test_it_offers_no_operation_that_is_not_bound(self):
        """`set_doc_class` is gone; a description still naming it teaches a call
        that fails, and a Dokumentart the reader could never accept."""
        for name, description in _file_verb_descriptions().items():
            assert "set_doc_class" not in description and "doc_class" not in description, name

    def test_every_operation_is_described(self):
        (description,) = _file_verb_descriptions().values()
        for operation in ("`move`", "`rename`", "`create_folder`", "`assign`"):
            assert operation in description

    def test_a_name_is_taken_from_the_overview_and_never_invented(self):
        (description,) = _file_verb_descriptions().values()
        assert "exactly as the overview or a listing shows it" in description


class TestTheThreeDraftingTurnShapes:
    """Commission, revise, file — the same three cases the live eval runs.

    ``evals/turn-shapes/test_turn_shapes_live.py`` puts these prompts to the
    real model and skips without a key, so nothing about a drafting turn was
    checked on any PR (ledger row 5). These are the same cases, the same
    assertion (``tests/fixtures/drafting_turns.py``) and the same real tools —
    the working directory, the card registry and the budget accounting — with
    the model scripted, which is what makes them runnable in CI.

    What they can prove and the live pair cannot: that the graph does the right
    thing with the calls. What the live pair proves and these cannot: that the
    model MAKES them.
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("agent.agents.piloti.answer_pipeline.verify_citations") as mock_verify,
            patch("agent.agents.piloti.answer_pipeline.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    @pytest.fixture
    def scripted_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def provider(self, scripted_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=scripted_llm)
        return provider

    @pytest.fixture
    def cards(self):
        from agent.cards.registry import CardRegistry
        from agent.cards.registry import reset_card_registry
        from agent.cards.registry import set_card_registry

        registry = CardRegistry()
        token = set_card_registry(registry)
        try:
            yield registry
        finally:
            reset_card_registry(token)

    @pytest.fixture
    def working_directory(self):
        from langgraph.store.memory import InMemoryStore

        from agent.tools.documents.draft_store import DraftBackend
        from agent.tools.documents.tools import draft_tools

        backend = DraftBackend(store=InMemoryStore(), conversation_id="conv-1")
        return backend, draft_tools(backend)

    @staticmethod
    def _answer(text: str) -> AIMessage:
        """The reply a drafting turn ends on: prose, a kind, and no verdict."""
        import json as _json

        return AIMessage(content=f"```answer_json\n{_json.dumps({'answer': text, 'kind': 'direct'})}\n```")

    @staticmethod
    def _call(name: str, args: dict, call_id: str) -> AIMessage:
        return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])

    def _agent(self, provider, tools):
        # A research budget of ONE: writing is not researching, so a turn that
        # charged the file verbs to it would be forced into synthesis before it
        # reached the second call.
        return ChatAgent(llm_provider=provider, tools=[web_search_tool, *tools], max_tool_iterations=1)

    async def _seed(self, backend, case):
        for path, content in case.seed.items():
            await backend.awrite(path, content)

    def _file_draft_tool(self, monkeypatch, backend, posted):
        """`file_draft` with only the HTTP call doubled, as the filing test does."""
        from langchain_core.tools import StructuredTool

        from agent.tools.documents import register as filing_tools

        async def _same_backend(conversation_id: str, dsn: str | None = None):
            return backend

        monkeypatch.setattr(filing_tools, "get_draft_backend", _same_backend)
        monkeypatch.setattr(
            filing_tools,
            "post_document_version",
            lambda payload, envelope: (
                posted.append(payload),
                {"documentId": "doc-7", "version": {"id": "ver-7", "state": "draft", "contentHash": "h7"}},
            )[1],
        )
        _bind_signed_turn(monkeypatch, conversation_id="conv-1")
        return StructuredTool.from_function(
            coroutine=filing_tools.run_file_draft, name="file_draft", description="legt ab"
        )

    @pytest.mark.asyncio
    async def test_a_commission_writes_the_document_and_does_not_file_it(
        self, provider, scripted_llm, cards, working_directory
    ):
        backend, tools = working_directory
        scripted_llm.ainvoke = AsyncMock(
            side_effect=[
                self._call(
                    "write_file",
                    {
                        "file_path": SEEDED_DRAFT_PATH,
                        "content": "# Aktenvermerk – Besprechung MA 37\n\n## 3. Fluchtweg\nBesprochen.\n",
                    },
                    "1",
                ),
                self._answer("Der Aktenvermerk liegt als Entwurf in dieser Unterhaltung."),
            ]
        )
        agent = self._agent(provider, tools)

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content=COMMISSION.prompt)]))

        assert_turn_shape(
            COMMISSION,
            called_tools=_scripted_tool_names(scripted_llm),
            cards=cards.snapshot(),
            answer_meta=result.answer_meta,
            escalated=result.escalation_requested,
        )
        assert draft_cards(cards.snapshot())[-1]["version"] == 1
        assert result.answer_meta["kind"] == "direct", "the envelope's kind never reached the state"

    @pytest.mark.asyncio
    async def test_a_revision_edits_the_draft_it_was_given(self, provider, scripted_llm, cards, working_directory):
        backend, tools = working_directory
        await self._seed(backend, REVISE)
        scripted_llm.ainvoke = AsyncMock(
            side_effect=[
                self._call(
                    "edit_file",
                    {
                        "file_path": SEEDED_DRAFT_PATH,
                        "old_string": "Die Behörde hält die Länge des Fluchtwegs für klärungsbedürftig und erwartet "
                        "eine Darstellung im Einreichplan, aus der die Gehweglänge bis ins Freie hervorgeht.",
                        "new_string": "Die Gehweglänge ist im Einreichplan darzustellen.",
                    },
                    "1",
                ),
                self._answer("Punkt 3 ist auf einen Satz gekürzt."),
            ]
        )
        agent = self._agent(provider, tools)

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content=REVISE.prompt)]))

        assert_turn_shape(
            REVISE,
            called_tools=_scripted_tool_names(scripted_llm),
            cards=cards.snapshot(),
            answer_meta=result.answer_meta,
            escalated=result.escalation_requested,
        )
        stored = backend._get_store().get(("conversation", "conv-1", "drafts"), SEEDED_DRAFT_PATH)
        assert "klärungsbedürftig" not in stored.value["content"]
        # The revision is a VERSION of the same path, not a second document.
        assert draft_cards(cards.snapshot())[-1]["version"] == 2

    @pytest.mark.asyncio
    async def test_filing_puts_the_draft_in_the_project_and_the_card_can_act(
        self, provider, scripted_llm, cards, working_directory, monkeypatch
    ):
        backend, tools = working_directory
        await self._seed(backend, FILE)
        posted: list[dict] = []
        file_draft_tool = self._file_draft_tool(monkeypatch, backend, posted)
        scripted_llm.ainvoke = AsyncMock(
            side_effect=[
                self._call("file_draft", {"path": SEEDED_DRAFT_PATH}, "1"),
                self._answer("Der Aktenvermerk liegt als Entwurf im Projekt."),
            ]
        )
        agent = self._agent(provider, [*tools, file_draft_tool])

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content=FILE.prompt)]))

        assert_turn_shape(
            FILE,
            called_tools=_scripted_tool_names(scripted_llm),
            cards=cards.snapshot(),
            answer_meta=result.answer_meta,
            escalated=result.escalation_requested,
        )
        assert [payload["op"] for payload in posted] == ["create"]


def _scripted_tool_names(scripted_llm) -> list[str]:
    """Every tool the scripted turn actually asked for, in order.

    Read off the replies the model made rather than off the tool doubles: the
    graph may withhold a call (the round-zero fan-out cap answers the surplus
    with an explanation), and what the shape assertion is about is what the
    turn DID — a withheld call did not happen.
    """
    names: list[str] = []
    for call in scripted_llm.ainvoke.await_args_list:
        for message in call.args[0]:
            for tool_call in getattr(message, "tool_calls", None) or []:
                name = traced_tool_name(tool_call["name"], tool_call.get("args"))
                if name not in names:
                    names.append(name)
    return names
