/**
 * Project intake service (ADR-0111, `docs/design/agentic-project-intake.md`):
 * the review a person reads and decides on, and the reading Piloti runs.
 *
 * One service, two kinds of caller, the same rules (ADR-0055):
 *
 *  - a person, through `/api/projects/[id]/intake` (`./client.ts`): read the
 *    review, start a reading, decide on suggestions, finish the review;
 *  - the reading itself, through `POST /api/internal/project-intake`, as the
 *    pinned session of the person who started it (ADR-0108): what the project
 *    still needs, the values it found, and that it has finished.
 *
 * The values live on the profile and are written only through
 * `patchProjectProfile`, the profile's one door, so its vocabulary check, its
 * prune and its caches apply to a reading as to a person. A write that loses
 * the profile's optimistic lock is planned again on the fresh profile, up to
 * {@link MAX_WRITE_ATTEMPTS} times.
 *
 * A reading holds the intake's `job_id`; every internal op names it, and one
 * that is not the current reading's is refused with 409 `stale-reading`.
 */

import 'server-only'
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import type { ProjectIntakeRow } from '@/lib/db/schema/project-intakes'
import { withTenant } from '@/lib/db/tenant-context'
import { fetchBackendJobOutcome, JobProbeError } from '@/lib/jobs/backend-client'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { extractableDocuments, type ExtractableDocument } from '@/lib/project-experience/readable-files'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { salvageProjectProfile } from '@/lib/project-profile/salvage'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { isProjectClosedError, PROJECT_CLOSED_REASON } from '@/lib/projects/project-status'
import { findProjectInOrg, findProjectProfileInOrg } from '@/lib/projects/repository'
import { setProjectStatus } from '@/lib/projects/service'
import { maskAnswerText } from '@/lib/upload-screening/service'
import { onIntakeCompleted, onIntakeReady } from './attention'
import { planDecisions } from './decisions'
import { documentEvidence, reasonFromEvidence } from './evidence'
import { computeNeeds } from './needs'
import { planRecord, staticRefusal, type ScreenedValue } from './record'
import { patchForKeys } from './profile-edits'
import {
  addIntakeDismissed,
  claimIntakeReading,
  completeProjectIntake,
  endIntakeReading,
  findProjectIntake,
  findProjectIntakeByJobId,
  requestIntakeRerun,
} from './repository'
import { mintIntakeJobId, submitIntakeRun, type IntakeTrigger } from './run'
import { enqueueIntakeRead } from './trigger'
import {
  MAX_INTAKE_NEEDS,
  MAX_UNREAD_FILES,
  STALE_READING_REASON,
  type DocumentRead,
  type IntakeDecision,
  type IntakeDecisionResult,
  type IntakeStatus,
  type IntakeView,
  type InternalIntakeNeedsResponse,
  type Need,
  type RecordRefusalReason,
  type RecordResult,
  type RecordValue,
  type StartIntakeRequest,
} from './types'
import { buildIntakeView, intakeCounts } from './view'

/** Writing the profile (`PROFILE_WRITE` in `profile-service.ts`): a decision, a reading, starting one. */
const PROFILE_WRITE: readonly ProjectPermission[] = ['project:memory:write', 'project:edit']

/** A reading older than this, still `reading`, is asked about at the backend when the review is read. */
export const STALE_READING_AFTER_MS = 30 * 60 * 1000

/** How often a profile write is planned again after losing the optimistic lock. */
export const MAX_WRITE_ATTEMPTS = 3

const definition = projectIntakeDefinitionV1

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function requireIntake(organizationId: string, projectId: string): Promise<ProjectIntakeRow> {
  const row = await findProjectIntake(organizationId, projectId)
  if (!row) throw new NotFoundError('This project has no intake.')
  return row
}

async function loadProfile(organizationId: string, projectId: string): Promise<ProjectProfile> {
  const state = await findProjectProfileInOrg(projectId, organizationId)
  if (!state) throw new NotFoundError()
  return salvageProjectProfile(state.profile).profile ?? emptyProjectProfile()
}

async function requireProject(organizationId: string, projectId: string) {
  const project = await findProjectInOrg(projectId, organizationId)
  if (!project) throw new NotFoundError()
  return project
}

/** The documents a reading may read: the project's main collection, as every member may open it. */
async function readableDocuments(organizationId: string, projectId: string): Promise<ExtractableDocument[]> {
  const project = await requireProject(organizationId, projectId)
  return withTenant({ organizationId }, () => extractableDocuments(organizationId, projectId, project.collectionName))
}

/** What stands for a document's bytes: its content hash, or its last change when the hash is unknown. */
export function contentKeyOf(document: Pick<ExtractableDocument, 'contentHash' | 'updatedAt'>): string {
  return document.contentHash ?? `updated:${document.updatedAt.toISOString()}`
}

/** The readable documents a reading has not read in the bytes they hold now. */
export function unreadDocuments(documents: readonly ExtractableDocument[], read: readonly DocumentRead[]): ExtractableDocument[] {
  const seen = new Set(read.map((entry) => `${entry.documentId}\u0000${entry.contentHash}`))
  return documents.filter((document) => !seen.has(`${document.documentId}\u0000${contentKeyOf(document)}`))
}

const needsOf = (profile: ProjectProfile, row: ProjectIntakeRow): Need[] =>
  computeNeeds(profile, definition, { mode: row.mode, dismissed: row.dismissed })

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function holds(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission | readonly ProjectPermission[]
): Promise<boolean> {
  try {
    await requireProjectAccess(session, projectId, permission)
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/** Profile write, with a closed project refused as a 409 the review can name. */
async function requireProfileWriter(session: AuthorizedSession, projectId: string): Promise<void> {
  try {
    await requireProjectAccess(session, projectId, PROFILE_WRITE)
  } catch (error) {
    if (!isProjectClosedError(error)) throw error
    throw new ConflictError('This project is closed. Reopen it to read its documents again.', {
      reason: PROJECT_CLOSED_REASON,
    })
  }
}

const staleReading = () =>
  new ConflictError('This reading is no longer the intake’s current one.', { reason: STALE_READING_REASON })

const intakeCompleted = () =>
  new ConflictError('The review of this intake was finished.', { reason: 'intake-completed' })

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

async function viewOf(session: AuthorizedSession, row: ProjectIntakeRow): Promise<IntakeView> {
  const { organizationId } = session
  const [profile, documents, canDecide, canManage] = await Promise.all([
    loadProfile(organizationId, row.projectId),
    readableDocuments(organizationId, row.projectId),
    holds(session, row.projectId, PROFILE_WRITE),
    row.mode === 'closing' ? holds(session, row.projectId, 'project:manage') : Promise.resolve(false),
  ])
  const open = row.status !== 'completed'
  return buildIntakeView({
    row,
    profile,
    definition,
    needs: needsOf(profile, row),
    unreadDocuments: unreadDocuments(documents, row.documentsRead).length,
    canDecide,
    canComplete: open && (row.mode === 'closing' ? canManage : canDecide),
  })
}

/**
 * A reading the worker never reported back on: past {@link STALE_READING_AFTER_MS}
 * the backend is asked. A job it does not know, or one that failed or was
 * cancelled, fails the reading; a finished one ends it as read. One that still
 * runs, or a backend that does not answer, leaves it be.
 */
async function reconcileStaleReading(row: ProjectIntakeRow, now: Date): Promise<ProjectIntakeRow> {
  if (row.status !== 'reading' || !row.jobId || !row.startedAt) return row
  if (now.getTime() - new Date(row.startedAt).getTime() < STALE_READING_AFTER_MS) return row
  let outcome: Awaited<ReturnType<typeof fetchBackendJobOutcome>>
  try {
    outcome = await fetchBackendJobOutcome(row.jobId, row.organizationId)
  } catch (error) {
    if (error instanceof JobProbeError) return row
    throw error
  }
  if (outcome && (outcome.status === 'submitted' || outcome.status === 'running')) return row
  const status = outcome?.status === 'success' ? 'ready' : 'failed'
  const ended = await endIntakeReading(row.organizationId, row.projectId, row.jobId, { status, now })
  return ended ?? (await requireIntake(row.organizationId, row.projectId))
}

/** The review, as the reader may see it. `project:view`. */
export async function getIntakeView(session: AuthorizedSession, projectId: string): Promise<IntakeView> {
  await requireProjectAccess(session, projectId, 'project:view')
  const row = await reconcileStaleReading(await requireIntake(session.organizationId, projectId), new Date())
  return viewOf(session, row)
}

// ---------------------------------------------------------------------------
// Starting a reading
// ---------------------------------------------------------------------------

/**
 * Claim and submit a reading as `session`. Single flight: when one runs, a
 * rerun is recorded and the running one starts the next when it finishes. A
 * submission the backend refuses fails the reading and throws.
 */
async function beginReading(
  session: AuthorizedSession,
  projectId: string,
  scope: StartIntakeRequest['scope'],
  trigger: IntakeTrigger
): Promise<ProjectIntakeRow> {
  const { organizationId } = session
  const project = await requireProject(organizationId, projectId)
  const jobId = mintIntakeJobId()
  const now = new Date()
  const claimed = await claimIntakeReading(organizationId, projectId, {
    jobId,
    requestedBy: session.userId,
    forgetRead: scope === 'all',
    now,
  })
  if (!claimed) {
    // Somebody else claimed it between the read and the claim, or it was finished.
    const rerun = await requestIntakeRerun(organizationId, projectId)
    return rerun ?? (await requireIntake(organizationId, projectId))
  }
  try {
    const submitted = await submitIntakeRun({
      organizationId,
      projectId,
      userId: session.userId,
      email: session.email || null,
      collectionName: project.collectionName,
      jobId,
      scope,
      trigger,
    })
    if (submitted !== jobId) console.warn(`[project-intake] the backend ran ${jobId} as ${submitted}`)
    return claimed
  } catch (error) {
    await endIntakeReading(organizationId, projectId, jobId, { status: 'failed', now: new Date() })
    console.error(`[project-intake] submitting the reading of ${projectId} failed:`, error)
    throw new ServiceUnavailableError('Piloti could not start reading the documents. Try again in a moment.', {
      reason: 'submit-failed',
    })
  }
}

/** Start a reading, or record a rerun when one runs. The intake as it stands. Profile write. */
async function startReading(
  session: AuthorizedSession,
  projectId: string,
  scope: StartIntakeRequest['scope'],
  trigger: IntakeTrigger
): Promise<ProjectIntakeRow> {
  await requireProfileWriter(session, projectId)
  const row = await requireIntake(session.organizationId, projectId)
  if (row.status === 'completed') throw intakeCompleted()
  if (row.status === 'reading') {
    return (await requestIntakeRerun(session.organizationId, projectId)) ?? (await requireIntake(session.organizationId, projectId))
  }
  return beginReading(session, projectId, scope, trigger)
}

/** `POST /api/projects/[id]/intake`: start a reading now (`all` forgets what was read). */
export async function startIntakeRun(
  session: AuthorizedSession,
  projectId: string,
  body: StartIntakeRequest,
  trigger: IntakeTrigger = 'click'
): Promise<IntakeView> {
  return viewOf(session, await startReading(session, projectId, body.scope, trigger))
}

/**
 * The `project_intake_read` BFF job (`lib/jobs-queue/handlers.ts`), as the
 * uploader: a reading of what is new. A requester who may no longer write the
 * profile, a project gone or closed, or a review finished ends the job quietly;
 * a retry would be refused the same way.
 */
export async function runIntakeReadSlice<TPayload extends { projectId: string }>(
  session: AuthorizedSession,
  payload: TPayload
): Promise<{ done: true; payload: TPayload }> {
  try {
    await startReading(session, payload.projectId, 'new', 'upload')
  } catch (error) {
    const refused = error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ConflictError
    if (!refused) throw error
    console.warn(`[project-intake] no reading of ${payload.projectId} for ${session.userId}:`, error.message)
  }
  return { done: true, payload }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Plan on the profile as it is, write through the one door, again on a lost lock. */
async function writeProfile<TPlan>(
  session: AuthorizedSession,
  projectId: string,
  plan: (profile: ProjectProfile) => { value: TPlan; before: ProjectProfile; after: ProjectProfile; keys: string[] }
): Promise<TPlan> {
  for (let attempt = 1; ; attempt += 1) {
    const profile = await loadProfile(session.organizationId, projectId)
    const planned = plan(profile)
    const operations = patchForKeys(planned.before, planned.after, planned.keys)
    if (operations.length === 0) return planned.value
    try {
      await patchProjectProfile(session, projectId, operations)
      return planned.value
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= MAX_WRITE_ATTEMPTS) throw error
    }
  }
}

function scoreDecisions(
  row: ProjectIntakeRow,
  session: AuthorizedSession,
  scored: ReturnType<typeof planDecisions>['scored']
): Promise<unknown> {
  if (!row.traceId || scored.length === 0) return Promise.resolve()
  const reading = row.jobId ?? row.id
  return Promise.all(
    scored.map((entry) =>
      recordDecisionScore({
        organizationId: row.organizationId,
        subject: 'intake_suggestion',
        subjectId:
          entry.alternativeIndex === null ? `${reading}-${entry.key}` : `${reading}-${entry.key}-${entry.alternativeIndex}`,
        decision: entry.decision,
        decidedBy: session.userId,
        traceId: row.traceId,
      })
    )
  )
}

/** `POST /api/projects/[id]/intake/decisions`: one patch for the batch, a result per decision. Profile write. */
export async function applyIntakeDecisions(
  session: AuthorizedSession,
  projectId: string,
  decisions: readonly IntakeDecision[]
): Promise<{ results: IntakeDecisionResult[]; intake: IntakeView }> {
  await requireProfileWriter(session, projectId)
  const row = await requireIntake(session.organizationId, projectId)
  const plan = await writeProfile(session, projectId, (profile) => {
    const planned = planDecisions(profile, decisions, { userId: session.userId, now: new Date().toISOString() })
    return { value: planned, before: profile, after: planned.profile, keys: planned.changedKeys }
  })
  const updated = plan.dismissed.length > 0 ? await addIntakeDismissed(session.organizationId, projectId, plan.dismissed) : null
  // The score is the reading's precision; `recordDecisionScore` never rejects.
  await scoreDecisions(row, session, plan.scored)
  return { results: plan.results, intake: await viewOf(session, updated ?? row) }
}

// ---------------------------------------------------------------------------
// Finishing the review
// ---------------------------------------------------------------------------

/**
 * `POST /api/projects/[id]/intake/complete`. For a closing intent the project
 * is closed with its outcome and Abschluss (`setProjectStatus`, which asks
 * `project:manage`); otherwise profile write. Finishing twice answers the
 * finished review.
 */
export async function completeIntake(session: AuthorizedSession, projectId: string, request?: Request): Promise<IntakeView> {
  await requireProjectAccess(session, projectId, 'project:view')
  const row = await requireIntake(session.organizationId, projectId)
  if (row.status === 'completed') return viewOf(session, row)
  if (row.mode === 'closing' && row.closing) {
    await setProjectStatus(session, projectId, {
      status: 'closed',
      outcome: row.closing.outcome,
      endedOn: row.closing.endedOn,
    }, request)
  } else {
    await requireProfileWriter(session, projectId)
  }
  const completed = await completeProjectIntake(session.organizationId, projectId, session.userId, new Date())
  await onIntakeCompleted({ organizationId: session.organizationId, intakeId: row.id })
  return viewOf(session, completed ?? (await requireIntake(session.organizationId, projectId)))
}

// ---------------------------------------------------------------------------
// The reading's own ops (`POST /api/internal/project-intake`)
// ---------------------------------------------------------------------------

/** The intake, when `jobId` is its current reading; 409 `stale-reading` otherwise. */
async function requireCurrentReading(session: AuthorizedSession, projectId: string, jobId: string): Promise<ProjectIntakeRow> {
  await requireProjectAccess(session, projectId, 'project:view')
  const row = await findProjectIntake(session.organizationId, projectId)
  if (!row) throw new NotFoundError('This project has no intake.')
  if (row.status !== 'reading' || row.jobId !== jobId) throw staleReading()
  return row
}

/** `needs`: what the project still needs, and the readable files not read yet. */
export async function intakeNeeds(
  session: AuthorizedSession,
  projectId: string,
  jobId: string
): Promise<InternalIntakeNeedsResponse> {
  const row = await requireCurrentReading(session, projectId, jobId)
  const [profile, documents] = await Promise.all([
    loadProfile(session.organizationId, projectId),
    readableDocuments(session.organizationId, projectId),
  ])
  const unread = [...new Set(unreadDocuments(documents, row.documentsRead).map((document) => document.fileName))]
  return {
    needs: needsOf(profile, row).slice(0, MAX_INTAKE_NEEDS),
    unreadFiles: unread.slice(0, MAX_UNREAD_FILES),
    description: row.description ?? null,
    location: row.location ?? null,
    mode: row.mode,
  }
}

/**
 * The static screen of each value (vocabulary, dismissed, unreadable file),
 * and the masked evidence of each that passed. Masked once, before any write
 * attempt: the quote does not change with the profile.
 */
async function screenValues(
  organizationId: string,
  row: ProjectIntakeRow,
  values: readonly RecordValue[],
  profile: ProjectProfile,
  readableFiles: ReadonlySet<string>
): Promise<Array<{ key: string; screened: ScreenedValue | null; refusal: RecordRefusalReason | null }>> {
  const needs = new Map(needsOf(profile, row).map((need) => [need.key, need]))
  return Promise.all(
    values.map(async (value) => {
      const refusal = staticRefusal(value, { needs, dismissed: row.dismissed, readableFiles })
      if (refusal) return { key: value.key, screened: null, refusal }
      const evidence = await documentEvidence(value.evidence, { organizationId })
      return { key: value.key, screened: { key: value.key, value: value.value, evidence, reason: reasonFromEvidence(evidence) }, refusal: null }
    })
  )
}

/**
 * `record`: what each value became (`./record.ts`). One profile write for the
 * batch, the derived Gebäudeklasse of every Bauwerk whose inputs moved with it.
 */
export async function recordIntakeValues(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  values: readonly RecordValue[]
): Promise<{ results: RecordResult[] }> {
  const { organizationId } = session
  const row = await requireCurrentReading(session, projectId, jobId)
  const [profile, documents] = await Promise.all([
    loadProfile(organizationId, projectId),
    readableDocuments(organizationId, projectId),
  ])
  const readableFiles = new Set(documents.map((document) => document.fileName))
  const screened = await screenValues(organizationId, row, values, profile, readableFiles)
  const results = await writeProfile(session, projectId, (current) => {
    const needs = new Map(needsOf(current, row).map((need) => [need.key, need]))
    const plan = planRecord(current, definition, screened, needs, new Date().toISOString())
    return { value: plan.results, before: current, after: plan.profile, keys: plan.changedKeys }
  })
  return { results }
}

/** The file names a reading reports as read, as `{ documentId, contentHash }`, merged over what was read before. */
export function mergeDocumentsRead(
  previous: readonly DocumentRead[],
  documents: readonly ExtractableDocument[],
  fileNames: readonly string[]
): DocumentRead[] {
  const named = new Set(fileNames)
  const merged = new Map(previous.map((entry) => [entry.documentId, entry]))
  for (const document of documents) {
    if (named.has(document.fileName)) {
      merged.set(document.documentId, { documentId: document.documentId, contentHash: contentKeyOf(document) })
    }
  }
  return [...merged.values()]
}

/**
 * `finish`: the reading ends `ready` with what it read, its counts, its
 * summary (masked) and its trace; its requester is told. A rerun asked for
 * meanwhile starts at once, as the same person.
 */
export async function finishIntakeReading(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  input: { summary: string; documentsRead: readonly string[]; traceId: string | null }
): Promise<{ status: IntakeStatus }> {
  const { organizationId } = session
  const row = await requireCurrentReading(session, projectId, jobId)
  const [profile, documents, project] = await Promise.all([
    loadProfile(organizationId, projectId),
    readableDocuments(organizationId, projectId),
    requireProject(organizationId, projectId),
  ])
  const documentsRead = mergeDocumentsRead(row.documentsRead, documents, input.documentsRead)
  const needs = needsOf(profile, row)
  const counts = intakeCounts(profile, definition, needs, documentsRead.length)
  const summary = input.summary.trim() ? (await maskAnswerText(organizationId, input.summary.trim())).text : null
  const ended = await endIntakeReading(organizationId, projectId, jobId, {
    status: 'ready',
    now: new Date(),
    documentsRead,
    counts,
    summary,
    traceId: input.traceId,
  })
  if (!ended) throw staleReading()
  await onIntakeReady({
    organizationId,
    projectId,
    intakeId: ended.id,
    recipientUserId: ended.requestedBy ?? session.userId,
    projectName: project.name,
    decisiveOpen: counts.decisiveOpen,
    summary,
  })
  if (!ended.rerunRequested) return { status: ended.status }
  try {
    return { status: (await beginReading(session, projectId, 'new', 'upload')).status }
  } catch (error) {
    console.warn(`[project-intake] the rerun of ${projectId} could not start; the next upload or a click starts it:`, error)
    return { status: (await requireIntake(organizationId, projectId)).status }
  }
}

// ---------------------------------------------------------------------------
// The worker's outcome
// ---------------------------------------------------------------------------

/**
 * How the backend job of a reading ended, from the worker's outcome callback
 * (`/api/internal/jobs/[jobId]/outcome`) when no run row knows the job. A
 * reading still running ends: `failed` when the job failed or was cancelled,
 * `ready` when it succeeded without saying `finish`. Null when no intake has
 * this job in this organization.
 */
export async function settleIntakeOutcome(
  organizationId: string,
  jobId: string,
  status: 'success' | 'failure' | 'interrupted'
): Promise<ProjectIntakeRow | null> {
  const row = await findProjectIntakeByJobId(organizationId, jobId)
  if (!row) return null
  if (row.status !== 'reading') return row
  const ended = await endIntakeReading(organizationId, row.projectId, jobId, {
    status: status === 'success' ? 'ready' : 'failed',
    now: new Date(),
  })
  // A trigger that arrived during the reading is not lost with it: queued as
  // the person whose reading it was, who is re-checked when it runs.
  if (ended?.rerunRequested && ended.requestedBy) {
    await enqueueIntakeRead(organizationId, ended.projectId, ended.requestedBy).catch((error: unknown) =>
      console.warn(`[project-intake] the rerun of ${ended.projectId} could not be queued:`, error)
    )
  }
  return ended ?? row
}
