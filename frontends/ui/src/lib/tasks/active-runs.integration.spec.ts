/**
 * @vitest-environment node
 *
 * The count of a project's runs in flight (`countActiveRunsInProject`), which
 * the turn's WORKSPACE block tells Piloti, against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/tasks/active-runs.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * It used to filter the newest `RUN_LIST_LIMIT` runs, so a project with more
 * recent finished runs than that hid an older run still running. Proven here:
 * a run older than a full page of newer ones is counted, finished runs are not,
 * and another project's and another organization's runs are not.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_runs_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_runs_${STAMP}`
const url = process.env.GRID_TEST_DATABASE_URL

describe.skipIf(!url)('countActiveRunsInProject against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./repository')
  const ids = { project: '', other: '', foreign: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: USER }, run)

  const project = async (organizationId: string, name: string) =>
    String(
      Array.from(
        await inOrg(organizationId, () =>
          db.execute<{ id: string }>(sql`
            insert into projects (organization_id, name, created_by, collection_name)
            values (${organizationId}, ${name}, ${USER}, ${`proj_runs_${name}_${STAMP}`}) returning id`)
        )
      )[0]?.id
    )

  /** `count` runs of one status, created `minutesAgo` before now. */
  const runs = (organizationId: string, projectId: string, status: string, count: number, minutesAgo: number) =>
    inOrg(organizationId, () =>
      db.execute(sql`
        insert into task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status,
                               skill_snapshot, created_at)
        select ${organizationId}, ${projectId}::uuid, 'document', 'Aktenvermerk',
               '{"prompt":"Schreibe","skill":{},"dataSources":null}'::jsonb, ${USER}, 'delegated', ${status},
               '{}'::jsonb, now() - make_interval(mins => ${minutesAgo})
        from generate_series(1, ${count})`)
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.project = await project(ORG, 'own')
    ids.other = await project(ORG, 'other')
    ids.foreign = await project(OTHER_ORG, 'foreign')
    // One run still running behind a full page of newer finished ones.
    await runs(ORG, ids.project, 'running', 1, 600)
    await runs(ORG, ids.project, 'succeeded', repo.RUN_LIST_LIMIT, 10)
    await runs(ORG, ids.project, 'queued', 2, 1)
    await runs(ORG, ids.other, 'running', 3, 1)
    await runs(OTHER_ORG, ids.foreign, 'running', 4, 1)
  })

  afterAll(async () => {
    if (!db) return
    for (const organizationId of [ORG, OTHER_ORG]) {
      await inOrg(organizationId, () => db.execute(sql`delete from task_runs where organization_id = ${organizationId}`))
      await inOrg(organizationId, () => db.execute(sql`delete from projects where organization_id = ${organizationId}`))
    }
  })

  it('counts every queued or running run of the project, the one behind a full page of newer runs included', async () => {
    expect(await inOrg(ORG, () => repo.countActiveRunsInProject(ids.project, ORG))).toBe(3)
    // The page the old count filtered holds none of the running one.
    const page = await inOrg(ORG, () => repo.listRunsInProject(ids.project, ORG))
    expect(page.filter((run) => run.status === 'queued' || run.status === 'running')).toHaveLength(2)
  })

  it('pages a filtered run list by cursor, through rows that share one created_at, without a gap or a repeat', async () => {
    // The hundred finished runs were inserted by one statement: one created_at, so the id breaks every tie.
    const first = await inOrg(ORG, () => repo.listRunPage(ids.project, ORG, { limit: 60, cursor: null, status: 'succeeded' }))
    const second = await inOrg(ORG, () => repo.listRunPage(ids.project, ORG, { limit: 60, cursor: first.next, status: 'succeeded' }))
    const seen = [...first.rows, ...second.rows].map((run) => run.id)

    expect(first.next).not.toBeNull()
    expect(second.next).toBeNull()
    expect(new Set(seen).size).toBe(repo.RUN_LIST_LIMIT)
    expect([...first.rows, ...second.rows].every((run) => run.status === 'succeeded')).toBe(true)
    const unreviewed = await inOrg(ORG, () => repo.listRunPage(ids.project, ORG, { limit: 200, cursor: null, review: 'none' }))
    expect(unreviewed.rows).toHaveLength(repo.RUN_LIST_LIMIT + 3)
  })

  it('lists the tasks of a project without the delegations, and keeps a dated one-shot', async () => {
    const define = (title: string, trigger: string, dueAt: string | null) =>
      inOrg(ORG, () =>
        db.execute(sql`
          insert into task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger, due_at)
          values (${ORG}, ${ids.other}::uuid, 'deep-research', ${title},
                  '{"prompt":"Prüfe","skill":{},"dataSources":null}'::jsonb, ${USER}, ${trigger}, ${dueAt}::timestamptz)`)
      )
    await define('Delegiert', 'once', null)
    await define('Freitag', 'once', '2030-01-04T08:00:00Z')
    await define('Montags', 'manual', null)

    const page = await inOrg(ORG, () => repo.listDefinitionPage(ids.other, ORG, { limit: 1, cursor: null }))
    const rest = await inOrg(ORG, () => repo.listDefinitionPage(ids.other, ORG, { limit: 5, cursor: page.next }))

    expect([...page.rows, ...rest.rows].map((row) => row.title).sort()).toEqual(['Freitag', 'Montags'])
    expect(rest.next).toBeNull()
    await inOrg(ORG, () => db.execute(sql`delete from task_definitions where organization_id = ${ORG}`))
  })

  it('counts no other project’s runs, and no other organization’s', async () => {
    expect(await inOrg(ORG, () => repo.countActiveRunsInProject(ids.other, ORG))).toBe(3)
    expect(await inOrg(ORG, () => repo.countActiveRunsInProject(ids.foreign, ORG))).toBe(0)
  })
})
