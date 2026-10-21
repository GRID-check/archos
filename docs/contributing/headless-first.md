# Headless first

What you do when you add or change something a person can do in Piloti. The
reason and the design are in
[ADR-0121](../adr/0121-everything-a-person-can-do-an-agent-can-do.md) and
[`../architecture/agent-surface.md`](../architecture/agent-surface.md).

**The rule.** A capability is a route and an operation. The operation is the
capability; the UI is one client of it, and an agent is another. The agent door
offers what only Piloti has: the office's workspace (its data and the actions
on it), Piloti's domain knowledge (the legal corpus, BIM/IFC analysis of the
office's models) and Piloti itself (`piloti-ask`), with the person saying yes
or no to every write.

**What the door does not offer** (ADR-0121, "Amendment: the door offers what
only Piloti has"). Such an operation is still written, then marked
`withheld: { category, reason }`, and reads as an unknown name on every door:

| Category | What | Examples |
|---|---|---|
| `external-service` | A service we only proxy or switch; the calling agent has its own | web search and its switch, the geocoder, RIS texts, WorkOS widget tokens and portal links |
| `product-config` | How Piloti itself works for the office | models and their versions, zero data retention, LLM keys and provider mode, budgets and usage, settings, standing instructions, upload screening, retention policies, curated skills on or off |
| `model-compute` | Model work the caller can do itself, whose result is no office artifact | conversation titles, citation formatting, skill review |
| `ui-state` | This person's own screen or device | push devices and preferences, the preference bag, read and unread marks |

A domain feature that makes an office artifact with Piloti's knowledge stays on
the door (`project-summary-generate`, `project-consistency-check`,
`project-experience-extract`). The operator console (`platform`) is never on the
office door; it waits for a server of its own for platform staff.

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
| Add a route that is not something a person does (transport, sign-in plumbing, typing) | Add it to `NOT_AN_AGENT_CAPABILITY` in `agent-reachability.spec.ts`, with a category and a reason |
| Add a route that is product configuration, a proxied service, model compute or screen state | Write its operation and mark it `withheld: { category, reason }`; add its line to `WITHHELD` in `agent-reachability.spec.ts` |
| Offer a withheld operation again | Delete its `withheld` entry and its `WITHHELD` line, and say why in the PR |
| Change a route's body, query or meaning | Update the operation's schema and description. The schema is shared, so the type checker tells you; the description only review does |
| Move a route-local zod schema | Into `lib/<area>/<x>-wire.ts`, imported by the route and the catalog |
| Cover a route that sits in `agent-reachability-baseline.json` | Remove it from the baseline (`UPDATE_FIXTURES=1`) |
| Add a Python tool for a workspace capability | Do not. A capability is a route and an operation. A Python tool is for task-shaped reasoning (retrieval, IFC, canvas) |
| Touch sharing grants, folder access, custom roles, a held file let through or a legal hold lifted | Catalogue it with its `sensitivity`, and its line in `SENSITIVE` ([ADR-0121](../adr/0121-everything-a-person-can-do-an-agent-can-do.md), "Sensitive operations") |

## Checklist

- [ ] The route method has an operation, or an exemption with a category and a reason.
- [ ] The operation is office work, domain knowledge or Piloti itself; otherwise it is `withheld`.
- [ ] `name` is `<entity>-<verb>`, at most 52 characters, one operation per route method.
- [ ] The description says when to call it, what comes back, where ids come from, what to call next.
- [ ] `body` and `query` are the route's own schemas, not copies.
- [ ] `destructive`, `readOnly` and `idempotent` are right where the defaults are not.
- [ ] `cd frontends/ui && bunx vitest run src/lib/agent-api/` is green.
- [ ] Nothing outside `lib/agent-api/dispatch.ts` calls `runAsActingSession`.

## What fails you

`frontends/ui/src/lib/agent-api/agent-reachability.spec.ts`. It fails a new
person-facing route with no operation and no exemption, a baseline entry that is
now covered, and a malformed operation. The baseline only shrinks. It also fails
when the withheld set differs from its `WITHHELD` list, when an offered
operation sits on a product-configuration path (`/api/organization/settings`,
`/model-config`, `/llm-credentials`, `/web-search`, `/upload-screening`,
`/api/platform/…` and the rest of `CONFIG_PATH_PREFIXES`) without a reason in
`OFFERED_ON_CONFIG_PATHS`, and when an offered operation's text names a withheld one.

## Not sure it deserves a tool

Three layers (ADR-0121): an operation per route method; a hand-written
task-shaped tool where an agent needs more than CRUD; a skill that teaches
composition. If a person can click it, it is layer one, whether or not you think
an agent would ask for it. Whether the door offers it is the separate question
above: write the operation either way, and withhold it when it is not office work.
