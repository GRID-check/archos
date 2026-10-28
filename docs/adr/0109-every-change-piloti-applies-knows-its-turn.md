---
status: accepted
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Every change Piloti applies knows its turn

## Context and Problem Statement

Piloti changes shared objects as the person who asked (ADR-0105): it sets,
resolves, assigns and deletes Anmerkungen and answers in their threads. What a
turn changed lived in one place: the chat card the turn emitted
(`canvas_activity`). The card kept its own copy of before and after, undo was
the browser replaying that copy, a colleague's window could not tell which
turn made a change, and Langfuse could not score a person's decision on it,
because nothing on the server joined a change to the turn.

Proposals, Piloti's UNASKED changes, already became server rows
(`proposed_changes`, migration 0140). The asked ones had no row at all. The
work lives on the objects; what is missing is the record of what a turn did to
them.

## Decision Drivers

* The card is a window onto objects, not a copy of them: it must show what is
  true now, to every reader, live.
* Undo must never undo a colleague's later change.
* A decision on Piloti's work is a score on the trace that produced it
  (ADR-0089).
* Do not log reads (ADR-0105): record changes only.

## Considered Options

1. Keep the card's copy; undo from the browser.
2. Origin columns on each object (`origin_message_id` on marks and replies).
3. One change record: a row per applied change, with the turn, the state
   before and after, and its undo.

## Decision Outcome

Chosen option: 3, `agent_changes` (migration 0142).

* **One row per applied change**, written by the BFF in the route Piloti
  calls (`lib/annotations/agent.ts`): `create`, `update` or `delete` of a mark,
  `create` of a reply, with the changeable state `before` and `after`, the
  turn (`origin_conversation_id`, `origin_message_id`: the answer the turn
  wrote) and the person it acted for. Reads, presence, pointing and
  highlighting are not changes.
* **The card reads the record**: `GET /api/conversations/[id]/messages/[messageId]/changes`
  answers what that turn changed as it stands now, only on documents the reader
  may see. The card's own list stays as the fallback for answers older than
  the record.
* **Undo is a compare-and-swap, run as the person clicking**:
  `POST /api/piloti-changes/[id]/undo` applies the inverse through the
  annotations service only while the object is still as Piloti left it, and
  refuses `moved-on` otherwise. The row records who undid it.
* **Decisions are scored**: applying or dismissing a proposal, taking over or
  dismissing a proposed mark, and undoing a change post one `piloti-decision`
  score onto the producing turn's trace (`lib/langfuse/decision-score.ts`).
* **No foreign key on the mark**: a `delete` outlives the mark it deleted, or
  it could never be undone. The row goes with its document and with the
  conversation of the turn that made it.

### Consequences

* Good, because every reader's card, the canvas and the thread agree: they
  read the same rows and the same objects.
* Good, because undo is safe on shared work, and its refusal says why.
* Good, because Langfuse sees which of Piloti's changes people keep, take back
  or undo, per turn.
* Bad, because one more table inside the tenant boundary (`grid_secure_table`
  over the document's organization, `rls-coverage.spec.ts`).
* Neutral, because only Anmerkungen and their threads are recorded today. A
  second object Piloti applies changes to adds an `object_kind` and its state
  shape, not a second record.

### Confirmation

* Migration 0142's CHECKs (states by op, a reply is only created, undo
  complete) exercised in `scripts/rls-test-db.sh`.
* `lib/changes` specs: each op records its row; no answer id records nothing;
  the list leaves out invisible documents; undo refuses `moved-on` and
  `already-undone`; two concurrent undos leave one.
* `lib/langfuse/decision-score.spec.ts` and the Python `SCORE_DEFINITIONS`
  test (`test_langfuse_scores.py`).

## Pros and Cons of the Options

### 1. The card's copy

* Bad, because a second reader, the canvas and the card disagree, and undo can
  overwrite a colleague.

### 2. Origin columns on each object

* Good, because no new table.
* Bad, because it records who created a mark, not what a turn changed on a
  mark it did not create, and it cannot undo a delete.

## More Information

ADR-0105 (Piloti works on shared objects), ADR-0106 (wakes; a woken turn's
changes are recorded the same way), ADR-0089 (Langfuse).
