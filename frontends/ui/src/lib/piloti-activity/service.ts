/**
 * „Was Piloti tut" — the rules and the reads behind `GET /api/projects/[id]/piloti-activity`
 * (`docs/architecture/piloti-activity.md`; the contract is `./types`).
 *
 * A read over records that already exist; nothing here writes, and there is no
 * table of its own. Each section is built from bounded queries, every one
 * scoped to the organization and the project, and gated for THIS reader so the
 * view never shows a row the reader could not open from where it lives.
 *
 * ## Entry
 *
 * 1. `requireProjectAccess(session, projectId, 'project:view')`; its denial is
 *    the 404 every project route answers.
 * 2. `projectOverviewReader(session, projectId)` (`lib/projects/service.ts`)
 *    gives `{ hiddenFolderIds, reader }`, which with the organization and the
 *    project is a `ProjectDocumentGate` (`lib/documents/repository.ts`). EVERY
 *    query that reads a document or a document's facts (marks, wakes, changes,
 *    a filed document) joins `documents` and ANDs, in that query's WHERE,
 *    `projectShelfScope(gate)` (organization, project, the project shelf,
 *    outside every hidden folder) and `documentVisibleTo(gate.reader)`
 *    (`lib/documents/visibility.ts`). So a held upload, a document in a folder
 *    closed to the reader, a Büroablage document and another project's
 *    document never reach a row, by name or in a count.
 * 3. Conversations, two ways, both the conversation list's own rule
 *    (`listConversations` in `lib/conversations/service.ts`), so this view and
 *    the chat never disagree about which thread the reader may open:
 *    - **In SQL, before the LIMIT**, for the rows that live in a conversation
 *      (proposals, changes): the conversation joined on id and organization,
 *      not deleted, and `conversationVisibleInProject(organizationId, userId,
 *      projectId)` (`lib/conversations/repository.ts`): the project branch of
 *      `listVisibleConversations`, which is built from the same function.
 *    - **After the query**, the rows whose conversation is in
 *      `lockedConversationIds(session, refs)` (`lib/conversations/restricted-use.ts`)
 *      are dropped: a thread that drew on a restricted folder, or another
 *      project, the reader may not read now (ADR-0087, ADR-0088, ADR-0094).
 *      One call for the whole response.
 *    - For a LINK only (a wake's turn, a run's block), the same two halves
 *      over the bounded set of ids: `listVisibleConversationIds` minus
 *      `lockedConversationIds`. A row is still shown when its thread is not
 *      readable; it just carries no `turn` / `run` target.
 *    `conversationOpenToProjectReaders` is NOT the gate here: it is the rule
 *    for text read into EVERY member's prompt, and it would hide a person's own
 *    restricted thread from that person.
 * 4. Names: `loadOrganizationDirectory(organizationId)` once
 *    (`lib/sharing/directory.ts`); `forPerson = { userId, name: directory.get(userId)?.name ?? null }`.
 * 5. `capabilities = { wakes: isPilotiWakesEnabled(session), automation: isSkillsEnabled(session) }`
 *    (`lib/authz/feature-flags.ts`). Neither hides rows: a wake recorded
 *    before the switch went off is still true.
 *
 * Every source reads one row past its cap, so `truncated` is exact: a source
 * that had more than its cap, or a merge that cut rows, says so.
 *
 * ## running (Läuft gerade)
 *
 * **Wakes** — `listLiveProjectWakes(gate, cap + 1)` (`lib/annotations/wake-repository.ts`):
 * `queued`/`started`, newest first by `created_at`. Per row:
 * - `startedAt` = `settled_at` when `status = 'started'`, else null.
 * - `mark.excerpt` = the body cut to `MARK_EXCERPT_MAX` ({@link markExcerpt}).
 * - `canTakeBack` = `trigger_kind = 'assigned'` AND the mark's `delegated_at`
 *   is set AND `event_id = delegationEventId(markId, delegatedAt)` (still THIS
 *   delegation) AND `mayEditAnnotations(session, documentId)`
 *   (`lib/annotations/service.ts`, the annotation service's own write check),
 *   asked once per distinct document.
 * - `target = { kind: 'review', documentId, annotationId: markId }`.
 * - `turn`: the wake ran in its person's thread about the document,
 *   `documentThreadConversationId(documentId, actorUserId)`, at the message
 *   the job wrote, whose id is the wake's id, when that thread passes the
 *   link gate (step 3), else null. In practice only the person who acted, or
 *   someone they shared the thread with, gets a link.
 *
 * **Runs** — `listActiveRunsInProject(projectId, organizationId, cap + 1)`
 * (`lib/tasks/repository.ts`), then `withoutUnreadableSubjects` (the Aufträge
 * list's rule). Per row:
 * - `canStop` = what `requireRunActor` (`lib/runs/service.ts`) lets through,
 *   decided once: `requireProjectAccess(session, projectId, CHAT_PERMISSIONS)`
 *   holds, and not (`readsBecauseClosed` AND `requesterUserId !== session.userId`);
 *   and per row a `backendJobId` to cancel.
 * - `target`: `{ kind: 'run', conversationId, messageId: runMessageId, runId }`
 *   when both ids are set and the conversation passes the link gate; else
 *   `{ kind: 'task', taskId: run.id }` when `capabilities.automation`; else null.
 *
 * ## waiting (Wartet auf Entscheidung)
 *
 * **Proposals** — `listOpenProposalsInProject(reader, cap + 1)`
 * (`lib/proposals/repository.ts`): `requireReadableProposal`'s rule as a list
 * (a proposal with no conversation needs only `project:view`), then the locked
 * ones dropped. Per row: `summary = summaryOf(parseKindPayload(kind, payload))`
 * (a payload that does not parse is skipped and logged, never a 500);
 * `canDecide` = `DECIDE_PERMISSIONS[kind]` holds, asked once per kind present;
 * `target` = the turn at the origin message, else the project chat.
 *
 * **Proposed marks** — `listProposedMarkDocuments(gate, PROPOSED_MARK_DOCUMENTS_CAP + 1)`
 * and `listProposedMarkSamples(gate, documentIds, PROPOSED_MARK_SAMPLE)`
 * (`lib/annotations/repository.ts`): one row per document, `at` its newest
 * proposal, its first marks by number, `target` the Prüfansicht at the first.
 *
 * ## recent (Zuletzt)
 *
 * `since = recentSince(query, now)`, `limit = query.limit`; each source reads
 * `limit + 1` rows with its own time column `>= since`:
 * - **Ended wakes** — `listEndedProjectWakes(gate, since, limit + 1)`:
 *   `answered`, `stopped`, `failed`, `refused` (`suppressed` ran no turn).
 *   `reason` only for `failed` and `refused`, classified by
 *   {@link wakeEndReasonKind}.
 * - **Finished runs** — `listFinishedRunsInProject(…, since, limit + 1)`, then
 *   `withoutUnreadableSubjects`. `filedDocument` when one batched read of the
 *   filed ids under the gate (`listVisibleProjectDocumentNames`) returns it.
 * - **Changes** — `listRecentTurnChanges(gate, userId, since, limit + 1, CHANGE_DOCUMENTS_SHOWN)`
 *   (`lib/changes/repository.ts`): one row per turn, counted over the
 *   reader's documents in a conversation they may open (the turn card's own
 *   rule as a list); the locked ones dropped; the documents named by the same
 *   batched read.
 * - **Decided proposals** — `listDecidedProposalsInProject(reader, since, limit + 1)`:
 *   gated as the open ones; `decidedBy` is `decided_by`.
 *
 * Merge each section by `at` DESC (ties: `id` DESC) and keep its cap.
 *
 * Migration 0144 adds what these reads scan by (wakes live and ended, and
 * changes, by organization and time; decided proposals by project and time).
 * Nothing calls a model, so nothing is traced to Langfuse.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { listProposedMarkDocuments, listProposedMarkSamples } from '@/lib/annotations/repository'
import { mayEditAnnotations } from '@/lib/annotations/service'
import { delegationEventId, documentThreadConversationId } from '@/lib/annotations/wake-ids'
import { listEndedProjectWakes, listLiveProjectWakes, type ProjectWakeRow } from '@/lib/annotations/wake-repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { isPilotiWakesEnabled, isSkillsEnabled } from '@/lib/authz/feature-flags'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { listRecentTurnChanges, type TurnChangesRow } from '@/lib/changes/repository'
import { listVisibleConversationIds } from '@/lib/conversations/repository'
import { lockedConversationIds } from '@/lib/conversations/restricted-use'
import type { TaskRun } from '@/lib/db/schema'
import { documentDisplayName } from '@/lib/documents/display-name'
import { listVisibleProjectDocumentNames, type ProjectDocumentGate } from '@/lib/documents/repository'
import { projectOverviewReader } from '@/lib/projects/service'
import { DECIDE_PERMISSIONS, parseKindPayload, summaryOf } from '@/lib/proposals/kinds'
import {
  listDecidedProposalsInProject,
  listOpenProposalsInProject,
  type ProposalReader,
  type ProposedChangeRow,
} from '@/lib/proposals/repository'
import type { ProposedChangeKind } from '@/lib/proposals/types'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import { listActiveRunsInProject, listFinishedRunsInProject } from '@/lib/tasks/repository'
import { withoutUnreadableSubjects } from '@/lib/tasks/subject-access'
import {
  CHANGE_DOCUMENTS_SHOWN,
  DECIDED_PROPOSAL_STATUSES,
  ENDED_WAKE_STATUSES,
  FINISHED_RUN_STATUSES,
  MARK_EXCERPT_MAX,
  PILOTI_ACTIVITY_RUNNING_CAP,
  PILOTI_ACTIVITY_WAITING_CAP,
  PROPOSED_MARK_DOCUMENTS_CAP,
  PROPOSED_MARK_SAMPLE,
  recentSince,
  type ActivityDocument,
  type ActivityPerson,
  type ActivityTarget,
  type EndedWakeStatus,
  type FinishedRunStatus,
  type PilotiActivityQuery,
  type PilotiActivityResponse,
  type RecentChanges,
  type RecentItem,
  type RecentProposal,
  type RecentRun,
  type RecentWake,
  type RunningItem,
  type RunningRun,
  type RunningWake,
  type TurnActivityTarget,
  type WaitingItem,
  type WaitingProposal,
  type WaitingProposedMarks,
  type WakeEndReasonKind,
} from './types'

// ---------------------------------------------------------------------------
// Pure pieces, exported for the spec
// ---------------------------------------------------------------------------

/**
 * The class of a failed or refused wake's stored reason, so the view words the
 * row by what the person can do about it and shows the stored reason only as
 * a tooltip. Null for a wake that answered or was stopped, and for a missing
 * reason. The reasons that can be stored:
 *
 * - The wake job (`lib/annotations/wake-job.ts`): `budget: <the budget's
 *   message>` (refused); `gave up waiting: <why>` (failed, after its waits);
 *   `rejected: <code>[ (<message>)]` (failed: the chat socket refused the
 *   message; `auth_expired` and `conversation_mismatch` are the session and the
 *   signed envelope); the refusal's own words (refused: the socket's admission
 *   or the agent's budget said no before the turn ran).
 * - The turn's outcome (`lib/turns/outcome.ts`, posted by the chat socket):
 *   the refusal's words, `RUN_ERROR`'s message (`auth_error`, `token_expired`,
 *   `token_invalid` for an auth failure; a sentence for a deadline or a fault),
 *   `failed`, or `DEFAULT_FAILURE_REASON`.
 *
 * Anything else is `error`: the turn broke off without an answer.
 */
export function wakeEndReasonKind(status: EndedWakeStatus, reason: string | null): WakeEndReasonKind | null {
  if (status !== 'failed' && status !== 'refused') return null
  const text = reason?.trim()
  if (!text) return null
  // The job's own refusal (`budget: …`), and the agent's (`The organization's LLM budget is exhausted …`).
  if (/\bbudget\b/i.test(text)) return 'budget'
  if (/^gave up waiting\b/i.test(text)) return 'busy'
  // The socket's admission: the global pool, and the organization's.
  if (/\bis busy\b/i.test(text) || /\banswers in progress\b/i.test(text)) return 'busy'
  if (/^rejected: (auth_expired|conversation_mismatch)\b/.test(text)) return 'access'
  if (/^(auth_error|token_expired|token_invalid)$/.test(text)) return 'access'
  return 'error'
}

/** A mark's text as a row carries it: one line, at most {@link MARK_EXCERPT_MAX} characters, cut at a word with „…". */
export function markExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= MARK_EXCERPT_MAX) return flat
  const cut = flat.slice(0, MARK_EXCERPT_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > MARK_EXCERPT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

interface Dated {
  at: string
  id: string
}

/** One source's rows after its gates, and whether its read had more than it may show. */
export interface SourceRows<T extends Dated> {
  items: T[]
  truncated: boolean
}

const newestFirst = (a: Dated, b: Dated) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)

/**
 * Several sources as one section: newest first by `at` (ties: `id` DESC), at
 * most `cap`, truncated when any source was or the cut dropped a row. `at` is
 * always `toISOString()`, so the strings order as the instants do.
 */
export function mergeNewestFirst<T extends Dated>(sources: readonly SourceRows<T>[], cap: number): SourceRows<T> {
  const all = sources.flatMap((source) => source.items).sort(newestFirst)
  return { items: all.slice(0, cap), truncated: all.length > cap || sources.some((source) => source.truncated) }
}

/** A source read with one row past `cap`: its first `cap` rows, and whether there was more. */
function capped<T>(rows: readonly T[], cap: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, cap), truncated: rows.length > cap }
}

const present = <T>(value: T | null): value is T => value !== null

// ---------------------------------------------------------------------------
// The reads and the decisions
// ---------------------------------------------------------------------------

type Directory = ReadonlyMap<string, DirectoryPerson>

const personOf = (directory: Directory, userId: string): ActivityPerson => ({
  userId,
  name: directory.get(userId)?.name ?? null,
})

const isRefusal = (error: unknown) => error instanceof NotFoundError || error instanceof ForbiddenError

/** Whether `session` holds any of `permission` in the project now; a refusal is a no. */
async function holds(
  session: AuthorizedSession,
  projectId: string,
  permission: readonly ProjectPermission[]
): Promise<boolean> {
  try {
    await requireProjectAccess(session, projectId, permission)
    return true
  } catch (error) {
    if (isRefusal(error)) return false
    throw error
  }
}

/** Every source, cut to what it may show, and whether it had more. */
interface Sources {
  live: { rows: ProjectWakeRow[]; truncated: boolean }
  ended: { rows: ProjectWakeRow[]; truncated: boolean }
  activeRuns: { rows: TaskRun[]; truncated: boolean }
  finishedRuns: { rows: TaskRun[]; truncated: boolean }
  open: { rows: ProposedChangeRow[]; truncated: boolean }
  decided: { rows: ProposedChangeRow[]; truncated: boolean }
  markDocuments: { rows: Awaited<ReturnType<typeof listProposedMarkDocuments>>; truncated: boolean }
  changes: { rows: TurnChangesRow[]; truncated: boolean }
  directory: Directory
}

/** Every source in one round, each read one past what it may show; the runs narrowed by their subject. */
async function readSources(
  session: AuthorizedSession,
  gate: ProjectDocumentGate,
  since: Date,
  limit: number
): Promise<Sources> {
  const { organizationId, projectId } = gate
  const reader: ProposalReader = { organizationId, projectId, userId: session.userId }
  const [live, ended, activeRuns, finishedRuns, open, decided, markDocuments, changes, directory] = await Promise.all([
    listLiveProjectWakes(gate, PILOTI_ACTIVITY_RUNNING_CAP + 1),
    listEndedProjectWakes(gate, since, limit + 1),
    listActiveRunsInProject(projectId, organizationId, PILOTI_ACTIVITY_RUNNING_CAP + 1),
    listFinishedRunsInProject(projectId, organizationId, since, limit + 1),
    listOpenProposalsInProject(reader, PILOTI_ACTIVITY_WAITING_CAP + 1),
    listDecidedProposalsInProject(reader, since, limit + 1),
    listProposedMarkDocuments(gate, PROPOSED_MARK_DOCUMENTS_CAP + 1),
    listRecentTurnChanges(gate, session.userId, since, limit + 1, CHANGE_DOCUMENTS_SHOWN),
    loadOrganizationDirectory(organizationId),
  ])
  const runs = { active: capped(activeRuns, PILOTI_ACTIVITY_RUNNING_CAP), finished: capped(finishedRuns, limit) }
  // The Aufträge list's rule, asked once for both lists.
  const readable = new Set(
    (await withoutUnreadableSubjects(session, projectId, [...runs.active.rows, ...runs.finished.rows])).map(
      (run) => run.id
    )
  )
  const keepReadable = (source: { rows: TaskRun[]; truncated: boolean }) => ({
    rows: source.rows.filter((run) => readable.has(run.id)),
    truncated: source.truncated,
  })
  return {
    live: capped(live, PILOTI_ACTIVITY_RUNNING_CAP),
    ended: capped(ended, limit),
    activeRuns: keepReadable(runs.active),
    finishedRuns: keepReadable(runs.finished),
    open: capped(open, PILOTI_ACTIVITY_WAITING_CAP),
    decided: capped(decided, limit),
    markDocuments: capped(markDocuments, PROPOSED_MARK_DOCUMENTS_CAP),
    changes: capped(changes, limit),
    directory,
  }
}

/** What a run's stop needs: `requireRunActor`'s rule, decided once, and a job to cancel. */
async function stopRule(
  session: AuthorizedSession,
  projectId: string,
  runs: readonly TaskRun[]
): Promise<(run: TaskRun) => boolean> {
  if (runs.length === 0) return () => false
  try {
    const access = await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
    return (run) => run.backendJobId !== null && !(access.readsBecauseClosed && run.requesterUserId !== session.userId)
  } catch (error) {
    if (isRefusal(error)) return () => false
    throw error
  }
}

/** The delegation a wake belongs to is still the mark's current one. */
const isCurrentDelegation = (wake: ProjectWakeRow) =>
  wake.triggerKind === 'assigned' &&
  wake.markDelegatedAt !== null &&
  wake.eventId === delegationEventId(wake.annotationId, wake.markDelegatedAt)

/** The documents among these wakes' whose marks this reader may edit, asked once per document. */
async function editableDocuments(session: AuthorizedSession, wakes: readonly ProjectWakeRow[]): Promise<Set<string>> {
  const asked = [...new Set(wakes.filter(isCurrentDelegation).map((wake) => wake.documentId))]
  const answers = await Promise.all(
    asked.map((documentId) =>
      mayEditAnnotations(session, documentId).catch((error: unknown) => {
        if (isRefusal(error)) return false
        throw error
      })
    )
  )
  return new Set(asked.filter((_, index) => answers[index]))
}

/** The kinds among these proposals this reader may decide, asked once per kind. */
async function decidableKinds(
  session: AuthorizedSession,
  projectId: string,
  proposals: readonly ProposedChangeRow[]
): Promise<Set<ProposedChangeKind>> {
  const kinds = [...new Set(proposals.map((proposal) => proposal.kind))]
  const answers = await Promise.all(kinds.map((kind) => holds(session, projectId, DECIDE_PERMISSIONS[kind])))
  return new Set(kinds.filter((_, index) => answers[index]))
}

const wakeThread = (wake: ProjectWakeRow) => documentThreadConversationId(wake.documentId, wake.actorUserId)

const runThread = (run: TaskRun): string | null => (run.conversationId && run.runMessageId ? run.conversationId : null)

/**
 * The conversations a row may link to (`listVisibleConversationIds` over the
 * link candidates), and the locked ones among those and the conversations rows
 * live in. One locked-read for the whole response.
 */
async function conversationGates(
  session: AuthorizedSession,
  projectId: string,
  sources: Sources
): Promise<{ linkable: Set<string>; locked: Set<string> }> {
  const candidates = [
    ...[...sources.live.rows, ...sources.ended.rows].map(wakeThread),
    ...[...sources.activeRuns.rows, ...sources.finishedRuns.rows].map(runThread).filter(present),
  ]
  const homes = [
    ...[...sources.open.rows, ...sources.decided.rows].map((row) => row.originConversationId).filter(present),
    ...sources.changes.rows.map((row) => row.conversationId),
  ]
  const visible = await listVisibleConversationIds(session.organizationId, session.userId, projectId, candidates)
  const refs = [...new Set([...visible, ...homes])].map((id) => ({ id, projectId }))
  const locked = refs.length > 0 ? await lockedConversationIds(session, refs) : new Set<string>()
  return { linkable: new Set([...visible].filter((id) => !locked.has(id))), locked }
}

/** Everything a row is decided by, beyond its own record. */
interface RowContext {
  directory: Directory
  linkable: ReadonlySet<string>
  locked: ReadonlySet<string>
  automation: boolean
  editable: ReadonlySet<string>
  decidable: ReadonlySet<string>
  mayStop: (run: TaskRun) => boolean
  /** The documents the gate names, by id: a change's and a filed document's. */
  named: ReadonlyMap<string, ActivityDocument>
}

const documentOf = (id: string, row: { filename: string; displayName: string | null }): ActivityDocument => ({
  id,
  name: documentDisplayName(row),
})

/** The documents the changes and the filed runs name, under the gate, in one read. */
async function namedDocuments(gate: ProjectDocumentGate, sources: Sources): Promise<Map<string, ActivityDocument>> {
  const rows = await listVisibleProjectDocumentNames(gate, [
    ...sources.changes.rows.flatMap((row) => row.documentIds),
    ...sources.finishedRuns.rows.map((run) => run.filedDocumentId).filter(present),
  ])
  return new Map(rows.map((row) => [row.id, documentOf(row.id, row)]))
}

/** Every decision the rows need, beside the sources, in one round. */
async function rowContext(
  session: AuthorizedSession,
  gate: ProjectDocumentGate,
  sources: Sources
): Promise<RowContext> {
  const [gates, mayStop, editable, decidable, named] = await Promise.all([
    conversationGates(session, gate.projectId, sources),
    stopRule(session, gate.projectId, sources.activeRuns.rows),
    editableDocuments(session, sources.live.rows),
    decidableKinds(session, gate.projectId, sources.open.rows),
    namedDocuments(gate, sources),
  ])
  return { directory: sources.directory, ...gates, automation: isSkillsEnabled(session), editable, decidable, mayStop, named }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What a live and an ended wake share. */
function wakeParts(wake: ProjectWakeRow, context: RowContext) {
  const thread = wakeThread(wake)
  const turn: TurnActivityTarget | null = context.linkable.has(thread)
    ? { kind: 'turn', conversationId: thread, messageId: wake.id }
    : null
  return {
    id: wake.id,
    trigger: wake.triggerKind,
    forPerson: personOf(context.directory, wake.actorUserId),
    document: documentOf(wake.documentId, { filename: wake.documentFilename, displayName: wake.documentDisplayName }),
    mark: { id: wake.annotationId, number: wake.markNumber, kind: wake.markKind, excerpt: markExcerpt(wake.markBody) },
    target: { kind: 'review' as const, documentId: wake.documentId, annotationId: wake.annotationId },
    turn,
  }
}

function runningWake(wake: ProjectWakeRow, context: RowContext): RunningWake | null {
  if (wake.status !== 'queued' && wake.status !== 'started') return null
  return {
    kind: 'wake',
    ...wakeParts(wake, context),
    at: wake.createdAt.toISOString(),
    status: wake.status,
    startedAt: wake.status === 'started' && wake.settledAt ? wake.settledAt.toISOString() : null,
    canTakeBack: isCurrentDelegation(wake) && context.editable.has(wake.documentId),
  }
}

const isEndedWakeStatus = (status: string): status is EndedWakeStatus =>
  (ENDED_WAKE_STATUSES as readonly string[]).includes(status)

function recentWake(wake: ProjectWakeRow, context: RowContext): RecentWake | null {
  if (!isEndedWakeStatus(wake.status) || !wake.endedAt) return null
  const reason = wake.status === 'failed' || wake.status === 'refused' ? wake.reason : null
  return {
    kind: 'wake_ended',
    ...wakeParts(wake, context),
    at: wake.endedAt.toISOString(),
    status: wake.status,
    reason,
    reasonKind: wakeEndReasonKind(wake.status, reason),
  }
}

function runTarget(run: TaskRun, context: RowContext): ActivityTarget | null {
  const thread = runThread(run)
  if (thread && run.runMessageId && context.linkable.has(thread)) {
    return { kind: 'run', conversationId: thread, messageId: run.runMessageId, runId: run.id }
  }
  return context.automation ? { kind: 'task', taskId: run.id } : null
}

function runningRun(run: TaskRun, context: RowContext): RunningRun | null {
  if (run.status !== 'queued' && run.status !== 'running') return null
  return {
    kind: 'run',
    id: run.id,
    at: run.createdAt.toISOString(),
    status: run.status,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    taskKind: run.kind,
    title: run.title,
    forPerson: personOf(context.directory, run.requesterUserId),
    canStop: context.mayStop(run),
    target: runTarget(run, context),
  }
}

const isFinishedRunStatus = (status: string): status is FinishedRunStatus =>
  (FINISHED_RUN_STATUSES as readonly string[]).includes(status)

function recentRun(run: TaskRun, context: RowContext): RecentRun | null {
  if (!isFinishedRunStatus(run.status)) return null
  return {
    kind: 'run_finished',
    id: run.id,
    at: (run.finishedAt ?? run.updatedAt).toISOString(),
    status: run.status,
    error: run.error ?? null,
    taskKind: run.kind,
    title: run.title,
    forPerson: personOf(context.directory, run.requesterUserId),
    filedDocument: (run.filedDocumentId ? context.named.get(run.filedDocumentId) : undefined) ?? null,
    target: runTarget(run, context),
  }
}

/** The one line a proposal is named by, or null (logged) for a payload this build cannot read. */
function proposalSummary(row: ProposedChangeRow): string | null {
  try {
    return summaryOf(parseKindPayload(row.kind, row.payload))
  } catch (error) {
    console.warn(`[piloti-activity] proposal ${row.id} (${row.kind}) has a payload that does not parse; left out:`, error)
    return null
  }
}

const proposalTarget = (row: ProposedChangeRow): ActivityTarget =>
  row.originConversationId
    ? { kind: 'turn', conversationId: row.originConversationId, messageId: row.originMessageId ?? null }
    : { kind: 'project_chat' }

/** A proposal lives in its conversation: one locked for this reader is not shown. */
const proposalUnlocked = (row: ProposedChangeRow, context: RowContext) =>
  row.originConversationId === null || !context.locked.has(row.originConversationId)

function waitingProposal(row: ProposedChangeRow, context: RowContext): WaitingProposal | null {
  const summary = proposalUnlocked(row, context) ? proposalSummary(row) : null
  if (summary === null) return null
  return {
    kind: 'proposal',
    id: row.id,
    at: row.createdAt.toISOString(),
    proposalKind: row.kind,
    summary,
    forPerson: personOf(context.directory, row.onBehalfOf),
    canDecide: context.decidable.has(row.kind),
    target: proposalTarget(row),
  }
}

const isDecidedStatus = (status: string): status is RecentProposal['status'] =>
  (DECIDED_PROPOSAL_STATUSES as readonly string[]).includes(status)

function decidedProposal(row: ProposedChangeRow, context: RowContext): RecentProposal | null {
  if (!isDecidedStatus(row.status) || !row.decidedAt || !row.decidedBy) return null
  const summary = proposalUnlocked(row, context) ? proposalSummary(row) : null
  if (summary === null) return null
  return {
    kind: 'proposal_decided',
    id: row.id,
    at: row.decidedAt.toISOString(),
    proposalKind: row.kind,
    status: row.status,
    summary,
    forPerson: personOf(context.directory, row.onBehalfOf),
    decidedBy: personOf(context.directory, row.decidedBy),
    target: proposalTarget(row),
  }
}

function turnChanges(row: TurnChangesRow, context: RowContext): RecentChanges | null {
  if (context.locked.has(row.conversationId) || row.count < 1) return null
  const documents = row.documentIds
    .map((id) => context.named.get(id))
    .filter((document): document is ActivityDocument => document !== undefined)
    .slice(0, CHANGE_DOCUMENTS_SHOWN)
  if (documents.length === 0) return null
  return {
    kind: 'changes',
    id: `${row.conversationId}:${row.messageId}`,
    at: row.newestAt.toISOString(),
    count: row.count,
    undoneCount: Math.min(row.undoneCount, row.count),
    documents,
    documentCount: Math.max(row.documentCount, documents.length),
    forPerson: personOf(context.directory, row.onBehalfOf),
    target: { kind: 'turn', conversationId: row.conversationId, messageId: row.messageId },
  }
}

/** One document's proposed marks as a row: its first marks by number, or null when they went in between the reads. */
function proposedMarksRow(
  document: Sources['markDocuments']['rows'][number],
  samples: Awaited<ReturnType<typeof listProposedMarkSamples>>,
  directory: Directory
): WaitingProposedMarks | null {
  const marks = samples
    .filter((mark) => mark.documentId === document.documentId)
    .sort((a, b) => a.number - b.number)
    .slice(0, PROPOSED_MARK_SAMPLE)
    .map((mark) => ({
      id: mark.id,
      number: mark.number,
      kind: mark.kind,
      excerpt: markExcerpt(mark.body),
      page: mark.page,
      forPerson: personOf(directory, mark.createdBy),
      createdAt: mark.createdAt.toISOString(),
    }))
  if (marks.length === 0) return null
  return {
    kind: 'proposed_marks',
    id: document.documentId,
    at: document.newestAt.toISOString(),
    document: documentOf(document.documentId, document),
    count: Math.max(document.count, marks.length),
    marks,
    target: { kind: 'review', documentId: document.documentId, annotationId: marks[0].id },
  }
}

async function proposedMarkRows(gate: ProjectDocumentGate, sources: Sources): Promise<WaitingProposedMarks[]> {
  const documents = sources.markDocuments.rows
  if (documents.length === 0) return []
  const samples = await listProposedMarkSamples(
    gate,
    documents.map((document) => document.documentId),
    PROPOSED_MARK_SAMPLE
  )
  return documents.map((document) => proposedMarksRow(document, samples, sources.directory)).filter(present)
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** One source's rows through its row builder, keeping whether it had more. */
const rowsOf = <S, T extends Dated>(
  source: { rows: S[]; truncated: boolean },
  build: (row: S) => T | null
): SourceRows<T> => ({ items: source.rows.map(build).filter(present), truncated: source.truncated })

/**
 * What Piloti is doing in `projectId`, as `session`'s person may see it: the
 * three sections of {@link PilotiActivityResponse}. 404 (`NotFoundError`) for
 * a project the person may not view. Specified in the module header.
 */
export async function getPilotiActivity(
  session: AuthorizedSession,
  projectId: string,
  query: PilotiActivityQuery
): Promise<PilotiActivityResponse> {
  await requireProjectAccess(session, projectId, 'project:view')
  const { hiddenFolderIds, reader } = await projectOverviewReader(session, projectId)
  const gate: ProjectDocumentGate = { organizationId: session.organizationId, projectId, reader, hiddenFolderIds }
  const now = new Date()
  const since = recentSince(query, now)
  const sources = await readSources(session, gate, since, query.limit)
  const [context, markRows] = await Promise.all([rowContext(session, gate, sources), proposedMarkRows(gate, sources)])
  const recent = mergeNewestFirst<RecentItem>(
    [
      rowsOf(sources.ended, (wake) => recentWake(wake, context)),
      rowsOf(sources.finishedRuns, (run) => recentRun(run, context)),
      rowsOf(sources.changes, (row) => turnChanges(row, context)),
      rowsOf(sources.decided, (row) => decidedProposal(row, context)),
    ],
    query.limit
  )
  return {
    projectId,
    viewerUserId: session.userId,
    generatedAt: now.toISOString(),
    capabilities: { wakes: isPilotiWakesEnabled(session), automation: context.automation },
    running: mergeNewestFirst<RunningItem>(
      [
        rowsOf(sources.live, (wake) => runningWake(wake, context)),
        rowsOf(sources.activeRuns, (run) => runningRun(run, context)),
      ],
      PILOTI_ACTIVITY_RUNNING_CAP
    ),
    waiting: mergeNewestFirst<WaitingItem>(
      [
        rowsOf(sources.open, (row) => waitingProposal(row, context)),
        { items: markRows, truncated: sources.markDocuments.truncated },
      ],
      PILOTI_ACTIVITY_WAITING_CAP
    ),
    recent: { ...recent, since: since.toISOString() },
  }
}
