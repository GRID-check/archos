"""The look card (ADR-0128): where Piloti looked, as addresses, never pixels."""

from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import ConfigDict
from pydantic import Field
from pydantic import model_validator

from agent.cards.card_model import CardModel

#: How many items one card carries: the turn's look budget is 6, plus the
#: gestures that point at the same document.
MAX_LOOK_ITEMS = 12


UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


#: A text that is not a `data:` URL, as a pattern, so the generated JSON Schema
#: and Zod schema refuse one too (a lookahead: these models use Python's `re`).
NOT_A_DATA_URL = r"^(?!\s*[dD][aA][tT][aA]:)"


#: A share of the page or image: 0 to 1.
Share = Annotated[float, Field(ge=0, le=1)]


def refuse_data_urls(value: Any, path: str = "card") -> None:
    """Raise on any string under ``value`` that starts ``data:``: a card stores an address, never bytes."""
    if isinstance(value, str):
        if value.lstrip()[:5].lower() == "data:":
            raise ValueError(f"{path}: a look card holds an address, never image bytes (a `data:` URL)")
    elif isinstance(value, dict):
        for key, item in value.items():
            refuse_data_urls(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            refuse_data_urls(item, f"{path}[{index}]")


class LookDocument(CardModel):
    """The document looked at: its id when it is a workspace document, its file name, its shelf."""

    model_config = ConfigDict(regex_engine="python-re")

    id: str | None = Field(
        default=None,
        pattern=UUID_PATTERN,
        description="The workspace document's id; absent for a base-corpus document or when it was not resolved",
    )
    name: str = Field(min_length=1, max_length=300, pattern=NOT_A_DATA_URL, description="The file name")
    shelf: Literal["stored", "base"] = Field(
        default="stored",
        description="`stored`: a document of the office or the project; `base`: the platform corpus (Basiswissen)",
    )


class LookItem(CardModel):
    """One place on the document: a look Piloti took, or a box or pointer it showed the room (`reference`)."""

    model_config = ConfigDict(regex_engine="python-re")

    origin: Literal["look", "reference"] = Field(
        default="look", description="`look`: Piloti looked here; `reference`: Piloti pointed the room here"
    )
    page: int = Field(ge=1, description="The page, from 1")
    frame: Literal["page", "image"] = Field(
        default="page", description="`page`: the region is on the page as shown; `image`: on the embedded image"
    )
    scope: Literal["overview", "region", "point"] = Field(
        description="`overview`: the whole page or image; `region`: a box on it; `point`: a pointer"
    )
    region: list[Share] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="[x, y, w, h] as shares of the frame, origin top left; x + w and y + h at most 1",
    )
    point: list[Share] | None = Field(
        default=None, min_length=2, max_length=2, description="[x, y] of a pointer, as shares of the page"
    )
    image_index: int | None = Field(default=None, ge=0, description="The embedded image, for frame `image`")
    revision_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_.-]+$",
        description="The Fassung looked at; absent means the document's current Fassung",
    )
    question: str | None = Field(
        default=None, max_length=200, pattern=NOT_A_DATA_URL, description="What Piloti looked for"
    )
    reading: str | None = Field(
        default=None, max_length=300, pattern=NOT_A_DATA_URL, description="The first thing read there"
    )
    label: str | None = Field(
        default=None, max_length=80, pattern=NOT_A_DATA_URL, description="A reference's label, as the room saw it"
    )
    where: str | None = Field(
        default=None, max_length=60, pattern=NOT_A_DATA_URL, description="The region in words, e.g. „oben rechts“"
    )

    @model_validator(mode="after")
    def _a_place(self) -> LookItem:
        if self.region is not None:
            x, y, w, h = self.region
            if w <= 0 or h <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
                raise ValueError("the region reaches past the frame or has no area: x + w and y + h are at most 1")
        if self.scope == "region" and self.region is None:
            raise ValueError("a `region` item names its region")
        if self.scope == "point" and self.point is None:
            raise ValueError("a `point` item names its point")
        if self.frame == "image" and self.image_index is None:
            raise ValueError("an `image` frame names its `image_index`")
        return self


class LookCard(CardModel):
    """Where Piloti looked on one document in this turn, and what it showed the room there.

    System-emitted (``tools/look/cards.py``) once the answer is final, from the
    looks the answer relies on; the model cannot emit it (``SYSTEM_CARD_TYPES``).
    """

    type: Literal["look"] = "look"
    document: LookDocument
    items: list[LookItem] = Field(
        min_length=1, max_length=MAX_LOOK_ITEMS, description="The places, in the order Piloti reached them"
    )

    @model_validator(mode="before")
    @classmethod
    def _no_bytes(cls, data: Any) -> Any:
        refuse_data_urls(data)
        return data
