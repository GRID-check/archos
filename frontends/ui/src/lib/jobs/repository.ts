/**
 * The legacy `jobs` table's one remaining read (ADR-0017). Tasks and their runs
 * live in `task_definitions` and `task_runs` since migration 0086, read and
 * written through `@/lib/tasks/repository`; what is left here is the lookup the
 * skill-resource authorization decision still makes (`lib/authz/decide.ts`).
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { jobs, type Job } from '@/lib/db/schema'

/** Load a job scoped to an organization (double-filtered by org). */
export async function findJob(jobId: string, organizationId: string): Promise<Job | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}
