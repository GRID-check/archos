"""System-prompt and turn-context assembly for Piloti.

A request to the model is ``[system, *history, turn context, newest human
message, *this turn's tool calls]`` (:func:`request_messages`).

THE SYSTEM PROMPT IS THE STATIC HALF ALONE: the same bytes for every tenant,
every turn and every round, authored and versioned in **Langfuse** and pulled
by :func:`resolve_static_block` through ``common/prompt_store.py``.
``prompts/chat_static.md`` is the BUNDLED FALLBACK for it — what is rendered
when prompt management is off (the default), when the credentials are absent,
when Langfuse is unreachable or when it holds no such prompt. It is allowed to
lag the live version; ``task prompts:pull`` refreshes it.

THE TURN CONTEXT is ``piloti.j2``: the date, the asker, the inventory, what
this conversation already read, the workspace, the project. It is rendered once
per ``run()`` and sent as its own message right before the newest human
message, never appended to the system prompt. Appended there it made every
turn's system message unique, so the provider's prefix cache stopped at the
static half and never reached the history behind it, and a model that keeps
its reasoning across turns saw the instructions change under it. Request-only:
it never enters ``state.messages``, so the transcript the checkpointer stores
carries none of it and the next turn sends only its own.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any
from typing import NamedTuple

from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from agent.common import load_prompt
from agent.common import render_prompt_template
from agent.common.applicability import render_project_block
from agent.common.estate_paths import estate_path
from agent.common.estate_paths import reads_the_estate
from agent.common.norm_registry import parcel_note
from agent.common.page_region_words import percent
from agent.common.page_region_words import where_on_the_page_en
from agent.common.platform_lessons import render_lessons_block
from agent.common.prompt_store import ResolvedPrompt
from agent.common.prompt_store import git_blob_version
from agent.common.prompt_store import prompt_store
from agent.common.prompt_utils import PromptError
from agent.common.question_language import answer_language_line
from agent.common.question_language import question_language
from agent.common.question_language import trace_metadata as question_language_metadata
from agent.common.question_language import warm as warm_language_detector
from agent.common.source_kinds import SHELF_QUALIFIERS
from agent.common.source_kinds import parse_shelf
from agent.common.steering import AppliedSteer
from agent.common.steering import with_steering
from agent.knowledge.already_read import render_already_read_block
from agent.observability.langfuse_trace_attributes import current_fallback_identity
from agent.observability.langfuse_trace_attributes import record_prompt_link
from agent.observability.langfuse_trace_attributes import record_trace_metadata

from .models import ResearchAgentState

logger = logging.getLogger(__name__)

#: This agent's directory; the prompts live beside the code that renders them.
AGENT_DIR = Path(__file__).parent
PROMPTS_DIR = AGENT_DIR / "prompts"
PROMPT_NAME = "piloti"
#: The workspace function group's tools as bound (`workspace__search` …): the
#: WORKSPACE block renders only when one of them is (ADR-0123).
WORKSPACE_TOOL_PREFIX = "workspace__"
#: The bundled fallback for the static half. Langfuse holds the live one.
STATIC_PROMPT_FILE = "chat_static.md"
#: What the live text is called in Langfuse. A wire name: every version in the
#: store and ``scripts/prompts_pull.py`` are keyed on it, so it moves only with
#: a rename in Langfuse itself.
STATIC_PROMPT_NAME = "piloti-system-static"


@functools.cache
def system_prompt_template() -> str:
    """Piloti's turn-context template, read from disk once per process.

    A missing or unreadable prompt raises ``PromptError`` at the first
    construction, which is boot: production must never run on a stub prompt,
    and a typed failure at boot is the only place the fault is cheap.

    The static half is resolved here too, although the return value does not
    carry it. That is deliberate: this function is called once, at boot, so the
    store's first fetch — the only one that can block on the network — is paid
    where nobody is waiting on a turn, and the process starts with the identity
    its traces will name already resolved.
    """
    resolve_static_block()
    # The language detector reads its model here for the same reason: a second
    # of numpy at boot, not on the first turn's event loop.
    warm_language_detector()
    return load_prompt(PROMPTS_DIR, PROMPT_NAME)


@functools.cache
def bundled_static_block() -> ResolvedPrompt:
    """The bundled fallback, with the identity that says it IS the fallback.

    Named by its path and versioned by its git blob hash, so a trace stamped
    with this version names a text an operator can produce with
    ``git cat-file -p <hash>`` — and a fleet running on the bundled prompt is
    visible in the trace list rather than indistinguishable from one serving
    the live Langfuse version.
    """
    path = PROMPTS_DIR / STATIC_PROMPT_FILE
    return ResolvedPrompt(
        text=load_prompt(PROMPTS_DIR, STATIC_PROMPT_FILE),
        name=f"git:{path.relative_to(AGENT_DIR)}",
        version=git_blob_version(path),
        is_fallback=True,
    )


def resolve_static_block() -> ResolvedPrompt:
    """The static half to render with, and the prompt link for this turn's spans.

    The store returns the bundled fallback unless prompt management is on, the
    credentials are present, and Langfuse answered — see
    ``common/prompt_store.py`` for the budget that guarantees a turn never
    waits on it twice.

    Only a Langfuse version becomes a prompt LINK. The bundled fallback names
    no prompt Langfuse holds and is versioned by a git blob hash where the
    ingestion schema wants an int, and a generation carrying that is dropped
    whole. It is recorded as a fallback instead and reaches the trace as
    free-form metadata through :func:`record_static_prompt_metadata`.
    """
    resolved = prompt_store().get(STATIC_PROMPT_NAME, fallback=bundled_static_block())
    if not resolved.is_fallback and not _renders(resolved.text):
        # The store's promise ("never raises into a turn") covers the FETCH.
        # The text it fetched is still a Jinja template one layer up, and a
        # prompt author who pastes a JSON example with ``{{`` into Langfuse
        # would otherwise fail every turn on every replica for as long as the
        # version is published. The bundled file is the floor here too.
        resolved = bundled_static_block()
    # One record for both outcomes: a fallback is recorded AS a fallback, which
    # is no link and is what the trace metadata names; a served version is the
    # link. Recording the fallback rather than clearing is what stops a process
    # that served a version and then fell back from naming it on generations.
    record_prompt_link(name=resolved.name, version=resolved.version, is_fallback=resolved.is_fallback)
    return resolved


async def stamp_static_prompt_for_turn(messages: Sequence[BaseMessage] = ()) -> str:
    """Resolve the static half for THIS turn, then name a fallback and the question's language in its trace.

    Awaited on the event loop at the start of a turn. The resolution runs in a
    worker thread because the store may fetch; the stamp runs on the loop
    because ``asyncio.to_thread`` copies the context, so a ContextVar written
    in the thread dies with it. Resolving first is what makes the stamp this
    turn's: the render that follows hits the store's cache and serves the same
    identity. Never raises: the store never raises into a turn, and
    ``record_trace_metadata`` absorbs its own failures.

    Returns the rendered static half, the system prompt this turn sends, so
    the caller can name it as the provider cache's stable prefix
    (``prompt_caching.begin_stable_prefix``). Rendered here from the same
    resolution, so it cannot differ from what the turn sends; the render is
    cached on the text, so this costs a hash.
    """
    static_text = await asyncio.to_thread(_render_resolved_static_block)
    record_static_prompt_metadata()
    # The question's language and whether the context names it: the call
    # :func:`with_answer_language` makes in the render thread, recorded here on
    # the loop, where a ContextVar write survives.
    record_trace_metadata(**question_language_metadata(question_language(messages)))
    return static_text


def _render_resolved_static_block() -> str:
    return render_static_block(resolve_static_block().text)


def record_static_prompt_metadata() -> None:
    """Name a bundled-fallback render in this turn's trace metadata, on the loop.

    Reads the turn's own record, so a transition another turn makes between
    this turn's resolve and its stamp names nothing here.
    """
    fallback = current_fallback_identity()
    if fallback is None:
        return
    name, version = fallback
    record_trace_metadata(prompt_name=name, prompt_version=version)


@functools.lru_cache(maxsize=4)
def _renders(static_text: str) -> bool:
    """Whether a served text renders as the static half; logged once per text."""
    try:
        render_static_block(static_text)
    except PromptError:
        logger.warning(
            "The static prompt served by the store does not render as a template; "
            "the bundled file serves until the published version is fixed",
            exc_info=True,
        )
        return False
    return True


@functools.lru_cache(maxsize=4)
def render_static_block(static_text: str) -> str:
    """Substitute the one variable the static half carries, once per distinct text.

    The static half is plain text but for ``{{ answer_envelope_schema }}``,
    which ``render_prompt_template`` injects from the models that validate the
    envelope (one source of truth, and no caller can teach an empty schema).
    ``document_inventory`` is passed empty only to skip that injection's work:
    the static half never lists files.

    Cached on the text, so a re-render costs a hash of ~33 KB rather than a
    Jinja pass, and a new Langfuse version re-renders exactly once. The
    trailing newlines come off so that the file's mandatory final newline and a
    Langfuse-stored text that has none produce the same system prompt bytes.
    """
    return render_prompt_template(static_text, document_inventory="").rstrip("\n")


def shelf_label(shelf: str | None) -> str | None:
    """Reader-facing German shelf name for the focused file, or None.

    The prompt names the shelf the same way the inventory block does, so the
    subject line and the inventory cannot disagree about where a file sits.
    An unparseable shelf yields None: the focus line then names the file
    alone rather than inventing a shelf for it.
    """
    if not shelf:
        return None
    parsed = parse_shelf(shelf)
    return SHELF_QUALIFIERS.get(parsed) if parsed is not None else None


def focus_file_path(state: Any, tool_names: Sequence[str]) -> str | None:
    """The estate path of the turn's subject, when the turn reads the estate by path; else None.

    The folder is left out: inside one shelf the leaf names the document, and
    ``read_file`` resolves it wherever it is filed (``knowledge_layer.estate.resolve_in``).
    """
    file_name = getattr(state, "focus_file_name", None)
    shelf = getattr(state, "focus_shelf", None)
    if not file_name or not shelf or not reads_the_estate(tool_names):
        return None
    parsed = parse_shelf(shelf)
    return estate_path(parsed if parsed is not None else shelf, None, file_name)


def focus_region_block(state: Any, tool_names: Sequence[str]) -> str | None:
    """The „Focus region“ section: the box a person drew, and what to do with it. None without one.

    Short: which document, page and box in
    words, then the order of work — look at exactly that crop
    before answering (``look``, bound in every context), and where the canvas
    tools are bound show what the answer refers to, propose findings as marks,
    and answer in the thread when the question was asked there. The model
    decides; nothing is posted for it.
    """
    region = getattr(state, "focus_region", None)
    if region is None:
        return None
    file_name = getattr(state, "focus_file_name", None)
    document = f"of **{file_name}**" if file_name else "of the open document"
    box = f"[{region.x:.3f}, {region.y:.3f}, {region.w:.3f}, {region.h:.3f}]"
    canvas = "canvas__highlight" in tool_names
    target = f'`document="{file_name}"`, ' if file_name else ""
    lines = [
        "## Focus region",
        f"The person drew a frame on page {region.page} {document}: {where_on_the_page_en(region)}, "
        f"about {percent(region.w)} of the page width and {percent(region.h)} of the page height (`region={box}`: "
        "x, y, w, h as shares of the page, origin top left). „Hier“, „das“ and „diese Stelle“ mean this "
        "crop.",
        f"Look at it before you answer: `look` with {target}`page={region.page}` and `region={box}`. "
        "Answer about what lies within the frame, and say so if you need something outside it for that. "
        "If an earlier state is asked about, look at the same crop in that Fassung.",
    ]
    if canvas:
        lines.append(
            "Show with `canvas__highlight` or `canvas__point` what you refer to; you propose findings with "
            "`canvas__mark` as Anmerkungen, the spot read off what you saw. What the person "
            "explicitly asks for, you do in their name: `canvas__mark` with `open=true`, `canvas__update`, "
            "`canvas__delete`."
        )
    if getattr(state, "reply_in_thread", False) and region.annotation_id and canvas:
        lines.append(
            f"You were asked in the thread of the Anmerkung with id `{region.annotation_id}`: answer there with "
            "`canvas__reply` (`annotation` = this id), briefly, understandable on its own "
            "and without source marks, and "
            "give the same answer here."
        )
    lines.append(
        "If the tool shows no image, for instance because this office's model does not read images, say so openly and "
        "do not guess what is inside the frame."
    )
    return "\n".join(lines)


#: What woke a turn, in the words the prompt uses (``wire_v2.TurnTrigger.kind``).
#: English, like everything else the agent reads; „Anmerkung" is the domain's word.
_TRIGGER_EVENTS = {
    "thread_mention": "mentioned you in the thread of an Anmerkung",
    "thread_reply": "replied in the thread of an Anmerkung you started",
    "assigned": "assigned an Anmerkung to you",
    "agent_consult": "asked you through a connected agent (such as Claude or Cursor)",
    "new_document": "uploaded a new document that has just been indexed, and this check was queued for it",
}


def trigger_block(state: Any, tool_names: Sequence[str]) -> str | None:
    """The „Woken by“ section: an event woke this turn, nobody is typing. None for a typed turn.

    A fact block, not a policy: who acted (the verified name the turn runs
    under), what they did, on which Anmerkung, and the outcome to reach, which
    is an answer where it happened (ADR-0060: the prompt states the outcome).
    It also says nobody watches the turn live, because ``ask_user`` refuses on
    such a turn and a question belongs in the thread.
    """
    trigger = getattr(state, "trigger", None)
    if trigger is None:
        return None
    user = getattr(state, "user_info", None) or {}
    who = (user.get("name") or user.get("email") or "A person") if isinstance(user, dict) else "A person"
    lines = [
        "## Woken by",
        f"Nobody typed this question into the chat: {who} {_TRIGGER_EVENTS[trigger.kind]} "
        f"(event `{trigger.event_id}`), and that woke you. Nobody watches this turn live.",
    ]
    if trigger.annotation_id and "canvas__reply" in tool_names:
        lines.append(
            f"Answer where it happened: in the thread of the Anmerkung `{trigger.annotation_id}`, with "
            "`canvas__reply` (`annotation` = this id), short and readable on its own. If you need something, "
            "ask in that thread; do not wait for an answer in this turn."
        )
    else:
        lines.append(
            "Answer so the person finds it where they asked. If you need something, ask in your answer; do not "
            "wait for an answer in this turn."
        )
    return "\n".join(lines)


def oib_applicability(project_context: str | None) -> str | None:
    """Which OIB-Richtlinien this project's own facts make applicable, or None.

    The one part of the old ``## Normenregister`` block that survives the cut:
    the catalog itself was a list of RIS addresses ``ris_lookup`` resolves from
    a free-text question (ADR-0060 (d)), while this section is derived from the
    project's `confirmed:` facts and no tool can produce it from the question.
    Fail-open, because a verdict list is never worth a turn.
    """
    try:
        return render_project_block(project_context or "")
    except Exception:  # noqa: BLE001 — applicability must never break prompt building
        logger.warning("piloti: OIB applicability block failed — omitted", exc_info=True)
        return None


def build_tools_info(tools: Sequence[Any]) -> list[dict[str, str]]:
    """Name + description per tool, the shape the template's tool list reads."""
    return [
        {
            "name": getattr(tool, "name", str(tool)),
            "description": getattr(tool, "description", "No description available"),
        }
        for tool in tools
    ]


class TurnPrompt(NamedTuple):
    """What one turn sends besides the transcript: the system prompt and the turn context."""

    system: str
    context: str


def render_turn_prompt(template: str, state: ResearchAgentState, tools_info: Sequence[dict[str, str]]) -> TurnPrompt:
    """The system prompt (the static half, resolved through the store) and this turn's context."""
    return TurnPrompt(
        system=render_static_block(resolve_static_block().text),
        context=with_answer_language(render_turn_context(template, state, tools_info), state.messages),
    )


def with_answer_language(context: str, messages: Sequence[BaseMessage]) -> str:
    """The turn context, ended by the line naming the question's language when it is confidently not German.

    The context is mostly German and reaches the model as the human-role
    message right before the question, so it outweighed the static rule „write
    in the language of the newest message" (#1336, measured on dev 2026-10-28).
    The line goes after ``</turn_context>``, the last text before the question;
    ``common/question_language.py`` decides whether there is one.
    """
    line = answer_language_line(question_language(messages))
    return context if line is None else f"{context.rstrip()}\n\n{line}"


def request_messages(
    prompt: TurnPrompt,
    history: Sequence[BaseMessage],
    steering: Sequence[AppliedSteer] = (),
) -> list[BaseMessage]:
    """The request for one model call: system, history, turn context, newest human message, this turn. Pure.

    The turn context goes right BEFORE the last human message and is never
    stored, so every round of a turn shares the whole prefix up to and
    including it, and the next turn shares the system prompt and every turn
    before the previous question (that question was sent behind its own
    context, which the next turn no longer carries). A transcript with no
    human message gets it right after the system prompt. Steering notes are
    spliced after it: they arrive while the turn runs, so they index past the
    newest human message, and two messages (system, context) precede the
    transcript they index into.
    """
    newest = next(
        (index for index in range(len(history) - 1, -1, -1) if isinstance(history[index], HumanMessage)),
        0,
    )
    request = [
        SystemMessage(content=prompt.system),
        *history[:newest],
        HumanMessage(content=prompt.context),
        *history[newest:],
    ]
    return with_steering(request, steering, offset=2)


def render_turn_context(
    template: str,
    state: ResearchAgentState,
    tools_info: Sequence[dict[str, str]],
) -> str:
    """Render this turn's context message for one run.

    The date is rendered at DAY precision: research needs the date, not the
    clock, and a stable context keeps the rounds of one turn byte-identical.
    """
    documents = [doc.model_dump() for doc in (state.available_documents or [])]
    tool_names = [str(tool.get("name", "")) for tool in tools_info]
    rendered = render_prompt_template(
        template,
        # Per TENANT. The envelope's `escalate_to_deep` stays in the schema
        # either way: a field described and then refused is one the model can
        # decline out loud. A hand-off that is refused anyway is replaced by a
        # note (`conversation._finalize_answer`), so without this sentence the
        # reader would get the note and no answer.
        deep_research_enabled=state.deep_research_allowed,
        # The turn's signed scope holds a restricted folder's collection
        # (ADR-0087): every door it shuts is refused in code too, and the block
        # says why, in place of the per-tenant one above.
        confined=state.confined,
        # The one sentence about drafting no tool description can carry: what
        # „mach daraus ein File" refers to. Only for a turn that HAS the
        # working directory bound; everything else is in `write_file`,
        # `edit_file` and `file_draft` (ADR-0060 (d)).
        drafting_enabled="write_file" in tool_names,
        user_info=state.user_info,
        current_datetime=datetime.now().strftime("%Y-%m-%d"),
        available_documents=documents,
        # The conversation's "already read" digest, rendered right after the
        # inventory. None renders no section (the template guards it).
        already_read_block=render_already_read_block(state.already_read_digest),
        # Not a document list: the files that are NOT yet in one. The renderer
        # hands it to the inventory block.
        in_flight_documents=state.in_flight_documents,
        project_context=state.project_context,
        platform_lessons=render_lessons_block(state.platform_lessons),
        # The office's own standing instructions. Bounded at the header
        # boundary (``project_context.ORG_INSTRUCTIONS_MAX_CHARS``), so nothing
        # here has to remember a cap.
        org_instructions=state.org_instructions,
        # The office's reference projects: only when the turn can look into
        # them (`project_lookup` bound), else the block promises a door the
        # model does not have.
        reference_projects=state.reference_projects if "project_lookup" in tool_names else None,
        # Who asks, where, and what is open now (ADR-0123): only when the turn
        # can act on it through the workspace tools.
        workspace_block=(
            state.workspace_block if any(name.startswith(WORKSPACE_TOOL_PREFIX) for name in tool_names) else None
        ),
        focus_file_name=state.focus_file_name,
        focus_shelf_label=shelf_label(state.focus_shelf),
        # The path `read_file` opens it by, when the turn reads the estate: a bare „dieses Dokument“
        # then goes straight into the read. A hint, never a filter (ADR-0133 decision 3).
        focus_file_path=focus_file_path(state, tool_names),
        focus_region_block=focus_region_block(state, tool_names),
        trigger_block=trigger_block(state, tool_names),
        oib_applicability=oib_applicability(state.project_context),
        parcel_note=parcel_note(documents),
        # The L1 skills catalog, collated by the register layer; None renders
        # no section.
        skills_block=state.skills_block,
        # The shapes of the cards this turn is likely to earn (ADR-0064),
        # beyond the shapes the envelope teaches (ENVELOPE_SHAPE_TYPES).
        card_shapes_block=state.card_shapes_block,
    )
    if os.environ.get("DEBUG_PROMPTS"):
        logger.debug("Rendered turn context:\n%s", rendered)
    return rendered
