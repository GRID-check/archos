/**
 * @vitest-environment node
 *
 * `root_sort_runs` (migration 0173, ADR-0121) against a REAL Postgres, through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/filing/root-sort-run-repository.integration.spec.ts
 *
 * What it proves, claims about SQL a mocked handle cannot disagree with: the
 * jsonb columns round-trip; the partial unique index admits one run in work per
 * shelf (and one per org on the Archiv shelf, where project_id is NULL); the
 * conditional update writes only from the status it names; the CHECKs refuse
 * what the migration says they refuse; row-level security hides one org's run
 * from another; and deleting a project takes its runs with it.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RootSortRunStatus } from './root-sort-types'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG_A = `org_root_sort_a_${STAMP}`
const ORG_B = `org_root_sort_b_${STAMP}`
const ME = `user_root_sort_${STAMP}`
const WORKING: readonly RootSortRunStatus[] = ['judging', 'grouping', 'applying', 'undoing']
const NOT_WORKING: readonly RootSortRunStatus[] = ['ready', 'applied', 'undone', 'cancelled', 'failed']
const IN_WORK_INDEX = 'root_sort_runs_one_in_work_per_shelf'

interface PgError {
  code?: string
  constraint_name?: string
}

/** The Postgres error under drizzle's wrapper: the first link that carries a SQLSTATE. */
function pgError(error: unknown): PgError {
  let current: unknown = error
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && typeof (current as PgError).code === 'string') {
      return current as PgError
    }
    current = current instanceof Error ? current.cause : undefined
  }
  throw new Error(`no SQLSTATE on the error: ${String(error)}`)
}

/** Await a write that must be refused, and return the error it was refused with. */
async function refusal(write: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await write()
  } catch (error) {
    return error
  }
  throw new Error('expected the write to be refused, but it succeeded')
}

const placement = (documentId: string, folderId: string | null, newFolderPath: string | null) => ({
  documentId,
  folderId,
  newFolderPath,
  reason: 'permit in the title',
  confidence: folderId ? 0.91 : null,
})

describe.skipIf(!url)('root_sort_runs against Postgres', () => {
  let repo: typeof import('./root-sort-run-repository')
  let isUniqueViolation: typeof import('@/lib/db/errors').isUniqueViolation
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  // One project per case, so the cases cannot see each other's in-work runs.
  const projects: Record<'roundTrip' | 'unique' | 'conditional' | 'checks' | 'rls' | 'cascade' | 'archiv' | 'stalled' | 'fresh', string> = {
    stalled: '',
    fresh: '',
    roundTrip: '',
    unique: '',
    conditional: '',
    checks: '',
    rls: '',
    cascade: '',
    archiv: '',
  }

  async function seedProject(org: string, name: string): Promise<string> {
    return withTenant({ organizationId: org, userId: ME }, async () => {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into projects (organization_id, name, created_by, collection_name)
        values (${org}, ${`${name} ${STAMP}`}, ${ME}, ${`coll_${name}_${STAMP}`})
        returning id`)
      return row.id
    })
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./root-sort-run-repository')
    isUniqueViolation = (await import('@/lib/db/errors')).isUniqueViolation

    for (const org of [ORG_A, ORG_B]) {
      await withPlatformAccess('root sort spec: create organization', () =>
        db.execute(sql`insert into organizations (workos_organization_id, display_name)
                       values (${org}, ${org}) on conflict do nothing`)
      )
    }
    for (const key of Object.keys(projects) as (keyof typeof projects)[]) {
      projects[key] = await seedProject(ORG_A, `root sort ${key}`)
    }
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('root sort spec cleanup', async () => {
      await db.execute(sql`delete from root_sort_runs where organization_id in (${ORG_A}, ${ORG_B})`)
      await db.execute(sql`delete from projects where organization_id in (${ORG_A}, ${ORG_B})`)
      await db.execute(sql`delete from organizations where workos_organization_id in (${ORG_A}, ${ORG_B})`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('round-trips the jsonb columns intact through insert, patch and find', async () => {
    const [d1, d2, d3] = [randomUUID(), randomUUID(), randomUUID()]
    const run = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: projects.roundTrip,
      requestedBy: ME,
      status: 'judging',
      documentIds: [d1, d2, d3],
      unreadable: 2,
      truncated: false,
    })
    expect(run.placements).toEqual([])
    expect(run.keptMoves).toEqual([])

    const placements = [placement(d1, randomUUID(), null), placement(d2, null, 'Permits/2026')]
    const keptMoves = [
      { documentId: d1, folderId: placements[0].folderId, newFolderPath: null },
      { documentId: d2, folderId: null, newFolderPath: 'Permits/2026' },
    ]
    const newFolders = [{ path: 'Permits/2026', description: null, documentIds: [d2], confidences: { [d2]: 0.7 } }]
    const moveFailures = [{ documentId: d3, error: 'locked' }]

    const patched = await repo.updateRootSortRun(ORG_A, run.id, ['judging'], {
      status: 'ready',
      cursor: 3,
      placements,
      newFolders,
      keptMoves,
      failedDocumentIds: [d3],
      movedDocumentIds: [d1],
      moveFailures,
      groupingError: 'backend_502',
    })
    expect(patched?.status).toBe('ready')

    const found = await repo.findRootSortRun(ORG_A, run.id)
    expect(found).not.toBeNull()
    expect(found).toMatchObject({
      id: run.id,
      organizationId: ORG_A,
      scope: 'project',
      projectId: projects.roundTrip,
      requestedBy: ME,
      status: 'ready',
      unreadable: 2,
      truncated: false,
      cursor: 3,
      groupingError: 'backend_502',
      error: null,
      finishedAt: null,
    })
    expect(found?.documentIds).toEqual([d1, d2, d3])
    expect(found?.placements).toEqual(placements)
    expect(found?.newFolders).toEqual(newFolders)
    expect(found?.keptMoves).toEqual(keptMoves)
    expect(found?.failedDocumentIds).toEqual([d3])
    expect(found?.movedDocumentIds).toEqual([d1])
    expect(found?.moveFailures).toEqual(moveFailures)
  })

  it('refuses a second run in work on the same project shelf, for every working status', async () => {
    for (const working of WORKING) {
      const first = await repo.insertRootSortRun({
        organizationId: ORG_A,
        scope: 'project',
        projectId: projects.unique,
        requestedBy: ME,
        status: working,
        documentIds: [],
      })
      const error = await refusal(() =>
        repo.insertRootSortRun({
          organizationId: ORG_A,
          scope: 'project',
          projectId: projects.unique,
          requestedBy: ME,
          status: 'judging',
          documentIds: [],
        })
      )
      expect(isUniqueViolation(error, IN_WORK_INDEX), `second run while first is ${working}`).toBe(true)
      expect(pgError(error).constraint_name).toBe(IN_WORK_INDEX)
      await repo.updateRootSortRun(ORG_A, first.id, [working], { status: 'cancelled' })
    }
  })

  it('admits a new run once the first has left work, for every non-working status', async () => {
    for (const done of NOT_WORKING) {
      const first = await repo.insertRootSortRun({
        organizationId: ORG_A,
        scope: 'project',
        projectId: projects.unique,
        requestedBy: ME,
        status: 'judging',
        documentIds: [],
      })
      await repo.updateRootSortRun(ORG_A, first.id, ['judging'], { status: done })
      const second = await repo.insertRootSortRun({
        organizationId: ORG_A,
        scope: 'project',
        projectId: projects.unique,
        requestedBy: ME,
        status: 'judging',
        documentIds: [],
      })
      expect(second.status, `second run after first is ${done}`).toBe('judging')
      await repo.updateRootSortRun(ORG_A, second.id, ['judging'], { status: 'cancelled' })
    }
  })

  it('limits the Archiv shelf (project_id NULL) to one in work per org, and no project run is blocked by it', async () => {
    const archiv = (org: string, status: RootSortRunStatus) =>
      repo.insertRootSortRun({ organizationId: org, scope: 'office_shelf', projectId: null, requestedBy: ME, status, documentIds: [] })

    const officeA = await archiv(ORG_A, 'judging')
    const refused = await refusal(() => archiv(ORG_A, 'grouping'))
    expect(isUniqueViolation(refused, IN_WORK_INDEX)).toBe(true)

    // A project shelf is a different scope; the Archiv run does not block it.
    const project = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: projects.archiv,
      requestedBy: ME,
      status: 'judging',
      documentIds: [],
    })
    expect(project.status).toBe('judging')

    // The index is per organization: another org's Archiv is not blocked.
    const officeB = await archiv(ORG_B, 'judging')
    expect(officeB.status).toBe('judging')

    // Once the first Archiv run leaves work, a new one is admitted.
    await repo.updateRootSortRun(ORG_A, officeA.id, ['judging'], { status: 'applied' })
    const officeAgain = await archiv(ORG_A, 'undoing')
    expect(officeAgain.status).toBe('undoing')
  })

  it('writes only from the statuses it names: a stale update changes nothing', async () => {
    const run = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: projects.conditional,
      requestedBy: ME,
      status: 'judging',
      documentIds: [],
    })
    const p = placement(randomUUID(), randomUUID(), null)
    await repo.updateRootSortRun(ORG_A, run.id, ['judging'], { status: 'ready', placements: [p] })
    const before = await repo.findRootSortRun(ORG_A, run.id)

    const stale = await repo.updateRootSortRun(ORG_A, run.id, ['judging', 'grouping'], {
      status: 'applying',
      placements: [],
    })
    expect(stale).toBeNull()

    const after = await repo.findRootSortRun(ORG_A, run.id)
    expect(after?.status).toBe('ready')
    expect(after?.placements).toEqual([p])
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime())

    const applied = await repo.updateRootSortRun(ORG_A, run.id, ['ready'], { status: 'applying' })
    expect(applied?.status).toBe('applying')
  })

  it('refuses a scope that does not match its project, an unknown status, and more than 12 new folders', async () => {
    const base = { organizationId: ORG_A, requestedBy: ME, documentIds: [] as string[] }

    const projectWithoutProject = await refusal(() =>
      repo.insertRootSortRun({ ...base, scope: 'project', projectId: null, status: 'ready' })
    )
    expect(pgError(projectWithoutProject)).toMatchObject({ code: '23514', constraint_name: 'root_sort_runs_scope_owner_check' })

    const archivWithProject = await refusal(() =>
      repo.insertRootSortRun({ ...base, scope: 'office_shelf', projectId: projects.checks, status: 'ready' })
    )
    expect(pgError(archivWithProject)).toMatchObject({ code: '23514', constraint_name: 'root_sort_runs_scope_owner_check' })

    const unknownStatus = await refusal(() =>
      repo.insertRootSortRun({ ...base, scope: 'office_shelf', projectId: null, status: 'bogus' as RootSortRunStatus })
    )
    expect(pgError(unknownStatus)).toMatchObject({ code: '23514', constraint_name: 'root_sort_runs_status_check' })

    const run = await repo.insertRootSortRun({ ...base, scope: 'project', projectId: projects.checks, status: 'judging' })
    const folder = (index: number) => ({ path: `Folder ${index}`, description: null, documentIds: [], confidences: {} })
    const thirteen = Array.from({ length: 13 }, (_, index) => folder(index))
    const tooMany = await refusal(() =>
      repo.updateRootSortRun(ORG_A, run.id, ['judging'], { newFolders: thirteen })
    )
    expect(pgError(tooMany)).toMatchObject({ code: '23514', constraint_name: 'root_sort_runs_lists_bounded' })
    expect((await repo.findRootSortRun(ORG_A, run.id))?.newFolders).toEqual([])

    // The boundary itself is admitted: 12 is the most one proposal answers.
    const twelve = await repo.updateRootSortRun(ORG_A, run.id, ['judging'], { newFolders: thirteen.slice(0, 12) })
    expect(twelve?.newFolders).toHaveLength(12)
  })

  it('hides a run from another organization: select, update and insert all refused by RLS', async () => {
    const run = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: projects.rls,
      requestedBy: ME,
      status: 'judging',
      documentIds: [],
    })

    const seenByB = await withTenant({ organizationId: ORG_B, userId: ME }, () =>
      db.execute<{ id: string }>(sql`select id from root_sort_runs where id = ${run.id}`)
    )
    expect(Array.from(seenByB)).toEqual([])

    const updatedByB = await withTenant({ organizationId: ORG_B, userId: ME }, () =>
      db.execute<{ id: string }>(sql`update root_sort_runs set status = 'cancelled' where id = ${run.id} returning id`)
    )
    expect(Array.from(updatedByB)).toEqual([])

    const insertedAsA = await refusal(() =>
      withTenant({ organizationId: ORG_B, userId: ME }, () =>
        db.execute(sql`insert into root_sort_runs (organization_id, scope, requested_by, status)
                       values (${ORG_A}, 'office_shelf', ${ME}, 'ready')`)
      )
    )
    expect(pgError(insertedAsA).code).toBe('42501')

    expect(await repo.findRootSortRun(ORG_B, run.id)).toBeNull()
    expect((await repo.findRootSortRun(ORG_A, run.id))?.status).toBe('judging')
  })

  it('ends a working run that stopped moving, frees the shelf, and leaves a fresh one alone', async () => {
    const insert = (projectId: string, status: RootSortRunStatus) =>
      repo.insertRootSortRun({ organizationId: ORG_A, scope: 'project', projectId, requestedBy: ME, status, documentIds: [] })
    const stalled = await insert(projects.stalled, 'applying')
    await withTenant({ organizationId: ORG_A, userId: ME }, () =>
      db.execute(sql`update root_sort_runs set updated_at = now() - interval '2 hours' where id = ${stalled.id}`)
    )
    const fresh = await insert(projects.fresh, 'judging')
    const before = new Date(Date.now() - 30 * 60 * 1000)

    // Another organization's sweep reaches nothing of this one.
    expect(await repo.failStalledRootSortRuns(ORG_B, { kind: 'project', projectId: projects.stalled }, before)).toEqual([])

    const ended = await repo.failStalledRootSortRuns(ORG_A, { kind: 'project', projectId: projects.stalled }, before)
    expect(ended.map((run) => [run.id, run.status, run.error])).toEqual([[stalled.id, 'failed', 'stalled']])
    expect(ended[0].finishedAt).not.toBeNull()

    // The shelf takes a new run again, and the other shelf's fresh run kept working.
    expect((await insert(projects.stalled, 'judging')).status).toBe('judging')
    expect(await repo.failStalledRootSortRuns(ORG_A, { kind: 'project', projectId: projects.fresh }, before)).toEqual([])
    expect((await repo.findRootSortRun(ORG_A, fresh.id))?.status).toBe('judging')
  })

  it('deletes a project\'s runs with it, and leaves the Archiv runs alone', async () => {
    const cascadeProject = await seedProject(ORG_A, 'root sort cascade doomed')
    const working = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: cascadeProject,
      requestedBy: ME,
      status: 'judging',
      documentIds: [],
    })
    const finished = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'project',
      projectId: cascadeProject,
      requestedBy: ME,
      status: 'applied',
      documentIds: [],
    })
    const archiv = await repo.insertRootSortRun({
      organizationId: ORG_A,
      scope: 'office_shelf',
      projectId: null,
      requestedBy: ME,
      status: 'ready',
      documentIds: [],
    })

    await withTenant({ organizationId: ORG_A, userId: ME }, () =>
      db.execute(sql`delete from projects where id = ${cascadeProject}`)
    )

    expect(await repo.findRootSortRun(ORG_A, working.id)).toBeNull()
    expect(await repo.findRootSortRun(ORG_A, finished.id)).toBeNull()
    expect((await repo.findRootSortRun(ORG_A, archiv.id))?.id).toBe(archiv.id)
  })
})
