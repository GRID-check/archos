"""Per-turn ceiling on ``look`` calls.

Every call hands the model one image block: a page render or a stored
raster, base64-encoded, on the order of a few hundred kilobytes of context
and one vision-model input. A model that decides to "look at every figure"
in a document set — or loops on a tool result it cannot parse — would otherwise
spend the turn's whole budget on images. The card registry's problem, in
another shape: something per-turn that a tool must see and that must not
leak into the next turn or another tenant, so it is the same ContextVar
pattern (:mod:`agent.cards.registry`).

Two limits, one budget (ADR-0128): at most :data:`MAX_IMAGE_VIEWS_PER_TURN`
looks, and of those at most :data:`MAX_OVERVIEW_VIEWS_PER_TURN` whole pages (an
``overview``: no ``region``, no ``image_index``). Whole-sheet answering is the
weakest way to read a large drawing, so a turn may not spend its looks on
overviews and never read a region.

The chat entrypoint binds a budget around each turn
(``turn/registries.turn_registries``) and deep research around each run
(``agents/deep_researcher/register.run_deep_research``). A call site with no
budget bound (CLI, batch, tests) is not capped: an unbound default would have
to live at module level, and that is exactly the state that leaks across turns.
"""

from __future__ import annotations

import contextvars
from typing import Literal

#: How many images one turn may ask to see. Six covers a question that needs a
#: drawing, its section and a detail with room to re-look; past that the model
#: is browsing, not answering.
MAX_IMAGE_VIEWS_PER_TURN = 6
#: How many of them may be whole pages. One overview, then regions, is the
#: shape that reads a large sheet well; two leaves room for a second document.
MAX_OVERVIEW_VIEWS_PER_TURN = 2

#: A whole page or image (``overview``), or a box or stored raster on it (``region``).
ViewKind = Literal["overview", "region"]


class ImageViewBudget:
    """Counts image views against a fixed limit for one turn."""

    def __init__(
        self, limit: int = MAX_IMAGE_VIEWS_PER_TURN, overview_limit: int = MAX_OVERVIEW_VIEWS_PER_TURN
    ) -> None:
        self.limit = limit
        self.overview_limit = overview_limit
        self.used = 0
        self.overviews_used = 0
        #: How many of the views rendered a REGION of a page (``region=``): the
        #: turn looked at the box a person drew, not just at the page around it.
        #: Read once the turn ends, as ``focus_region_viewed`` on its trace.
        self.regions_viewed = 0

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def overviews_remaining(self) -> int:
        """Whole-page looks still possible: bounded by both limits."""
        return min(self.remaining, max(0, self.overview_limit - self.overviews_used))

    def try_consume(self, kind: ViewKind = "region") -> bool:
        """Take one view of ``kind`` if the turn has one left; ``False`` when it is spent."""
        if self.used >= self.limit:
            return False
        if kind == "overview":
            if self.overviews_used >= self.overview_limit:
                return False
            self.overviews_used += 1
        self.used += 1
        return True

    def remaining_text(self) -> str:
        """The line every successful look ends with, so the model can plan the rest of the turn."""
        looks = "look" if self.remaining == 1 else "looks"
        return f"{self.remaining} {looks} left this turn ({self.overviews_remaining} of them whole pages)."


_budget_var: contextvars.ContextVar[ImageViewBudget | None] = contextvars.ContextVar("_image_view_budget", default=None)


def begin_image_view_budget(limit: int = MAX_IMAGE_VIEWS_PER_TURN) -> contextvars.Token:
    """Bind a fresh budget for the current turn; pair with :func:`end_image_view_budget`."""
    return _budget_var.set(ImageViewBudget(limit))


def end_image_view_budget(token: contextvars.Token) -> None:
    """Restore whatever was bound before :func:`begin_image_view_budget`."""
    _budget_var.reset(token)


def get_image_view_budget() -> ImageViewBudget | None:
    """The budget bound to the current turn, or ``None`` outside one."""
    return _budget_var.get()


def try_consume_image_view(kind: ViewKind = "region") -> bool:
    """Take one view of ``kind`` from the turn's budget; always ``True`` when none is bound."""
    budget = _budget_var.get()
    return True if budget is None else budget.try_consume(kind)


def remaining_views_text() -> str:
    """:meth:`ImageViewBudget.remaining_text` for the turn's budget; empty outside a turn."""
    budget = _budget_var.get()
    return "" if budget is None else budget.remaining_text()


def note_region_viewed() -> None:
    """A region of a page was rendered for the model this turn; nothing to note outside a turn."""
    budget = _budget_var.get()
    if budget is not None:
        budget.regions_viewed += 1
