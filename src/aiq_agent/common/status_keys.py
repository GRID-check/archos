"""The status keys: stable dotted ids the frontend resolves against its own dictionary.

The frontend owns the words; these own the meaning. Renaming one is a wire change
(``ALL_STATUS_KEYS`` is what the dictionary parity check reads).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


#: ``status.documents.<shelf>`` — which shelf of the reader's own files is
#: being read. The shelf is in the KEY rather than in ``values`` because German
#: needs the dative ("aus der Büroablage") and English needs no article at all:
#: a shelf name cannot be interpolated into one shared template.
KEY_DOCUMENTS_PREFIX = "status.documents."


#: ``status.documents.waiting`` — a file the reader just uploaded is still
#: being indexed and the turn is holding for it. Value-less: the filename is
#: the reader's own word but the line reads the same whichever file it is.
KEY_DOCUMENTS_WAITING = "status.documents.waiting"


#: Retrieval, with and without a query to quote.
KEY_RETRIEVAL_WITH_QUERY = "status.retrieval.withQuery"


KEY_RETRIEVAL_PLAIN = "status.retrieval.plain"


#: A LOCATOR round: the agent already knows which passage it wants and is
#: opening it rather than searching for it ("Liest OIB-Richtlinie 2, Pkt.
#: 3.5.2"). Two keys because German prints a Punkt and a page differently
#: ("Pkt. 3.5.2" vs "S. 12") and English differently again, and a shared
#: template with one slot cannot carry both. The document travels as a VALUE
#: because it is a proper noun — the office's or the publisher's own name for
#: the document, the same word in every locale (rule 1 of the module docstring).
KEY_RETRIEVAL_CLAUSE = "status.retrieval.clause"


KEY_RETRIEVAL_PAGE = "status.retrieval.page"


#: The retrieval loop trying other formulations after judging the first pool
#: insufficient. Value-less on purpose: the alternative queries are the
#: model's words, not the reader's, and the rule above keeps them off the line.
KEY_RETRIEVAL_REQUERY = "status.retrieval.requery"


#: Non-retrieval tools the reader asked for by name.
KEY_ACTION_REMEMBER = "status.action.remember"


KEY_ACTION_CARD = "status.action.card"


#: The conversation's working directory, one key per verb. A file verb is an
#: ACTION and never a retrieval round: nothing is read into evidence, nothing
#: can be cited from it, and "Sucht in Ihren Unterlagen" would say the opposite
#: of what just happened. The reader asked for the document, so the line says
#: which of the four things is happening to it.
KEY_ACTION_DRAFT_LIST = "status.action.draftList"


KEY_ACTION_DRAFT_READ = "status.action.draftRead"


KEY_ACTION_DRAFT_WRITE = "status.action.draftWrite"


KEY_ACTION_DRAFT_EDIT = "status.action.draftEdit"


#: A write-side workspace tool proposing a file operation (`tools/files`). ONE
#: key for all four verbs, unlike the working directory's own four: the reader is
#: about to be shown a card that says exactly which operation on which file, so
#: a line naming the verb a second time would be the card, worse and earlier.
#: What the line has to carry is that nothing is being changed yet.
KEY_ACTION_FILE_PROPOSAL = "status.action.fileProposal"


#: The two things `file_draft` does when a draft leaves the conversation:
#: filing it, and — with `submit=true` — handing it to a reviewer. Their own
#: keys, and not the working directory's four, because what changes is not the
#: draft but WHERE it is: „Entwurf wird geschrieben" while a document is being
#: put into the project would describe the wrong half of what just happened. Filing and
#: submitting are also kept apart, unlike the five proposal verbs that share
#: one key: there the card names the operation a moment later, while here there
#: is nothing else on screen to tell a filing from a handover to a reviewer.
KEY_ACTION_DRAFT_FILED = "status.action.draftFiled"


KEY_ACTION_DRAFT_SUBMITTED = "status.action.draftSubmitted"


#: Handing work over (`create_task`). Its own key rather than one of the two
#: above, because what is happening is not a draft moving: the reader is being
#: told that this turn will NOT produce the answer, and something outside the
#: conversation will.
KEY_ACTION_TASK_CREATED = "status.action.taskCreated"


#: Anmerkungen on a document (`tools/canvas`: `marks`, `mark`, `update`, `delete`,
#: `reply`), one key per act: reading the marks, proposing findings, setting a
#: mark the person asked for, changing one, deleting one, answering in a thread
#: are different things to the reader, and nothing else on screen says which.
#: The proposal line carries that nothing is set yet, as the file proposal does;
#: `mark` with `open` sets, and gets the setting line (:func:`action_key`).
KEY_ACTION_ANNOTATIONS_READ = "status.action.annotationsRead"


KEY_ACTION_ANNOTATIONS_PROPOSE = "status.action.annotationsPropose"


KEY_ACTION_ANNOTATIONS_SET = "status.action.annotationsSet"


KEY_ACTION_ANNOTATIONS_UPDATE = "status.action.annotationsUpdate"


KEY_ACTION_ANNOTATIONS_DELETE = "status.action.annotationsDelete"


KEY_ACTION_ANNOTATIONS_REPLY = "status.action.annotationsReply"


#: Piloti is looking at a page or a box on it (``look``, ADR-0128). Value-less:
#: which document and where is the look's own Herleitung step
#: (:func:`emit_look_step`), not the live line.
KEY_ACTION_LOOK = "status.action.look"


#: A call to the workspace through Piloti's MCP server (``workspace__call``,
#: ADR-0122): a read runs, a write comes back as a proposal. Keyed on the
#: QUALIFIED name, because the basename ``call`` says nothing and another group
#: may own it. Value-less: the operation is an English id, not the reader's
#: words, and the derivation names what was read (``workspace_records``).
#: ``search`` and ``describe`` get no line: they are bookkeeping, like ``look``.
KEY_ACTION_WORKSPACE_CALL = "status.action.workspaceCall"


KEY_CITATIONS = "status.citations"


#: The turn's one bounded repair (ADR-0067): a quotation no passage holds
#: verbatim is being corrected to its passage's wording, in place, with no
#: retrieval and no rewrite. Value-less; the one count, ``quotesFailed``,
#: travels as detail (``emit_answer_repair``).
KEY_REPAIR = "status.repair"


KEY_ESCALATION = "status.escalation"


#: The model stopped calling tools and is writing the answer. Without this the
#: live line keeps showing the last retrieval event through the whole synthesis
#: call — the same stale-label fault the legacy path fixed by never letting a
#: finished step drive the phrase. Value-less: the sentence is the dictionary's.
KEY_SYNTHESIS = "status.synthesis"


#: EVERY key this module can emit, exhaustively. Two tests hang off it: the
#: Python one asserts nothing is emitted that is not in here, and the UI one
#: (``features/chat/lib/turn-events.spec.ts``) reads this tuple out of this
#: file and asserts each id has a German AND an English string. Drift in either
#: direction is a failing build rather than a reader seeing a blank line.
ALL_STATUS_KEYS: tuple[str, ...] = (
    "status.documents.officeShelf",
    "status.documents.project",
    "status.documents.session",
    "status.documents.several",
    "status.documents.waiting",
    "status.retrieval.withQuery",
    "status.retrieval.plain",
    "status.retrieval.clause",
    "status.retrieval.page",
    "status.retrieval.requery",
    "status.action.remember",
    "status.action.card",
    "status.action.draftList",
    "status.action.draftRead",
    "status.action.draftWrite",
    "status.action.draftEdit",
    "status.action.fileProposal",
    "status.action.draftFiled",
    "status.action.draftSubmitted",
    "status.action.taskCreated",
    "status.action.annotationsRead",
    "status.action.annotationsPropose",
    "status.action.annotationsSet",
    "status.action.annotationsUpdate",
    "status.action.annotationsDelete",
    "status.action.annotationsReply",
    "status.action.look",
    "status.action.workspaceCall",
    "status.citations",
    "status.repair",
    "status.escalation",
    "status.synthesis",
)
