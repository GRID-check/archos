# Headless first

What you do when you add or change something a person can do in Piloti. The
reason and the design are in
[ADR-0121](../adr/0121-everything-a-person-can-do-an-agent-can-do.md) and
[`../architecture/agent-surface.md`](../architecture/agent-surface.md).

**The rule.** A capability is a route and an operation. The operation is the
capability; the UI is one client of it, and an agent is another. Anything a
person can do, their agent can do through Piloti's MCP server, with the person
saying yes or no.

## The order

PostHog's phrase is "headless first, then wire up the UI". Ours:

1. Build the route, service and schema. The route is the capability.
2. Write its operation in `frontends/ui/src/lib/agent-api/catalog/`.
3. Wire the UI to the route.

Steps 1 and 2 land in the same change. If you build the button first, the
operation is the part that gets forgotten, and that is the part a reviewer cannot
see.

## What you must do

| When you | You must |
|---|---|
| Add an `app/api` route method a person calls | Add an operation for it in the same change |
| Add a route that is not something a person does (transport, sign-in plumbing, typing) | Add it to `NOT_AN_AGENT_CAPABILITY` in `agent-reachability.spec.ts`, with a reason |
| Change a route's body, query or meaning | Update the operation's schema and description. The schema is shared, so the type checker tells you; the description only review does |
| Move a route-local zod schema | Into `lib/<area>/<x>-wire.ts`, imported by the route and the catalog |
| Cover a route that sits in `agent-reachability-baseline.json` | Remove it from the baseline (`UPDATE_FIXTURES=1`) |
| Add a Python tool for a workspace capability | Do not. A capability is a route and an operation. A Python tool is for task-shaped reasoning (retrieval, IFC, canvas) |
| Touch sharing grants, folder access, custom roles or LLM provider keys | Leave the route uncatalogued and say so in the PR. They wait on a permission decision ([ADR-0121](../adr/0121-everything-a-person-can-do-an-agent-can-do.md)) |

## Checklist

- [ ] The route method has an operation, or an exemption with a reason.
- [ ] `name` is `<entity>-<verb>`, at most 52 characters, one operation per route method.
- [ ] The description says when to call it, what comes back, where ids come from, what to call next.
- [ ] `body` and `query` are the route's own schemas, not copies.
- [ ] `destructive`, `readOnly` and `idempotent` are right where the defaults are not.
- [ ] `cd frontends/ui && bunx vitest run src/lib/agent-api/` is green.
- [ ] Nothing outside `lib/agent-api/dispatch.ts` calls `runAsActingSession`.

## What fails you

`frontends/ui/src/lib/agent-api/agent-reachability.spec.ts`. It fails a new
person-facing route with no operation and no exemption, a baseline entry that is
now covered, and a malformed operation. The baseline only shrinks.

## Not sure it deserves a tool

Three layers (ADR-0121): an operation per route method; a hand-written
task-shaped tool where an agent needs more than CRUD; a skill that teaches
composition. If a person can click it, it is layer one, whether or not you think
an agent would ask for it.
