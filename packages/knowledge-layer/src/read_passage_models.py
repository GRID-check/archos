"""The shapes a passage read is built from: the input a call carries, and the target a document name resolves to."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import AliasChoices
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field


# The arguments of one ``read_passage`` call, as the model sees them. No docstring: pydantic
# would put it in the tool schema the model reads.
#
# ``punkt`` is the argument's former name: accepted for one release so a replayed turn, a
# cached plan or a model that learned the old name still opens its passage. Only ``clause``
# appears in the tool schema. Remove the alias after one release.
class ReadPassageInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    document: str
    clause: str | int | None = Field(default=None, validation_alias=AliasChoices("clause", "punkt"))
    page: int | str | None = None
    pages: str | int | None = None
    cursor: str | None = None
    conclusion: str = ""


@dataclass(frozen=True)
class PassageTarget:
    """One resolved (collection, document) the locator will fetch from."""

    collection: str
    file_name: str
    shelf: str | None
    #: The current Fassung of this document when a PERSON confirmed it replaced, else None.
    current: str | None = None


@dataclass(frozen=True)
class Fetched:
    """What one gathered fetch returned: the chunks, the failures, and whether every read was structural."""

    chunks: list[Any]
    failures: list[BaseException]
    structural: bool
