---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering; the product owner approved the generative-UI plan whose slice 4 this is
consulted: AG-UI 1.0 (`@ag-ui/core` 1.0.3 type definitions, read 2026-10-27; docs.ag-ui.com/concepts/interrupts and /concepts/events, undated, read 2026-10-27); LangGraph 1.2.16 source and two probes run against it; ADR-0068, ADR-0080, ADR-0107, ADR-0132, ADR-0135
informed: everyone working on the chat wire, the turn, `ask_user`, the clarifier and the chat UI
---

# A turn that needs the person pauses, and a new run resumes it: LangGraph `interrupt()` with the checkpointer, as AG-UI 1.0's interrupt outcome

## Context and Problem Statement

When Piloti needs the person mid-turn (`ask_user`, the clarifier's question
and its plan approval), the turn **waits with the run open**. The tool calls
NAT's `prompt_user_input`; the chat socket's `RunningTurn.ask` sends
`CUSTOM interaction_request`, parks a future, and the graph's coroutine sits
on it until `interaction_response` arrives or
`GRID_HITL_RESPONSE_TIMEOUT_SECONDS` (default 1800 s) passes and the turn ends
with `RUN_ERROR{interaction_expired}`. ADR-0068 kept that path and left
"LangGraph `interrupt()` + `Command(resume=…)`" for its own ADR. This is it.

What an open wait costs, read from the code on 2026-10-27:

- **It lives in one process.** The answer is relayed over the conversation bus
  to the replica that owns the task (ADR-0080), but the task itself dies with
  its pod. A deploy, a crash or a scale-in during the wait loses the turn, and
  the drain (`GRID_CHAT_DRAIN_SECONDS`, 2700 s) is sized to wait out such a turn
  before it cancels it.
- **It holds a turn's admission slot** (ADR-0040, `GRID_MAX_ACTIVE_TURNS`) for
  as long as the person thinks, up to 30 minutes, and NAT's own concurrency
  gate had to be switched off because it held its slot the same way
  (`aiq_api/plugin.py`, `_create_chat_session_manager`).
- **It cannot outlive the socket's patience.** Thirty minutes is a compromise
  between "somebody checks a drawing" and "a pinned task"; a question asked on
  Friday cannot be answered on Monday.
- **A headless turn cannot ask at all** (`ask_user` refuses on `X-Grid-Mode:
  headless`), because nobody holds a socket to answer it.

The standard has since named this. **AG-UI 1.0** (released 2026-09-17) makes
a pause a *run outcome*, not an event: `RUN_FINISHED.outcome = {type:
"interrupt", interrupts: Interrupt[]}`, each `Interrupt` with `id`, `reason`,
`message?`, `toolCallId?`, `responseSchema?`, `expiresAt?`,
`subagentRunId?`. The client resumes by **starting a new run on the same
thread** whose `RunAgentInput.resume[]` answers every open interrupt
(`{interruptId, status: "resolved" | "cancelled", payload?}`); partial resumes
are not supported, a resume must be safe to replay, and "framework-native
checkpointing is an implementation optimization, not a protocol contract". A
subagent that pauses ends its segment with `SUBAGENT_FINISHED{outcome:
{type: "suspended", interruptIds}}`. Wire v2 already speaks AG-UI's names
(ADR-0068) and, since this slice, its subagent events; its HITL is the one
place it still has its own shape.

Two facts about the substrate, measured on LangGraph 1.2.16 with a probe that
mirrors Piloti's shape (an outer graph compiled with a checkpointer whose node
calls, through a plain async function, an inner graph compiled with
`compile()`, as `agents/piloti/agent.py:1163` does):

1. **Piloti's inner graph already writes into the outer saver.** A graph
   compiled without a checkpointer, invoked inside a node of one that has one,
   inherits it and checkpoints under the namespace `shallow_research:<task>`.
   One plain turn of the probe wrote 3 root checkpoints and **4 inner ones**.
   Nobody chose this: the conversation graph streams with LangGraph's default
   `durability="async"`, so every superstep of every turn is persisted twice
   over, and the inner state carries the whole turn's messages.
2. **That accident is what makes `interrupt()` work through the NAT
   boundary.** An `interrupt()` raised in the inner graph bubbled out of the
   outer `ainvoke` as `__interrupt__` with a stable id; `aget_state` showed the
   pending task; `Command(resume=…)` re-entered the outer node from its top
   while the inner graph resumed at the interrupted node, not at its first.
   With `durability="exit"` the same plain turn wrote **1** root checkpoint and
   no inner one, the interrupted turn 1 + 1, and the resume still worked.

The loop is moving. The product owner has decided that Piloti's two-node
`StateGraph` loop is ported to LangChain's `create_agent` (ADR-0135 recorded it
as option C, then out of scope; no ADR for the port exists as of 2026-10-27).
`create_agent` (langchain 1.4.7 here) ships a
`HumanInTheLoopMiddleware` built on `interrupt()`. So the question is not only
which pause we want, but which one to build first on the new loop, so that
nothing is built twice.

## Decision Drivers

* A question the person has not answered yet survives a deploy, a reload, a
  second device and a weekend.
* A waiting turn costs a database row, not a process, a socket or an
  admission slot.
* AG-UI 1.0's names and shapes, as for every other wire v2 event, so any
  AG-UI client can follow a paused turn and the S7 egress adapter stays a
  translation.
* Buy, don't build: the pause and the resume are LangGraph's, the vocabulary
  AG-UI's; what we own is the authorization of who may answer.
* Built once, on the `create_agent` loop, not retrofitted onto the
  `StateGraph` loop that is being replaced.
* Nothing the reader saw is lost: the Herleitung and partial work of the
  paused run stay visible while it waits and after it resumes.

## Considered Options

* **A. Keep the run open (today), renamed to AG-UI.** `interaction_request`
  stays, a `CUSTOM` that AG-UI does not have; only the names move.
* **B. AG-UI's interrupt outcome over a record of our own, no LangGraph
  pause.** The turn ends `RUN_FINISHED{interrupt}`; we store the question; the
  resume is a new turn that replays the transcript with the answer appended
  as a tool result, and the model runs the turn's remaining rounds again.
* **C. LangGraph `interrupt()` with the checkpointer, surfaced as AG-UI's
  interrupt outcome and resumed by a new run with `resume[]`.** The graph
  pauses where it stands, LangGraph persists the pending task, the turn ends,
  and the resume run hands LangGraph `Command(resume={interrupt_id: payload})`.
* **D. NAT 1.9 `HITLMiddleware`.** A prompt before or after a NAT function,
  on the same `prompt_user_input` path.

## Decision Outcome

Chosen option: **C**, built in the slices below **directly after the
`create_agent` port lands**, with `ask_user` as its first producer.

C is the only option that meets the first two drivers: the pause is a
checkpoint, so it outlives the process, holds no slot and can wait days. It
is what AG-UI describes and what `create_agent`'s own
`HumanInTheLoopMiddleware` does, so the port and the pause share one
mechanism. B rebuilds LangGraph's resume by hand and pays for it in tokens
and in a model that may decide differently the second time. A and D keep the
open run, which is the cost this ADR exists to remove.

### What it means concretely

1. **A pause is a checkpoint, written on purpose.** The chat turn's root run
   streams with `durability="exit"`: LangGraph writes the turn's checkpoint
   when the graph ends or pauses, and nothing per superstep. That replaces the
   accidental per-step inner writes (fact 1) with exactly the one write a pause
   needs (fact 2). The inner agent keeps inheriting the outer saver; a test
   pins the namespaces, so the inheritance is no longer an accident.
2. **The producers call `interrupt()`.** `ask_user` becomes a tool whose body
   is `interrupt({"question", "options"}, response_schema=…)`; the clarifier's
   question and plan approval become `interrupt()` calls in its node. The
   value is typed data the wire maps; LangGraph's interrupt id is the wire's
   `interrupt_id`.
3. **The turn ends with AG-UI's interrupt outcome.** `RUN_FINISHED{outcome:
   "interrupt", interrupts: [...], result}`. The result is what the turn has
   so far (steps, cards, sources, no final text) and is persisted like any
   terminal, so a reload, a second tab and an observer read the same paused
   row from the server.
4. **A new run resumes it.** The client sends `resume{message_id,
   interrupted_turn_id, resume: [{interrupt_id, status, payload?}]}`. The
   socket checks that the sender may answer (the asker, as today), that every
   open interrupt is addressed and none has expired, then runs the
   conversation graph with `Command(resume={id: payload})` under the new
   turn id. The resumed run is an ordinary turn on the wire from `RUN_STARTED`
   to its terminal.
5. **A new question on a paused conversation cancels the pause** the AG-UI
   way: the client sends the open interrupts as `status: "cancelled"` with
   it, and the graph resumes into a "the person moved on" answer for each
   (`ask_user` reads it as a decline). A `user_message` without them on a
   paused conversation is refused (`rejected{paused}`), never silently merged.

### Implementation plan

Each slice ships and is measured alone, in this order. S0 may start before
the `create_agent` port; S1 onwards build on it.

| Slice | What ships | Measure / exit |
|---|---|---|
| **S0 · Make the checkpoint deliberate** | `durability="exit"` on the chat turn's `astream` (`agents/piloti/conversation.py`). A test through the compiled conversation graph that counts checkpoints by namespace for one plain turn (expect root only) and for an interrupted one (root + one inner). A test that an `interrupt()` raised two NAT function boundaries deep (Piloti's NAT function, then a tool) reaches the root as `__interrupt__` and is not wrapped, retried or logged as a tool error by NAT, `nat_step_repair` or the deep researcher's retry middleware. | Checkpoint rows per turn before and after, from the dev database (`checkpoints`, `checkpoint_writes`, `checkpoint_blobs`), recorded in the PR. `task be:eval:answer-suite` unchanged (the write path is off the answer path) |
| **S1 · The contract, reader first** | `wire_v2.py`: `RunFinishedBody.outcome` gains `"interrupt"` and `interrupts: list[Interrupt]` (`interrupt_id`, `reason`, `message`, `input: text | choice`, `options`, `tool_call_id?`, `response_schema?`, `expires_at`, `subagent_run_id?`); `SubagentFinishedBody.outcome` gains `{type: "suspended", interrupt_ids}`; client message `resume`; `rejected.code` gains `paused`, `interrupt_expired`, `interrupt_unanswered`; hello `accepts: resume`. The UI bundle that reads them ships **one release before** the server writes them, behind a server flag, because a new `outcome` value is a known event whose value an older tab cannot parse (chat-wire-v2.md, Compatibility). Fixture `turn-interrupted.jsonl` and `turn-resumed.jsonl`. | Both contract suites; `newer-events.jsonl` gains the interrupt terminal so the lenient read is proven before the flag flips |
| **S2 · `ask_user` pauses** (after the port) | `ask_user`'s body becomes `interrupt()`. `AskUserGuard` goes: "one question per turn" is the interrupt id's uniqueness, "already pending" is the paused state of the thread. The headless refusal stays (nobody will answer), but its reason changes from "nobody holds a socket" to "nobody was asked". The per-turn ContextVar registries a tool reads after a resume (`cards/registry.py`, `common/citation_verification.py`'s `SourceRegistry`, the round ledger) are rebuilt from the checkpointed state at the top of the resumed run, because the resumed node re-enters from its top in a new task, possibly on another replica. | A turn test through the real graph: round 1 searches, `ask_user` pauses, the process is replaced (a new graph over the same saver), the resume continues at round 2 with round 1's sources still cited. The HITL eval in the answer suite |
| **S3 · The socket ends and resumes runs** | `chat_socket.py`: a `GraphInterrupt` out of the stream becomes `RUN_FINISHED{interrupt}`, persisted. `on_resume` authorizes (asker only, as `cancel_turn` and `steer`), validates completeness, expiry and idempotency (`(conversation, interrupt_id, status, payload)` replayed twice runs once), and starts the run. `RunningTurn.ask`, the HITL futures, the bus's `HITL_ANSWER`, `interaction_request`, `interaction_resolved` and `interaction_response` are deleted once the clarifier has moved too (S4). | `test_chat_socket.py`: pause, reload, resume from a second socket on another replica; a colleague's resume is `rejected{not_asker}`; an expired one `interrupt_expired`; a duplicate is a no-op |
| **S4 · The clarifier pauses** | The clarifier's question and the plan approval call `interrupt()`; `common/human_prompt.py` and the NAT HITL models leave `aiq_api`. | The clarifier specs through the graph; L14 below |
| **S5 · The UI reads a pause** | `turn-fold.ts` folds `outcome: "interrupt"` into a paused view (the prompt from `interrupts`, a reload shows it from the stored row); the composer sends `resume`, and a question typed while paused carries the cancelled entries. `AgentPrompt` reads `interrupts` instead of `interaction`. The `interaction_*` fold and its socket handling in `use-websocket-chat.ts` go. | Specs per lifecycle row below; a `/dev/turn-outcomes?scenario=paused` and `resumed` |
| **S6 · Longer waits** | With nothing held open, `GRID_HITL_RESPONSE_TIMEOUT_SECONDS` stops being a process budget and becomes a product choice for `expires_at` (proposal: a working week). The checkpoint retention job (`aiq_api/jobs/checkpoint_retention.py`) keeps a paused thread at least until its interrupt expires. | Retention spec: a paused thread older than the window but not yet expired is kept |

### What changes on the wire

| Today | After S3 / S4 |
|---|---|
| `CUSTOM interaction_request {interaction_id, input, text, options, placeholder, expires_at}` mid-run | `RUN_FINISHED {outcome: "interrupt", interrupts: [{interrupt_id, reason, message, input, options, response_schema?, tool_call_id?, expires_at, subagent_run_id?}], result}`, the run's last event |
| `CUSTOM interaction_resolved {interaction_id, outcome}` | gone: the next run's `RUN_STARTED` (`resumes_turn_id`) or the cancelled entries say it |
| client `interaction_response {turn_id, interaction_id, answer}` | client `resume {message_id, interrupted_turn_id, resume: [{interrupt_id, status: resolved \| cancelled, payload?}]}` (AG-UI's `ResumeEntry`, snake case); counted as a turn by the gateway's limiter (`lib/limits/ws-frames.js` gains the type) |
| `RUN_ERROR {code: interaction_expired}` after 30 min of an open run | the paused row simply stays; a late resume is `rejected{interrupt_expired}` and the composer offers the question again |
| — | `SUBAGENT_FINISHED {outcome: {type: "suspended", interrupt_ids}}` for a subagent that paused (none today) |
| — | `rejected.code`: `paused`, `interrupt_expired`, `interrupt_unanswered`; hello `accepts`: `resume` |

Wire v2 keeps its flat string `outcome` and lists `interrupts` beside it,
rather than AG-UI's nested `{type, interrupts}`: the other outcomes are
already strings and the S7 egress adapter maps both in one line. `expires_at`
stays epoch milliseconds like every wire v2 time; AG-UI's ISO string is the
adapter's.

### What changes in the lifecycle matrix (`docs/design/lifecycles/chat-turn.md`)

- **P8 terminal** gains the `interrupt` outcome; a new phase **P8a paused**:
  the header reads „Wartet auf Sie“ with a still glyph (no spinner: nothing
  runs), the prompt row is the one home of the options, the composer shows
  Send, and the timer freezes on the time worked.
- **L13 choice prompt** and **L14 plan approval** are rewritten: the prompt
  arrives with the terminal, not mid-stream; the pick starts a resumed run
  whose question row is not drawn (the answer is the prompt card's receipt),
  and its Herleitung continues under the paused one.
- **New edges:** reload while paused (the stored row shows the prompt, no
  `attach`); a deploy while paused (nothing happens); answered from a second
  device; a new question while paused (the open interrupts are cancelled, said
  in the receipt); the question expired; Stop while paused (not offered:
  nothing runs; the prompt's own „Überspringen“ resolves it); an observer
  while paused (sees the prompt read-only, as L29); a headless turn (still
  refuses, L44).
- **Events:** E12, E13, E14 are replaced by `RUN_FINISHED interrupt` and the
  resumed run's `RUN_STARTED`; E15 (heartbeat) stops during a wait, because
  nothing runs.

### Consequences

* Good, because a pending question costs one checkpoint row: no task, no
  socket, no admission slot, no drain budget, and it survives a deploy.
* Good, because the conversation graph stops writing a checkpoint per
  superstep twice over (fact 1), which is a write cost every turn pays today.
* Good, because `ask_user` loses its process-wide guard, the HITL futures,
  the bus relay of answers and NAT's HITL models; HITL is one mechanism with
  the tool-approval middleware `create_agent` brings.
* Good, because a paused turn is an AG-UI paused run, so the planned egress
  adapter (generative-UI plan S7) carries it with no special case.
* Bad, because a resumed node re-enters from its top. A tool that ran before
  the `interrupt()` in the same node runs again, and per-turn ContextVar state
  does not survive. S2 rebuilds the registries from state, and the premise
  that `create_agent` runs each tool call as its own task (so a sibling call
  that finished before the pause is not re-run) is checked by S0's test, not
  assumed.
* Bad, because `durability="exit"` gives up crash recovery inside a turn.
  Nothing uses it today: a turn that dies is asked again, never resumed from a
  checkpoint. A deep-research **job** keeps `durability="async"` (its own
  graph, ADR-0018), which this ADR does not touch.
* Bad, because the paused answer and the resumed answer are two rows of the
  thread, where today they are one bubble. The reader sees the prompt, its
  receipt and the answer under it, which is honest, but the projection must
  draw them as one turn's continuation (S5).
* Bad, because a new `outcome` value is not additive for an open tab: S1
  ships the reader a release ahead and flags the writer, the same staging
  `GRID_WIRE_V2_ADDITIVE_FIELDS` needed.
* Neutral, because steering (ADR-0107) is unaffected: a paused turn has no
  running round to steer, and a note typed while paused is a new question
  (point 5).

### Confirmation

* S0's checkpoint-namespace test and the NAT-boundary interrupt test.
* The wire contract suites with `turn-interrupted.jsonl` and
  `turn-resumed.jsonl`; `test_a_turn_still_ends_only_on_the_terminals_old_tabs_know`
  keeps `RUN_FINISHED` the only non-error terminal, so a pause can never become
  an event an old tab waits on.
* Once S3 lands, a test that no module under `src/` or `frontends/aiq_api`
  calls `prompt_user_input`, and a ruff `banned-api` for
  `nat.data_models.interactive`, so the open-run path cannot come back.
* Until S0 lands, nothing enforces any of this; review is the only gate.

## Pros and Cons of the Options

### A. Keep the run open, renamed

* Good, because it works today and changes nothing.
* Bad, because every cost in the Context stays, and AG-UI has no event to
  rename `interaction_request` to: the standard models a pause as the end of a
  run, so A would be wire v2's one non-standard HITL shape forever. The
  premise: AG-UI 1.0 (`@ag-ui/core` 1.0.3) has no mid-run input-request event.

### B. AG-UI's outcome over our own record, replaying the turn

* Good, because it needs no checkpointer and no LangGraph semantics.
* Bad, because the resume re-runs the model over the transcript: the rounds
  before the question are paid again in tokens and seconds (each decision is
  about 5.7 s, `turn-latency-measured-2026-09.md`), and the model may choose a
  different path than the one the person was asked about. The premise: the
  checkpointer the conversation graph already has does not carry a resumable
  task. Fact 2 measured that it does.

### C. LangGraph `interrupt()` with the checkpointer, as AG-UI's outcome

* Good, because the pause, the pending task and the resume are LangGraph's,
  and the inheritance that makes them work through the NAT boundary was
  measured, not assumed.
* Good, because `create_agent`'s `HumanInTheLoopMiddleware` is the same
  mechanism, so tool approval later is configuration.
* Bad, because node re-entry and lost ContextVar state are real costs (see
  Consequences), and S0 must prove NAT passes `GraphInterrupt` through intact.

### D. NAT `HITLMiddleware`

* Good, because it is configuration on a path we already run.
* Bad, because it is option A for one more caller: the run stays open on
  `prompt_user_input`. The premise: NAT 1.9's `HITLMiddleware` prompts through
  `user_input_callback` (chat-wire-v2.md, "NAT 1.9 in the cut").

## More Information

- The probes behind facts 1 and 2 are a 70-line script: an outer
  `StateGraph` with `InMemorySaver`, one node calling an inner graph compiled
  without a checkpointer through a plain async function with its own
  `configurable`, run plain and with an `interrupt()` in the inner second
  node, under `durability="async"` and `"exit"`, counting
  `saver.list(None)` by `checkpoint_ns`. S0 turns it into the committed test
  over the real graph; until then the figures are the probe's, not
  production's.
- AG-UI's `Interrupt.responseSchema` maps to LangGraph 1.2's
  `interrupt(value, response_schema=…)`, which already carries one.
- Related: ADR-0068 (the open question), ADR-0080 (the bus that relays answers
  today), ADR-0107 (steering), ADR-0132 (the Herleitung the paused run keeps),
  [`chat-wire-v2.md`](../design/chat-wire-v2.md) (the wire, its subagent
  events), [`lifecycles/chat-turn.md`](../design/lifecycles/chat-turn.md).
