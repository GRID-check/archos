---
status: accepted
date: 2026-10-21
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The operator console has its own MCP door: a second server for platform staff, its own audience

## Context and Problem Statement

ADR-0121 put every person-facing route behind one MCP server at `/api/mcp`. Its
amendment ("the door offers what only Piloti has") took the `platform` domain off
that door for everyone, platform staff included: the operator console is GRID's,
not an office's, and every write there (default models, prices, the base corpus,
the kill switch) reaches every tenant. The 54 console operations stayed in the
catalog with no door.

Platform operators work the console with agents too: triaging feedback, reading
quality views, checking an organization's usage before changing its budget. How
does a platform operator's agent reach the console without putting those
operations back in front of every office's agents, without a second
implementation of the MCP server, and without a token that opens both?

## Decision Drivers

* An office token must never reach the console, and a console token must never
  act in an office: one token, one door (RFC 8707 audience binding).
* One implementation: the same handler factory, catalog, dispatcher, search,
  describe and call (ADR-0055, ADR-0121). A door is a filter, not a fork.
* The route stays the gate: each console route already checks its own
  `platform:*` permission through `platformApiRoute`, and the read-only Platform
  Support role must stay read-only through an agent.
* Standards: MCP 2026-07-28 with the legacy fallback, OAuth 2.1, RFC 8707 resource
  indicators, RFC 9728 protected-resource metadata.
* Off until switched on, like every other agent door.

## Considered Options

* **A second MCP server at `/api/platform/mcp`, its own resource and audience.**
* **Show the platform domain on `/api/mcp` to platform staff only.** The policy
  would read the person's platform permissions and list the domain for staff.
* **Platform operations as a scope on the office door** (`piloti:platform`),
  granted by WorkOS to staff.
* **No agent door for the console.** Operators use the browser.

## Decision Outcome

Chosen option: "a second MCP server at `/api/platform/mcp`", because it is the
only option where an office's token cannot reach the console by construction:
the audience is checked before anything else, and the two audience groups do not
overlap.

**The path.** `/api/platform/mcp` sits beside the routes it serves. Every other
`/api/platform/*` route is a console route behind `platformApiRoute` and the
browser's cookie; this one is the door to them, authenticating a bearer token, so
it is the one hand-rolled route under `/api/platform` (`authz-coverage.spec.ts`,
`HAND_ROLLED`) and the one route there with no `platform:*` permission of its own
(`platform-permission-coverage.spec.ts`, `DOORS`). `/api/mcp/platform` was the
alternative; it nests the console under the office door's URL, and the proxy,
`doorOf` and every reader would have to know a sub-path of the office door is
not the office door.

**The resource.** `platformMcpResourceUrl` is the MCP resource's origin plus
`/api/platform/mcp`, derived exactly as the A2A door's is, so `GRID_MCP_RESOURCE_URL`
moves all three and no new environment variable is needed. Its metadata is at
`/.well-known/oauth-protected-resource/api/platform/mcp`, and its 401 challenge
points there.

**Audiences.** `acceptedAudiences(door)` has two groups. The office doors
(`/api/mcp`, `/api/a2a`) accept each other's tokens, as ADR-0123 decided. The
platform door accepts only its own audience, and neither office door accepts it.
A token for the wrong group fails signature-time verification with 401
`invalid_token`.

**Who gets in** (`principal.ts`, `platformPrincipal`):

1. The token's `org_id` is the GRID Platform organization
   (`getPlatformOrganizationId`). Any other organization gets 403, platform staff's
   own included: only the platform organization's membership carries the platform
   role. When the platform organization cannot be resolved, 503.
2. The platform organization has the entitlement `platform-agent-mcp` on. Off by
   default. The office door's `agent-mcp` opens nothing here.
3. The person's membership is live (`resolvePinnedRequesterSession`, the fresh
   one-minute lookup), and `isPlatformStaff` accepts the session: the console's own
   precondition.
4. Piloti's internal credential is refused with 403. In-product Piloti works for
   an office.

The principal carries `door: 'platform'`. That is the only thing the policy reads:
`isOnDoor(op, door)` with `DOOR_DOMAINS.platform = {platform}`, so the door lists,
searches, describes and calls exactly the platform domain, never a withheld
operation and never the Python agent's read tools. An office operation named on
the platform door reads as unknown, and the reverse.

**Writes.** A platform write runs directly for the operator, as the console's
button does; there is no proposal step, because the caller is the person, not
Piloti. The route's permission decides: Platform Support holds only `*:view`, so
its agent's writes come back 403. Fleet-wide writes carry `destructive: true` so a
client asks the person before each one: the default models, reasoning efforts,
retrieval settings, the price list (also `idempotent: false`, since each call
saves a new version), the norm registry, a forced re-ingest, plus the kill switch,
vector reconcile and deletes that already did. No platform write gains a
`sensitivity`: the classes (`access`, `secret`, `control`) are about one office's
grants, keys and controls, and a `sensitivity` would hide the operation until
WorkOS enforces the step-up scope, which would make the door read-only for no
reason the annotations do not already cover. The one console operation that
already has a class, `platform-audit-portal-link` (`secret`), keeps it and stays
hidden on this door until that scope is enforced.

**The edge is shared.** `/api/mcp` and `/api/platform/mcp` both export
`mcpDoorPost(door, label)` (`lib/agent-api/mcp-door-route.ts`): origin check,
batch refusal, the principal with its JSON 503 while WorkOS cannot answer, one
charge of the person's `mcp-request` budget, then `createAgentDoorHandler`. The
route also checks that the principal's door is its own. The budget is shared on
purpose: one person, one agent budget, whichever door.

**Telemetry.** `agent_operation_called` and `agent_operation_missing` carry
`door: 'platform'`; the Langfuse `agent-tool-call` trace carries the same door in
metadata and tags.

### Consequences

* Good, because an office's token cannot reach the console and a console token
  cannot act in an office: two audience groups, checked first.
* Good, because nothing was implemented twice. The door is one enum member, one
  set of domains, one principal branch and a ten-line route.
* Good, because the console routes stay the gate, so the read-only role stays
  read-only.
* Bad, because a platform operator who wants both connects two servers, each with
  its own sign-in, and must sign in to the second in the GRID Platform organization.
* Bad, because the shared `mcp-request` budget means a busy console session
  slows the same person's office agent; a separate rule is a one-line change if
  that ever bites.
* Bad, because WorkOS must register a third resource indicator per environment
  (`workos-provisioning.md`); until it does, clients cannot get a token for this
  door.

### Confirmation

* `app/api/platform/mcp/route.spec.ts`: real signed tokens through the real
  principal: an office audience refused here and a platform audience refused on
  `/api/mcp`; an office organization's token 403; the flag off 403; not staff 403;
  Piloti's credential 403; WorkOS down 503; the listing is exactly the platform
  domain, the search domain enum is `['platform']`, an office operation is
  unknown here, and the office door lists no platform operation for the same
  operator.
* `lib/agent-api/principal.spec.ts`: the verifier per door, both directions.
* `lib/agent-api/policy.spec.ts`: `DOOR_DOMAINS.platform` and `canSee` on that door.
* `agent-reachability.spec.ts`: every `/api/platform` operation is the `platform`
  domain, and the office door does not offer it.
* `authz-coverage.spec.ts` and `platform-permission-coverage.spec.ts`: the door is
  the one recorded exception under `/api/platform`.

## Pros and Cons of the Options

### Show the platform domain on `/api/mcp` to platform staff only

* Good, because one server to connect.
* Bad, because the same token then opens both an office and the console; a
  leaked office-door token of a staff member is a console token.
* Bad, because visibility would depend on a live permission lookup per listing,
  and a staff member's office agent would carry 54 console tools it never needs.

### Platform operations as a scope on the office door

* Bad, because WorkOS does not yet enforce custom scopes for us
  (`SENSITIVE_SCOPE_ENFORCED_BY_WORKOS`), so the scope would mean nothing.
* Bad, because it still shares an audience with the office door.

### No agent door for the console

* Good, because nothing to build.
* Bad, because the catalog already describes every console operation and
  operators already ask for it; "everything a person can do, an agent can do"
  would stop at the operators.

## More Information

* ADR-0121 and its amendment: the office door, and why the platform domain left it.
* ADR-0123: the A2A door, the office doors' shared audience.
* ADR-0016: the GRID Platform organization and its roles.
* [`../architecture/agent-surface.md`](../architecture/agent-surface.md), "The platform door".
* [`../deployment/workos-provisioning.md`](../deployment/workos-provisioning.md): the flag and the resource indicator.
