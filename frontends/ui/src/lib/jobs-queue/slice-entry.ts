/**
 * The `bff-jobs` runner's in-process door to a job slice (ADR-0079, amendment 1).
 *
 * `scripts/build-jobs-bundle.ts` bundles this module, and everything it reaches,
 * into `dist-jobs/slice.mjs`, which `workers/jobs/runner.js` imports when
 * `GRID_BFF_JOBS_MODE=inprocess`. The runner then runs a slice in its own
 * process instead of POSTing to a `node server.js` it spawned. It is the same
 * {@link runJobSlice} the internal route calls, inside the same tenant slot the
 * route opens, so a handler cannot tell the two paths apart.
 *
 * What a request would have answered as an HTTP status is answered here as the
 * runner's `SliceOutcome` (`workers/jobs/runner.js`), so the claim loop keeps one
 * reading of a slice whichever door it came through.
 *
 * Not imported by the Next app: a caller is `scripts/build-jobs-bundle.ts`.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { bootLine } from '@/lib/boot'
import { databaseUnavailableCode } from '@/lib/db/errors'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { bootstrapPlatformModelDefaults } from '@/lib/model-config/bootstrap-defaults'
import { shutdownPosthogServer } from '@/lib/analytics/posthog-server'
import { runJobSlice } from './run'

/** The runner's `SliceOutcome`, with `notBefore` as an ISO string across the module boundary. */
export type InProcessSliceOutcome =
  | { kind: 'done' }
  | { kind: 'more'; payload: object }
  | { kind: 'defer'; payload: object; notBefore: string }
  | { kind: 'lost' }
  | { kind: 'transient'; failure: { kind: string; detail?: string } }
  | { kind: 'error'; message: string }

/** Statuses the HTTP door reads as "briefly wrong, not the job's fault" (`workers/failure-streak.js`). */
const TRANSIENT_STATUSES = new Set([502, 503, 504])

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * What `instrumentation.ts` `register()` does for a Next server, minus what a
 * job host has no use for (request-error capture; the supervisor already
 * bridges console to OTLP logs). Never rejects: a failed bootstrap leaves the
 * workflow config in charge, as it does for the server.
 */
export async function initSliceHost(): Promise<void> {
  // oxlint-disable-next-line no-console -- the boot line is info on stdout, as in instrumentation.ts
  console.log(bootLine())
  try {
    await bootstrapPlatformModelDefaults()
  } catch (error) {
    console.error('[Model Config] Could not run the platform default bootstrap:', error)
  }
}

/** Flush what the slices queued for PostHog, as `server.js` does with `__gridShutdownHooks`. */
export async function shutdownSliceHost(): Promise<void> {
  await shutdownPosthogServer()
}

/** Map a thrown slice to the outcome the HTTP door would have produced from its status. */
export function classifySliceError(error: unknown): InProcessSliceOutcome {
  if (error instanceof ApiError && error.status === 409) return { kind: 'lost' }
  const unavailable = databaseUnavailableCode(error)
  if (unavailable) return { kind: 'transient', failure: { kind: `database unavailable (${unavailable})`, detail: describe(error) } }
  if (error instanceof ApiError && TRANSIENT_STATUSES.has(error.status)) {
    return { kind: 'transient', failure: { kind: `${error.status} ${error.code}`, detail: error.message } }
  }
  if (!(error instanceof ApiError)) console.error('[bff-jobs] unhandled error in a job slice:', error)
  return { kind: 'error', message: describe(error) }
}

/** Run one slice of a claimed job and say what it came to. Never rejects. */
export async function runSlice(jobId: string, worker: string): Promise<InProcessSliceOutcome> {
  try {
    // The slot the internal route opens: a slice starts with no tenant and
    // leaves none behind for the next one on this process.
    const result = await runWithTenantSlot(() => runJobSlice(jobId, worker))
    if (result.done) return { kind: 'done' }
    if (result.notBefore) return { kind: 'defer', payload: result.payload, notBefore: result.notBefore }
    return { kind: 'more', payload: result.payload }
  } catch (error) {
    return classifySliceError(error)
  }
}
