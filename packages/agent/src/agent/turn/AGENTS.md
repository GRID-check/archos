# The per-turn harness: `packages/agent/src/agent/turn`

Everything that happens exactly once per chat turn and is **not** the answering
agent: parsing what the request says about the turn, loading its context and
document inventory, binding the per-turn registries, admitting it against
capacity and budget, lifting the finished state onto the wire, streaming it.
`agents/piloti/conversation_register.py` composes these units in that order.

## What belongs here, and what does not

Ask how often it runs. **Once per request, whatever the graph decides** — a
header parse, an inventory load, a registry bind, a refusal — is a unit here.
**Once per step of the conversation, deciding what the turn is** — an escalation
edge, a clarify hop, an answer — is a graph node in `agents/piloti/`.

Each unit is a plain function with an explicit signature, so it can be tested
without standing up the runtime's workflow. That is the point of the package: the
harness used to be one closure, and a field could be written, declared by the
frontend and reach nobody without a single test noticing.

**The dependency runs one way.** `agent_host` hosts this workflow and imports it;
nothing under `agent` imports `agent_host`. What the agent needs from a request
lives in the agent tier and the API tier writes it there: the caller identity
(`auth/request_identity.py`, bound by the middleware), the auth error
(`auth/errors.py`, subclassed by the token errors). An API-tier capability the
agent drives is handed in by its API-tier caller (`oib_sync`'s `enqueue`).
`turn/` also imports no agent state at
runtime — `response.py` and `dispatch.py` type against it under `TYPE_CHECKING`
only.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Need something from `agent_host` | Own the type or state here and let `agent_host` write it, or take the capability as a parameter its API-tier caller passes | The `agent-api-seam` import-linter contract (`pyproject.toml`, run by `task be:lint`), over every module in `agent` |
| Add a wire field or a stage fact | Add it to `TurnResult` (`common/wire_v2.py`), lift it in `response.build_result`, and give it a test that reads it back | Nothing. A field nobody lifts is set, valid, and invisible |
| Add setup I/O to the turn | Gather it with the existing `asyncio.gather` and let it fail open on its own | It lands on the time-to-first-byte path in series |

## Live answer (ADR-0066)

`answer_stream.py` streams the answering call's prose while the model writes
it, as wire bodies through the graph's own writer (`turn_status.emit`, chat wire
v2 §b). The docs of record are
[`docs/design/chat-wire-v2.md`](../../../../../docs/design/chat-wire-v2.md) and
[`docs/design/streaming-chat-answer.md`](../../../../../docs/design/streaming-chat-answer.md).

- **Add the token callback to the call's inherited manager** (`streaming_call`),
  never as the call's own `callbacks`. Those replace the inherited ones, and
  the runtime's profiler, which bills the call, rides on them.
- **Live bodies are provisional.** `RUN_FINISHED` is authoritative, replaces the
  text, and is what the socket persists.
- **A streamed call that turns out to ask for tools was a round, not the
  answer.** It writes `answer_retracted`, `LiveProse.streamed` resets, and a
  later call of the turn may stream again.
- **Deltas are coalesced at the producer**: at most one `TEXT_MESSAGE_CONTENT`
  per `RELAY_WINDOW_S`, and whatever is held goes out before any other body.
- **Work in a token callback heavier than parsing goes off the loop**
  (`asyncio.to_thread`, as `_settle_prose` does). The stream awaits the
  callback, so body order holds.
- **The verifier and the gates stay on the agent side**, behind the `Live`
  protocol (`answer_pipeline.LiveAnswer`). `turn/` does not import them.
- **Every generator in the turn is closed with `contextlib.aclosing`.** `async
  for` never closes what it iterates, so a consumer that walks away would leave
  the graph suspended mid-run past the ledger flush.
- **Everything fails open.** Nothing bound, an LLM that cannot stream, or a
  callback that raises, and the turn is the buffered turn it was.
