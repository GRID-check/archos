"""Every deep research run looks under a budget of its own (ADR-0128, plan risk R6).

``look`` is capped by the per-turn image budget, and an unbound budget is no cap
at all. A chat turn binds one (``turn/registries``); a deep research run on the
job worker enters no chat turn, so ``run_deep_research`` binds its own, and a
run inside a turn gets its own too rather than spending the turn's looks.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

from langchain_core.messages import HumanMessage

from agent.agents.deep_researcher import register as deep_register
from agent.agents.deep_researcher.models import DeepResearchAgentState
from agent.common.image_view_budget import MAX_IMAGE_VIEWS_PER_TURN
from agent.common.image_view_budget import begin_image_view_budget
from agent.common.image_view_budget import end_image_view_budget
from agent.common.image_view_budget import get_image_view_budget
from agent.common.image_view_budget import try_consume_image_view


async def _run(seen: list) -> DeepResearchAgentState:
    """One run with a prebuilt agent that records the budget it ran under and spends one look."""
    state = DeepResearchAgentState(messages=[HumanMessage(content="q")])

    async def run(_state):
        seen.append(get_image_view_budget())
        try_consume_image_view("region")
        return _state

    provider = MagicMock()
    prebuilt = SimpleNamespace(run=run)
    tools = [SimpleNamespace(name="look")]
    lazy = SimpleNamespace(
        get=AsyncMock(return_value=(tools, prebuilt)),
        blueprint=SimpleNamespace(provider=provider, sandbox=None),
    )
    context = SimpleNamespace(apply=lambda given: given)
    with (
        patch.object(deep_register, "read_request_llm_context", new=AsyncMock(return_value=context)),
        patch.object(deep_register, "filter_tools_by_sources", return_value=tools),
        patch.object(deep_register, "all_mapped_tools_filtered_out", return_value=False),
        patch.object(deep_register, "validate_tool_availability", return_value=(True, [], [])),
    ):
        return await deep_register.run_deep_research(state, lazy)


async def test_a_run_outside_a_turn_looks_under_a_cap_and_leaves_none_behind() -> None:
    seen: list = []

    await _run(seen)

    [budget] = seen
    assert budget is not None and budget.limit == MAX_IMAGE_VIEWS_PER_TURN and budget.used == 1
    assert get_image_view_budget() is None


async def test_a_run_inside_a_turn_spends_its_own_looks_not_the_turns() -> None:
    seen: list = []
    token = begin_image_view_budget()
    try:
        turn = get_image_view_budget()
        await _run(seen)
        assert get_image_view_budget() is turn and turn.used == 0
    finally:
        end_image_view_budget(token)

    assert seen[0] is not turn
