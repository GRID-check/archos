---
status: accepted
date: 2026-10-22
decision-makers: Grid engineering
consulted: four outside-agent dogfooding runs of the MCP door and a catalog audit (October 2026); Anthropic, "Writing effective tools for agents" (2025-09) and "Advanced tool use" (2025-11); MCP specification 2026-07-28
informed: everyone adding a route, an operation or a wire type
---

# The agent API speaks one dialect: one word, one id slot, lean pages, views not rows

## Context and Problem Statement

ADR-0055 made every workspace primitive one HTTP API with equal clients, and
ADR-0122 put an MCP door in front of it: about 225 operations, each a route
the UI already calls. The door works. What it exposes is the API's dialects.

In October 2026 four agents used the door as an outside agent would, on real
projects, and logged every friction. Then four more read every operation
against its route. What they measured:

- **Rows on the wire.** `project-memory-list` answered 3,554,106 characters
  for one project, almost all of it embedding vectors. `project-list` sent
  every project's whole profile (46 KB for ten projects, cut at 40,000
  characters). `task-run-start` answered with the raw row: the skill body (up to
  32,000 characters), the backend job id, the requester. `conversation-message-list`
  sends up to 200 thinking steps and 200 sources per message.
- **The project id in four places.** `params.id` (folders, roles,
  annotations), `query.projectId` (document list, conversations, proposals),
  `body.projectId` (document search, conversation create) and flat (the agent
  read tools). Each scout guessed per operation, and `files-list` refused
  `query.projectId` with "pass projectId".
- **Two words for one thing, one word for two.** A task is a `job` in
  `task-list`'s answer and in `task-get`'s parameter, and `taskId` means a run
  in the review route; the routes are crossed (`/api/projects/[id]/tasks`
  serves runs, `/jobs` serves tasks). One run is `succeeded` in one list and
  `submitted` in another, because one view maps every worker outcome to
  `submitted`, a failed run included.
- **Silent caps.** The inbox stops at 50, conversations at 200, proposals at
  50, messages at the newest 1,000, tasks at 100, with no cursor and no flag.
- **Fourteen twins.** `office-shelf-folder-list` and `project-folder-list`
  (and twelve more pairs) share one handler; the shelf is a prefix, not an
  argument.
- **One-way doors.** `document-archive` has no reverse; a document has no bin,
  only `document-delete`, which is permanent.

Each of these was a reasonable local choice. Together they cost an agent a
guess per call, and they cost the UI the same bytes.

## Decision Drivers

* An agent reads the API cold, every time: what a colleague learns once, it
  pays for on every call, in tokens and in wrong guesses.
* The UI is a client of the same routes (ADR-0055), so a fix belongs in the
  route, not in a door-only translation that leaves the UI paying.
* Anthropic's guidance and the MCP specification agree: tools fit the tasks an
  agent does, lists are lean and paged by default, one name per concept, and
  a response returns what the next call needs.

## Considered Options

* Translate at the door: keep the routes, reshape answers in `dispatch.ts`.
* Fix the API: one set of conventions for routes and their wire types, the
  door unchanged except where it is the convention's own seam.
* Do nothing: describe each dialect better.

## Decision Outcome

Chosen option: "Fix the API", because the door translating a row it should
never have received still makes the UI download it, and a description of a
dialect is still a dialect. The rules:

1. **One word per concept on the wire**, the glossary's: a `task` is a
   definition, a `task run` one attempt; `job` names a claim-queue item and
   never reaches the wire. An `annotation`, never a mark or an open point; a
   `conversation`, never a thread; a `version`; the `bin`. Keys of a list are
   the plural entity (`tasks`, `runs`), of a get the singular.
2. **Views, not rows.** A route answers a named wire type from a
   `lib/<area>/*-wire.ts` module, never a drizzle row. Vectors, bodies, plans,
   prompt renderings and backend ids appear only where the entity's own `-get`
   needs them, and never a vector.
3. **Lists are lean pages.** Every list takes `limit` and `cursor`, answers
   `nextCursor` (null on the last page), and states its cap in the
   description. The default row is the summary an agent picks from (id, name,
   state, the names of what it refers to); heavy fields are opt-in through
   `view=full` or `include=`. No silent cap.
4. **The project id has one place per role.** The path names the resource
   (`/api/projects/[id]/…`); a query parameter `projectId` filters a list that
   spans projects; a body field never carries it. A cross-project list's rows
   carry `projectId` and `projectName`.
5. **A scope is an argument, not a prefix.** The office shelf is a value of
   one operation's scope, not an `office-shelf-` twin of it.
6. **Closed vocabularies are enums over the domain tuple**, in the schema and
   so in the description, one status vocabulary per entity, the persisted one.
7. **Every reversible act has its reverse** (bin and restore, archive and
   unarchive); an irreversible one says "permanently" and is annotated
   destructive.
8. **A description promises only what the door offers**: every operation it
   names exists on that door, and every field it says to take from another
   operation is one that operation returns.

The conventions apply to routes as they are touched and to every new route.
The October 2026 slices move the operations the dogfooding measured.

### Consequences

* Good, because an agent's second call no longer depends on its first guess:
  the id is where the rule says, the word is the glossary's, the list fits.
* Good, because the UI stops downloading what it never rendered (the memory
  list, the project list).
* Good, because a rule a spec checks (8, 3) stops the next dialect at review
  rather than at the next dogfooding run.
* Bad, because renaming a wire key or a route breaks a client that remembers
  it: renamed operations stay accepted for one release (`RENAMED_OPERATIONS`),
  and a moved route keeps its old path for the same release.
* Bad, because some lists gain a cursor the UI did not need; the UI asks for a
  page large enough for its screen.

### Confirmation

* `lib/agent-api/description-references.spec.ts`: every operation a
  description names exists on the door that offers the describing operation
  (rule 8).
* `lib/agent-api/list-paging.spec.ts`: every `-list` operation's query takes
  `limit` and `cursor`, except those in its baseline, which only shrinks
  (rule 3).
* `search-ranking.spec.ts` keeps the queries agents typed in the first three.
* Rules 1, 2, 4–7: review, with this ADR as the reference. Nothing else
  enforces them yet.

## More Information

The friction logs and the audit are summarised in the pull request that
accepted this record. ADR-0055 (one API), ADR-0122 (the door), ADR-0123 (the
eval that measures the door) and `docs/architecture/agent-surface.md`
(naming, descriptions, schemas) are the context it extends.
