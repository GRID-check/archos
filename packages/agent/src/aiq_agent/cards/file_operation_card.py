"""The file-operation proposal card: moves, renames, new folders and assignments waiting for the person's yes."""

from typing import Literal

from pydantic import Field
from pydantic import model_validator

from aiq_agent.cards.card_model import CardModel
from aiq_agent.cards.proposal_cards import PROPOSAL_ID_PATTERN

#: How many operations one card may carry. A tidying turn proposes a handful;
#: past that the card stops being a decision the reader can actually read
#: before answering, and „alles verschieben" is not a proposal, it is a job.
MAX_FILE_OPERATIONS = 8


#: The four operations, each an `operation` value of the one tool that emits
#: them, `propose_file_change` (four tools, one per kind, until they merged).
#:
#: A fifth, `set_doc_class`, was here and is gone. A project document has no
#: doc_class route for an Accept to run, so the card drew the proposal and no
#: control — a decision the reader could read and could not take. It comes back
#: with the route, not before it.
FileOperationKind = Literal["move", "rename", "create_folder", "assign"]


class FileOperationItem(CardModel):
    """One proposed change, in the vocabulary of the operation that owns it.

    Deliberately flat with per-operation fields rather than a nested union: the
    card is built by the tool, validated once here, and rendered by one
    component that switches on the CARD's `operation` — a shape the frontend's
    generated Zod can narrow without a second discriminator inside every row.
    :meth:`FileOperationProposalCard._require_operation_fields` is what keeps a
    row from carrying another operation's fields.

    ``document`` is a FILE NAME and never an id. The agent's inventory
    (``knowledge/inventory.py``) knows files by ``(collection, file_name)`` and
    has no document ids in it at all, so a card carrying an id would be
    carrying something the tool invented. The reader's session resolves the
    name against their own document list when they accept.
    """

    document: str | None = Field(
        default=None,
        description="File name exactly as the inventory lists it (move, rename, assign)",
    )
    source: Literal["project", "office"] | None = Field(
        default=None,
        description="Which shelf the document sits on, so the name resolves in the right corpus",
    )
    current: str | None = Field(
        default=None,
        description="What this is TODAY (current folder or name) — for the before/after line",
    )
    target_folder: str | None = Field(
        default=None,
        description="move: the destination folder PATH, e.g. 'Einreichung/Akten'. Empty string is the project root",
    )
    new_display_name: str | None = Field(default=None, description="rename: the new display name")
    folder_name: str | None = Field(default=None, description="create_folder: the new folder's own name (one segment)")
    parent_folder: str | None = Field(
        default=None,
        description="create_folder: the parent folder PATH, or an empty string for the project root",
    )
    member: str | None = Field(
        default=None,
        description="assign: the person as the user named them; the reader's session resolves it against the project",
    )
    reason: str | None = Field(
        default=None,
        max_length=300,
        description="Why this change, one short sentence the reader sees under the row",
    )


class FileOperationProposalCard(CardModel):
    """A workspace change the agent PROPOSES and a person applies.

    System-emitted by ``propose_file_change`` (``packages/agent/src/aiq_agent/tools/files/``).
    Every operation is a write, none of them writes: the tool's own result text
    says plainly that nothing has changed yet. With ``proposal_id`` the card
    shows a proposal stored on the server (ADR-0105), which the server applies
    in the accepting person's session; it then carries the one operation of
    the call that created it. Without one (an older BFF, a run with no
    envelope, a refusal) the proposal was not stored: the UI draws the card
    read-only, saying so, and the browser executes nothing.
    """

    type: Literal["file_operation_proposal"] = "file_operation_proposal"
    title: str = Field(min_length=1, description="Short action title, e.g. 'Vier Dateien in „Einreichung“ verschieben'")
    operation: FileOperationKind = Field(description="Which verb every entry in `operations` is")
    operations: list[FileOperationItem] = Field(
        min_length=1,
        max_length=MAX_FILE_OPERATIONS,
        description="The proposed changes, in the order they will be applied",
    )
    note: str | None = Field(default=None, description="One line of context under the list, when it adds something")
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals). Absent: the proposal was not "
            "stored, and the card is a read-only notice that nothing was proposed"
        ),
    )

    @model_validator(mode="after")
    def _require_operation_fields(self) -> FileOperationProposalCard:
        """Every entry must carry what its verb needs, and nothing it does not.

        The card is built in Python, so this is not a guard against a model —
        it is the guard against a TOOL that grows a fifth caller and forgets a
        field. A row missing its target renders as a proposal to do nothing,
        which the reader would accept.
        """
        required: dict[str, tuple[str, ...]] = {
            "move": ("document", "target_folder"),
            "rename": ("document", "new_display_name"),
            "create_folder": ("folder_name",),
            "assign": ("document", "member"),
        }[self.operation]
        for index, item in enumerate(self.operations):
            missing = [name for name in required if getattr(item, name) is None]
            if missing:
                raise ValueError(f"operation {index} ({self.operation}) is missing {', '.join(missing)}")
        return self
