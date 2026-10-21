---
status: proposed
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner; north-star scene 5 (`docs/architecture/north-star-answers.md`, `ns-notice-new-document`)
informed: everyone working on Fassungen, the review canvas, the inbox and the job pool
---

# Piloti notices a new Fassung: it compares it unasked and leaves proposed marks where it changed

## Context and Problem Statement

North-star scene 5 (`docs/architecture/agent-capabilities.md`): „A new Fassung
arrives. Piloti checks it against the last one, the fire-safety report and the
zoning plan, and leaves a marked note on the drawing where something no longer
fits." The capability register lists „Notice unasked" as **absent**: no trigger
reviews a new Fassung against its context.

Every part a notice needs already exists, each started by a person:

- **The trigger.** A Fassung under another name is linked to the older document
  at ingestion (the upload dialog, a title block) or by a person
  (`PUT /api/documents/[id]/revision`). `notifyNewRevision`
  (`lib/documents/revision-notify.ts`) announces it once per Fassung, claimed in
  `document_revision_announcements`, from the settle hook and from the link route.
- **The cheap compare.** `revision_diff` tells which pages changed from the
  chunks both Fassungen already have in the index, with no model call; only the
  agent's `list_files(compare_to=…)` reads it.
- **The look.** `POST /api/documents/[id]/revision-compare` boxes what changed on
  one page and says it in words: one vision call per page pair on the office's
  vision credential, cached by the pixels, traced as `revision-visual-compare`.
- **The marks.** Piloti's canvas tool proposes marks through
  `POST /api/internal/document-annotations` (`op: propose`,
  `runAgentAnnotationRequest`). A proposal waits for a person
  (`only_piloti_proposes`, migration 0138), records a `piloti_changes` row per
  mark against the turn's answer, and a decision on it is scored
  `piloti-decision` on that answer's trace.
- **Running in the background as a person.** ADR-0106 wakes a turn as the person
  whose act is the event, re-resolved when the job runs; ADR-0108 makes a
  background run act as the person who commissioned it and rejects a principal
  of Piloti's own; ADR-0121 puts work that outlives a request on `bff_job_queue`.

What is missing is the decision to start the compare without being asked, what
it may leave behind, and who pays for it.

## Decision Drivers

- **Writes need the person's yes** (ADR-0122). Unasked, Piloti may only propose.
- **Headless first, no second path.** The notice is one more client of the
  routes and service functions a person's click and Piloti's tool already use.
- **Silence is an answer.** A notice that found nothing tells nobody; noise
  trains people to ignore Piloti.
- **A reading of two pictures is not a finding about the law.** A changed wall
  is a change, not a violation.
- **Cost nobody typed is opt-in and bounded.** A vision call per page, per new
  Fassung, for every office, is spend no one asked for.
- **Observable** (ADR-0089): the generation, a score, and the precision of what
  it proposed.

## Considered Options

1. **A headless agent turn per new Fassung** (the ADR-0106 wake, with a
   `new_revision` trigger): the agent reads, compares, searches the project's key
   documents and marks.
2. **A deterministic job in the BFF**: changed pages from the index, one vision
   compare per changed page, each box a proposed mark, through the existing
   routes' service functions.
3. **Compare at ingestion, in the ingest worker.**
4. **Do nothing; the person clicks „Vergleichen".**

## Decision Outcome

Chosen option: **2, a deterministic job, as the first slice; option 1 is the
second slice, for the cross-document check.** The visual compare is one bounded
step with a known cost and no judgement to make, so it needs no agent loop, and
it can be tested end to end without a model. Checking the changed values against
the Brandschutzkonzept or the Bebauungsplan is judgement over retrieval, which
is what a turn is for.

### Trigger

- **When.** `notifyNewRevision` has just claimed the announcement of a Fassung
  **under another name** (a link, at ingestion or by a person). A same-name
  version is not noticed: publishing it purges the older bytes from the index,
  so there is nothing left to compare it with.
- **Once.** The claim makes it once per Fassung; the job id is uuid5 of the pair
  (`revisionNoticeId`) and is inserted `ON CONFLICT DO NOTHING`, so a second
  enqueue while one waits is no second job.
- **Debounce.** The job waits `GRID_REVISION_NOTICE_DELAY_SECONDS` (120 s) before
  it may be claimed, so a burst of re-reads, relinks and settles has come to
  rest before a model looks.
- **Per-office switch, off by default.** The WorkOS flag `piloti-notices`, an
  entitlement: read per organization when queued, and again from the person's
  session when the job runs.

### Runs as whom

As **the person whose upload or link made the Fassung** (`actorUserId` of the
announcement), resolved from WorkOS when the job runs
(`resolvePinnedRequesterSession`), exactly as ADR-0106's wake runs as the person
whose act woke it and ADR-0108's run as its requester. No system principal:
ADR-0108 rejected an identity of Piloti's own, and a system principal with the
office's rights would see folders the person cannot. Every check is the
person's of today: read access to both documents (the compare's
`getAccessibleDocument`), neither held (ADR-0086), one collection, no restricted
folder (refused, as for a click, ADR-0087), write access to the newer document
for the proposals. A person who left, a document now held, a restricted folder:
the notice ends quietly. No person (an announcement without an actor): no notice.

### What it checks (this slice)

1. **Which pages changed**, read from the index with no model call:
   `POST /v1/collections/{c}/revision-pages` (`revision_diff.changed_pages`).
   A page the read content shows unchanged is never sent to a vision model.
   When neither Fassung has read text or a drawing reading (a scan), nothing can
   be called unchanged, and the first pages are looked at.
2. **What changed on each**, through the compare a person's click runs
   (`compareRevisionPage`, the service behind `POST /api/documents/[id]/revision-compare`),
   with `purpose: notice`: the provider queue is `bulk`, since nobody waits
   (ADR-0081), and the generation carries `purpose` in its metadata.

At most `GRID_REVISION_NOTICE_MAX_PAGES` (3, at most 10) pages are looked at.
Changed pages past the cap are named in the message, not looked at.

### What it leaves

- **Proposed marks on the new Fassung**, one per box, through
  `runAgentAnnotationRequest` with `op: propose`, the one path the canvas tool
  uses. Kind `hint`; body „Geändert gegenüber „<ältere Fassung>“: <label>.
  <Satz>"; basis „Bildvergleich mit „…“, S. n; von Piloti ohne Auftrag
  vorgeschlagen, nicht geprüft". At most 20 (`MAX_PROPOSALS_PER_CALL`). A mark
  Piloti already proposed at the same place with the same words is not proposed
  again, so a retried job adds nothing. Never open, never applied.
- **One message in the person's thread about the document** (ADR-0106's
  `ensureDocumentThread`), with a derived id: what was compared, the proposals,
  the pages not looked at, and that this is a picture comparison, no check
  against regulations or other documents. The marks' `piloti_changes` rows name
  this message, so the activity card, undo, and the `piloti-decision` score on
  each mark work unchanged.
- **One inbox row** for that person, `piloti.revision_checked`, anchored on the
  first mark, which opens the Prüfansicht there.
- **Nothing found is silence**: no mark, no message, no row.

### What it never does

It never edits, links, unlinks, classifies, sets a Dokumentart or a profile
fact, sets a mark open, resolves or dismisses one, or writes in another
person's name. It never says a change is allowed or forbidden: the body says
what moved, the basis says it was read off two pictures.

### Budget and cost

- Off unless the office has `piloti-notices`.
- At most `GRID_REVISION_NOTICE_MAX_PAGES` vision calls per new Fassung, and none
  for a page the index shows unchanged. The compare is cached by the pixels, so a
  retry, or a person's later click on „Vergleichen" for the same page, costs no
  second call.
- Before it spends, the job asks the person's budget status
  (`getBudgetStatus`); a spent scope, or a budget that cannot be read, ends it.
  Fail-closed, unlike a turn: nobody asked for this spend.
- **Known gap.** The compare's vision call is made outside a turn and is not
  booked to `llm_usage_events` (`cost_tracking.record_usage_event` books only
  inside a turn's tracker). That is true for a person's click today too. Until it
  is booked, the budget gate reads spend that excludes notices, and Langfuse is
  where their cost is seen. Booking auxiliary vision calls is its own change.

### Observability

- Each page is a `revision-visual-compare` generation with metadata `purpose:
  notice`; the route returns its `trace_id`.
- `revision-notice`, a NUMERIC score declared in `SCORE_DEFINITIONS`, on the
  trace of the first traced page: how many marks were proposed (0 is written).
- The thread message carries that `trace_id`, so a person's decision on each mark
  is a `piloti-decision` on the same trace. The share accepted is the precision
  of noticing, the measurement scene 5 names.

### Next slice: the cross-document check

The north star also checks the changed values against the project's key
documents (Brandschutzkonzept, Bebauungsplan). That is option 1: after the
visual notice, when the budget allows, a headless turn on the same pair with a
`new_revision` trigger on ADR-0106's wake path, in the same person's thread,
given the changed pages and values (`list_files(compare_to=…)`), told to find
the key documents by retrieval and to propose a mark only where a changed value
contradicts one of them, with both sources. It needs a wake trigger kind, a
per-office cap on unasked turns, and a judge row `flags_mismatch` in the north-
star eval before it ships. It is not in this slice.

### Consequences

- Good: scene 5 exists in its visual form for every office that switches it on,
  with no new write path, no new table and no second compare.
- Good: what Piloti noticed is measured as accepted or dismissed marks.
- Good: silence when nothing moved, and no page sent to a model that the index
  shows unchanged.
- Bad: the notice compares pictures, so a change that moves no pixels on the
  compared pages (a value in a report the index did not read) is not seen, and a
  page past the cap is only named.
- Bad: spend outside a turn is not yet booked to the budget (above).
- Neutral: an announcement without a person (none today) is not noticed.

### Confirmation

- `frontends/ui/src/lib/revision-notice/*.spec.ts`: the pages chosen and capped,
  the proposals and their words, retry dedupe, every quiet end before a model is
  asked (person left, switch off, held, budget spent or unreadable, restricted
  folder), the one propose path with the message id, the inbox row, the score,
  silence, the debounce and the per-pair job id.
- `revision-notify.spec.ts`: queued once per claimed cross-name Fassung, never
  for a same-name version, a held document or an announcement made before.
- `frontends/aiq_api/tests/test_revision_compare.py`: `revision-pages` with no
  model call, the `notice` purpose on the bulk queue and in the generation's
  metadata, the trace id handed on.
- `tests/aiq_agent/observability/test_langfuse_scores.py`: the score is declared
  and documented.

## Pros and Cons of the Options

### 1. A headless agent turn per new Fassung

- Good: one mechanism for the visual and the cross-document check.
- Bad: an agent loop, its cost and its variance for a step with no judgement in
  it; nothing to test without a model; a wake runs only where `piloti-wakes` is
  on and competes with the person's own turns in their thread.

### 3. Compare at ingestion

- Good: no job, the pages are fresh.
- Bad: the ingest worker has no person and no session, so it could only run as
  the system; the link at ingestion may not be the one a person keeps; a held
  upload would be compared before screening passed.

### 4. Do nothing

- Good: no cost.
- Bad: scene 5 stays absent; a new Fassung is compared only when someone thinks
  to.

## More Information

- [`docs/architecture/revisions.md`](../architecture/revisions.md#piloti-notices-a-new-fassung)
- [`docs/architecture/document-annotations.md`](../architecture/document-annotations.md)
- ADR-0086, ADR-0087, ADR-0089, ADR-0104, ADR-0105, ADR-0106, ADR-0108, ADR-0121, ADR-0122
