---
status: accepted
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Everything a person can do, an agent can do: one MCP server, every agent a client

## Context and Problem Statement

A planning office will not only work in Piloti. Its architects already work in
Claude, Cursor or ChatGPT, and they want those agents to file a document, assign
a mark or start a task in the office's workspace. Today none of them can.

The numbers, from a scout of the code in October 2026:

- The UI offers about 150 capabilities, spread over 313 route methods in
  `frontends/ui/src/app/api`.
- Piloti, the in-product agent, reaches about 15 of those capabilities through 28
  Python tools. Each tool was added when a turn needed it, so the set follows
  the turns we thought of, not the workspace.
- No external agent has any access. There is no token an outside client can
  obtain, and the only credential that reaches a route is the AuthKit cookie.

ADR-0055 said that a workspace primitive is one HTTP route with a typed client
and that every consumer is a client of it. It bound what was added. It did not
say which primitives an agent gets, so the agent's reach grew by accident and
stopped where the last tool stopped.

PostHog faced the same question and answered it with one MCP server in front of
its product API, built so that the API is the product and the UI one client of
it ("headless first, then wire up the UI"). Its handbook is the reference for
this record.

## Decision Drivers

- A person who can do something in Piloti expects their agent to be able to do it,
  and not to be told "the agent can't do that" for a button that exists.
- An agent acts for a person and never above them. Its writes pass the gate a
  person's pass: permission check, rate limit, tenant slot, body schema, audit.
- Two doors drift. A rule true at one and missing at the other makes the
  one that holds look safe (the argument of ADR-0055).
- The person says yes or no to what an agent changes, whichever agent it is.
- Reach has to stay true as the product grows. A list of tools somebody
  remembers to extend is the status quo again, one level up.
- Buy, don't build: MCP is the protocol every agent client speaks, and WorkOS is
  already our identity provider.

## Considered Options

1. **Keep the status quo**: Python tools for Piloti, nothing for anyone else.
2. **A private agent API for Piloti, plus a separate door for external agents.**
   Two surfaces, each with its own idea of what an agent may do.
3. **One MCP server that wraps the routes the UI already calls, and every agent
   a client of it.**
4. **Generate the tools from an OpenAPI spec first.** The spec would be the
   catalog, and the tools would follow.

## Decision Outcome

Chosen option: **3**.

**Everything a person can do in Piloti, an agent can do on that person's
behalf, through one MCP server at `/api/mcp`.** The UI is one client of the
workspace. Agents are others. The long form, with the how-to, is
[`../architecture/agent-surface.md`](../architecture/agent-surface.md).

### The surface

Each MCP tool is an **operation**: an entry in
`frontends/ui/src/lib/agent-api/catalog/` that names a BFF route the UI already
calls (`method` + `path`), says in words a model can act on when to call it, and
states its input as zod. The catalog is not a new door. It makes an existing one
findable.

The dispatcher (`lib/agent-api/dispatch.ts`) runs that route's exported handler
in-process, as the person. The handler's factory then does what it does for a
browser: it resolves the session, checks the `authz` declaration, charges the
rate limit, opens the tenant slot and parses the body with the route's own
schema. Nothing is restated, so there is no second gate and no second contract.
This extends ADR-0055 from "every primitive added" to "every capability".

The handlers learn who is asking from one function, `getGridSession()`. It has
one extra answer: the acting session of the call in flight, bound by
`runAsActingSession` in `lib/agent-api/acting-session.ts` to the async execution
of that call. Only the dispatcher enters it.

ADR-0055 allowed `publicApiRoute` for routes with no session, and `publicApiRoute`
needs an ADR. This record covers its use for the OAuth protected-resource
metadata documents (RFC 9728) that an MCP client reads before it has a token.

### Identity

Every agent is a client of the same server. Two doors are built, two more are
planned. None has a path to a route except the dispatcher.

| Client | Authenticates with | Status |
|---|---|---|
| External agents (Claude, Cursor, ChatGPT) | OAuth 2.1. WorkOS AuthKit is the authorization server (MCP specification 2026-07-28); Piloti publishes RFC 9728 protected-resource metadata; tokens are audience-bound to the MCP URL; clients register by Client ID Metadata Document (CIMD), with dynamic client registration (DCR) for older clients | Built |
| Piloti, in-product | The same server, echoing the turn's signed request-context envelope. Python echoes the envelope and never signs one (ADR-0054 §4, ADR-0108) | Built |
| Scripts and jobs | WorkOS API Keys | Later |
| Piloti outside a browser turn | WorkOS Agent Auth (user-delegated tokens), when it leaves early access | Later |

A WorkOS access token carries no permissions. The person's live membership, role
and permissions are resolved on every call with `resolvePinnedRequesterSession`
(ADR-0108), so a role change or a removed member takes effect on the next call
and not when a token expires.

External agents are off by default. A WorkOS feature flag, `agent-mcp`, gates
them per organization; an organization admin turns it on.

### The person says yes or no

The agent acts for a person, and the person decides what changes.

- **External clients** confirm writes through MCP tool annotations. Every
  operation states `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` explicitly (an absent `destructiveHint` means "destructive" in
  the specification, which would make every write look like a delete). The client
  asks its user before a call the annotations mark as a write.
- **Piloti in-product never applies a write itself.** Every write it attempts
  becomes an `operation` proposal, a server object the person accepts, which runs
  as the accepting person, or dismisses (ADR-0105). A read runs at once.

### Sensitive operations

An operation may carry `sensitivity: 'access' | 'secret'`. `access` widens who
may do what: sharing grants, folder access, custom role definitions. `secret`
touches the organization's credentials: LLM provider keys.

These are designed to be reachable, with guards a plain operation does not need:

- the organization opted in a second time;
- the client holds a step-up OAuth scope, and a call without it answers
  `403 insufficient_scope` so the client can ask the person to grant it;
- the person confirms every call (`destructiveHint` is always true);
- Piloti in-product only proposes them, never applies one;
- a secret is write-only and never returned.

**They are not catalogued yet.** They wait for an explicit permission decision
in the agent tooling: whether an agent may hold the right to widen access at all.
Until that is made, they are uncovered, and the ratchet lists them as such. An
unmade decision is recorded as a gap and not as a policy.

### Discovery and tools mode

MCP has no standard tool search. With about 300 operations, listing them all in
`tools/list` costs a client tens of thousands of tokens on every conversation.
PostHog's `exec` and Cloudflare's search-and-execute are the industry answer.
The server has two modes:

- `discovery` (default): four meta-tools, `search-operations`,
  `describe-operation`, `call-operation` and `report-missing-capability`. The
  agent searches the catalog, reads one operation's schema, then calls it. The
  annotations that `call-operation` cannot carry per operation are answered by
  `describe-operation` and enforced at the call.
- `tools`: one MCP tool per operation, with its own annotations, for clients and
  models that handle a long list.

### What deserves a tool

Three layers, as in PostHog.

1. **Atomic operations**, one per route method, catalogued. This is the layer
   that makes the rule "everything a person can do" checkable.
2. **Task-shaped tools**, written by hand where an agent needs more than CRUD:
   Piloti's retrieval, IFC and canvas tools. `knowledge_search`, `read_passage`,
   `list_files`, `view_knowledge_image`, `ifc_query`, `ifc_measure` and
   `ris_lookup` are Python-only reads. In phase 2 they are served through the
   same MCP server by an internal backend endpoint, so an external agent
   searches the office's documents with the retrieval Piloti uses.
3. **Skills that teach composition**, served as MCP prompts. Later.

A new workspace capability is a BFF route and an operation. It is not a new
Python tool. Python tools are for reasoning that has no route.

### What stays out

Some routes are not something a person does. `NOT_AN_AGENT_CAPABILITY` in
`agent-reachability.spec.ts` lists them with a reason each: transport (the SSE
stream, the realtime channel, the proxies), browser sign-in plumbing (the AuthKit
callback and redirect), and typing indicators. An entry needs a sentence a
reviewer can disagree with.

### The app is a client of the same routes

"One way of working" is held on the server: a capability has one route, one
handler, one gate and one schema (a `lib/**/*-wire.ts` module the route and the
catalog both import, kept pure by `lib/api/wire-modules.spec.ts`). The browser
already calls those routes, so it is a client of the same API, not a second one.

Two moves that look like more of the same were weighed and refused:

- **A generic browser client generated from the catalog**, with every raw
  `fetch('/api/…')` in `features/` migrated onto it. The duplication it removes is
  a URL string; the cost is a new abstraction and churn across 80 call sites.
  A feature with enough calls to earn a typed client gets one, as ADR-0055 says.
- **Server actions for mutations.** A server action is an RPC door outside
  `apiRoute`: no `authz` declaration, no rate limit, no reachability ratchet, and
  no agent can call it. It is exactly the second surface this record exists to
  prevent. Server components keep reading through repositories, which is not a
  door anyone else needs.

### Consequences

* Good, because an agent's writes go through the gate a person's go through.
  There is no agent-only code path to review.
* Good, because the product's reach is a checked property. A new route without
  an operation or an exemption fails a test in the commit that adds it.
* Good, because one server serves Claude, Cursor, ChatGPT and Piloti, so a
  capability added for one is there for all.
* Good, because the catalog's descriptions are the first place a missing
  capability becomes visible: `agent_capability_missing` says what agents asked
  for and could not do.
* Bad, because in-process dispatch couples the MCP server to the Next route
  modules. A route that moves breaks its operation; the `load` check in the spec
  catches that, and a route that cannot be imported outside a request would block
  its operation.
* Bad, because the acting session is a second answer of `getGridSession()`. Code
  that reads the session by another route (the cookie directly) would not see
  it. The rule that only the dispatcher enters the seam, and that nothing a
  request carries can, is what keeps it from becoming a bypass.
* Bad, because catalog descriptions can go stale. The route changes and the
  sentence telling a model what it returns does not. Review is the only check,
  and the operation sits beside the change in the same commit to make that
  review easy.
* Bad, because the first release has a baseline: routes that predate the rule are
  listed in a file and uncovered. The claim "everything" is true by direction,
  and the file says by how much it is not yet.
* Neutral: Option 4 stays open. The catalog has enough to emit an OpenAPI
  document later.

Option 4 was deferred, not rejected. Generating tools from OpenAPI needs response
schemas, which the routes do not declare, and zod 4's JSON Schema export. The
catalog names the same things an OpenAPI path does, so it can emit one when the
routes declare their responses.

Option 2 is the one that rebuilds the problem. A private agent API for Piloti and
a separate external door would each decide what an agent may do. They would drift
the way the three consumers of ADR-0055 did.

### Confirmation

- `frontends/ui/src/lib/agent-api/agent-reachability.spec.ts` walks every
  `app/api/**/route.ts`. A person-facing route method without an operation or an
  entry in `NOT_AN_AGENT_CAPABILITY` fails. Routes that predate the rule sit in
  `agent-reachability-baseline.json`, which only shrinks: a covered or removed
  route must leave it, and `UPDATE_FIXTURES=1` rewrites it so the diff is the
  review. The spec also checks every operation: unique `<entity>-<verb>` name, a
  description of at least 40 characters, a `load` that imports the route its
  `path` names, params that match the path's segments, and schemas the JSON
  Schema export can describe.
- The principal and policy specs under `lib/agent-api/` cover who may call (the
  `agent-mcp` flag, scopes, audience) and what the client must confirm.
- PostHog events, through the collector (ADR-0119): `agent_operation_called`
  (operation, client, status) and `agent_capability_missing` (what an agent
  tried to do and no operation covers).
- Nothing enforces that a description is true. Review is the gate.

## More Information

- [ADR-0055](0055-api-first-workspace-primitives.md): one HTTP route per
  primitive, every consumer a client. This record extends it to every capability.
- [ADR-0105](0105-piloti-works-on-shared-objects.md):
  proposals, the person decides.
- [ADR-0108](0108-background-runs-act-as-the-person-who-commissioned-them.md):
  `resolvePinnedRequesterSession`, echo the envelope and never sign.
- [ADR-0119](0119-every-metric-goes-to-posthog-through-the-collector.md): the
  events.
- How to add an operation, connect a client, and set up WorkOS:
  [`../architecture/agent-surface.md`](../architecture/agent-surface.md).
- The contributor rule: [`../contributing/headless-first.md`](../contributing/headless-first.md).
- PostHog, [implementing MCP tools](https://posthog.com/handbook/engineering/ai/implementing-mcp-tools).
- MCP [specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
- WorkOS [AuthKit for MCP](https://workos.com/docs/authkit/mcp).
- **Revisit when** the permission decision on sensitive operations is made, when
  Piloti moves to WorkOS Agent Auth, or when the routes declare response schemas
  (then generate from OpenAPI).
