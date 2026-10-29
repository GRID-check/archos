"""The canvas activity card: what happened on a canvas this turn."""

from typing import Annotated
from typing import Literal

from pydantic import Field

from agent.cards.card_model import CardModel

#: How many entries one card carries: the `mark` tool proposes at most 20 per call.
MAX_CANVAS_ACTIVITY_ITEMS = 20


class CanvasDocument(CardModel):
    """The document the activity happened on, by the BFF's id and its file name."""

    id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        description="The document's id, as the BFF returned it",
    )
    name: str = Field(min_length=1, description="The file name, as the BFF returned it")


class _CanvasSetMark(CardModel):
    """A mark the agent set on a page: where, what kind, what it says."""

    annotation_id: str = Field(min_length=1, description="The mark's id")
    number: int = Field(ge=1, description="The mark's number on the document")
    page: int = Field(ge=1, description="The page, from 1")
    shape: Literal["point", "region"]
    x: float = Field(ge=0, le=1, description="Left edge (or the point), as a share of the page's width")
    y: float = Field(ge=0, le=1, description="Top edge (or the point), as a share of the page's height")
    w: float | None = Field(default=None, gt=0, le=1, description="Width share, for a region")
    h: float | None = Field(default=None, gt=0, le=1, description="Height share, for a region")
    kind: Literal["hint", "question", "defect"]
    body: str = Field(min_length=1, max_length=2000, description="What the mark says")


class CanvasProposedItem(_CanvasSetMark):
    """A mark the agent proposed: a person takes it over or dismisses it on the document."""

    action: Literal["proposed"] = "proposed"


class CanvasCreatedItem(_CanvasSetMark):
    """A mark the agent set because the person asked for it: open at once, in the person's name."""

    action: Literal["created"] = "created"


class CanvasFieldChange(CardModel):
    """One field a change moved. An absent ``before``/``after`` is an empty field (no assignee, no date)."""

    field: Literal["status", "assignee", "due_on", "kind", "body"]
    before: str | None = Field(default=None, max_length=2000, description="The value before; absent when empty")
    after: str | None = Field(default=None, max_length=2000, description="The value after; absent when empty")
    before_label: str | None = Field(default=None, max_length=200, description="The assignee's name before")
    after_label: str | None = Field(default=None, max_length=200, description="The assignee's name after")


class CanvasChangedItem(CardModel):
    """A mark the agent changed because the person asked: what moved, the note it left, and the status it left."""

    action: Literal["changed"] = "changed"
    annotation_id: str = Field(min_length=1, description="The mark's id")
    number: int = Field(ge=1, description="The mark's number on the document")
    status: Literal["proposed", "open", "resolved", "dismissed"] = Field(
        description="The mark's status after the change: what an undo expects to find"
    )
    changes: list[CanvasFieldChange] = Field(min_length=1, max_length=5)
    note: str = Field(min_length=1, max_length=300, description="The start of the agent's note in the thread")


class CanvasDeletedItem(CardModel):
    """A mark the agent deleted because the person who set it asked. Gone with its thread; no undo."""

    action: Literal["deleted"] = "deleted"
    number: int = Field(ge=1, description="The deleted mark's number")
    body: str = Field(min_length=1, max_length=2000, description="What the mark said")


class CanvasRepliedItem(CardModel):
    """An answer the agent wrote in a mark's thread."""

    action: Literal["replied"] = "replied"
    annotation_id: str = Field(min_length=1, description="The mark whose thread was answered")
    number: int = Field(ge=1, description="The mark's number on the document")
    excerpt: str = Field(min_length=1, max_length=300, description="The start of the reply")


CanvasActivityItem = Annotated[
    CanvasProposedItem | CanvasCreatedItem | CanvasChangedItem | CanvasDeletedItem | CanvasRepliedItem,
    Field(discriminator="action"),
]


class CanvasActivityCard(CardModel):
    """What the agent did on one document in this turn: marks proposed or set, changed, deleted, threads answered.

    A proposed mark is taken over or dismissed from here as well as on the
    document, and a change is undone from here, through the same annotations API.

    System-emitted by the canvas tools (``packages/agent/src/agent/tools/canvas/``) after
    the BFF confirmed each write; the model cannot emit it (``SYSTEM_CARD_TYPES``).
    """

    type: Literal["canvas_activity"] = "canvas_activity"
    document: CanvasDocument
    items: list[CanvasActivityItem] = Field(
        min_length=1,
        max_length=MAX_CANVAS_ACTIVITY_ITEMS,
        description="What happened, in the order it happened",
    )
