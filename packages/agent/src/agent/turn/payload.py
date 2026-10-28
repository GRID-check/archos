"""What one user message states about how to answer it.

The chat socket hands the workflow the v2 ``user_message`` itself
(``wire_v2.UserMessage``): its fields are flat and typed, so nothing is parsed
out of the text. ``nat run``, ``nat eval`` and a single-shot HTTP turn hand it
the question as a plain string, which is the whole question and states nothing
else. The turn's intent (the composer's "Asking about <file>" subject) is set
from it here, once per turn, because retrieval reads the same ContextVars.
"""

from dataclasses import dataclass
from typing import Literal
from typing import NamedTuple

from agent.common import parse_data_sources
from agent.common.client_tools import set_turn_client_tools
from agent.common.focus_file import get_focused_file_name
from agent.common.focus_file import get_focused_shelf
from agent.common.focus_file import set_turn_intent
from agent.common.reasoning_settings import set_turn_reasoning_effort
from agent.common.wire_v2 import FocusRegion
from agent.common.wire_v2 import TurnTrigger
from agent.common.wire_v2 import UserMessage


@dataclass(frozen=True)
class SubjectVersion:
    """The document version the composer says this turn is about.

    Additive beside the focused FILE NAME, and a different question from it.
    The name is a retrieval identity — which chunks to prefer — and it is only
    ever as good as the index: a version nobody has published has no chunks at
    all, so the focus filter matches nothing and falls open to the whole corpus
    (``packages/knowledge-layer/src/register.py``). This says WHICH version, by
    id, and what editorial state it is in, so the turn can read the bytes
    instead of hoping the index has them.

    Every field is optional and unvalidated here on purpose: it arrives from a
    client, the BFF re-checks tenancy on the read, and an incomplete triple is
    simply not a subject version.
    """

    document_id: str | None = None
    version_id: str | None = None
    state: str | None = None

    @property
    def is_open(self) -> bool:
        """Whether this names a version retrieval cannot see.

        The open states of the lifecycle (``lifecycle-types.ts``,
        ``OPEN_DOCUMENT_VERSION_STATES``). ``published`` is deliberately NOT a
        membership test that could grow a hole: anything not in this set is
        left to retrieval, which is the behaviour that already works.
        """
        return bool(self.document_id) and bool(self.version_id) and self.state in _OPEN_VERSION_STATES


#: The version states in which a document is still being worked on and therefore
#: has no chunks. Mirrors ``OPEN_DOCUMENT_VERSION_STATES`` in
#: ``apps/workspace/bff/documents/lifecycle-types.ts``; there is no shared
#: schema between the two, exactly as for the source kinds.
_OPEN_VERSION_STATES = frozenset({"draft", "in_review", "changes_requested"})


#: Where a question was asked, as Langfuse slices turns by it (``turn_surface``).
TurnSurface = Literal["chat", "review_canvas", "annotation_thread"]


def thread_reply_requested(message: UserMessage) -> bool:
    """Whether ``message`` asks for its answer in an Anmerkung's thread: the flag AND a region naming the mark."""
    region = message.focus_region
    return bool(message.reply_in_thread) and region is not None and bool(region.annotation_id)


def turn_surface(focus_region: FocusRegion | None, *, reply_in_thread: bool) -> TurnSurface:
    """``annotation_thread`` for a thread reply, ``review_canvas`` for a box, else ``chat``. Pure."""
    if reply_in_thread:
        return "annotation_thread"
    return "review_canvas" if focus_region is not None else "chat"


class TurnInputs(NamedTuple):
    """Everything one user message states about how to answer it.

    The focus fields are read back from the turn ContextVars that
    :func:`extract_turn_inputs` sets — retrieval reads the same vars, so the
    state carries exactly the (normalised) subject retrieval sees.
    """

    query_text: str
    #: None: not stated (a plain question), so every configured tool. A list,
    #: even an empty one, is the composer's selection.
    data_sources: list[str] | None
    focus_file_name: str | None
    focus_shelf: str | None
    #: The subject's open version, or an empty :class:`SubjectVersion`. NOT read
    #: back from a ContextVar like the two fields above it: nothing in retrieval
    #: consumes it, so it never becomes turn-wide state.
    subject: SubjectVersion = SubjectVersion()
    #: The box drawn on a page of the conversation's document, or None. The
    #: prompt names it and tells the model to look at that crop first.
    focus_region: FocusRegion | None = None
    #: Post the answer into the thread of ``focus_region.annotation_id``
    #: (:mod:`agent.turn.annotation_reply`). Only ever True with a region
    #: that names its Anmerkung: the wire flag alone has no thread to answer in.
    reply_in_thread: bool = False
    #: The event that woke this turn when nobody typed it (``wire_v2.TurnTrigger``),
    #: or None. The prompt says who woke it and to answer where it happened.
    trigger: TurnTrigger | None = None
    #: The name the sender stamped on the message (``user_message.author_name``).
    #: A woken turn has no signed-in principal, so this is the only place the
    #: person who woke it is named; the „Woken by“ block reads it.
    author_name: str | None = None

    @property
    def surface(self) -> TurnSurface:
        """Where the question was asked: :func:`turn_surface` of this turn's fields."""
        return turn_surface(self.focus_region, reply_in_thread=self.reply_in_thread)


def extract_turn_inputs(request: UserMessage | str) -> TurnInputs:
    """The inputs a turn is built from, with the turn's intent set for retrieval.

    Always sets the intent: a turn without a subject clears the previous
    turn's, because the ContextVars outlive one turn.

    Raises:
        TypeError: for anything but a ``UserMessage`` or a plain question.
    """
    if isinstance(request, str):
        set_turn_intent()
        set_turn_reasoning_effort(None)
        set_turn_client_tools(None)
        return TurnInputs(request.strip(), None, None, None)
    if not isinstance(request, UserMessage):
        raise TypeError(f"A turn is asked with a v2 user_message or a plain question, not a {type(request).__name__}")
    set_turn_intent(
        file_name=request.focus_file_name,
        shelf=request.focus_shelf,
        source_preset=request.source_preset,
        document_id=request.focus_document_id,
    )
    set_turn_reasoning_effort(request.reasoning_effort)
    # The frontend tools the asking page can run (ADR-0144); a headless sender declares none.
    set_turn_client_tools(request.client_tools)
    subject = SubjectVersion(request.focus_document_id, request.focus_version_id, request.focus_version_state)
    return TurnInputs(
        request.text.strip(),
        parse_data_sources(request.data_sources),
        get_focused_file_name(),
        get_focused_shelf(),
        subject,
        request.focus_region,
        thread_reply_requested(request),
        request.trigger,
        (request.author_name or "").strip() or None,
    )
