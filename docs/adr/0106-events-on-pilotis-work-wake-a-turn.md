---
status: accepted
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Events on Piloti's work wake a turn, run as the person who acted

## Context and Problem Statement

Only a person's browser could start a turn: the server ruled who a message was
for (ADR-0034) and then waited for a browser to act on it. Since Piloti works
on shared objects (ADR-0105), people answer it where the work is, in an
Anmerkung's thread, often with nobody's chat open. Those answers reached the
database and the live room, never Piloti. How does Piloti take part after its
answer without speaking unbidden (ADR-0036) and without turns that never end?

## Decision Drivers

* An event wakes Piloti only through a rule people can read, never a model's
  guess that it was meant (ADR-0036).
* The woken turn acts as a person, under that person's rights of today and
  budget, through every gate a typed turn passes (ADR-0051, ADR-0054 §4).
* It must not leak a conversation the acting person cannot read, and must not
  cancel anybody's running turn.
* Durable: a wake survives a restart. The live channels are lossy hints
  (ADR-0104) and cannot carry one.
* No Piloti-wakes-Piloti; bounded cost.

## Considered Options

1. Keep turns browser-driven only.
2. Event-woken chat turns, enqueued by the BFF in the event's transaction and
   run over the existing chat socket with a signed envelope.
3. Suspend turns with LangGraph `interrupt()` and a checkpointer, resume on
   events.
4. Run reactions as task runs in the Python job worker.
5. Ambient mode: every thread reply goes to the model.

## Decision Outcome

Chosen option: 2.


| Event | Wakes Piloti when |
|---|---|
| A person's reply in an Anmerkung's thread | it @mentions Piloti, or the mark is a Piloti question still open |
| Piloti is made the delegate on a mark | always |
| A person takes over or dismisses Piloti's mark | never: recorded, read on the next turn, scored |
| A new Fassung, ingest done | only through a standing rule a person wrote (later) |

* The turn runs as the person whose act is the event, in that person's own
  thread about the document, and answers where it was addressed.
* The BFF enqueues the wake in the same transaction as the event, runs it over
  the existing chat socket with a signed envelope (`x-aiq-mode: headless`),
  with `trigger` and `if_idle` on the message: a running turn is never
  superseded, and `ask_user` refuses on a headless turn.
* Guards: Piloti's own writes never wake it; only people who can edit the mark
  can wake it on that mark; one wake per event (idempotent turn id); caps per
  mark and per person; the person's usage budget; an organization switch, off
  by default.


### Consequences

* Good, because Piloti answers where it was addressed even when nobody's
  browser drives it, as the person who asked.
* Good, because a woken turn is an ordinary turn: spectators, persistence,
  presence and traces come with it.
* Bad, because wakes cost model calls nobody typed; caps, the budget and an
  organization switch (off by default) bound that.
* Bad, because the BFF gains a server-side socket client.

### Confirmation

* Wake specs: one wake per event; none for Piloti's own events; refusal when
  the waker cannot edit the mark; `if_idle` never supersedes a running turn;
  `ask_user` refuses on a headless turn.
* Langfuse: `turn_trigger`, `trigger_event_id`, tag `trigger:<kind>`.

## Pros and Cons of the Options

### 1. Browser-driven only

* Bad, because an @Piloti in a thread stays unanswered.

### 3. `interrupt()` and a checkpointer

* Bad, because an interrupted node re-runs from its top and the per-turn
  registries do not survive it (ADR-0068 deferred it), and a suspended turn
  holds its envelope past its window.

### 4. Task runs in the job worker

* Bad, because the worker has no signed envelope and no turn harness, so the
  canvas tools refuse there.

### 5. Ambient mode

* Bad, because ADR-0036 rejects asking a model who a message was for.
