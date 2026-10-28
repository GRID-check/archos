/**
 * The sweep that reads a document again when its read failed for a passing reason.
 *
 * The backend says why a read failed (`agent/knowledge/ingest_failures.py`), and
 * `transient` means the bytes were never the problem: the job was interrupted, a
 * download or a provider call timed out. Until now such a document stayed failed
 * until a person noticed it and pressed "Erneut lesen", and an office uploading a
 * folder during a provider hiccup found a dozen red rows the next morning. This
 * sweep sends each back at `bulk` priority, so it yields to people's uploads, at
 * most {@link TRANSIENT_MAX_ATTEMPTS} attempts in all, the second one
 * {@link TRANSIENT_FIRST_BACKOFF_MINUTES} minutes after the first failure and each
 * further one after twice the wait. `ingest_attempts`, which every dispatch already
 * counts (migration 0134), is the cap; a `deterministic` or `quarantined` failure is
 * never touched (`./retry-policy`). Only a failure of the last
 * {@link TRANSIENT_MAX_AGE_HOURS} hours is retried: the sweep is for a hiccup during
 * an upload, never a backlog. Without the window, the first deploy would have re-read
 * every transient failure ever recorded, at a vision call per drawing page.
 *
 * The caller is the job scheduler, through `POST /api/internal/maintenance/
 * reconcile-background-work`, beside the stuck-processing sweep. Safe from several
 * replicas at once: a document it sends back is no longer failed, and a second
 * dispatch for one object returns the job the first one queued.
 */

import 'server-only'
import { withTenant } from '@/lib/db/tenant-context'
import { listTransientFailures } from './repository'
import { retryTransientFailure } from './ingest-recovery'

/** Attempts in all, the first upload's included: two automatic retries. */
export const TRANSIENT_MAX_ATTEMPTS = 3
/** The wait after the first failure; it doubles for each further attempt. */
export const TRANSIENT_FIRST_BACKOFF_MINUTES = 5
/** A failure older than this is left for a person ("Erneut lesen") or the `reingest_failed` job. */
export const TRANSIENT_MAX_AGE_HOURS = 24
/** Documents one sweep sends back. Bounded: it is housekeeping on a 30 s timer. */
export const TRANSIENT_BATCH = 25

export interface TransientRetrySweepResult {
  checked: number
  requeued: number
  /** Dispatches the backend refused; the row says so and the next sweep may try again within the cap. */
  failed: number
  /** Rows that were gone or had moved on by the time the sweep got to them. */
  gone: number
  errors: number
}

export async function retryTransientFailures(now: Date = new Date()): Promise<TransientRetrySweepResult> {
  const rows = await listTransientFailures(now, {
    maxAttempts: TRANSIENT_MAX_ATTEMPTS,
    firstBackoffMinutes: TRANSIENT_FIRST_BACKOFF_MINUTES,
    maxAgeHours: TRANSIENT_MAX_AGE_HOURS,
    limit: TRANSIENT_BATCH,
  })
  const result: TransientRetrySweepResult = { checked: rows.length, requeued: 0, failed: 0, gone: 0, errors: 0 }
  for (const row of rows) {
    try {
      const outcome = await withTenant({ organizationId: row.organizationId }, () =>
        retryTransientFailure(row.organizationId, row.id)
      )
      result[outcome] += 1
    } catch (error) {
      console.error('[documents] could not retry the transient failure of', row.id, error)
      result.errors += 1
    }
  }
  return result
}
