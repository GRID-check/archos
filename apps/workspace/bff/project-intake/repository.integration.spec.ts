/**
 * @vitest-environment node
 *
 * Project intakes (migration 0144) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run bff/project-intake/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - an intake is born `waiting` with empty lists, in its creator's transaction;
 *   - a reading is single-flight: a second claim while one runs finds nothing,
 *     a rerun is recorded instead, and a finished review cannot be claimed;
 *   - ending a reading is compare-and-swap on its job: a stale job finds
 *     nothing, the current one ends it with what it read;
 *   - dismissed values append, from two writers alike;
 *   - the outcome lookup finds the intake by its job, in its organization only;
 *   - the open-intake lookup leaves out a finished review;
 *   - the database refuses a reading without a job and a completion without
 *     who finished it, and another organization neither reads an intake nor
 *     plants one on this organization's project.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_intake_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_intake_${STAMP}`
const DOC = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'

describe('the project-intakes suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('project intakes against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  const ids = { project: '', second: '', otherProject: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)

  async function project(organizationId: string, name: string): Promise<string> {
    const rows = await inOrg(organizationId, () =>
      db.execute<{ id: string }>(sql`
        insert into projects (organization_id, name, created_by, collection_name)
        values (${organizationId}, ${name}, ${USER}, ${`proj_intake_${name}_${STAMP}`}) returning id`)
    )
    return String(Array.from(rows)[0]?.id)
  }

  const insert = (organizationId: string, projectId: string) =>
    inOrg(organizationId, () =>
      db.transaction((tx) =>
        repo.insertProjectIntake(tx, { organizationId, projectId, createdBy: USER, mode: 'active', status: 'waiting' })
      )
    )

  const claim = (jobId: string, projectId = ids.project) =>
    repo.claimIntakeReading(ORG, projectId, { jobId, requestedBy: USER, forgetRead: false, now: new Date() })

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.project = await project(ORG, 'Wohnbau')
    ids.second = await project(ORG, 'Zubau')
    ids.otherProject = await project(OTHER_ORG, 'Fremd')
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('is born waiting, with empty lists, and reads back by its project', async () => {
    const row = await insert(ORG, ids.project)
    expect(row).toMatchObject({ status: 'waiting', jobId: null, documentsRead: [], dismissed: [], rerunRequested: false })
    expect((await repo.findProjectIntake(ORG, ids.project))?.id).toBe(row.id)
    await insert(ORG, ids.second)
  })

  it('reads a single flight: a second claim finds nothing while one runs, and a rerun is recorded instead', async () => {
    const first = await claim(`job-a-${STAMP}`)
    expect(first).toMatchObject({ status: 'reading', jobId: `job-a-${STAMP}`, requestedBy: USER })
    expect(first?.startedAt).toBeInstanceOf(Date)

    expect(await claim(`job-b-${STAMP}`)).toBeNull()
    expect((await repo.requestIntakeRerun(ORG, ids.project))?.rerunRequested).toBe(true)
    expect((await repo.findProjectIntakeByJobId(ORG, `job-a-${STAMP}`))?.projectId).toBe(ids.project)
    expect(await repo.findProjectIntakeByJobId(OTHER_ORG, `job-a-${STAMP}`)).toBeNull()
  })

  it('keeps the running reading’s opened files for its own job only', async () => {
    expect(await repo.setIntakeReadingFiles(ORG, ids.project, `job-stale-${STAMP}`, ['a.pdf'])).toBeNull()
    expect(await repo.setIntakeReadingFiles(OTHER_ORG, ids.project, `job-a-${STAMP}`, ['a.pdf'])).toBeNull()
    const stored = await repo.setIntakeReadingFiles(ORG, ids.project, `job-a-${STAMP}`, ['Einreichplan.pdf', 'Schnitt.pdf'])
    expect(stored?.readingFiles).toEqual(['Einreichplan.pdf', 'Schnitt.pdf'])
  })

  it('ends a reading only for its own job, with what it read', async () => {
    const now = new Date()
    expect(await repo.endIntakeReading(ORG, ids.project, `job-stale-${STAMP}`, { status: 'ready', now })).toBeNull()

    const ended = await repo.endIntakeReading(ORG, ids.project, `job-a-${STAMP}`, {
      status: 'ready',
      now,
      documentsRead: [{ documentId: DOC, contentHash: 'sha256:abc' }],
      counts: { documentsRead: 1, suggested: 4, contradictions: 1, decisiveOpen: 2 },
      summary: 'Zwei Pläne gelesen.',
      traceId: 'trace-1',
    })
    expect(ended).toMatchObject({
      status: 'ready',
      documentsRead: [{ documentId: DOC, contentHash: 'sha256:abc' }],
      counts: { decisiveOpen: 2 },
      summary: 'Zwei Pläne gelesen.',
      traceId: 'trace-1',
    })
    expect(await repo.endIntakeReading(ORG, ids.project, `job-a-${STAMP}`, { status: 'failed', now })).toBeNull()

    const forgetting = await repo.claimIntakeReading(ORG, ids.project, {
      jobId: `job-c-${STAMP}`,
      requestedBy: USER,
      forgetRead: true,
      now,
    })
    // A new reading starts with nothing opened: the last one's files are not its own.
    expect(forgetting).toMatchObject({ status: 'reading', documentsRead: [], readingFiles: [], rerunRequested: false })
    await repo.endIntakeReading(ORG, ids.project, `job-c-${STAMP}`, { status: 'failed', now })
  })

  it('appends dismissed values, from two writers alike', async () => {
    await Promise.all([
      repo.addIntakeDismissed(ORG, ids.project, [{ key: 'building_type@bldg1', value: 'small' }]),
      repo.addIntakeDismissed(ORG, ids.project, [{ key: 'storeys_above_ground@bldg1', value: 4 }]),
    ])
    const row = await repo.findProjectIntake(ORG, ids.project)
    expect(row?.dismissed).toEqual(
      expect.arrayContaining([
        { key: 'building_type@bldg1', value: 'small' },
        { key: 'storeys_above_ground@bldg1', value: 4 },
      ])
    )
  })

  it('finishes the review once, and a finished one is neither open nor claimable', async () => {
    expect(await repo.listOpenIntakeProjectIds(ORG, [ids.project, ids.second, ids.otherProject])).toEqual(
      expect.arrayContaining([ids.project, ids.second])
    )
    const done = await repo.completeProjectIntake(ORG, ids.second, USER, new Date())
    expect(done).toMatchObject({ status: 'completed', completedBy: USER })
    expect(done?.completedAt).toBeInstanceOf(Date)
    expect(await repo.completeProjectIntake(ORG, ids.second, USER, new Date())).toBeNull()
    expect(await claim(`job-d-${STAMP}`, ids.second)).toBeNull()
    expect(await repo.listOpenIntakeProjectIds(ORG, [ids.project, ids.second])).toEqual([ids.project])
  })

  /** What Postgres said: drizzle wraps the driver's error, whose message names the constraint. */
  async function refusal(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause
      return cause instanceof Error ? cause.message : String(error)
    }
    throw new Error('the statement was not refused')
  }

  it('refuses a reading without a job and a completion without who finished it', async () => {
    expect(
      await refusal(() =>
        inOrg(ORG, () =>
          db.execute(sql`update project_intakes set status = 'reading', job_id = null where project_id = ${ids.project}::uuid`)
        )
      )
    ).toMatch(/project_intakes_job_when_reading/)
    expect(
      await refusal(() =>
        inOrg(ORG, () =>
          db.execute(sql`update project_intakes set status = 'completed', completed_at = now() where project_id = ${ids.project}::uuid`)
        )
      )
    ).toMatch(/project_intakes_completion_complete/)
  })

  it('shows another organization nothing, and lets it plant nothing on this organization’s project', async () => {
    expect(await repo.findProjectIntake(OTHER_ORG, ids.project)).toBeNull()
    expect(await repo.listOpenIntakeProjectIds(OTHER_ORG, [ids.project])).toEqual([])
    await expect(insert(OTHER_ORG, ids.project)).rejects.toThrow()
  })
})
