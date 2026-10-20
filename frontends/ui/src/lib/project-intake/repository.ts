/**
 * Project intakes repository: the SQL over `project_intakes` (migration 0144,
 * ADR-0111). No authorization here; `./service` owns it. Every statement is
 * keyed by the organization as well as the project, and runs in its tenant
 * scope, except the insert, which runs in the caller's transaction (the create
 * flow writes the row with the project's profile, or not at all).
 *
 * The reading's lifecycle is carried by compare-and-swap updates: a reading is
 * claimed only from a status that is not `reading` (and not `completed`), and
 * every write a run makes names its `job_id` and finds no row once the intake
 * has moved on to another reading. The service turns "no row" into a 409.
 *
 * The jsonb columns are parsed on the way out (`toRow`): the CHECKs keep their
 * kinds, not their shapes, and a reading that stored something unexpected must
 * not take the review page down with it.
 */

import 'server-only'
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { projectIntakes, type NewProjectIntakeRow, type ProjectIntakeRow } from '@/lib/db/schema/project-intakes'
import { withTenant } from '@/lib/db/tenant-context'
import { geocodeResultSchema } from '@/lib/geocoding/types'
import {
  closingIntentSchema,
  dismissedValueSchema,
  documentReadSchema,
  intakeCountsSchema,
  type DismissedValue,
  type DocumentRead,
  type IntakeCounts,
} from './types'

export type { NewProjectIntakeRow, ProjectIntakeRow }

/** Most projects one lookup of open intakes asks about: a settle completes a handful of batches. */
export const MAX_OPEN_INTAKE_LOOKUP = 100

/** Most dismissed values an intake keeps; the oldest go first. Each one is a key and a value. */
export const MAX_DISMISSED_VALUES = 500

const lenientArray = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((entry) => {
        const parsed = item.safeParse(entry)
        return parsed.success ? [parsed.data as z.infer<T>] : []
      })
    )

const documentsReadColumn = lenientArray(documentReadSchema)
const dismissedColumn = lenientArray(dismissedValueSchema)
const readingFilesColumn = lenientArray(z.string().min(1).max(512))

/**
 * The row with its jsonb columns parsed. An entry that does not parse is
 * dropped, the rest kept; a whole column that does not parse is null (or
 * empty), never a thrown read.
 */
function toRow(row: ProjectIntakeRow): ProjectIntakeRow {
  return {
    ...row,
    location: geocodeResultSchema.nullable().catch(null).parse(row.location ?? null),
    closing: closingIntentSchema.nullable().catch(null).parse(row.closing ?? null),
    counts: intakeCountsSchema.nullable().catch(null).parse(row.counts ?? null),
    documentsRead: documentsReadColumn.parse(row.documentsRead),
    dismissed: dismissedColumn.parse(row.dismissed),
    readingFiles: readingFilesColumn.parse(row.readingFiles),
  }
}

const first = (rows: ProjectIntakeRow[]): ProjectIntakeRow | null => (rows[0] ? toRow(rows[0]) : null)

const ofProject = (organizationId: string, projectId: string) =>
  and(eq(projectIntakes.organizationId, organizationId), eq(projectIntakes.projectId, projectId))

/**
 * Store a project's intake, in the caller's transaction (the create flow's,
 * which writes the profile with it). The tenant context is the caller's.
 */
export async function insertProjectIntake(executor: DbExecutor, row: NewProjectIntakeRow): Promise<ProjectIntakeRow> {
  const [inserted] = await executor.insert(projectIntakes).values(row).returning()
  return toRow(inserted)
}

/** The project's intake, or null when it was set up without one. */
export async function findProjectIntake(organizationId: string, projectId: string): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb().select().from(projectIntakes).where(ofProject(organizationId, projectId)).limit(1)
  )
  return first(rows)
}

/** The intake whose current or last reading is this backend job, in this organization; null for any other job. */
export async function findProjectIntakeByJobId(organizationId: string, jobId: string): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(projectIntakes)
      .where(and(eq(projectIntakes.organizationId, organizationId), eq(projectIntakes.jobId, jobId)))
      .limit(1)
  )
  return first(rows)
}

/**
 * Of these projects, the ones with an intake a reading may still serve: not
 * `completed`. Bounded: at most {@link MAX_OPEN_INTAKE_LOOKUP} projects are
 * asked about, the rest are ignored.
 */
export async function listOpenIntakeProjectIds(organizationId: string, projectIds: readonly string[]): Promise<string[]> {
  const asked = [...new Set(projectIds)].slice(0, MAX_OPEN_INTAKE_LOOKUP)
  if (asked.length === 0) return []
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({ projectId: projectIntakes.projectId })
      .from(projectIntakes)
      .where(
        and(
          eq(projectIntakes.organizationId, organizationId),
          inArray(projectIntakes.projectId, asked),
          ne(projectIntakes.status, 'completed')
        )
      )
      .limit(asked.length)
  )
  return rows.map((row) => row.projectId)
}

export interface IntakeReadingClaim {
  /** The backend job id the reading will run as, minted before the submission. */
  jobId: string
  /** The person whose upload or click starts it; the run acts as them (ADR-0108). */
  requestedBy: string
  /** Forget what was read, so every document is read again (`scope: 'all'`). */
  forgetRead: boolean
  now: Date
}

/**
 * Claim a reading: `reading`, with its job, its requester and its start, from
 * any status but `reading` and `completed`. Null when a reading already runs
 * (the caller records a rerun instead) or the review was finished.
 */
export async function claimIntakeReading(
  organizationId: string,
  projectId: string,
  claim: IntakeReadingClaim
): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({
        status: 'reading',
        jobId: claim.jobId,
        requestedBy: claim.requestedBy,
        traceId: null,
        rerunRequested: false,
        startedAt: claim.now,
        finishedAt: null,
        updatedAt: claim.now,
        readingFiles: [],
        ...(claim.forgetRead ? { documentsRead: [] } : {}),
      })
      .where(and(ofProject(organizationId, projectId), notInArray(projectIntakes.status, ['reading', 'completed'])))
      .returning()
  )
  return first(rows)
}

/** Remember that a trigger arrived during a reading. Null when no reading runs any more. */
export async function requestIntakeRerun(organizationId: string, projectId: string): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({ rerunRequested: true, updatedAt: new Date() })
      .where(and(ofProject(organizationId, projectId), eq(projectIntakes.status, 'reading')))
      .returning()
  )
  return first(rows)
}

/**
 * The files the reading `jobId` has opened so far (step 3's live progress),
 * replacing what it reported before: the run sends its whole list each time.
 * The same compare-and-swap as {@link endIntakeReading}: null when the intake
 * has moved on, so a stale run cannot write another reading's progress.
 */
export async function setIntakeReadingFiles(
  organizationId: string,
  projectId: string,
  jobId: string,
  fileNames: readonly string[]
): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({ readingFiles: [...fileNames], updatedAt: new Date() })
      .where(
        and(ofProject(organizationId, projectId), eq(projectIntakes.jobId, jobId), eq(projectIntakes.status, 'reading'))
      )
      .returning()
  )
  return first(rows)
}

export interface IntakeReadingEnd {
  status: 'ready' | 'failed'
  now: Date
  /** The whole list after this reading; absent leaves it as it is (a failed reading read nothing for sure). */
  documentsRead?: DocumentRead[]
  counts?: IntakeCounts
  summary?: string | null
  traceId?: string | null
}

/**
 * End the reading `jobId`: `ready` with what it read, or `failed`. A
 * compare-and-swap on the job and on `reading`: null when the intake has moved
 * on (another reading claimed it, a person finished the review, or this one
 * already ended).
 */
export async function endIntakeReading(
  organizationId: string,
  projectId: string,
  jobId: string,
  end: IntakeReadingEnd
): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({
        status: end.status,
        finishedAt: end.now,
        updatedAt: end.now,
        ...(end.documentsRead ? { documentsRead: end.documentsRead } : {}),
        ...(end.counts ? { counts: end.counts } : {}),
        ...(end.summary !== undefined ? { summary: end.summary } : {}),
        ...(end.traceId !== undefined ? { traceId: end.traceId } : {}),
      })
      .where(
        and(ofProject(organizationId, projectId), eq(projectIntakes.jobId, jobId), eq(projectIntakes.status, 'reading'))
      )
      .returning()
  )
  return first(rows)
}

/**
 * Remember values a person dismissed, appended in SQL so two people
 * dismissing at once both land. Keeps the newest {@link MAX_DISMISSED_VALUES}.
 */
export async function addIntakeDismissed(
  organizationId: string,
  projectId: string,
  values: readonly DismissedValue[]
): Promise<ProjectIntakeRow | null> {
  if (values.length === 0) return findProjectIntake(organizationId, projectId)
  const appended = sql`${projectIntakes.dismissed} || ${JSON.stringify(values)}::jsonb`
  const kept = sql`(
    SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
    FROM jsonb_array_elements(${appended}) WITH ORDINALITY AS item(entry, position)
    WHERE position > jsonb_array_length(${appended}) - ${MAX_DISMISSED_VALUES}
  )`
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({ dismissed: kept, updatedAt: new Date() })
      .where(ofProject(organizationId, projectId))
      .returning()
  )
  return first(rows)
}

/**
 * Finish the review: `completed`, by whom and when, from any status but
 * `completed`. A reading still running is left to find its job no longer
 * current. Null when it was finished already.
 */
export async function completeProjectIntake(
  organizationId: string,
  projectId: string,
  completedBy: string,
  now: Date
): Promise<ProjectIntakeRow | null> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(projectIntakes)
      .set({ status: 'completed', completedAt: now, completedBy, rerunRequested: false, updatedAt: now })
      .where(and(ofProject(organizationId, projectId), ne(projectIntakes.status, 'completed')))
      .returning()
  )
  return first(rows)
}
