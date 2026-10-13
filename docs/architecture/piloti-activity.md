# „Was Piloti tut": one project's view of Piloti's work

Piloti works in several places at once. It works a mark someone delegated to
it, it answers in an Anmerkung's thread, it runs a research or an
Einreichcheck in the background, it proposes changes and marks that wait for a
person, and it changes marks when someone asks. Each of these lives on its own
object, and each object has its own surface: the Prüfansicht, the chat card,
the run block, the inbox. Nothing showed a project's people what Piloti is
doing in their project as a whole. „Was Piloti tut" is that view: for one
project, for the person looking, only what they may see.

The owner's rule holds here too: **the mark is the work item, the wake is
Piloti's turn on it, and tasks stay the record for work no object holds**
(ADR-0106). The view reads those records. It records nothing.

## The contract

`GET /api/projects/[id]/piloti-activity?since=<ISO instant>&limit=<n>`

| Piece | Where |
|---|---|
| zod schemas, row unions, caps, `recentSince` | `frontends/ui/src/lib/piloti-activity/types.ts` |
| the browser's client, `fetchPilotiActivity` | `frontends/ui/src/lib/piloti-activity/client.ts` |
| the route (thin adapter, `authz.enforcedBy`) | `frontends/ui/src/app/api/projects/[id]/piloti-activity/route.ts` |
| the reads and the gates, `getPilotiActivity` | `frontends/ui/src/lib/piloti-activity/service.ts` (its header is the specification) |

The response has three sections. Each is `{ items, truncated }`, its rows
newest first by `at`, each row a union member with a `kind`, and each row names
the person Piloti worked for (`forPerson`). Links are structured targets
(`review`, `turn`, `run`, `task`, `project_chat`), and the browser builds the
href with the helper that already owns each shape.

| Section | Row kinds | Read from | `at` |
|---|---|---|---|
| `running` (Läuft gerade) | `wake`: a woken turn queued or running on a mark, with `canTakeBack`. `run`: a background run queued or running, with `canStop` | `piloti_wakes` with status `queued`/`started`; `task_runs` with status `queued`/`running` | when it was woken or created |
| `waiting` (Wartet auf Entscheidung) | `proposal`: an undecided proposal of any of the three kinds, with its one-line summary and `canDecide`. `proposed_marks`: per document, how many marks Piloti proposed that nobody took over or dismissed, and the first three | `proposed_changes` with status `proposed`; `document_annotations` with status `proposed` | when it was proposed (the newest mark, per document) |
| `recent` (Zuletzt) | `wake_ended`: answered, stopped, failed or refused; a failed or refused one carries its class (`reasonKind`: budget, busy, access, error), which the view words the row by, and the stored reason only as a tooltip. `run_finished`: how a run ended, its error, the document it filed. `changes`: per turn, how many marks it changed and how many were undone since. `proposal_decided`: who decided what Piloti proposed, and how (applied, partly applied, failed, dismissed) | `piloti_wakes` with `ended_at`; `task_runs` finished; `piloti_changes` grouped by the turn's answer message; `proposed_changes` with `decided_at` | when it ended (the newest change, per turn) |

The response also carries `viewerUserId` (so a row reads „für Sie"),
`capabilities.wakes` (the organization's `piloti-wakes` switch) and
`capabilities.automation` (whether Automation exists for the reader, so a
`task` target leads somewhere).

### Bounds

Every list is limited in SQL; nothing is read whole. The caps are exported
from `types.ts`:

| Cap | Value | Bounds |
|---|---|---|
| `PILOTI_ACTIVITY_RUNNING_CAP` | 50 | `running`, and each of its two sources |
| `PILOTI_ACTIVITY_WAITING_CAP` | 50 | `waiting`, and the proposals read |
| `PROPOSED_MARK_DOCUMENTS_CAP` | 20 | the documents with proposed marks |
| `PROPOSED_MARK_SAMPLE` | 3 | the marks shown per document |
| `RECENT_DEFAULT_DAYS` / `RECENT_MAX_DAYS` | 14 / 30 | how far back `recent` reads; an older `since` is moved up, never refused |
| `RECENT_DEFAULT_LIMIT` / `RECENT_MAX_LIMIT` | 30 / 100 | `recent`, and each of its three sources; a larger `limit` is a 400 |
| `CHANGE_DOCUMENTS_SHOWN` | 3 | documents named per `changes` row |
| `MARK_EXCERPT_MAX` | 200 | characters of a mark's text |

Each source reads one row past its cap, so `truncated` is true exactly when
something was left out. Migration 0144 adds the indexes the new reads scan by
(on `piloti_wakes` and `piloti_changes`, by organization and time).

## Who sees what

The view never shows a row its reader could not open where it lives. It uses
the gates those places use, not new ones:

- **The project.** `project:view`, else 404, like every project route.
- **Documents.** Every read of a mark, a wake, a change or a filed document
  joins `documents` and ANDs `documentVisibleTo(reader)` and
  `outsideHiddenFolders(hiddenFolderIds)`, both from
  `projectOverviewReader` (the Overview's own reader). A held upload, a
  document in a folder closed to the reader, a document in the Büroablage and
  another project's document do not appear, by name or in a count.
- **Conversations.** A proposal and a turn's changes live in the conversation
  they were made in. They are shown only when the reader may open that
  conversation, by the rule the conversation list uses: the visibility
  predicate of `listVisibleConversations` in SQL (extracted so the two cannot
  drift), then `lockedConversationIds` for a thread that drew on a restricted
  folder or another project. A wake's turn runs in its person's private thread
  about the document, and a run lives in the thread that commissioned it; both
  rows are shown on the document or project gate, and carry a link to the
  thread only when it passes the same gate.
- **Runs.** The Aufträge list's rule: `project:view`, and
  `withoutUnreadableSubjects` for a revision task whose document the reader may
  no longer read.
- **Actions.** `canTakeBack` is the annotation service's own write check on
  the document, and only for a delegation that is still the mark's current
  one. `canStop` is what `requireRunActor` lets through. `canDecide` is the
  proposal kind's `DECIDE_PERMISSIONS`. The actions are the existing routes:
  the annotation PATCH with `delegateToPiloti: false`, the run's cancel, the
  proposal's card.

`conversationOpenToProjectReaders` is not the gate. It decides what may be
read into every member's prompt, and would hide a person's own restricted
thread from that person.

## Why there is no new table

Every row is a fact some record already holds: a wake's status and end, a
run's status, a proposal's status, a mark's status, a change and its undo. A
table of „activity" would be a second copy of each, written beside the first
and kept in step forever. That is the argument ADR-0106 makes against a task
per delegation. The cost of reading five records instead of one is a handful
of bounded queries and two indexes.

## How it relates to the inbox

The inbox is per person: what Piloti needs from you, or wants you to know
(`piloti.work_done`, `piloti.work_failed`, `piloti.asks_you`,
`piloti.proposal_waiting`). This view is per project: everything Piloti does
there that you may see, whoever it worked for. It creates no inbox item and
resolves none. Both link into the same places: a mark through
`reviewFilesHref`, a run through its block in its thread.

## Out of scope

- Writing anything. A decision on a proposal is made on its card, an undo on
  the turn's activity card; this view links there.
- Stopping a turn that a mention or an answer woke. Nothing stops those but
  the turn's end, and this view adds no stop route.
- Wakes a cap or a take-back held at enqueue (`suppressed`): no turn ran.
- Piloti's open Rückfragen (`piloti.asks_you`) and decided proposals, as their
  own rows.
- Live updates. The view reads on open and after the reader acts; there is no
  channel for it.
- Anything outside the project: the Büroablage, other projects.
- The agent reading this view. It is a person's surface; nothing is exported
  as JSON Schema for the Python tier.

## The view

**Where it sits.** A section of the project hub, beside Memory and Usage,
with a tile on the Overview: the hub's rule is that a block goes in the
section whose question it answers, and each section has a tile with one
number up front (`features/projects/lib/settings-sections.ts`). Automation
is the wrong home: it is gated on the `skills` flag, and most of what this
view shows (marks, wakes, proposals) is not a task.

- Add `'piloti'` to `PROJECT_SETTINGS_SECTION_KEYS` in
  `features/projects/lib/settings-sections.ts`, after `overview`, visible to
  every reader. Its route is `app/app/(shell)/projects/[id]/settings/piloti/page.tsx`
  (`project:view`, like the Memory page), its icon in
  `features/projects/components/settings/project-settings-nav.tsx` is
  `Sparkles`, and its label is `settings.project.nav.piloti`.
- The organism is `features/piloti-activity/components/piloti-activity.tsx`
  (`PilotiActivity`, props: `projectId` and the response), fed by a hook
  `features/piloti-activity/hooks/use-piloti-activity.ts` over
  `fetchPilotiActivity`, which re-reads after an action.
- The tile is `PilotiTile` in `features/projects/components/overview/live-tiles.tsx`,
  beside `MemoryTile` and in its pattern (`BentoTile`, the file's
  `TileSkeleton`, loading / error / ready), reading through
  `fetchPilotiActivity` rather than the file's untyped `useJson`, so the tile
  and the section parse one contract: the number of running rows up front, the number waiting
  beneath, the first running row named, opening the section. It is placed
  after the Documents and Memory tiles in `project-overview.tsx`.
- Hrefs come from one pure function,
  `features/piloti-activity/lib/activity-target.ts`
  (`activityTargetHref(projectId, target)`), using the shapes the target
  schema names: `reviewFilesHref` from `features/documents/lib/open-review.ts`
  for `review`, the conversation link of `lib/sharing/registry.ts` for `turn`,
  `runDeepLink`'s shape for `run`, the Automation drawer link for `task`. It
  gets a spec over every target kind.

**Composition.** Three sections, each a `SectionLabel` heading over an
`ItemList` of `Item` rows (`components/ui/item.tsx`): `ItemMedia` for the kind
(`PilotiGlyph` for a wake or a change, the run's icon for a run),
`ItemTitle`/`ItemDescription` for what and where, `TimeAgo` for `at`, and
`ItemActions` for the action and the link (`Button`, `ConfirmDialog` before a
stop or a take-back, as `RunBlock` and the thread do). Counts use `CountPill`.
The person is „für Anna", or „für Sie" for the viewer. Status words reuse the
existing labels: `tasks.status.*` and `tasks.kind.*` for runs,
`files.annotations.kinds.*` for a mark's kind, the delegate chip's wording
for a wake. If a row needs a shape the kit lacks, add the atom.

**Empty states** (`EmptyState`, one per section, the section still shown):

- Läuft gerade: „Piloti arbeitet gerade an nichts in diesem Projekt.", with
  „Delegieren Sie eine offene Anmerkung an Piloti, dann erscheint sie hier."
  when `capabilities.wakes`.
- Wartet auf Entscheidung: „Nichts wartet auf eine Entscheidung."
- Zuletzt: „In den letzten {days} Tagen hat Piloti hier nichts abgeschlossen."
- The whole view empty: one `EmptyState` instead of three („Piloti war in
  diesem Projekt noch nicht tätig.").
- Load failure: „Konnte nicht geladen werden." with a retry.

**Copy keys** (`settings` namespace, every dictionary in
`src/i18n/dictionaries`, German shown; never call a file a plan):

| Key | German |
|---|---|
| `project.nav.piloti` | Was Piloti tut |
| `project.overview.piloti.label` | Was Piloti tut |
| `project.overview.piloti.running` | {count, plural, =0 {Läuft gerade nichts} one {# läuft gerade} other {# laufen gerade}} |
| `project.overview.piloti.waiting` | {count, plural, =0 {nichts wartet} one {# wartet auf Entscheidung} other {# warten auf Entscheidung}} |
| `project.overview.piloti.open` | Ansehen |
| `project.pilotiActivity.title` | Was Piloti tut |
| `project.pilotiActivity.intro` | Woran Piloti in diesem Projekt arbeitet, was auf Sie oder Ihr Team wartet, und was zuletzt fertig wurde. |
| `project.pilotiActivity.sections.running` | Läuft gerade |
| `project.pilotiActivity.sections.waiting` | Wartet auf Entscheidung |
| `project.pilotiActivity.sections.recent` | Zuletzt |
| `project.pilotiActivity.forPerson` | für {name} |
| `project.pilotiActivity.forYou` | für Sie |
| `project.pilotiActivity.someone` | eine Person |
| `project.pilotiActivity.mark` | Anmerkung {number} |
| `project.pilotiActivity.wake.queued` | Wartet auf Piloti |
| `project.pilotiActivity.wake.started` | Piloti arbeitet daran |
| `project.pilotiActivity.wake.trigger.assigned` | delegiert |
| `project.pilotiActivity.wake.trigger.thread_mention` | erwähnt |
| `project.pilotiActivity.wake.trigger.thread_reply` | Antwort auf Rückfrage |
| `project.pilotiActivity.wake.answered` | Beantwortet |
| `project.pilotiActivity.wake.stopped` | Gestoppt |
| `project.pilotiActivity.wake.failed` | Nicht abgeschlossen |
| `project.pilotiActivity.wake.refused` | Nicht gestartet |
| `project.pilotiActivity.takeBack` | Von Piloti zurücknehmen |
| `project.pilotiActivity.takeBackConfirm` | Piloti hört auf, an Anmerkung {number} zu arbeiten. |
| `project.pilotiActivity.stop` | Abbrechen |
| `project.pilotiActivity.stopConfirm` | „{title}" wird abgebrochen. |
| `project.pilotiActivity.openMark` | Im Dokument zeigen |
| `project.pilotiActivity.openTurn` | Im Verlauf öffnen |
| `project.pilotiActivity.proposal.memory` | Gedächtnis |
| `project.pilotiActivity.proposal.file_operation` | Dateien |
| `project.pilotiActivity.proposal.project_profile` | Projektdaten |
| `project.pilotiActivity.proposal.yours` | Sie können entscheiden |
| `project.pilotiActivity.proposedMarks` | {count, plural, one {# Vorschlag} other {# Vorschläge}} von Piloti in {document} |
| `project.pilotiActivity.proposedMarksMore` | und {count} weitere |
| `project.pilotiActivity.changes` | {count, plural, one {# Änderung} other {# Änderungen}} an Anmerkungen |
| `project.pilotiActivity.changesUndone` | rückgängig gemacht |
| `project.pilotiActivity.changesPartlyUndone` | {undone} von {count} rückgängig gemacht |
| `project.pilotiActivity.truncated` | Es gibt mehr, als hier Platz hat. |
| `project.pilotiActivity.empty.*`, `project.pilotiActivity.error`, `project.pilotiActivity.retry` | the empty states and the failure above |

**Preview.** `app/dev/piloti-activity/page.tsx`, pinned to German like
`app/dev/run-block`, with fixtures in `app/dev/_fixtures/piloti-activity.ts`
parsed through `pilotiActivityResponseSchema` (a fixture that drifts from the
contract fails the page). Variants on `?variant=`: `full` (every row kind, a
truncated `recent`, a row for the viewer, a person the directory does not
know, a run with no target), `empty`, `waiting-only`, `actions` (a
take-back and a stop open in their confirm dialogs), `error`. The Overview
tile is shown on the same page in its three states. Capture it with
`agent-browser` and attach it to the PR.
