---
status: accepted
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Piloti works on shared objects, as the person it acts for

## Context and Problem Statement

Within a turn Piloti loops over tools, streams an answer and may ask one
question. At the edges of the turn it was shut in:

* **The answer was the only output type.** Cards were stapled to it and frozen
  with it (`turn/registries.py`: the registry's snapshot after the turn is the
  turn's cards). A decision on a card was written by the browser into the chat
  message (`cardInteractions`), and Piloti saw it, at best, on the next turn as
  the client's word (`PROPOSAL_DECISIONS v1`).
* Two neighbouring limits get records of their own: only a browser could
  start a turn (ADR-0106), and a running turn could not be steered (ADR-0107).
* **Piloti could not do what the person asked** on a document beyond
  proposing: it could not resolve, reopen, assign or set a mark the person
  explicitly asked for.

The review canvas (Anmerkungen, [`document-annotations.md`](../architecture/document-annotations.md))
made the gap concrete: people work on marks together, live, and Piloti has to
be a participant there, not a respondent beside it.

## Decision Drivers

* Piloti acts as a person, never above them: the signed envelope, the pinned
  session, the same API and the same checks (ADR-0054 §4, ADR-0055, ADR-0084).
* A person stands behind everything that becomes the office's work.
* Every action is visible and attributed: who acted, and for whom. The EU AI
  Act's transparency duty (Art. 50, applicable since 2 August 2026) makes a
  visible label close to a legal floor.
* Undo, because an agent acting on shared objects in an office of six to
  thirty people must be easy to take back.
* Reuse: the internal routes, the live channels (ADR-0110), the existing
  annotation CHECKs.

## Considered Options

1. Keep the answer as the unit; extend cards and `cardInteractions`.
2. Typed outputs on shared objects; Piloti does what the person may when they
   ask, its own findings arrive as proposals.
3. Typed outputs, but Piloti only ever proposes; people make every change.

## Decision Outcome

Chosen option: 2.

### Output has types; the answer is one of them

| Output | When it is the work | What makes it trustworthy |
|---|---|---|
| Answer | a question about the law, a document, the project | citations, checked quotes, the answer pipeline |
| Mark, thread reply | something about a place on a document | on the page, attributed, decided by a person |
| Proposal | a change to the workspace | applied only when someone accepts it |
| Draft, run | longer work | filed by a person; a progress record anyone can follow |

A turn can leave several. When the work lives on an object, the answer says
what happened and links to it, and a card is a live receipt of the objects the
turn produced (`canvas_activity`): it re-reads them and every decision on it is
a write to the object through its API, never only to `cardInteractions`.

### Piloti may do what the person may, when they ask

When the person asks, Piloti does on a document's Anmerkungen everything that
person may, under their own rights: set a mark born open, resolve, reopen,
dismiss, take over, assign, set a date, edit, delete a mark the person set.
Its own findings, made without being asked for each one, arrive as proposals.

* The person who asked is recorded as accountable (`accepted_by`,
  `closed_by`). The CHECKs of migration 0138 hold unchanged: an open Piloti
  mark always has a person behind it.
* Every change to an existing mark posts one short note in its thread, signed
  as Piloti, in the same request.
* The chat card offers undo per change: the inverse PATCH, compared against
  the state Piloti left, so a colleague's later move is never undone.
* Assigning work to Piloti keeps a person as the assignee; Piloti is a
  delegate on the mark (the pattern Linear ships: work is assigned to people
  and delegated to agents).
* Acting is behind the organization switch `piloti-acts`, a WorkOS
  entitlement off by default: an office starts with Piloti proposing only and
  turns acting on when it trusts it. Off, the BFF refuses `create`, `update`
  and `delete` (`piloti-acts-off`) and Piloti proposes instead.

### What is not done

* Reads are not logged per document beyond the existing traces: the cost is
  out of proportion for offices of this size.
* A turn does not outlive its answer. Long work is a task run; work that
  continues lives in the objects it made and in later woken turns.

### Consequences

* Good, because Piloti takes part where the work is, as the person who asked,
  through every gate a person's own action passes.
* Good, because decisions become server rows Piloti can read and Langfuse can
  score, instead of the browser's word.
* Good, because undo makes an acting agent safe on shared work without an
  approval step on every action.
* Bad, because an agent that may resolve and delete can do the wrong thing
  quickly; the note in the thread, the undo and steering (ADR-0107) are the
  answer, not a narrower permission.
* Neutral, because the three older proposal cards (`memory_proposal`,
  `project_profile_patch`, `file_operation_proposal`) still decide through
  `cardInteractions`. They move to proposals as server objects (a proposed
  state on the object, or one generic proposed change applied through the
  object's API) as the next step; the act-or-ask setting then becomes whether
  Piloti's output is born applied with undo or born proposed.
  *Amended 2026-10-13:* all three have moved. They are the kinds
  `file_operation`, `memory` and `project_profile` of one proposed change
  (`proposed_changes`), decided on the server, and a card that carries a
  `proposal_id` writes no `cardInteractions`. A memory or profile card without
  one (an older answer) keeps the browser path; a file card without one is
  read-only. See
  [`proposed-changes.md`](../architecture/proposed-changes.md).

### Confirmation

* Route and service specs for every Piloti op against the person's rights
  (`app/api/internal/document-annotations/route.spec.ts`); the CHECKs
  exercised against a real PostgreSQL (`task db:test:rls`,
  `lib/annotations/repository.integration.spec.ts`).
* `tests/aiq_agent/tools/canvas/`: every shared write passes the
  restricted-folder refusal.
* Langfuse: `turn_surface`; a proposal-decision score once marks record the
  turn that proposed them.

## Pros and Cons of the Options

### 1. The answer as the unit

* Good, because nothing new runs.
* Bad, because decisions stay the browser's word and the work Piloti does on a
  document has no home.

### 3. Piloti only proposes

* Good, because nothing becomes the office's work without a click.
* Bad, because „mach das bitte erledigt“ becomes a proposal the person must
  click again: the agent is less capable than the person it acts for, and the
  extra step buys nothing the note and the undo do not already give.

## More Information

Design page with the flow, the permission table and the comparison with
shipped products: kept with the pull request that introduced this record.
