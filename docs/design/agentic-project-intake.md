# Projekterfassung: Piloti sets a project up from its documents

Status: building. Ticket: Notion „Agentische Projekterfassung statt Wizard" (ID 26).
Decision record: [ADR-0111](../adr/0111-piloti-sets-a-project-up-from-its-documents.md).

A person creating a project names it, gives its address and, if they want, one
sentence about it. Then they drop the project's folder. Piloti reads the
documents in the background, suggests every value it finds with the page it
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
| „Nur fragen, was die Einstufung ändert" (C8 logic) | Computed, not listed: a gap is asked only when filling it with each band it could fall in gives different Gebäudeklassen | A hand-kept list of decisive questions is the C8 condition again, written once more. The computation is the rule itself |
| Regelwerks-Ampel | Not built. The confirmed values feed the existing applicability panel (`applicable-standards.ts`), which says per Richtlinie required / likely / check; it now reads the keys the wizard and the intake write | No Ampel exists anywhere in the code. Inventing one is a product decision of its own; the panel is the shipped answer to "which rules apply" |
| Geocoder for AT and DE, address autocomplete | Built for Austria only, behind one BFF route, with Photon (OSM) as the adapter; off unless `GRID_GEOCODER_URL` is set. The address is one text field either way: a chosen hit adds Gemeinde, Bundesland and position, a typed line is kept as the person's `standort_adresse` and the Bundesland is the reading's to find or the review's to ask. (Until 2026-10 the field turned into a Bundesland select when no geocoder answered, which threw away what was typed in every deployment without one.) | Piloti supports Austria only. Buy, don't build. An address is client data, so the provider is the deployment's choice (a self-hosted Photon in production). A second country is a filter and a state mapping in the adapter |
| A point on a map when there is no address (competitions) | The place or Gemeinde name through the same search | A map needs a map library and tiles; what the address decides (Land, Gemeinde) a place name decides too |
| Projektbeteiligte with roles at creation | Not at creation. The Steckbrief already holds people (ADR-0091, ADR-0101) | People are kept apart from the profile and the prompt on purpose, and a step at creation breaks the one-minute target |
| Ablage-Onboarding: folder tree, blacklist, role permissions | Upload, folder access per role and the content check stay as they are. Each folder says what belongs in it, and on every upload Piloti proposes the folder a file belongs in, learned from the office's other projects, confirmed folder by folder (see „Ablage" below) | Upload and access are built (ADR-0078, ADR-0087, ADR-0088, ADR-0086). What was missing is the sorting, and a folder that says what it holds |
| Create a project as „abgeschlossen" and fill it from its documents | The project is created **active with a closing intent** (outcome and period), read, and closed when the person finishes the review | A closed project is read-only (ADR-0090) and refuses profile writes. ADR-0096 reads a closed project the same way: reopen, read, close |
| Historical editions of the law per Stichtag | The intake records the OIB edition the project's documents name (`oib_edition`); the corpus holds one edition today | Keeping every edition of the law is corpus work, not intake work. It stays open, as the ticket says |
| Delta review when a new Stand arrives | A finished upload batch on a project with an intake starts a reading of the documents not read yet (by content hash, so a new Fassung counts). A value that differs from a confirmed one is shown as a contradiction, never written over it | `settleUploadBatches` is where "these documents are read" first becomes true on the server |

Quality of life, because a minute is the target:

- **Same address, earlier project.** When the address typed matches an existing
  project's `site_address` (or one within 50 m), the dialog says so and
  links it: a duplicate is avoided, and an earlier project on the same plot is
  often the best source (Bestandspläne, Bescheide).
- **The folder names the project.** Dropping a folder onto the create dialog
  fills the name from the folder name and uploads it after creation. The address
  may stay empty when documents follow: the agent proposes `site_address`
  from the title blocks like any other value.
- **A Rückfrage is answered by dropping the document on it.** The question names
  the document that would answer it; dropping a file there files it and starts a
  reading, and the question closes when the value is found.

## The shape

```
create dialog ─▶ POST /api/projects  { name, setup: 'piloti', description?, location?, closing? }
                    │ project row + project_intakes row (status: waiting)
                    ▼
/app/projects/{id}/setup ─▶ existing folder upload ─▶ ingest ─▶ settleUploadBatches
                    │ batch completed, project has an intake
                    ▼  BFF job `project_intake_read` as the uploader
startIntakeRun ─▶ submitBackgroundRun ─▶ research worker, agent type `project_intake`
                    │ signed envelope (ADR-0108), scope = the project's main collection only
   Erfassungs-Agent (LangGraph ReAct, own prompt)
     intake_needs   ─────────────▶ POST /api/internal/project-intake {op:'needs'}
     read_document / knowledge_search / read_passage / list_files  (every read is logged)
     record_values  ─────────────▶ {op:'record'}   quote checked against the read log first;
                                                   answers what each became and the needs it opened
     withdraw_values ────────────▶ {op:'withdraw'} only this reading's own suggestions
     finish_intake  ─────────────▶ {op:'needs'}, then {op:'finish'}; held once while decisive
                                                   needs are open and files unread
                    ▼
profile: assumptions (agent_suggested) with evidence; alternatives on assumption or fact
project_intakes: status, documents read, dismissed, counts, job
                    ▼
/app/projects/{id}/setup: Widersprüche · Rückfragen · Prüfen · Ablage · Ableitungen · Abschließen
  decisions ─▶ POST /api/projects/{id}/intake/decisions ─▶ patchProjectProfile
  Ablage    ─▶ the project's open filing suggestions, applied or dismissed through /api/proposals
```

Ablage is not part of the review. It lists the project's open `file_operation`
filing suggestions (`listOpenProposals({ projectId, kind: 'file_operation' })`)
in the `FilingBar` that sits above a folder in Dateien and in the upload tray:
one line per target folder with its full path, „neu“ where the move creates it,
the count, and „Belassen“ / „Verschieben“ (or „Anlegen und verschieben“). The
page shows no cards to light, so each line also names its files. A decision here
is the same proposal, inbox item and score as there. It is a quiet secondary
section, the card surface with one hairline: nothing when there is no open
suggestion, and nothing once the setup is finished.

### Why an agent of its own, on the research worker

The work has a different shape from a chat turn. It has no question, it runs for
minutes, nobody waits on it, and its output is values on the profile. ADR-0105:
a turn does not outlive its answer; long work is a run. Piloti's answering
prompt and its 28 tools are tuned for answers. The intake needs a handful of
tools and a prompt that says what a value is and when it counts as found.

The research worker already gives a long run what it needs: the claim queue
with per-organization fairness (ADR-0079), heartbeat and reaper, cancellation,
the envelope injected at claim (ADR-0108), and a `research-job` trace in
Langfuse. A BFF job calling a synchronous Python loop would rebuild all of that
on the `api` role, which ADR-0082 does not size for long work.

The agent is not a pipeline, and its prompt prescribes no procedure (the
product owner, 2026-10-14: "provide tools rather than explicitly stating a
graph or an approach it should take"). The prompt (`prompts/system.j2`) says
who Piloti is, why the values matter, the goal (a profile a person can confirm
page by page; an open value is a correct result), the rules a value must meet,
what each tool is for in one line, and the budget as information; the model
chooses its own way through the documents. How each tool is used, what its
answer means and what to do on a refusal live in the tool's description
(ADR-0060). The opening message is the project's state, the `needs` answer
with the last reading's summary beside it, given as context to save a first
call. Its main reading tool reads a document's pages in full
(`read_document`); the search tools find where a value is.

The run's budgets are `max_tool_steps` (80) and `max_run_seconds` (1200) on
`ProjectIntakeAgentConfig`, handed to the agent by the runner
(`_create_agent_instance`). The finish is guaranteed in code: past the step
budget only `finish_intake` runs, and a run that stops, times out or fails is
finished with a summary written in code.

Two answers let the model see what its own work changed. A `record` answer
names the needs the values opened (`building_type = gebaeude` opens the
Gebäude's Geschoße, Fluchtniveau and areas, decisive ones marked), computed
from the needs before and after the same write; a model that read the opening
needs once and never asked again finished with them unseen. And
`finish_intake` holds the model's first call once, naming the decisive needs
still open and the files no reading has opened, when there are both; a
second call finishes. Past the step budget it never holds, and the finish in
code calls the tool's function past that check. `finish_intake` is therefore
not `return_direct`: the run ends before the next model call once the intake
is finished (`IntakeToolMiddleware.abefore_model`).

A reading may take back a suggestion it recorded itself (`withdraw_values`):
the eval's boot model recorded a Wärmeversorgung the Baubeschreibung calls
undecided, said so in its own summary, and had no way to undo it. Only an
`agent_suggested` value no person confirmed, carrying this reading's id
(`readingId` on the assumption), may go; a person's value, a confirmed fact,
the derived class and an earlier reading's suggestion stay. A withdrawal is
not a dismissal: no person said no, so nothing is added to `dismissed` and a
later reading may suggest the value again, where a dismissed one stays
refused.

### Why the profile, not a ledger of its own

A value Piloti found is a suggested state on the profile, the way ADR-0096
already writes them: an `assumption` with `source: agent_suggested`. Adding
the evidence to it keeps one record that the wizard, the chat's prompt view,
the brief and the applicability panel already read. ADR-0105 names "a proposed
state on the object" as one form a proposal may take.

## Decisions the review settled

An adversarial review against the code (2026-10-14) changed the first draft:

1. **Wizard save kept the suggestions.** `mergeIntakeProfile` dropped every
   earlier assumption under an intake key, so opening the wizard and saving
   deleted the whole reading. It now keeps an `agent_suggested` assumption
   unless the save brings a fact or assumption for that key, and carries
   `evidence` over when the value is unchanged.
2. **A contradiction with a confirmed fact lives on the fact.**
   `pruneResolvedAssumptions` removes an assumption whose key has a fact on
   every write, so `alternatives` is a field of facts and of assumptions.
3. **New fields are lenient.** `evidence` and `alternatives` are optional and
   `.catch(undefined)`: `salvage.ts` parses fact by fact, and a malformed
   evidence must not cost the fact.
4. **The prompt view stays bounded.** Evidence renders on `assumptions:` lines
   as `[Vorschlag: <file>, S. <n>]`, without quotes; a `contested:` section
   lists keys with alternatives; `confirmed:` lines do not change (Python's
   `facts_from_project_context` reads them). The view says it is bounded.
5. **Decisive needs bands.** Metres and m² have infinitely many values, so the
   derivation declares bands per numeric input. A key is decisive when the
   cartesian product of the open inputs' bands and options gives more than one
   class.
6. **Only files every member may open are read.** The profile is read by every
   member (ADR-0087, ADR-0096). The gate is `extractableFileNames`
   (`lib/project-experience/readable-files.ts`): the run's scope is the
   project's main collection, and `record` refuses evidence from any other file.
7. **A stale run cannot write.** Every internal op carries `jobId`; the route
   refuses unless `project_intakes.job_id = jobId` and the status is `reading`.
8. **Failure reaches the BFF.** A run with no `task_runs` row has its outcome
   dropped today; the outcome route falls back to `project_intakes.job_id`, and
   the intake view reconciles a reading older than 30 minutes with
   `fetchBackendJobOutcome`.
9. **One score.** A decided suggestion posts the existing `piloti-decision`
   score on the run's trace, with `kind = intake_suggestion`.
10. **English in code, German in copy.** Statuses `waiting | reading | ready |
    failed | completed`, route `/app/projects/[id]/setup`.
11. **The answer is the wizard's control.** Answering a Rückfrage renders the
    wizard's own question field for that key and writes through the profile's
    one door; `frontends/ui/AGENTS.md`'s "one editor" rule is amended to say so.
12. **Overlap with ADR-0096.** For a closing intent, the intake's reading
    replaces the experience reading's fingerprint; the experience's decision
    drafting stays where it is.

## The information need

`lib/project-intake/needs.ts`, `computeNeeds(profile, definition, { mode, dismissed })`,
a pure function. The agent's `intake_needs` returns its result.

1. Every question whose conditions hold for the answers known so far (facts,
   then suggestions, through `answersFromProfile`) and that writes a profile
   key, scoped per Bauwerk as the wizard scopes it (`key@bldgN`). The Bundesland
   is asked unless another country was chosen (`excludes_any` on `A2_country`):
   a reading finds „Bundesland: Wien“ long before any document names Austria.
2. Minus what is confirmed, and minus keys a person marked unknown. A key with
   only a suggestion stays, as `state: 'suggested'`, so the agent can corroborate
   it or find a contradiction. A confirmed Gebäudeklasse input stays too, as
   `state: 'confirmed'`, never decisive and listed last, so a reading of a newer
   Stand can corroborate it or bring a contradiction a person decides. The
   review's `questions` stay the decisive `open` needs only.
3. Each need carries the label, the type and the option tokens, the unit, the
   `why`, `foundIn`, and `decisive`.
4. In `mode: 'closing'` nothing is decisive: what matters is what the documents say.

## The location register

`lib/project-intake/location-register.ts`, `locationRegisterFor(...)`, pure,
carried on the view as `locationRegister` for step 4, Rückfragen. The ticket's
„Der Standort bestimmt den Informationsbedarf" and its table „Standortinformationen
aus den Unterlagen", as data (`LOCATION_REGISTER`): per determinant (Grundstück,
Widmung und Bebauungsbestimmungen, Denkmal- und Ortsbildschutz, Naturgefahren
und Altlasten, Lärm) the wizard keys it settles, when it applies (Vorhaben,
Nutzungen, a Bestand; an unknown input counts as applying), the document to
ask for, the reason, and per Bundesland or Gemeinde only what differs (Wien's
Plandokument, each Land's Raumordnungsgesetz, the Graz and Salzburg Altstadt
laws). Every entry cites its law by title; a section number not yet checked
against the text is `needsReview`. A request is settled when each key holds a
value, a suggestion or „nicht bekannt". The Bundesland comes from the profile,
else the geocoder; while it is open it is asked first (a typed address has
none), with the Vorhaben. A `closing` project is asked its Bundesland and no
document. The agent learns the same documents through `foundIn` on the needs
(`grundstueck_ez` and `grundstuecksflaeche`, questions `B0_ez` and
`B0_flaeche`, were added for the Grundbuchauszug). Not modelled: the Stichtag
and Standortdienste, as below.

## The Gebäudeklasse derivation

`lib/project-intake/derivations.ts`. Nine inputs per Bauwerk: `building_type`
(only a Gebäude has a class), `building_position`, `access_three_sides` (asked
by the wizard's question `C9_zugang`, added for this), `storeys_above_ground`,
`escape_level_m`, `gfa_above_ground`, `use_units`, `units_over_400`
and `uses` (a reines Wohngebäude opens GK 2 up to 800 m²). Fundstelle:
OIB-Richtlinien, Begriffsbestimmungen (Ausgabe Mai 2023), „Gebäudeklassen".

The repository holds GK 4 verbatim and GK 1–3 and 5 only as the office's own
published paraphrase (`frontends/web/src/data/landing/glossary.ts`); the
Richtlinie is the authority, and the rules in code say which they quote and
which they paraphrase. Where the wizard's questions are coarser than the
definition, the code errs towards the higher class and says so: GK 1's
„höchstens zwei Wohnungen oder eine Betriebseinheit" is read as at most two
units, GK 4's per-unit Nutzfläche is read from the BGF question C8, and a
Reihenhaus takes the Bauwerk's Fluchtniveau, not each unit's.
`derivations.spec.ts` holds the test table, with the boundaries at 7, 11 and
22 m, 400 and 800 m², and 3 and 4 Geschoße.

When every input it needs has a value (confirmed or suggested), the intake
writes `building_class@bldgN` as an assumption, the class as a number 1..5 (as
`similarity.ts` and the experience reading store it), with `derivation`
evidence naming its inputs and whether any is still only suggested. A
Fluchtniveau above 22 m is no Gebäudeklasse: the derivation says Hochhaus
(OIB-RL 2.3) and writes nothing; the applicability panel reads `escape_level_m`
itself.

## Data

### `project_intakes` (migration 0144)

| Column | Holds |
|---|---|
| `id` uuid pk, `organization_id`, `project_id` unique | composite FK `(project_id, organization_id)` → `projects` on delete cascade; RLS by `secure_table` |
| `created_by` | who created it |
| `mode` | `active` or `closing`; CHECK `(mode = 'closing') = (closing IS NOT NULL)` |
| `description` | the person's „Worum geht es?", ≤ 500 |
| `location` jsonb | the geocoder's result when one was chosen (`GeocodeResult`), else null |
| `closing` jsonb | `{ outcome, startedOn?, endedOn }` for a closing intent |
| `status` | `waiting`, `reading`, `ready`, `failed`, `completed` (CHECK) |
| `job_id`, `requested_by`, `trace_id` | the current or last reading; `job_id` partial unique |
| `rerun_requested` | a trigger arrived during a reading |
| `documents_read` jsonb | `[{ documentId, contentHash }]` |
| `reading_files` jsonb | file names the current or last reading opened, reported while it runs (`progress`, migration 0157); emptied at a claim |
| `dismissed` jsonb | `[{ key, value }]` a person dismissed, so they are not suggested again |
| `counts` jsonb | `{ documentsRead, suggested, contradictions, decisiveOpen }` at the last finish |
| `summary` | the agent's closing sentence |
| `started_at`, `finished_at`, `completed_at`, `completed_by`, `created_at`, `updated_at` | |

CHECKs: `status` known; `completed_at` and `completed_by` exactly when
`completed`; `job_id` set when `reading`; `documents_read` and `dismissed`
arrays; `mode` known.

### Profile fields (`lib/project-profile/types.ts`)

```ts
evidence?: ProfileEvidence[]      // on ProjectFactSchema and ProjectAssumptionSchema, ≤ 5
alternatives?: ProfileAlternative[] // on both, ≤ 5
ProfileEvidence =
  | { kind: 'document', fileName, page: number | null, quote }      // quote masked (ADR-0086), ≤ 400
  | { kind: 'geocoder', provider: 'photon', label, resolvedAt }
  | { kind: 'derivation', rule: 'building_class', citation, inputs: [{ key, value, suggested }] }
  | { kind: 'person', userId, at }
ProfileAlternative = { value, evidence: ProfileEvidence[], recordedAt }
readingId?: string                  // on ProjectAssumptionSchema: the reading (job id) that suggested it
```

## Wire contracts

All zod lives in `frontends/ui/src/lib/project-intake/types.ts` (no
`server-only`), exported as JSON Schema to
`frontends/ui/tests/fixtures/project-intake.schema.json` by
`lib/project-intake/intake-schema.ts` (the `proposal-schema.ts` pattern).

### Person routes (`lib/project-intake/client.ts`, ADR-0055)

| Route | Body | Does | Gate |
|---|---|---|---|
| `GET /api/projects/[id]/intake` | — | `IntakeView`: status, counts, needs, suggestions grouped by the wizard's modules (each with evidence and alternatives), contradictions, derivations, closing intent | `project:view` |
| `POST /api/projects/[id]/intake` | `{ scope: 'new' \| 'all' }` | start a reading now (`all` forgets `documents_read`) | profile write (`project:memory:write` or `project:edit`) |
| `POST /api/projects/[id]/intake/decisions` | `{ decisions: [{ key, action: 'confirm' \| 'dismiss' \| 'answer' \| 'unknown', value?, alternativeIndex? }] }`, 1..60 | confirm writes the suggestion (or the chosen alternative) as a fact with its evidence; answer writes the person's value as a fact with `person` evidence; dismiss removes the suggestion and remembers it; unknown records the key as „nicht bekannt" | profile write |
| `POST /api/projects/[id]/intake/complete` | — | finish the review; for a closing intent, `setProjectStatus(closed)` with its outcome and period | `project:manage` when closing, else profile write |

`IntakeView` (sketch):

```ts
{
  status, mode, description, location, closing,
  counts: { documentsRead, unreadDocuments, suggested, contradictions, decisiveOpen },
  readingStartedAt, readingFinishedAt, summary,
  contradictions: Suggestion[],
  questions: Need[],                         // decisive, open
  groups: [{ stage: 'A'..'G', title, items: Suggestion[] }],
  derivations: [{ buildingId, rule: 'building_class', value: 1..5 | null, hochhaus: boolean, inputs, missing: string[] }],
}
Suggestion = { key, baseKey, buildingId, label, value, display, state: 'suggested' | 'confirmed' | 'contested',
               evidence: ProfileEvidence[], alternatives: ProfileAlternative[], decisive }
```

### Piloti's route: `POST /api/internal/project-intake`

Signed envelope (ADR-0054 §4, ADR-0108), pinned session, the project from the
envelope, `withTenant`. Discriminated on `op`, each branch strict, each with
`jobId`:

| op | Body | Answer |
|---|---|---|
| `needs` | `{ jobId }` | `{ needs: Need[], unreadFiles: string[] (≤ 200), description, location, mode, previousSummary }` (`previousSummary`: the last finished reading's stored, masked summary, or null) |
| `record` | `{ jobId, values: [{ key, value, evidence: { fileName, page, quote } }] }` (1..20) | `{ results: [{ key, outcome: 'suggested' \| 'corroborated' \| 'contradiction' \| 'refused', reason?: 'vocabulary' \| 'unknown-key' \| 'dismissed' \| 'unreadable-file' }], opened: [{ key, decisive }] }` |
| `withdraw` | `{ jobId, keys: string[] }` (1..20) | `{ results: [{ key, outcome: 'withdrawn' \| 'refused', reason?: 'nothing-suggested' \| 'confirmed' \| 'not-this-reading' }] }` |
| `progress` | `{ jobId, filesOpened: string[] }` (≤ 500), every file the run opened so far, sent after a tool call that opened a new one | `{ filesOpened }`. Stored in `reading_files` (migration 0157) for the setup page's live „x von y gelesen" (step 3); never what decides the next reading's unread files |
| `finish` | `{ jobId, summary (≤ 2000), documentsRead: string[] (≤ 500), traceId: string \| null }` | `{ status }` |

A stale `jobId` answers 409 `stale-reading`. The BFF decides what a value
becomes: a token outside the question's vocabulary is refused; a key no wizard
question writes, in the scope that question is asked in, or on a Bauwerk the
profile does not describe, is refused (`unknown-key`; `questionForKey` in
`needs.ts`), while a key whose question is not asked yet is taken, so the
Wohnungen found before the Nutzungen that open them are kept and a batch has no
order dependency; `building_class@bldgN` is always refused, beside a confirmed
class too, because the class is derived from its inputs and only proposed (and
it is what an injected line asks for); a value a person dismissed is refused; evidence from a
file outside `extractableFileNames` is refused; a value equal to a confirmed
fact corroborates it (its evidence is added); a different one becomes an
alternative on the fact (a contradiction); a different suggestion already
present becomes an alternative on the assumption; the quote is masked before it
is stored. After each `record` and `withdraw`, the derivation runs and writes
or refreshes `building_class@bldgN`, and removes a derived class whose inputs
are gone.

The Python tool checks first: a quote it cannot find (NFC, folded whitespace and
case) in text it read in this run, in that file, is refused before any request,
and the refusal shows the closest passage it did read there, with its page, so
the next call can quote it. The tool takes the citation as a reading tool
printed it (`Baubeschreibung.pdf, p.3`) or `fileName` and `page`; the wire
body is always `{ fileName, page, quote }`. An `unknown-key` refusal names the
closest keys `intake_needs` listed.
For select keys, `knowledge/fingerprint_verify.verify_fingerprint` asks whether
the quote states the value, as ADR-0096 does.

## Ownership of the build

| Slice | Files |
|---|---|
| 0 Contract | `lib/project-intake/types.ts`, `intake-schema.ts` (+spec, fixture), `lib/project-profile/types.ts` (fields), migration 0144 + down + journal, `lib/db/schema/project-intakes.ts`, signatures of `needs.ts` and `derivations.ts` |
| 1 Profile substrate | `salvage.ts`, `intake-definition.ts` (`mergeIntakeProfile`, `foundIn`, `feeds`), `prompt-view.ts`, `project-experience/service.ts` + shared `lib/project-intake/evidence.ts` |
| 2 Needs and derivation | `lib/project-intake/needs.ts`, `derivations.ts` (+specs) |
| 3 BFF service and routes | `lib/project-intake/{repository,service,run,client}.ts`, the four routes, outcome fallback, settle hook and BFF job, inbox type, `submitBackgroundRun` in `lib/jobs/service.ts` |
| 4 Worker hosting | `aiq_api/registry.py`, `aiq_api/jobs/runner.py` |
| 5 The agent | `src/aiq_agent/agents/intake/`, `pyproject.toml` entry point, `configs/config_oib_openrouter.yml`, `project_context.TOOL_CONTEXT_REQUIREMENTS` |
| 6 Create flow and UI | `lib/projects/service.ts`, `app/api/projects/route.ts`, `projects/actions.ts`, `create-project-form.tsx`, `app/app/(shell)/projects/[id]/setup/`, `features/project-intake/`, `/dev/project-setup`, i18n |
| 7 Docs | ADR-0111, this doc, `where-is-what.md`, `CONTEXT.md`, `langfuse.md`, `python-endpoints.md`, `frontends/ui/AGENTS.md` |

## Ablage: the files into documented folders

Product decision (2026-10-14), revised the same day: filing belongs to the
Files workspace, for every upload on either shelf (Dateien and the
Büroablage), whether or not a project has an intake. The intake is one reader
of the result, not its home. The design is in
[`proposed-changes.md`](../architecture/proposed-changes.md#filing-suggestions);
what it means for the intake:

- **A folder has a description.** `project_folders.description` (≤ 500
  characters, migration 0145), on both shelves, written in Dateien and the
  Büroablage, and handed to the agents with the folder tree
  (`FOLDER_DESCRIPTIONS v1`).
- **Piloti proposes, folder by folder.** Every upload batch is judged twice as
  its uploader (`filing_review`): from the names at the seal, from what
  ingestion read at the settle. Each target folder is one `file_operation`
  proposal with no conversation, so a person confirms per folder („bestätigt
  pro Ordner, nicht pro Datei") with the proposals' own apply and dismiss. A
  folder the project does not have yet is proposed as the move's `new_folder`:
  one confirm creates it with its description and files into it.
- **The structure is learned from the office**: the folder paths and
  descriptions of the projects the uploader may open, and the Dokumentarten
  filed in them, with an Austrian default (Grundlagen, Bestand, Behörde und
  Bescheide, Einreichung, Fachplaner, Ausführung) only when the office has
  none. The model chooses; code only checks.
- **What the setup page shows** is the project's open proposals
  (`GET /api/proposals?projectId=…&kind=file_operation`), not a plan of its
  own. The earlier plan here (a `project_intakes.filing_plan` column and a
  `propose_filing` intake tool) is dropped: it would have been a second record
  and a second confirm for the same decision.

## Observability (ADR-0089)

- The run is a `research-job` trace (`agent: project_intake`); the worker's
  exporter covers its model calls. Trace metadata: documents read, values
  recorded, refusals by reason, contradictions, decisive gaps.
- A decided suggestion posts `piloti-decision` with `kind = intake_suggestion`
  on the run's trace: the reading's precision, per organization.
- Before a change ships, `task be:eval:intake` runs the agent on a fixture
  Wohnbau with planted traps and reports precision, recall, the traps and the
  cost against floors ([the intake eval](../contributing/testing-and-verification.md#the-intake-eval)).

## Not built, and why

- A Regelwerks-Ampel beyond the applicability panel; OIB-6 categories; other
  derivations. One derivation proves the mechanism; each more is a row.
- Editions of the law per Stichtag. Corpus work.
- A German catalogue. The machinery takes `country`; the catalogue is Austria's.
- Standortdienste (BEV, Landes-GIS, HORA, Denkmalliste). Deferred by the ticket.
- People from documents into the Steckbrief.
- Restricted folders: never read by the intake; their documents may not feed a
  profile every member reads.

## The profile's names are English (migrations 0159 to 0162)

The profile's keys, option tokens and building ids are English: `federal_state`,
`uses@bldg1@residential`, `construction_method=timber`, `building_class@bldg1`
(rule `building_class`). Labels and copy stay German; only the stored name changed.

- **One table.** `frontends/ui/src/lib/project-profile/legacy-names.json` maps
  every old key, the tokens per new key (`offen` is `open` under a zoning, but
  `ja` is only `yes` under `servicing`, so a token is never renamed on its own),
  the derivation rule and the building prefix. `legacy-names.ts` and
  `aiq_agent/profile_names.py` are generated from it and held to it by specs;
  migration 0159 embeds the same table.
- **One release of tolerance.** Readers accept the old names and map them with
  `normalizeLegacyProfile`, `normalizeProfilePatchOperation`,
  `normalizeLegacyPromptView` (TypeScript) and `normalize_prompt_view` (Python);
  nothing writes them. A pod that has not rolled can still write German names
  during a deploy; the next read renames them. Delete the tolerance (and the
  `legacy-names` files) in the release after the one that ships 0159.
- **What the migrations rewrite.** 0159 `projects.profile` and
  `profile_prompt_view` (and bumps `profile_version`); 0160
  `project_intakes.dismissed` and `location`; 0161
  `document_roles.scope_instance_id` (`bwN` to `bldgN`) and the patches of
  `project_profile` proposals; 0162 adds `permit_records.federal_state` beside
  `bundesland`, kept in step by a trigger until a later migration drops the old
  column. A key the table does not know (an agent-invented fact) is kept as is,
  so scan the distinct keys before deploying.
- **Qdrant stays German** until the retrieval rename: `ProjectFacts.to_store()`
  and `SimilarityWeights.to_store()` translate at the aiq_api boundary.
