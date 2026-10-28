"""The revision-compare card: what changed between two Fassungen of a document."""

from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import ConfigDict
from pydantic import Field
from pydantic import model_validator

from aiq_agent.cards.card_model import CardModel
from aiq_agent.cards.look_card import NOT_A_DATA_URL
from aiq_agent.cards.look_card import UUID_PATTERN
from aiq_agent.cards.look_card import Share
from aiq_agent.cards.look_card import refuse_data_urls

#: Changes one card carries: the comparison returns at most this many boxes.
MAX_REVISION_CHANGES = 12


#: Sentences one card carries: the comparison returns at most this many.
MAX_REVISION_SUMMARY = 8


class RevisionCompareChange(CardModel):
    """One change, boxed on the page (the same frame on both Fassungen)."""

    model_config = ConfigDict(regex_engine="python-re")

    region: list[Share] = Field(
        min_length=4,
        max_length=4,
        description="[x, y, w, h] as shares of the page, origin top left; x + w and y + h at most 1",
    )
    label: str = Field(min_length=1, max_length=200, pattern=NOT_A_DATA_URL, description="What changed there")

    @model_validator(mode="after")
    def _a_box(self) -> RevisionCompareChange:
        x, y, w, h = self.region
        if w <= 0 or h <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
            raise ValueError("the region reaches past the page or has no area: x + w and y + h are at most 1")
        return self


class RevisionCompareCard(CardModel):
    """The same page of an older and a newer Fassung, side by side, with the changes boxed on each.

    System-emitted (``tools/workspace/cards.py``) from a ``document-revision-compare``
    result; the model cannot emit it (``SYSTEM_CARD_TYPES``). The boxes were found
    on the newer page and are drawn at the same place on the older one.
    """

    model_config = ConfigDict(regex_engine="python-re")

    type: Literal["revision_compare"] = "revision_compare"
    older_id: str = Field(pattern=UUID_PATTERN, description="The older Fassung's workspace document id")
    newer_id: str = Field(pattern=UUID_PATTERN, description="The newer Fassung's workspace document id")
    older_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        pattern=NOT_A_DATA_URL,
        description="The older Fassung's file name, when the comparison named it; the side's label",
    )
    newer_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        pattern=NOT_A_DATA_URL,
        description="The newer Fassung's file name, when the comparison named it; the side's label",
    )
    page: int = Field(ge=1, description="The page compared, from 1; the same page of both Fassungen")
    changes: list[RevisionCompareChange] = Field(
        default_factory=list, max_length=MAX_REVISION_CHANGES, description="The boxed changes; empty when none"
    )
    summary: list[Annotated[str, Field(min_length=1, max_length=400, pattern=NOT_A_DATA_URL)]] = Field(
        min_length=1, max_length=MAX_REVISION_SUMMARY, description="What changed, in short sentences"
    )

    @model_validator(mode="before")
    @classmethod
    def _no_bytes(cls, data: Any) -> Any:
        refuse_data_urls(data)
        return data
