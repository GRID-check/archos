/**
 * @vitest-environment node
 *
 * The in-process door over the REAL queue and the REAL services (ADR-0079,
 * amendment 1): `createRunner` claims from `bff_job_queue`, and each slice runs
 * through `dist-jobs/slice.mjs`, built here and imported by Node itself, with
 * no Next server anywhere. What `runner.integration.spec.mjs` proves for the
 * loop with a stub, this proves for the bundle: the handlers' queries run under
 * the lane's tenant as `grid_app_rw`, and a handler that reads the request
 * (the locale, for a report's PDF) still finishes with no request to read.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run workers/jobs/slice-bundle.integration.spec.mjs
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as queue from '../job-queue.js'
import { createFailureStreak } from '../failure-streak.js'
import { withPlatformScope } from '../platform-scope.js'
import { createInProcessSliceRunner, createRunner } from './runner.js'

const url = process.env.GRID_TEST_DATABASE_URL
const LANE = `org_bundle_${Date.now()}`
const UI_ROOT = path.resolve(import.meta.dirname, '..', '..')

const CONFIG = {
  workerPrefix: 'bundle-test',
  concurrency: 1,
  pollMs: 5,
  heartbeatMs: 60_000,
  staleSeconds: 180,
  maxAttempts: 3,
  perLaneCap: 0,
  yieldAfterMs: 0,
  reapEveryMs: 60_000,
  transientBackoffMs: 0,
  retryBackoffSeconds: 0,
  deadRetentionSeconds: 14 * 86_400,
  purgeEveryMs: 600_000,
}

const REQUESTER = {
  userId: 'user_bundle',
  email: 'bundle@example.com',
  organizationMembershipId: 'om_bundle',
  role: 'admin',
  permissions: [],
}

describe.skipIf(!url)('bff-jobs slices through the bundle, against live Postgres', () => {
  let sql
  let dir
  let bundle
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

  const runnerOver = () =>
    createRunner(CONFIG, {
      sql,
      queue,
      runSlice: createInProcessSliceRunner({ bundle, timeoutMs: 60_000 }),
      streak: createFailureStreak({ label: '[test]', escalateAfter: 5, log }),
      log,
      sleep: () => Promise.resolve(),
    })

  const rowOf = async (jobId) =>
    (await withPlatformScope(sql, (tx) => tx`SELECT * FROM bff_job_queue WHERE job_id = ${jobId}::uuid`))[0]

  beforeAll(async () => {
    sql = postgres(url, { prepare: false, max: 4 })
    // Built inside the UI's node_modules, so its package imports resolve as from
    // `dist-jobs/` in the image, and so Vitest leaves it to Node to load.
    mkdirSync(path.join(UI_ROOT, 'node_modules', '.cache'), { recursive: true })
    dir = mkdtempSync(path.join(UI_ROOT, 'node_modules', '.cache', 'jobs-bundle-it-'))
    const build = spawnSync('bun', ['scripts/build-jobs-bundle.ts', '--outdir', dir], { cwd: UI_ROOT, encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`the jobs bundle did not build: ${build.stderr}`)
    process.env.GRID_APP_DATABASE_URL = url
    bundle = await import(pathToFileURL(path.join(dir, 'slice.mjs')).href)
  }, 120_000)

  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (!sql) return
    await withPlatformScope(sql, async (tx) => {
      await tx`DELETE FROM bff_job_queue WHERE lane = ${LANE}`
      await tx`DELETE FROM bff_job_lane_turns WHERE lane = ${LANE}`
    })
    await sql.end()
  })

  it('runs a system walk to its end in the lane’s organization, and the row is gone', async () => {
    const jobId = await queue.enqueue(sql, {
      kind: 'annotation_due_reminders',
      lane: LANE,
      priority: 1,
      payload: {
        day: '2026-10-27',
        cursor: null,
        counts: { checked: 0, dueSoon: 0, overdue: 0, already: 0, unreachable: 0, failed: 0 },
      },
    })

    expect(await runnerOver().step('bundle-test-0')).toBe(true)

    expect(log.error).not.toHaveBeenCalled()
    expect(await rowOf(jobId)).toBeUndefined()
  })

  it('files nothing for a project that is not there, and finishes rather than throwing for want of a request', async () => {
    // `renderAndFileReport` reads the locale (`getTranslations`, `getLocale`)
    // before it opens the project. Outside a request Next's `cookies()` throws,
    // so without the slice mark this attempt failed on "`cookies` was called
    // outside a request scope" instead of reaching the project and refusing.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jobId = await queue.enqueue(sql, {
      kind: 'file_research_report',
      lane: LANE,
      priority: 1,
      payload: { runId: `run-${randomUUID()}`, projectId: randomUUID(), report: '# Report\n\nBody', taskRunId: null, requester: REQUESTER },
    })

    expect(await runnerOver().step('bundle-test-0')).toBe(true)

    const said = [...log.error.mock.calls, ...errors.mock.calls].flat().map(String).join('\n')
    errors.mockRestore()
    expect(said).not.toMatch(/outside a request scope/)
    expect(await rowOf(jobId)).toBeUndefined()
  })

  it('answers a job this worker does not hold as lost, and leaves it to its holder', async () => {
    const jobId = await queue.enqueue(sql, { kind: 'annotation_due_reminders', lane: LANE, priority: 1, payload: {} })

    expect(await bundle.runSlice(jobId, 'not-the-holder')).toEqual({ kind: 'lost' })
    expect(await rowOf(jobId)).toMatchObject({ status: 'queued', attempts: 0 })
  })
})
