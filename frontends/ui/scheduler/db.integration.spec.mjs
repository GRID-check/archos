/**
 * @vitest-environment node
 *
 * The scheduler's claim (`claimDue`) against a real Postgres as `grid_app_rw`:
 * what `db.spec.mjs` asserts about the SQL text, proved with the SQL. The claim
 * is "each due occurrence fires once, on whichever replica", which only row
 * locks and a committed advance can make true.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run scheduler/db.integration.spec.mjs
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withPlatformScope } from '../workers/platform-scope.js'
import { claimDue } from './db.js'

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_scheduler_${Date.now()}`
const NEXT = new Date('2099-01-01T09:00:00Z')

describe('the suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

/**
 * A `sql` whose transactions run `onStatement(text)` after each statement, so a
 * test can hold a claim open between its due-scan and its commit, or fail it there.
 */
function instrumented(sql, onStatement) {
  return {
    begin: (fn) =>
      sql.begin((tx) => {
        const wrapped = async (strings, ...values) => {
          const rows = await tx(strings, ...values)
          await onStatement(strings.join('$').trim())
          return rows
        }
        wrapped.unsafe = (text) => tx.unsafe(text)
        return fn(wrapped)
      }),
  }
}

describe.skipIf(!url)('the scheduler claim against live Postgres', () => {
  let sql
  let projectId = ''
  const ids = { schedule: '', once: '' }

  const rowsOf = async () =>
    withPlatformScope(
      sql,
      (tx) => tx`
        SELECT id, enabled, next_run_at FROM task_definitions WHERE organization_id = ${ORG} ORDER BY id
      `
    )
  const byId = async (id) => (await rowsOf()).find((row) => row.id === id)
  const mine = (claimed) =>
    claimed.map((row) => row.id).filter((id) => Object.values(ids).includes(id))

  beforeAll(async () => {
    sql = postgres(url, { prepare: false, max: 4 })
    await withPlatformScope(sql, async (tx) => {
      const [project] = await tx`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Scheduler', 'user_1', ${`proj_${ORG}`})
        RETURNING id
      `
      projectId = project.id
    })
  })

  beforeEach(async () => {
    await withPlatformScope(sql, async (tx) => {
      await tx`DELETE FROM task_definitions WHERE organization_id = ${ORG}`
      // The recurring one is due first, so its advance is written before the one-shot's.
      const [schedule] = await tx`
        INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger, schedule_cron, next_run_at)
        VALUES (${ORG}, ${projectId}, 'chat', 'Wöchentlich', '{}'::jsonb, 'user_1', 'schedule', '0 9 * * 1', now() - interval '2 minutes')
        RETURNING id
      `
      const [once] = await tx`
        INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger, due_at, next_run_at)
        VALUES (${ORG}, ${projectId}, 'chat', 'Einmal', '{}'::jsonb, 'user_1', 'once', now() - interval '1 minute', now() - interval '1 minute')
        RETURNING id
      `
      ids.schedule = schedule.id
      ids.once = once.id
    })
  })

  afterAll(async () => {
    if (!sql) return
    await withPlatformScope(sql, async (tx) => {
      await tx`DELETE FROM task_definitions WHERE organization_id = ${ORG}`
      await tx`DELETE FROM projects WHERE organization_id = ${ORG}`
    })
    await sql.end()
  })

  it('gives each due definition to one of two racing claimers, and the next scan finds nothing', async () => {
    // Claimer A holds its rows locked between its due-scan and its commit while B scans.
    let scanned
    let resume
    const aScanned = new Promise((resolve) => (scanned = resolve))
    const aMayCommit = new Promise((resolve) => (resume = resolve))
    const holdAfterScan = instrumented(sql, async (text) => {
      if (!text.startsWith('SELECT')) return
      scanned()
      await aMayCommit
    })

    const a = claimDue(holdAfterScan, 50, () => NEXT)
    await aScanned
    const b = await claimDue(sql, 50, () => NEXT)
    resume()
    const claimedByA = mine(await a)

    expect(mine(b)).toEqual([])
    expect(claimedByA.sort()).toEqual([ids.schedule, ids.once].sort())
    expect(mine(await claimDue(sql, 50, () => NEXT))).toEqual([])
  })

  it('advances a recurring definition and retires a one-shot, leaving both enabled', async () => {
    await claimDue(sql, 50, () => NEXT)

    expect(await byId(ids.schedule)).toMatchObject({ enabled: true, next_run_at: NEXT })
    expect(await byId(ids.once)).toMatchObject({ enabled: true, next_run_at: null })
  })

  it('commits the claim and every advance together: a failure after the first advance leaves both due', async () => {
    const before = await rowsOf()
    const failOnRetire = instrumented(sql, async (text) => {
      if (text.startsWith('UPDATE task_definitions SET next_run_at = NULL'))
        throw new Error('replica died')
    })

    await expect(claimDue(failOnRetire, 50, () => NEXT)).rejects.toThrow('replica died')

    expect(await rowsOf()).toEqual(before)
    expect(mine(await claimDue(sql, 50, () => NEXT)).sort()).toEqual(
      [ids.schedule, ids.once].sort()
    )
  })
})
