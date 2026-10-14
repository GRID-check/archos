# Projekterfassung: Piloti sets a project up from its documents

Status: building. Ticket: Notion „Agentische Projekterfassung statt Wizard" (ID 26).
Decision record: [ADR-0111](../adr/0111-piloti-sets-a-project-up-from-its-documents.md).

A person creating a project names it, gives its address and, if they want, one
sentence about it. Then they drop the project's folder. Piloti reads the
documents in the background, proposes every value it finds with the page it
found it on, works out the Gebäudeklasse, and asks only for what would change
that classification. The person checks and confirms. The wizard stays: it is the
other way to fill the same profile, and the place to edit it by hand.

## What the ticket asked, and what this builds instead

The ticket is the business requirement. Where the codebase already does part of
it, or where building it as written would contradict a decision already made,
this design says so and builds the version that fits.

| Ticket | Built | Why |
|---|---|---|
| Replace the wizard | A second way into the same profile, offered at creation; the wizard stays the editor | The profile has one record and the wizard is its guided editor (`frontends/ui/AGENTS.md`). Two ways to fill one record keep a single truth; a replacement would throw away 2 300 lines of conditions and rationale this design reads from |
| A new Determinanten-Register with rule, threshold, Ampel effect, where found, question | The intake definition **is** the register: its questions already carry conditions, rationale (`why`) and the profile key. This adds where a value is usually found (`foundIn`) and which derivation it feeds. The one derivation built is the Gebäudeklasse, as data with its Fundstelle | `compliance-derivation-graph.md` §2 counts five encodings of one rulebook already. A sixth table beside the wizard's would drift from it the first time someone edits a question |
| „Nur fragen, was die Einstufung ändert" (C8 logic) | Computed, not listed: a gap is asked only when filling it with each value it could take gives different Gebäudeklassen | A hand-kept list of decisive questions is the C8 condition again, written once more. The computation is the rule itself |
| Regelwerks-Ampel | Not built. The confirmed values feed the existing applicability panel (`applicable-standards.ts`), which already says per Richtlinie required / likely / check | No Ampel exists anywhere in the code. Inventing one is a product decision of its own; the panel is the shipped answer to "which rules apply" |
| Geocoder for AT and DE, address autocomplete | Built for Austria only, behind one BFF route, with Photon (OSM) as the adapter; off unless `GRID_GEOCODER_URL` is set, then the Bundesland is chosen by hand as today | Piloti supports Austria only. Buy, don't build. An address is client data, so the provider is the deployment's choice (a self-hosted Photon in production). A second country is a filter and a state mapping in the adapter |
| A point on a map when there is no address (competitions) | The place or Gemeinde name through the same search | A map needs a map library and tiles; what the address decides (country, Land, Gemeinde) a place name decides too |
| Projektbeteiligte with roles at creation | Not at creation. The Steckbrief already holds people (ADR-0091, ADR-0101) | People are kept apart from the profile and the prompt on purpose, and a step at creation breaks the one-minute target |
| Ablage-Onboarding: folder tree, blacklist, role permissions | The existing folder upload, folders and folder access per role | Built already (ADR-0078, ADR-0087, ADR-0088, ADR-0086). The intake reads what is uploaded; it does not upload a second way |
| Create a project as „abgeschlossen" and fill it from its documents | The project is created **active with a closing intent** (outcome and period), read, and closed when the person confirms the review | A closed project is read-only (ADR-0090) and refuses profile writes. ADR-0096 reads a closed project the same way: reopen, read, close |
| Historical editions of the law per Stichtag | The intake records the OIB edition the project's documents name (`oib_ausgabe`); the corpus holds one edition today | Keeping every edition of the law is corpus work, not intake work. It stays open, as the ticket says, and is named in the ADR |
| Delta review on a new Planstand | A finished upload batch on a project with an intake starts a reading of the new documents only. A value that differs from a confirmed one is shown as a contradiction, never written over it | `settleUploadBatches` is where "these documents are read" first becomes true on the server |

## The shape

```
create dialog ─▶ POST /api/projects (name, address → jurisdiction, description, mode)
                    │ project row + project_intakes row (status: wartet)
                    ▼
upload (existing folder upload) ─▶ ingest ─▶ settleUploadBatches
                    │ batch completed, project has an intake
                    ▼
startIntakeRun ─▶ research worker: agent type project_intake (ADR-0108 envelope)
                    │
   Erfassungs-Agent (LangGraph, own prompt, own tools)
     intake_needs ──▶ GET what is still open, and why        ┐
     list_files / knowledge_search / read_passage (existing) │ one API:
     record_value(key, value, file, page, quote) ─────────────┤ POST /api/internal/project-intake
     mark_read(files) / finish(summary)                       ┘ (signed envelope, pinned session)
                    │
                    ▼
profile: assumptions with evidence (agent_suggested) · contradictions as alternatives
project_intakes: status, documents read, counts
                    │
                    ▼
/app/projects/{id}/erfassung: Rückfragen · Steckbrief prüfen · Ableitungen
  confirm / dismiss / answer ─▶ /api/projects/{id}/intake/... ─▶ patchProjectProfile (the profile's one door)
```

### Why an agent of its own

The work has a different shape from a chat turn. It has no question, it runs
for minutes, nobody waits on it, and its output is values on the profile rather
than an answer. ADR-0105 says a turn does not outlive its answer and long work
is a run. Piloti's answering prompt and its 28 tools are tuned for answers; the
intake needs five tools and a prompt that says what a value is and when it
counts as found. So the Erfassungs-Agent is a separate agent type on the
research worker, registered beside the deep researcher, with its own prompt and
tool list. Piloti's answering agent does not change: it sees the result through
the profile it already reads (the prompt view renders a suggestion with where it
was found).

It is not a pipeline either. ADR-0096 reads a closed project in three fixed
model calls over 24 000 characters. That fits a fingerprint of six keys. The
intake asks for up to fifty keys, and which ones depends on what it has found
(a Wohnbau asks for the number of Wohnungen, a Garage for its area). The agent
asks the API what is still needed, searches for it, reads the passage, records
it, and asks again.

### Why the profile, not a ledger of its own

A value Piloti found is a suggested state on the profile, the way ADR-0096
already writes them: an `assumption` with `source: agent_suggested`. Adding the
evidence to it, rather than a parallel table of findings, keeps one record that
the wizard, the chat's prompt view, the brief and the applicability panel all
already read. ADR-0105 names "a proposed state on the object" as one of the two
forms a proposal may take; this is that form.

What the profile could not say before, and now does:

- **`evidence`** on a fact and on an assumption: where it comes from
  (`document` with file, page and quote; `geocoder` with provider and date;
  `derivation` with the rule, its Fundstelle and its inputs; `person`).
- **`alternatives`** on an assumption: other values the documents state for the
  same key, each with its evidence. A key with alternatives is a contradiction
  and is shown first. A document value that differs from a confirmed fact lands
  as an alternative too, never over the fact.

The `project_intakes` row holds only what is not a profile value: the
jurisdiction the address resolved to, the person's description, the closing
intent, the status, the documents read, the values a person dismissed (so the
agent does not suggest them again), and the run.

## The information need

`needs.ts` computes, from the intake definition and the profile as it is now,
which keys this project needs. It is a pure function and the agent's
`intake_needs` returns its result.

1. Every question whose conditions hold for the answers known so far (facts,
   then suggestions) and that writes a profile key, scoped per Bauwerk as the
   wizard scopes it.
2. Minus what is confirmed. A key with only a suggestion stays in the list as
   `suggested`, so the agent can add evidence or find a contradiction.
3. Each entry carries the label, the type and the vocabulary (option tokens),
   the unit, the `why`, `foundIn` (the documents a value is usually in), and
   whether it is **decisive**.

**Decisive** is computed: a key is decisive when the Gebäudeklasse derivation,
evaluated over every value the open inputs could take, gives more than one
class, and this key is one of those open inputs. A closed project's intake
never marks anything decisive: what matters there is what the documents say.

## The Gebäudeklasse derivation

`derivations.ts` holds the one derivation as data: its inputs (profile keys),
its Fundstelle (OIB-Richtlinien, Begriffsbestimmungen, Ausgabe 2023, „Gebäudeklassen"),
and a pure function from inputs to a class. It is evaluated per Bauwerk. When
every input it needs has a value (confirmed or suggested), the intake proposes
`gebaeudeklasse` as an assumption with `derivation` evidence naming the inputs
and whether any of them is still only suggested. A person confirms it like any
other value. The skill text in the Richtlinie stays the authority; the
derivation cites it.

Fluchtniveau above 22 m is not a Gebäudeklasse; it proposes the band `>22m`
(Hochhaus, OIB-RL 2.3) for `fluchtniveau`, which the applicability panel reads.

## Wire contracts

### Person routes (`lib/project-intake/client.ts`, ADR-0055)

| Route | Does | Gate |
|---|---|---|
| `GET /api/projects/[id]/intake` | The intake view: status, counts, needs (with decisive), suggestions grouped by topic with evidence and alternatives, derivations | `project:view` |
| `POST /api/projects/[id]/intake` | Start (or restart) a reading now, `{ scope: 'new' \| 'all' }` | `project:edit` |
| `POST /api/projects/[id]/intake/decisions` | `{ decisions: [{ key, action: 'confirm' \| 'dismiss' \| 'answer' \| 'unknown', value? }] }` (1..60). Confirm writes the suggestion (or the chosen alternative) as a fact with its evidence; answer writes the person's value as a fact with `person` evidence; dismiss removes the suggestion and remembers it; unknown records the key as „nicht bekannt" | `project:edit` or `project:memory:write` (the profile's write gate) |
| `POST /api/projects/[id]/intake/complete` | Finish the review. For a closing intent, closes the project with its outcome and period | `project:manage` when closing, else the profile's gate |

### Piloti's route (`POST /api/internal/project-intake`)

Signed envelope (ADR-0054 §4, ADR-0108), pinned session, the project from the
envelope. One route, an `op`:

| op | Body | Answer |
|---|---|---|
| `needs` | — | `{ needs: Need[], documentsRead: string[], description, jurisdiction, mode }` |
| `record` | `{ values: [{ key, value, evidence: { fileName, page?, quote } }] }` (1..20) | per value `{ key, outcome: 'suggested' \| 'corroborated' \| 'contradiction' \| 'refused', reason? }` |
| `mark_read` | `{ fileNames: string[] }` | `{ documentsRead: number }` |
| `finish` | `{ summary: string }` | `{ status }` |

The JSON Schema for the Python tier is generated from the zod schemas
(`frontends/ui/tests/fixtures/project-intake.schema.json`), and
`tests/aiq_agent/agents/intake/` validates the bodies the tools build against it.

The BFF, never the agent, decides what a recorded value becomes: a token outside
the question's vocabulary is refused; a value equal to a confirmed fact adds
nothing; a different one becomes an alternative (a contradiction); a value a
person dismissed is refused; the quote is masked (ADR-0086) before it is stored.
The Python tool refuses a quote it cannot find in text it read in this run, so
nothing reaches the BFF that the documents do not say word for word.

## What people see

- **Create dialog**: Name, Adresse (search), „Worum geht es?" (optional), Status
  (aktiv / abgeschlossen with outcome and period, as today), and how to set it
  up: „Piloti richtet ein" (default) or „Selbst ausfüllen" (the wizard).
- **`/app/projects/{id}/erfassung`**: a drop zone for the project's folder while
  nothing is uploaded; the reading's progress („23 Dokumente gelesen · 41 Werte ·
  3 Widersprüche · 5 Rückfragen"); then, in this order, Widersprüche,
  Rückfragen (decisive gaps, each with its question, why it matters and which
  document would answer it, answered inline or by uploading that document),
  Steckbrief prüfen (suggestions grouped by the wizard's modules, each with its
  source „Baubeschreibung.pdf, S. 3: ‚…'", confirm one or „Alle übernehmen"),
  Ableitungen (the Gebäudeklasse with its inputs), and „Erfassung abschließen".
- The chat is usable from the first minute; the prompt view tells Piloti which
  values are suggestions and where they come from.
- An inbox item when a reading finishes: „Piloti hat 23 Dokumente gelesen – 5
  Rückfragen" (`piloti.intake_ready`).

## Observability (ADR-0089)

- The run is a `research-job` trace with `agent: project_intake`; its model calls
  are covered by the worker's exporter.
- Score `intake-suggestion-decision` (bff): per decided suggestion, `confirmed`
  or `dismissed`, on the run's trace: the precision of the reading.
- Trace metadata: documents read, values recorded, contradictions, decisive gaps.

## Not built, and why

- A Regelwerks-Ampel beyond the applicability panel; OIB-6 categories; other
  derivations. One derivation proves the mechanism; each more is a row.
- Editions of the law per Stichtag. Corpus work (see above).
- A German question catalogue. The machinery takes `country`; the catalogue is
  Austria's (`country-extensibility.md`, step 6).
- Standortdienste (BEV, Landes-GIS, HORA, Denkmalliste). Deferred by the ticket.
- People from documents into the Steckbrief.
