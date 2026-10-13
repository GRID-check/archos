---
status: accepted
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# A running turn is steered at its next tool step

## Context and Problem Statement

Both composers blocked sending while Piloti worked, and a second message
cancelled the running turn. Now that Piloti acts on shared objects (ADR-0105),
a person watching it point at the wrong door has no way to say „nicht die Tür,
die Treppe“ short of stopping it and starting over.

## Decision Drivers

* Redirect without losing the work so far.
* Never let an action Piloti chose before the correction go through unchanged.
* Keep the prompt cache: the conversation's messages stay as they are.
* Observable: every steer traced.

## Considered Options

1. Keep blocking; stop and ask again.
2. A `steer` message delivered to the running turn at the next tool step.
3. A model-level steering API.
4. Approval before every write.

## Decision Outcome

Chosen option: 2, with stop and per-action undo beside it.


A message typed while Piloti works reaches the running turn at the next tool
step as a steering note (`steer` on the wire), never as a new turn. A write
Piloti chose before the note arrived is held back so it decides again. A note
that misses the turn becomes the next question. Stop cancels; undo is per
action. OpenRouter offers no steering for this setup (its endpoints are
stateless and can only be aborted), and activation steering cannot express an
instruction; the pattern is the one Claude Code, Codex and Cursor ship.


### Consequences

* Good, because a correction costs one sentence, not a restart.
* Good, because a write chosen before the correction is held back and decided
  again with it.
* Bad, because a note can arrive while the model is mid-call; it takes effect
  one step later.

### Confirmation

* A turn test whose second round sees the note, and a held-back write.
* `steer_received` / `steer_applied` on the wire; Langfuse tag `steered` and
  `steer_count`.

## Pros and Cons of the Options

### 1. Keep blocking

* Bad, because the only correction is to throw the turn away.

### 3. Model-level steering

* Bad, because OpenRouter offers none for this setup (stateless endpoints that
  can only be aborted), and activation steering shifts tendencies; it cannot
  carry an instruction.

### 4. Approval before every write

* Bad, because it turns every action into a click. Undo and steering give the
  same control without the friction; an act-or-ask setting stays possible as
  a per-person choice.
