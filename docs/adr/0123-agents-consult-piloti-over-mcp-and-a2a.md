---
status: accepted
date: 2026-10-21
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Agents consult Piloti: an ask over MCP, and an A2A server on the same primitive

## Context and Problem Statement

Since ADR-0121 an agent acting for a person (Claude, Cursor, ChatGPT) can do in
Piloti everything that person can do, through one MCP server. It could not do
what a colleague does most: ask Piloti. Piloti answers from the office's
documents, the project's files and building law, with retrieval and tools no
operation exposes one by one. PostHog makes its in-product agent callable the
same way, and that is the reference here.

Agents that speak the Agent2Agent protocol (A2A) rather than MCP have no door at
all. A2A is the standard for one agent delegating work to another, with a task
that has a lifecycle, a context that groups tasks, and artifacts as results.

How does an external agent consult Piloti, as the person it acts for, without a
second gate, without a loop of Piloti asking itself, and on whose budget?

## Decision Drivers

* The answer is Piloti's: the same turn, prompt, tools, retrieval and traces as a
  typed question, run as the person, with their rights of today.
* Budget: an ask is a model turn nobody typed. It is paid from the person's and
  the organization's LLM budget, and the organization switches it on.
* No recursion: a turn an ask started cannot start another, and Piloti's own door
  cannot ask Piloti.
* One gate (ADR-0055, ADR-0121): a capability is one route; every door is a
  client of it.
* Standards first: MCP for agents, A2A for agent-to-agent work, its vocabulary
  (task, context, message, part, artifact), and its official SDK if it fits.
* An MCP client holds a tool call for a while, not for minutes.

## Considered Options

1. **An MCP operation over the ADR-0106 headless turn, plus an A2A server that
   calls the same routes** (chosen).
2. **A Python tool or a backend endpoint that runs the agent graph directly**,
   bypassing the chat socket.
3. **A2A only**, and no MCP operation.
4. **The A2A task as a `task_runs` row** (the Aufgaben lane, ADR-0051) instead of
   a table of asks.

## Decision Outcome

Chosen option: **1**.

### The ask

`POST /api/piloti-asks` asks Piloti a question as the session's person;
`GET /api/piloti-asks/[id]?waitSeconds=` polls; `POST /api/piloti-asks/[id]/cancel`
stops it. The operations are `piloti-ask-create`, `piloti-ask-get` and
`piloti-ask-cancel` in `lib/agent-api/catalog/consult.ts`, in the `conversations`
domain, because an ask is a conversation.

`lib/piloti-asks/service.ts`:

1. The organization's switch, `piloti-ask` (an entitlement, off by default).
2. The thread: a new private conversation of the person, in the project they
   name (`requireProjectAccess` with the chat permissions), or one an earlier ask
   of the same person started, never another conversation.
3. A row in `piloti_asks` (migration 0177) and the question as the person's
   message in the thread, both under one id: the ask's id is the turn id and the
   A2A task id.
4. `resolveTurnContext` for that session and thread, which refuses a spent
   budget, then `runHeadlessTurn` (ADR-0106): the chat socket opened as an
   internal caller with the signed envelope and `X-AIQ-Mode: headless`, one
   `user_message` with `trigger: { kind: 'agent_consult', event_id: <ask id> }`
   and `if_idle`.
5. The chat socket posts every headless turn's outcome to
   `/api/internal/turns/outcome`. A turn that is not a wake is looked up as an
   ask there and ends it (`recordAskOutcome`), on whichever replica.
6. The request waits up to 40 seconds (`ASK_WAIT_SECONDS`; `waitSeconds` in the
   body asks for less, 0 for none) by reading the row. An ask that ended answers
   200 with the answer, which is the message the turn wrote, read by the id the
   agent derives (`answer_message_id`); one still running answers 202 and the
   agent polls.

An ask whose turn never started (a spent budget, a busy thread, a server that
refused it, a deployment with no chat service) ends `rejected` or `failed` with
the reason and takes back what it wrote: the question, and the thread when the
ask opened it (its row goes with it, so a later read of the id is a 404). A
throw while starting ends it `failed` too, never a 500 that leaves it
`submitted`. A cancel ends a `submitted` ask before it sends the stop, and the
start reads the row again before it sends the turn, so a cancel that lands
first sends none; a turn sent while the ask was canceled is stopped. A cancel
the server took answers `canceled` within five seconds even when the turn's own
notice is late. An ask still open after `GRID_PILOTI_ASK_MAX_SECONDS` (30
minutes) is ended `failed` when it is next read: its outcome notice was lost.

The states are the A2A task states, lowercase: `submitted`, `working`,
`completed`, `canceled`, `failed`, `rejected`. `input-required` does not occur,
because `ask_user` refuses on a headless turn.

### The recursion lock

* In-product Piloti never runs a write through the agent door; it files a
  proposal (ADR-0121). `lib/proposals/operation-applier.ts` refuses to file or
  apply any operation in `PILOTI_ASK_OPERATIONS`, so neither a typed turn nor a
  turn an ask started can ask Piloti again. The model reads the refusal.
* The A2A door refuses Piloti's own credential (the internal token with the
  turn's envelope) with 403.
* In-product Piloti does not see the three operations (`canSee` in
  `lib/agent-api/policy.ts`), so it cannot name one, nor run `piloti-ask-get`,
  which as a read would otherwise run without a proposal.

### Budget and limits

An ask is a turn, so the turn's own budget gates it: `resolveTurnContext`
refuses a spent person, project or organization budget before the socket opens
(the ask ends `rejected` with the reason), and the backend's tracker stops a
runaway turn. The route charges `chat-turn` (`lib/limits/rules.js`), the rule a
typed turn pays at the socket. The doors charge `mcp-request` once per request.

### The A2A server

`POST /api/a2a` is a JSON-RPC A2A server; the agent card is at
`/.well-known/agent-card.json`. The specification's current release is 1.0
(PascalCase methods: `SendMessage`, `SendStreamingMessage`, `GetTask`,
`CancelTask`, `SubscribeToTask`; enum names such as `TASK_STATE_COMPLETED`). A
request without `A2A-Version` is 0.3 by specification, and is served with the
0.3 methods (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
`tasks/resubscribe`). Push notifications, `ListTasks` and the extended card are
refused with their A2A errors.

| A2A | Piloti |
|---|---|
| Task | the `piloti_asks` row; `Task.id` is the ask's id |
| `contextId` | the conversation the ask ran in; send it back to follow up. One the client made up, or one no ask of the person started, starts a new conversation, and the task carries its id |
| `TaskState` | the ask's state, the same word |
| Message (user) | the question, the person's message in the thread |
| Message (agent) | Piloti's answer, its message in the thread |
| Artifact `answer` | the answer's text, `artifactId` the answer's message id |
| Artifact per document | a document Piloti filed in the thread while answering, as a data part naming it |
| `message.metadata.projectId` | the project to ask in (A2A has no field for it) |

A non-blocking `SendMessage` (`returnImmediately`; in 0.3, `blocking: false`)
and a stream ask with `waitSeconds: 0`, so the task comes back at once; a
stream of an ask that ended at once is one event, the whole task with its
artifacts. The ask routes run with the agent as reader, so a refusal reaches
the client in English. A body that is not JSON is the JSON-RPC parse error
(-32700), checked before the SDK, whose transport would answer -32602.

**The SDK.** `@a2a-js/sdk` 1.3.0, the official JavaScript SDK of the A2A
project, implements 1.0 with a 0.3 compatibility layer. We use its types and
codecs, `JsonRpcTransportHandler` and `LegacyJsonRpcTransportHandler` (parsing,
method dispatch, the error codes, the 1.0 and 0.3 serializations) and its SSE
formatting, and implement its `A2ARequestHandler` interface ourselves. We do not
use its `DefaultRequestHandler`, `AgentExecutor` or task stores: they run the
agent in the process that took the request and keep the task in a store of their
own, while our turn runs on the agent tier, reports its end to any replica, and
the task already has a home, the ask's row. Its server dependencies are `jose`,
which we ship; express is an optional peer it needs only for its own routers,
which we do not use.

**Not a second path.** `PilotiA2ARequestHandler` calls the ask routes through
`callOperation`, the dispatcher the MCP door and accepted proposals use, as the
person. The route's `authz`, its rate limit, its body schema, the switch and the
budget apply to an A2A client exactly as to an MCP client.

**Authentication.** The A2A door authenticates exactly as `/api/mcp`
(`resolvePrincipal`): a WorkOS AuthKit bearer token, the organization's
`agent-mcp` flag, the person's live membership. `/api/a2a` is a protected
resource of its own (RFC 8707): its metadata is at
`/.well-known/oauth-protected-resource/api/a2a` (RFC 9728), and its 401
challenge points there. Each door accepts a token issued for either resource
(`acceptedAudiences` in `lib/agent-api/mcp-config.ts`), because both are this
server and act as the same person with the same rights; a token for any other
audience is refused. The agent card names the OAuth scheme (authorization code
with PKCE at AuthKit) and tells the client to ask for the token for `/api/a2a`.
WorkOS must know `/api/a2a` as a resource indicator for it to issue such a
token (`docs/architecture/agent-surface.md`, connecting a client).

**Streaming** comes cheap with the SDK's transport, so it is on: the stream opens
with the task, sends a status update for each change of state, then the
artifacts and the final status. It polls the ask route, as `GetTask` does, so it
needs no channel between replicas.

### Why the row, not a task run

A `task_runs` row is work the job worker runs, with a run ledger, a schedule and
a run block in the conversation (ADR-0051, ADR-0062). An ask is a chat turn: it
runs on the chat socket, as a wake does, and its record needs only the state and
the reason. Reusing `task_runs` would give every ask a run block it does not have
and tie the A2A task's lifecycle to the job worker's. The ask's row is the A2A
task, and an ask that hands off to a research run (`handed_off`) completes with
the turn's message, which links the run.

### Observability

The ask is a turn, so it has its Langfuse trace like every turn, with
`turn_trigger: agent_consult` and the ask's id as `trigger_event_id`, and the tag
`trigger:agent_consult` (`record_turn_trigger`). The BFF makes no model call of
its own. The MCP door's calls are `agent_operation_called` in PostHog and an
`agent-tool-call` trace in Langfuse (ADR-0121); so is each A2A method, door
`a2a`, its observation `a2a.<operation>`.

### Consequences

* Good, because an external agent gets Piloti's own answer, with the person's
  rights, on the person's budget, and the person can open the thread in Piloti
  and read what was asked in their name.
* Good, because the A2A server is a client of the same route as the MCP
  operation: one gate, one schema, one switch.
* Good, because the A2A vocabulary maps onto ours without a translation table:
  the ask's states are A2A's words.
* Bad, because the asking request holds a connection for up to 40 seconds, and a
  blocking A2A `SendMessage` for up to five minutes. Both poll the database once
  every 750 ms while they wait.
* Bad, because an ask whose turn never reports its end (a lost outcome notice)
  reads `working` for up to thirty minutes, and is ended only when somebody
  reads it after that; nothing sweeps the table.
* Bad, because an A2A client that cannot send a `resource` parameter at all
  gets a token with no audience of ours and is refused.
* Neutral: legacy 0.3 clients that read the agent card in its 0.3 shape find a
  1.0 card; the SDK's card translation is internal to its express router.

### Confirmation

* `lib/piloti-asks/service.spec.ts`: the switch, the thread rules, the turn's
  message (`agent_consult`, `if_idle`, the envelope), every way an ask ends
  without a turn, the wait, the answer id (checked against the Python
  derivation), only the asker reads or stops an ask, the outcome mapping.
* `lib/piloti-asks/recursion-lock.spec.ts`: the lock names the catalog's ask
  operations, and refuses to file or apply each.
* `app/api/a2a/route.spec.ts`: the round trip through the SDK, the dispatcher
  and the real ask routes; Piloti's credential refused; 1.0 and 0.3; the errors;
  the stream.
* `app/api/piloti-asks/route.spec.ts`, `lib/a2a/*.spec.ts`,
  `lib/turns/outcome.spec.ts`, `tests/aiq_agent/agents/piloti/test_trigger_prompt.py`.
* `rls-coverage.spec.ts` lists 0177; `task db:test:rls` covers the table.

## More Information

* [ADR-0106](0106-events-on-pilotis-work-wake-a-turn.md): the headless turn.
* [ADR-0108](0108-background-runs-act-as-the-person-who-commissioned-them.md): acting as the person.
* [ADR-0121](0121-everything-a-person-can-do-an-agent-can-do.md): the agent door.
* A2A [specification](https://a2a-protocol.org/latest/specification/) 1.0, and
  the [JavaScript SDK](https://github.com/a2aproject/a2a-js).
* The user guide: [`../user-guides/connect-your-agent.md`](../user-guides/connect-your-agent.md#ask-piloti).
* **Revisit when** WorkOS Agent Auth replaces the bearer audience, when a lost
  outcome needs a sweep rather than expiry on read, or when A2A clients ask for push notifications.
