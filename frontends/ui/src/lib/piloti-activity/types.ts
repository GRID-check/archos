/**
 * „Was Piloti tut" (what Piloti is doing): one project's view of Piloti's
 * work, for the person looking, and only what they may see. The CONTRACT of
 * `GET /api/projects/[id]/piloti-activity` (`docs/architecture/piloti-activity.md`).
 *
 * The view is a read over records that already exist, never a record of its
 * own: a wake of Piloti on an Anmerkung (`piloti_wakes`, ADR-0106), a
 * background run (`task_runs`, ADR-0051/0062), a proposal waiting for a person
 * (`proposed_changes`, ADR-0105), a mark Piloti proposed (`document_annotations`
 * with status `proposed`), and the changes a turn applied (`piloti_changes`,
 * ADR-0109). The mark is the work item and the wake is Piloti's turn on it;
 * tasks stay the record for work no object holds.
 *
 * Three sections, each a list of rows with a `kind` discriminant, newest first
 * by the row's `at`:
 *
 * - `running` (Läuft gerade): woken turns not yet ended, and runs still queued
 *   or running.
 * - `waiting` (Wartet auf Entscheidung): open proposals of every kind, and the
 *   marks Piloti proposed that nobody took over or dismissed, one row per
 *   document.
 * - `recent` (Zuletzt): wakes that ended, runs that finished, and the changes
 *   each turn applied, since `recent.since`.
 *
 * Every row names the person Piloti worked for (`forPerson`). Links are
 * structured {@link ActivityTarget}s, never URLs: the browser builds the href
 * with the helpers that already own each shape (`reviewFilesHref` for a mark,
 * the thread link the inbox uses for a turn or a run).
 *
 * No `server-only` and no drizzle: the browser, the typed client (`./client`)
 * and the route read this. Change it deliberately, in one commit with every
 * caller.
 */

import { z } from 'zod'
import { ANNOTATION_KINDS, PILOTI_WAKE_TRIGGERS } from '@/lib/annotations/types'
import { PROPOSED_CHANGE_KINDS, type ProposedChangeStatus } from '@/lib/proposals/types'
import { TASK_KINDS } from '@/lib/tasks/task-vocabulary'

// ---------------------------------------------------------------------------
// Bounds. The server enforces every one; the browser may read them to word a
// „und weitere" line. Exported so the service, its spec and the UI share one
// number each.
// ---------------------------------------------------------------------------

/** Most rows `running` returns: woken turns and runs together, after the merge. Each source reads at most this many. */
export const PILOTI_ACTIVITY_RUNNING_CAP = 50

/** Most rows `waiting` returns: proposals and proposed-mark groups together, after the merge. */
export const PILOTI_ACTIVITY_WAITING_CAP = 50

/** Most documents whose open proposed marks are listed (one `proposed_marks` row each). */
export const PROPOSED_MARK_DOCUMENTS_CAP = 20

/** Marks shown per `proposed_marks` row; `count` says how many there are. */
export const PROPOSED_MARK_SAMPLE = 3

/** How far back `recent` reads when the query names no `since`. */
export const RECENT_DEFAULT_DAYS = 14

/** The furthest back `recent` ever reads: an older `since` is moved up to this. */
export const RECENT_MAX_DAYS = 30

/** Rows `recent` returns when the query names no `limit`. */
export const RECENT_DEFAULT_LIMIT = 30

/** The most rows `recent` returns, whatever the query asks. Each source reads at most this many. */
export const RECENT_MAX_LIMIT = 100

/** Documents a `changes` row names; `documentCount` says how many the turn touched. */
export const CHANGE_DOCUMENTS_SHOWN = 3

/** The longest a mark's text is carried in a row; the server cuts it at a word and adds „…". */
export const MARK_EXCERPT_MAX = 200

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects/[id]/piloti-activity?since=<ISO instant>&limit=<n>`.
 *
 * `since` bounds `recent` only (`running` and `waiting` are what is true now,
 * whatever its age). Absent: {@link RECENT_DEFAULT_DAYS} ago. Older than
 * {@link RECENT_MAX_DAYS}: moved up to that, never refused, so a stale link
 * still answers ({@link recentSince}). `limit` bounds `recent` and is refused
 * (400) outside 1..{@link RECENT_MAX_LIMIT}. Unknown parameters are ignored.
 */
export const pilotiActivityQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(RECENT_MAX_LIMIT).default(RECENT_DEFAULT_LIMIT),
})
export type PilotiActivityQuery = z.output<typeof pilotiActivityQuerySchema>
export type PilotiActivityQueryInput = z.input<typeof pilotiActivityQuerySchema>

/**
 * The instant `recent` reads from: the query's `since`, no earlier than
 * {@link RECENT_MAX_DAYS} before `now` and no later than `now`; without one,
 * {@link RECENT_DEFAULT_DAYS} before `now`. Pure, so the service and its spec
 * agree on the clamp.
 */
export function recentSince(query: Pick<PilotiActivityQuery, 'since'>, now: Date): Date {
  const floor = now.getTime() - RECENT_MAX_DAYS * DAY_MS
  const asked = query.since ? Date.parse(query.since) : now.getTime() - RECENT_DEFAULT_DAYS * DAY_MS
  return new Date(Math.min(now.getTime(), Math.max(floor, asked)))
}

// ---------------------------------------------------------------------------
// What a row points at
// ---------------------------------------------------------------------------

/** A mark or a document in its Prüfansicht: what every mark row leads to. */
export const reviewTargetSchema = z
  .object({
    kind: z.literal('review'),
    documentId: z.string().min(1),
    annotationId: z.string().min(1).nullable(),
  })
  .strict()

/** A thread, at a message: what a turn link is. */
export const turnTargetSchema = z
  .object({
    kind: z.literal('turn'),
    conversationId: z.string().min(1),
    messageId: z.string().min(1).nullable(),
  })
  .strict()

const runTargetSchema = z
  .object({
    kind: z.literal('run'),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict()

const taskTargetSchema = z.object({ kind: z.literal('task'), taskId: z.string().min(1) }).strict()

const projectChatTargetSchema = z.object({ kind: z.literal('project_chat') }).strict()

/**
 * Where a row leads, as data. The browser turns it into an href
 * (`features/piloti-activity/lib/activity-target.ts`):
 *
 * - `review`: the document's Prüfansicht, at `annotationId` when there is one
 *   (`reviewFilesHref(projectId, { documentId, annotationId })`, the link the
 *   inbox and the chat card use).
 * - `turn`: the thread, scrolled to `messageId` when there is one
 *   (`/app/projects/{p}/chat?session={conversationId}#message-{messageId}`,
 *   the conversation deep link of `lib/sharing/registry.ts`).
 * - `run`: the run's block in its thread
 *   (`/app/projects/{p}/chat?session={c}&run={runId}#message-{messageId}`,
 *   the shape of `runDeepLink` in `lib/inbox/targets.ts`).
 * - `task`: the run's drawer in Automation
 *   (`/app/projects/{p}/automation?tab=tasks&task={taskId}`), for a run whose
 *   thread this reader may not open. Only sent while Automation exists for
 *   the reader (`capabilities.automation`).
 * - `project_chat`: the project's chat, for a proposal made outside any
 *   conversation (where the inbox sends it too).
 *
 * A server only sends a `turn` or `run` target for a conversation this reader
 * may open; a row whose thread they may not open carries another target or
 * none.
 */
export const activityTargetSchema = z.discriminatedUnion('kind', [
  reviewTargetSchema,
  turnTargetSchema,
  runTargetSchema,
  taskTargetSchema,
  projectChatTargetSchema,
])
export type ActivityTarget = z.infer<typeof activityTargetSchema>
export type ReviewActivityTarget = z.infer<typeof reviewTargetSchema>
export type TurnActivityTarget = z.infer<typeof turnTargetSchema>

// ---------------------------------------------------------------------------
// What rows are made of
// ---------------------------------------------------------------------------

/** The person Piloti worked for: whose turn, delegation, request or proposal it was. */
export const activityPersonSchema = z
  .object({
    userId: z.string().min(1),
    /** As the organization's directory names them; null when it does not know them (a leaver). */
    name: z.string().nullable(),
  })
  .strict()
export type ActivityPerson = z.infer<typeof activityPersonSchema>

/** A document of the project, by the name the reader sees in Dateien (`documentDisplayName`). */
export const activityDocumentSchema = z.object({ id: z.string().min(1), name: z.string() }).strict()
export type ActivityDocument = z.infer<typeof activityDocumentSchema>

/** An Anmerkung as a row names it: „Anmerkung 4 · Mangel · „…“". */
export const activityMarkSchema = z
  .object({
    id: z.string().min(1),
    /** The document's running number. */
    number: z.number().int().positive(),
    kind: z.enum(ANNOTATION_KINDS),
    /** The mark's text, at most {@link MARK_EXCERPT_MAX} characters. */
    excerpt: z.string(),
  })
  .strict()
export type ActivityMark = z.infer<typeof activityMarkSchema>

/** An ISO-8601 instant, as `Date.prototype.toISOString` writes it. */
const instant = z.string().datetime({ offset: true })

// ---------------------------------------------------------------------------
// Läuft gerade
// ---------------------------------------------------------------------------

/**
 * A woken turn on a mark that has not ended (`piloti_wakes.status` `queued` or
 * `started`). `at` is when the event woke Piloti (`created_at`).
 */
export const runningWakeSchema = z
  .object({
    kind: z.literal('wake'),
    /** The wake's id: also its job id and its turn id. */
    id: z.string().min(1),
    at: instant,
    /** `queued`: waiting for its job (or for the thread to be free). `started`: the turn runs. */
    status: z.enum(['queued', 'started']),
    /** When the turn started (`settled_at`); null while queued. */
    startedAt: instant.nullable(),
    trigger: z.enum(PILOTI_WAKE_TRIGGERS),
    /** The person whose act woke Piloti; the turn runs as them (`actor_user_id`). */
    forPerson: activityPersonSchema,
    document: activityDocumentSchema,
    mark: activityMarkSchema,
    /**
     * Whether THIS reader may take the delegation back now, which stops the
     * turn: the wake is a delegation's (`assigned`), the mark is still
     * delegated by that delegation, and the reader may edit the document's
     * marks. The action is the existing PATCH (`updateAnnotation(documentId,
     * markId, { delegateToPiloti: false, expectedStatus: 'open' })`). Always
     * false for a mention or an answer: nothing stops those but the turn's end.
     */
    canTakeBack: z.boolean(),
    /** The mark, in the Prüfansicht. */
    target: reviewTargetSchema,
    /** The turn in its person's thread about the document, at the trigger; null when this reader may not open that thread. */
    turn: turnTargetSchema.nullable(),
  })
  .strict()
export type RunningWake = z.infer<typeof runningWakeSchema>

/** A background run still in the worker's hands (`task_runs.status` `queued` or `running`). `at` is when it was created. */
export const runningRunSchema = z
  .object({
    kind: z.literal('run'),
    /** The run's id, its public key (`/api/projects/[id]/runs/[runId]`). */
    id: z.string().min(1),
    at: instant,
    status: z.enum(['queued', 'running']),
    startedAt: instant.nullable(),
    taskKind: z.enum(TASK_KINDS),
    /** The run's own title, as the Aufträge list shows it. */
    title: z.string(),
    /** Who asked for it: the run spends their rights and budget (`requester_user_id`). */
    forPerson: activityPersonSchema,
    /**
     * Whether THIS reader may stop it now, by `POST /api/projects/[id]/runs/[runId]/cancel`
     * (`cancelRun` in `lib/runs/client`): what `requireRunActor` would let
     * through, and the run has a backend job to cancel.
     */
    canStop: z.boolean(),
    /** Its block in its thread, else its drawer in Automation, else null. */
    target: activityTargetSchema.nullable(),
  })
  .strict()
export type RunningRun = z.infer<typeof runningRunSchema>

export const runningItemSchema = z.discriminatedUnion('kind', [runningWakeSchema, runningRunSchema])
export type RunningItem = z.infer<typeof runningItemSchema>

// ---------------------------------------------------------------------------
// Wartet auf Entscheidung
// ---------------------------------------------------------------------------

/** A proposal nobody decided yet (`proposed_changes.status` `proposed`), any kind. `at` is when Piloti proposed it. */
export const waitingProposalSchema = z
  .object({
    kind: z.literal('proposal'),
    /** The proposal's id (`GET /api/proposals/[id]`). */
    id: z.string().min(1),
    at: instant,
    proposalKind: z.enum(PROPOSED_CHANGE_KINDS),
    /**
     * One line naming what it touches, language-free: the first file names,
     * the note's first words, or the profile change's title (`summaryOf` in
     * `lib/proposals/kinds.ts`, the inbox line).
     */
    summary: z.string(),
    /** The person whose turn proposed it (`on_behalf_of`). */
    forPerson: activityPersonSchema,
    /** Whether THIS reader holds the right its kind is decided with (`DECIDE_PERMISSIONS`); the decision itself is made on the card. */
    canDecide: z.boolean(),
    /** The card in its turn (`turn`, at the origin message), or the project chat for a proposal made outside a conversation. */
    target: activityTargetSchema,
  })
  .strict()
export type WaitingProposal = z.infer<typeof waitingProposalSchema>

/** One proposed mark as a `proposed_marks` row lists it. */
export const proposedMarkSchema = activityMarkSchema
  .extend({
    page: z.number().int().positive(),
    /** The person on whose behalf Piloti proposed it (`created_by`). */
    forPerson: activityPersonSchema,
    createdAt: instant,
  })
  .strict()
export type ProposedMark = z.infer<typeof proposedMarkSchema>

/**
 * The marks Piloti proposed on one document that are still proposals
 * (`document_annotations.status` `proposed`). `at` is the newest one's
 * `created_at`; `marks` are the first {@link PROPOSED_MARK_SAMPLE} by number.
 */
export const waitingProposedMarksSchema = z
  .object({
    kind: z.literal('proposed_marks'),
    /** The document's id: one row per document. */
    id: z.string().min(1),
    at: instant,
    document: activityDocumentSchema,
    /** How many proposed marks the document holds, all of them. */
    count: z.number().int().positive(),
    marks: z.array(proposedMarkSchema).min(1).max(PROPOSED_MARK_SAMPLE),
    /** The Prüfansicht at the first of `marks`, where the proposals lead the list. */
    target: reviewTargetSchema,
  })
  .strict()
export type WaitingProposedMarks = z.infer<typeof waitingProposedMarksSchema>

export const waitingItemSchema = z.discriminatedUnion('kind', [waitingProposalSchema, waitingProposedMarksSchema])
export type WaitingItem = z.infer<typeof waitingItemSchema>

// ---------------------------------------------------------------------------
// Zuletzt
// ---------------------------------------------------------------------------

/** How a wake ended, as this view tells it. `suppressed` is not listed: no turn ran, and a person or a cap decided that. */
export const ENDED_WAKE_STATUSES = ['answered', 'stopped', 'failed', 'refused'] as const
export type EndedWakeStatus = (typeof ENDED_WAKE_STATUSES)[number]

/**
 * What a failed or refused wake ran into, in words a person can act on. The
 * stored reason is written for the log (`budget: …`, `rejected: auth_expired`,
 * `gave up waiting: …`); the server classifies it so the view never shows it
 * as the sentence (`wakeEndReasonKind` in `./service`):
 *
 * - `budget`: the person's, the project's or the office's budget refused it.
 * - `busy`: Piloti could not start in time (the job gave up waiting).
 * - `access`: the person's sign-in or rights no longer carried the turn.
 * - `error`: the turn started and broke off without an answer.
 */
export const WAKE_END_REASON_KINDS = ['budget', 'busy', 'access', 'error'] as const
export type WakeEndReasonKind = (typeof WAKE_END_REASON_KINDS)[number]

/** A wake that reached its final word since `recent.since`. `at` is `ended_at`. */
export const recentWakeSchema = z
  .object({
    kind: z.literal('wake_ended'),
    id: z.string().min(1),
    at: instant,
    /**
     * `answered`: the turn answered. `stopped`: a person stopped it (took the
     * mark back). `failed`: the job gave up or the turn errored. `refused`: no
     * turn started (the person's rights or budget refused it).
     */
    status: z.enum(ENDED_WAKE_STATUSES),
    /** Why, for `failed` and `refused` only (the stored reason, ≤ 500 characters); null otherwise. For a tooltip, never the sentence. */
    reason: z.string().nullable(),
    /** The class of `reason` the view words the row by; null exactly when `reason` is. */
    reasonKind: z.enum(WAKE_END_REASON_KINDS).nullable(),
    trigger: z.enum(PILOTI_WAKE_TRIGGERS),
    forPerson: activityPersonSchema,
    document: activityDocumentSchema,
    mark: activityMarkSchema,
    target: reviewTargetSchema,
    turn: turnTargetSchema.nullable(),
  })
  .strict()
export type RecentWake = z.infer<typeof recentWakeSchema>

/** How a finished run ended (`TASK_RUN_STATUSES` without the two active ones). */
export const FINISHED_RUN_STATUSES = ['succeeded', 'failed', 'interrupted', 'skipped', 'error'] as const
export type FinishedRunStatus = (typeof FINISHED_RUN_STATUSES)[number]

/** A run that finished since `recent.since`. `at` is `finished_at`, else `updated_at` (a skip that never started). */
export const recentRunSchema = z
  .object({
    kind: z.literal('run_finished'),
    id: z.string().min(1),
    at: instant,
    status: z.enum(FINISHED_RUN_STATUSES),
    /** The skip reason or the user-safe error (`task_runs.error`); null when there is none. */
    error: z.string().nullable(),
    taskKind: z.enum(TASK_KINDS),
    title: z.string(),
    forPerson: activityPersonSchema,
    /** The document the result was filed as, when it was and this reader may see it. */
    filedDocument: activityDocumentSchema.nullable(),
    target: activityTargetSchema.nullable(),
  })
  .strict()
export type RecentRun = z.infer<typeof recentRunSchema>

/**
 * What one turn changed on the project's Anmerkungen (`piloti_changes`
 * grouped by the turn's answer message). `at` is the newest change's
 * `created_at`. Counts only the changes on documents this reader may see.
 */
export const recentChangesSchema = z
  .object({
    kind: z.literal('changes'),
    /** `<conversationId>:<messageId>`: one row per turn. */
    id: z.string().min(1),
    at: instant,
    count: z.number().int().positive(),
    /** How many of them were undone since, at most `count`; equal to `count` reads „rückgängig gemacht". */
    undoneCount: z.number().int().nonnegative(),
    /** The first {@link CHANGE_DOCUMENTS_SHOWN} documents the turn changed marks on, by name. */
    documents: z.array(activityDocumentSchema).min(1).max(CHANGE_DOCUMENTS_SHOWN),
    /** How many documents the turn changed marks on, at least `documents.length`. */
    documentCount: z.number().int().positive(),
    /** The person the turn acted for (`on_behalf_of`). */
    forPerson: activityPersonSchema,
    /** The turn's answer, where the activity card shows each change and offers „Rückgängig". */
    target: turnTargetSchema,
  })
  .strict()
export type RecentChanges = z.infer<typeof recentChangesSchema>

/** How a decided proposal ended: every `PROPOSED_CHANGE_STATUSES` but the open one. */
export const DECIDED_PROPOSAL_STATUSES = [
  'applied',
  'partially_applied',
  'failed',
  'dismissed',
] as const satisfies readonly Exclude<ProposedChangeStatus, 'proposed'>[]

/**
 * A proposal a person decided since `recent.since` (`proposed_changes.decided_at`):
 * who decided what Piloti proposed, for whom. `at` is `decided_at`. Gated as
 * the open ones in `waiting` are.
 */
export const recentProposalSchema = z
  .object({
    kind: z.literal('proposal_decided'),
    /** The proposal's id. */
    id: z.string().min(1),
    at: instant,
    proposalKind: z.enum(PROPOSED_CHANGE_KINDS),
    status: z.enum(DECIDED_PROPOSAL_STATUSES),
    /** The same one line as a waiting proposal's `summary`. */
    summary: z.string(),
    /** The person whose turn proposed it (`on_behalf_of`). */
    forPerson: activityPersonSchema,
    /** The person who decided it (`decided_by`). */
    decidedBy: activityPersonSchema,
    /** The card in its turn, or the project chat for a proposal made outside a conversation. */
    target: activityTargetSchema,
  })
  .strict()
export type RecentProposal = z.infer<typeof recentProposalSchema>

export const recentItemSchema = z.discriminatedUnion('kind', [
  recentWakeSchema,
  recentRunSchema,
  recentChangesSchema,
  recentProposalSchema,
])
export type RecentItem = z.infer<typeof recentItemSchema>

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

/** A section: its rows, newest first by `at`, and whether a cap cut rows off. */
const section = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), truncated: z.boolean() }).strict()

export const pilotiActivityResponseSchema = z
  .object({
    projectId: z.string().min(1),
    /** The reader: a row whose `forPerson.userId` is this reads „für Sie". */
    viewerUserId: z.string().min(1),
    /** When the server read it. */
    generatedAt: instant,
    /** Which parts of the product exist for this reader, for the empty states and the links. */
    capabilities: z
      .object({
        /** The organization lets events wake Piloti (`piloti-wakes`): marks can be delegated. */
        wakes: z.boolean(),
        /** Automation exists for this reader (`skills`): a `task` target leads somewhere. */
        automation: z.boolean(),
      })
      .strict(),
    running: section(runningItemSchema),
    waiting: section(waitingItemSchema),
    recent: section(recentItemSchema).extend({
      /** The instant `recent` was read from, after the clamp ({@link recentSince}). */
      since: instant,
    }),
  })
  .strict()
export type PilotiActivityResponse = z.infer<typeof pilotiActivityResponseSchema>
