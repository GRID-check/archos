/**
 * @vitest-environment node
 *
 * A project's Offene Punkte (`listProjectAnnotationPage`) against a REAL
 * Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/annotations/project-repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - the marks of the project's documents the reader's listing would show,
 *     and no others: a held upload's only for its uploader (and a reviewer), an
 *     archived document's and a hidden folder's for nobody, another project's
 *     and another organization's never;
 *   - the status, the Zuständige and the Frist narrow it;
 *   - by document (its name case-folded) then number, or by Frist with the
 *     marks without one last; and the keyset pages chain to exactly the whole
 *     list in either order, with no row twice;
 *   - each row comes with its thread, its Fassung's number and its document.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { memberReader, REVIEWER_READER } from '@/lib/documents/document-reader'
import type { ProjectAnnotationPageQuery, ProjectAnnotationRecord } from './project-repository'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_open_points_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const READER = `user_open_points_${STAMP}`
const OTHER = `${READER}_other`

describe('the Offene Punkte suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('a project’s Offene Punkte against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let projects: typeof import('./project-repository')
  const ids = { project: '', other: '', folder: '', a: '', b: '', heldOwn: '', heldForeign: '', archived: '', closed: '', elsewhere: '' }

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: READER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await withTenant({ organizationId, userId: READER }, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${READER}, ${`proj_op_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(
    projectId: string,
    filename: string,
    { createdBy = OTHER, status = 'completed', folderId = null }: { createdBy?: string; status?: string; folderId?: string | null } = {}
  ): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome, folder_id)
          values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${projectId}/${filename}`},
                  ${`proj_op_${projectId}`}, ${createdBy}, ${status}, ${status === 'completed' ? 'clean' : null},
                  ${folderId}::uuid) returning id`)
      )
    )
  }

  const mark = (extra: Partial<import('./repository').NewAnnotationValues> = {}) => ({
    page: 1,
    shape: 'point' as const,
    x: 0.5,
    y: 0.5,
    w: null,
    h: null,
    kind: 'hint' as const,
    body: 'Punkt',
    basis: null,
    assigneeUserId: null,
    dueOn: null,
    ...extra,
  })

  const insert = (documentId: string, marks = [mark()], authorKind: 'person' | 'piloti' = 'person') =>
    inOrg(() =>
      repo.insertDocumentAnnotations({ organizationId: ORG, documentId, versionId: null, authorKind, createdBy: READER, marks })
    )

  const read = (overrides: Partial<ProjectAnnotationPageQuery> = {}, organizationId = ORG) =>
    projects.listProjectAnnotationPage(organizationId, ids.project, {
      reader: memberReader(READER),
      hiddenFolderIds: [ids.folder],
      statuses: ['open'],
      order: 'document',
      cursor: null,
      limit: 100,
      ...overrides,
    })

  const label = (records: readonly ProjectAnnotationRecord[]) =>
    records.map((record) => `${record.document.filename}#${record.number}`)

  /** Every page of a read, chained by its cursor. */
  async function drain(overrides: Partial<ProjectAnnotationPageQuery>): Promise<string[]> {
    const rows: string[] = []
    let cursor: ProjectAnnotationPageQuery['cursor'] = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await read({ ...overrides, cursor })
      rows.push(...label(page.records))
      if (!page.next) return rows
      cursor = page.next
    }
    throw new Error('the pages never ended')
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    projects = await import('./project-repository')

    ids.project = await project(ORG, 'Wohnbau')
    ids.other = await project(ORG, 'Nachbar')
    await project(OTHER_ORG, 'Fremd')
    ids.folder = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into project_folders (organization_id, project_id, name, path)
          values (${ORG}, ${ids.project}::uuid, 'Vertraulich', 'Vertraulich') returning id`)
      )
    )
    // Lower case first: the order is the shown name case-folded, so „a-…" comes before „B-…".
    ids.a = await document(ids.project, 'a-Grundriss.pdf')
    ids.b = await document(ids.project, 'B-Schnitt.pdf')
    ids.heldOwn = await document(ids.project, 'held-own.pdf', { createdBy: READER, status: 'quarantined' })
    ids.heldForeign = await document(ids.project, 'held-foreign.pdf', { status: 'quarantined' })
    ids.archived = await document(ids.project, 'archived.pdf')
    ids.closed = await document(ids.project, 'closed.pdf', { folderId: ids.folder })
    ids.elsewhere = await document(ids.other, 'elsewhere.pdf')
    await inOrg(() => db.execute(sql`update documents set lifecycle = 'archived' where id = ${ids.archived}::uuid`))

    const [overdue] = await insert(ids.a, [
      mark({ body: 'Brandschutztür', assigneeUserId: READER, dueOn: '2026-10-10' }),
      mark({ body: 'Stiegenbreite', dueOn: '2026-10-20' }),
    ])
    await insert(ids.a, [mark({ body: 'Vorschlag' })], 'piloti')
    await insert(ids.b, [mark({ body: 'Höhenkote' }), mark({ body: 'Fensterteilung', dueOn: '2026-10-19' })])
    for (const id of [ids.heldOwn, ids.heldForeign, ids.archived, ids.closed, ids.elsewhere]) await insert(id)
    await inOrg(() =>
      repo.insertAnnotationReply({ organizationId: ORG, annotationId: overdue.id, authorKind: 'person', body: 'Erledige ich', createdBy: OTHER })
    )
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

  it('lists what the reader’s Dateien would show: their own held upload, never another’s, an archived or a hidden one', async () => {
    const page = await read()
    expect(label(page.records)).toEqual([
      'a-Grundriss.pdf#1',
      'a-Grundriss.pdf#2',
      'B-Schnitt.pdf#1',
      'B-Schnitt.pdf#2',
      'held-own.pdf#1',
    ])
    expect(page.next).toBeNull()
  })

  it('shows a reviewer the held uploads too, and still not what the listing leaves out', async () => {
    const page = await read({ reader: REVIEWER_READER })
    expect(label(page.records)).toContain('held-foreign.pdf#1')
    expect(label(page.records)).not.toContain('archived.pdf#1')
    expect(label(page.records)).not.toContain('closed.pdf#1')
  })

  it('shows another member none of the held uploads', async () => {
    const page = await read({ reader: memberReader(`${READER}_third`) })
    expect(label(page.records).filter((row) => row.startsWith('held'))).toEqual([])
  })

  it('narrows by status, by Zuständige and by Frist', async () => {
    expect(label((await read({ statuses: ['proposed'] })).records)).toEqual(['a-Grundriss.pdf#3'])
    expect(label((await read({ statuses: ['open', 'proposed'] })).records).slice(0, 3)).toEqual([
      'a-Grundriss.pdf#1',
      'a-Grundriss.pdf#2',
      'a-Grundriss.pdf#3',
    ])
    expect(label((await read({ assigneeUserId: READER })).records)).toEqual(['a-Grundriss.pdf#1'])
    expect(label((await read({ due: { before: '2026-10-18' } })).records)).toEqual(['a-Grundriss.pdf#1'])
    expect(label((await read({ due: { from: '2026-10-18', through: '2026-10-25' } })).records)).toEqual([
      'a-Grundriss.pdf#2',
      'B-Schnitt.pdf#2',
    ])
  })

  it('orders by Frist with the marks that have none last, by document among equals', async () => {
    expect(label((await read({ order: 'due' })).records)).toEqual([
      'a-Grundriss.pdf#1',
      'B-Schnitt.pdf#2',
      'a-Grundriss.pdf#2',
      'B-Schnitt.pdf#1',
      'held-own.pdf#1',
    ])
  })

  it('chains its pages to exactly the whole list, in either order', async () => {
    for (const order of ['document', 'due'] as const) {
      const whole = label((await read({ order })).records)
      expect(await drain({ order, limit: 2 })).toEqual(whole)
      expect(await drain({ order, limit: 1 })).toEqual(whole)
    }
  })

  it('carries each mark’s thread and its document', async () => {
    const [mine] = (await read({ assigneeUserId: READER })).records
    expect(mine.replies.map((reply) => reply.body)).toEqual(['Erledige ich'])
    expect(mine.document).toMatchObject({ id: ids.a, filename: 'a-Grundriss.pdf', projectId: ids.project })
    expect(mine.fassungNumber).toBeNull()
  })

  it('says whether the whole selection quotes a document not every member may open', async () => {
    const reaches = (overrides: Partial<Parameters<typeof projects.selectionReachesRestrictedDocuments>[2]> = {}) =>
      inOrg(() =>
        projects.selectionReachesRestrictedDocuments(ORG, ids.project, {
          reader: memberReader(READER),
          hiddenFolderIds: [ids.folder],
          statuses: ['open'],
          restrictedFolderIds: [ids.folder],
          ...overrides,
        })
      )
    // The reader's own held upload is in their list, and nobody else may open it.
    expect(await reaches()).toBe(true)
    // Narrowed to what sits in the root and passed screening: nothing to hide.
    expect(await reaches({ assigneeUserId: READER })).toBe(false)
    // A member who may read the restricted folder sees its document in the list; it is restricted for the others.
    const third = { reader: memberReader(`${READER}_third`), hiddenFolderIds: [] }
    expect(await reaches(third)).toBe(true)
    expect(await reaches({ ...third, restrictedFolderIds: [] })).toBe(false)
  })

  it('reads nothing for another organization', async () => {
    const page = await withTenant({ organizationId: OTHER_ORG, userId: READER }, () => read({}, OTHER_ORG))
    expect(page.records).toEqual([])
  })
})
