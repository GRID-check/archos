---
status: proposed
date: 2026-10-14
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Piloti sets a project up from its documents, as an agent of its own writing suggestions onto the profile

## Context and Problem Statement

A new project becomes useful once its profile holds the facts the rest
depends on: Bundesland, Vorhaben, Geschoße, Fluchtniveau, Nutzungseinheiten,
the Gebäudeklasse. Today the person types them into the intake wizard, nine
modules and up to fifty questions, which takes ten to forty minutes (product
owner's estimate, ticket 26). The project's documents already state most of
these values. The office has the Einreichplan, the Baubeschreibung and the
Bescheid of the building that stands there, and nobody reads them for the
profile.

ADR-0096 reads a closed project's fingerprint (six keys) from its documents in
three fixed model calls. The intake needs up to fifty keys, and which ones
depends on what has been found: a Wohnbau asks for the Wohnungen, a Garage for
its area. So the reading cannot be a fixed pipeline. Each answer changes what is
asked next.

## Decision Drivers

* Suggest, then confirm (VISION.md principle 4): no value Piloti read becomes
  the office's record without a person.
* Grounded and traceable: every value names the passage it came from.
* API first (ADR-0055): the agent, the UI and any later client reach the intake
  through one HTTP API with one typed client.
* The answering agent's behaviour does not change. Its 28 tools and its prompt
  are tuned for answers (`agent-tool-surface.md`).
* Long work is a run, never a turn (ADR-0105), and a run acts as the person who
  commissioned it (ADR-0108).
* One record per fact. The profile already has two editors, the wizard and
  accepted proposals, and every reader reads it.
* Only ask what changes the classification.

## Considered Options

1. **An agent of its own on the research worker** (agent type
   `project_intake`), working through an intake API, writing suggestions with
   evidence onto the profile.
2. A task kind run by Piloti, the answering agent, with an instruction.
3. A fixed extraction pipeline, ADR-0096 widened to every intake key.
4. A ledger of findings in its own table, beside the profile.

## Decision Outcome

Chosen: option 1, with the profile, not a ledger, as the record. An agent of
its own fits the shape of the work: it asks what is still needed, searches,
reads, records, and asks again. Writing onto the profile keeps one record that
the wizard, the chat's prompt view, the brief and the applicability panel
already read.

* **The Erfassungs-Agent** is an agent type on the research worker with its own
  prompt and four tools of its own (`intake_needs`, `record_values`,
  `read_document`, `finish_intake`), beside the existing `list_files`,
  `knowledge_search` and `read_passage`. It acts as the person whose upload or click
  started it, through the signed envelope (ADR-0108).
* **One API.** Person routes under `/api/projects/[id]/intake` and Piloti's
  route `POST /api/internal/project-intake` call the same service
  (`lib/project-intake/`), with zod types exported to JSON Schema for the
  Python tier.
* **A suggestion is a state on the profile** (ADR-0105's first form): an
  `assumption` with `source: agent_suggested` and new optional `evidence`
  (document with file, page and quote; geocoder; derivation; person). A
  contradiction is a list of `alternatives` on the assumption. A document value
  that differs from a confirmed fact becomes an alternative and never replaces
  the fact. Confirming writes the fact through `patchProjectProfile`, the
  profile's one door.
* **The intake definition is the register.** Which keys a project needs is
  computed from the wizard's questions, their conditions and the profile as it
  stands. The questions gain `foundIn`, the documents a value is usually in. No
  second register is written beside it.
* **Decisive is computed.** A gap is asked only when filling it with each value
  it could take gives different Gebäudeklassen. The one derivation built, the
  Gebäudeklasse (OIB-RL Begriffsbestimmungen 2023), is data with its Fundstelle
  and is proposed for confirmation, never set.
* **The BFF decides what a recorded value becomes.** It checks the vocabulary,
  refuses a value a person dismissed, and masks the quote (ADR-0086). The
  Python tool refuses a quote it cannot find in text it read in the same run.
* **Triggered by the work.** A finished upload batch on a project with an
  intake starts a reading of the documents it has not read. A person can start
  one by hand too.
* **A closed project is created active with a closing intent** (outcome and
  period), read, and closed when the person finishes the review. ADR-0090's
  read-only rule stays unchanged.
* The wizard stays, as the second way into the same profile and its editor.

### Consequences

* Good, because a project is usable in under a minute, and its profile fills in
  the background with values a person can check against the page they came from.
* Good, because the answering agent is untouched. It reads suggestions through
  the prompt view it already has.
* Good, because a second country or Land is a change to the intake definition
  and the derivation table. The flow and the agent stay as they are.
* Bad, because a reading can be wrong. A suggestion counts until a person
  dismisses it, and the agent and the brief label it unconfirmed.
* Bad, because the profile's fact and assumption shapes grow two optional
  fields that every reader must tolerate and the wizard must preserve on save.
* Bad, because the agent spends model calls per project. The run is bounded by
  documents and tool calls, and it shows in Langfuse as a research job.
* Neutral: historical editions of the law per Stichtag stay open. The intake
  records the edition the documents name; the corpus holds one.

### Confirmation

* `lib/project-intake/*.spec.ts`: the information need, decisiveness, the GK
  derivation table, and the outcome of a recorded value (vocabulary, dismissed,
  contradiction against a confirmed fact, masking).
* The route specs drive the handlers through `lib/project-intake/client.ts`
  (ADR-0055), and `authz-coverage.spec.ts` covers the new routes.
* `frontends/ui/tests/fixtures/project-intake.schema.json` is generated from the
  zod schemas. `tests/aiq_agent/agents/intake/` validates every body the tools
  build against it, and refuses a quote not found in the text read.
* `rls-coverage.spec.ts` covers `project_intakes` through `grid_secure_table`.
  Its CHECKs are exercised by `task db:test:rls`.

## Pros and Cons of the Options

### 2. A task kind run by Piloti

* Good, because a task row, a run block and the inbox come with it.
* Bad, because Piloti's answering prompt and 28 tools would run a job that needs
  five. Teaching the answering agent the intake's rules in an instruction makes
  them a prompt, and ADR-0060 keeps rules about a tool in the tool.

### 3. A fixed pipeline

* Good, because it is cheap and predictable, and ADR-0096 has the parts.
* Bad, because which keys are asked depends on what is found. A pipeline asks
  for every key at once over a fixed budget of text, which grows with the
  wizard instead of with the project.

### 4. A ledger of its own

* Good, because findings, conflicts and dismissals have a home with constraints.
* Bad, because it is a second record of the same facts. Every reader of the
  profile would have to learn a second place, and the wizard would edit one
  while the agent wrote the other.

## More Information

Design and wire contract:
[`docs/design/agentic-project-intake.md`](../design/agentic-project-intake.md).
The ticket's requirements, and where this deviates from them, are tabled there.

### Amendment, 2026-10-14: tools, not a procedure

The product owner's direction: do not hobble the model; give it tools rather
than a graph or an approach to follow. The intake's prompt no longer prescribes
a numbered loop. It states the goal, why the values matter, the rules a value
must meet and the budget; the model chooses its own order of work, and every
rule about how a tool is used lives in that tool's description (ADR-0060). Two
consequences reach the contract: the `record` gate refuses only a key no wizard
question writes (`unknown-key`, which replaced `not-a-need`), so a value found
before the answer that opens its question is kept; and `needs` lists a
confirmed Gebäudeklasse input as `confirmed` and carries the last reading's
summary (`previousSummary`), so a delta reading can corroborate or contradict
from a newer Stand and does not start blind. The design doc has the details.
