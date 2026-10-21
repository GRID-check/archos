"""The per-turn ceiling on ``look`` calls, and its whole-page split (ADR-0128).

What matters: a bound budget refuses the (N+1)-th view, a turn's budget is
invisible to a sibling context, and an unbound call site is not capped —
the cap is per turn, and a module-level fallback would be the leak the
ContextVar exists to prevent.
"""

from __future__ import annotations

import asyncio
import contextvars

from aiq_agent.common.image_view_budget import MAX_IMAGE_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import MAX_OVERVIEW_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import begin_image_view_budget
from aiq_agent.common.image_view_budget import end_image_view_budget
from aiq_agent.common.image_view_budget import get_image_view_budget
from aiq_agent.common.image_view_budget import remaining_views_text
from aiq_agent.common.image_view_budget import try_consume_image_view


def test_refuses_the_view_past_the_cap_and_recovers_at_turn_end():
    token = begin_image_view_budget()
    try:
        assert [try_consume_image_view() for _ in range(MAX_IMAGE_VIEWS_PER_TURN)] == [True] * MAX_IMAGE_VIEWS_PER_TURN
        assert try_consume_image_view() is False
        assert get_image_view_budget().remaining == 0
    finally:
        end_image_view_budget(token)
    assert get_image_view_budget() is None
    assert try_consume_image_view() is True  # unbound: not capped


def test_a_custom_limit_is_honoured():
    token = begin_image_view_budget(limit=1)
    try:
        assert try_consume_image_view() is True
        assert try_consume_image_view() is False
    finally:
        end_image_view_budget(token)


def test_budgets_do_not_leak_between_contexts():
    """Two turns in flight at once each spend their own budget."""

    async def turn(limit: int) -> int:
        token = begin_image_view_budget(limit=limit)
        try:
            await asyncio.sleep(0)
            return sum(1 for _ in range(10) if try_consume_image_view())
        finally:
            end_image_view_budget(token)

    async def both() -> tuple[int, int]:
        return await asyncio.gather(turn(2), turn(5))

    assert asyncio.run(both()) == [2, 5]

    # A copied context sees the budget; the parent stays unbound.
    token = begin_image_view_budget(limit=1)
    try:
        ctx = contextvars.copy_context()
        assert ctx.run(try_consume_image_view) is True
        assert ctx.run(try_consume_image_view) is False
    finally:
        end_image_view_budget(token)
    assert get_image_view_budget() is None


def test_at_most_two_of_the_six_are_whole_pages():
    token = begin_image_view_budget()
    try:
        overviews = [try_consume_image_view("overview") for _ in range(MAX_OVERVIEW_VIEWS_PER_TURN + 1)]
        assert overviews == [True] * MAX_OVERVIEW_VIEWS_PER_TURN + [False]
        # A refused overview costs nothing: the regions still have the rest of the turn.
        regions = [try_consume_image_view("region") for _ in range(MAX_IMAGE_VIEWS_PER_TURN)]
        assert regions.count(True) == MAX_IMAGE_VIEWS_PER_TURN - MAX_OVERVIEW_VIEWS_PER_TURN
        assert remaining_views_text() == "0 looks left this turn (0 of them whole pages)."
    finally:
        end_image_view_budget(token)
    assert remaining_views_text() == ""  # outside a turn there is nothing to count down


def test_the_whole_pages_left_never_exceed_the_looks_left():
    token = begin_image_view_budget()
    try:
        for _ in range(MAX_IMAGE_VIEWS_PER_TURN - 1):
            try_consume_image_view("region")
        assert remaining_views_text() == "1 look left this turn (1 of them whole pages)."
    finally:
        end_image_view_budget(token)
