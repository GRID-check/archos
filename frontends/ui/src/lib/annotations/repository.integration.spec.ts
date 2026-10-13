/**
 * @vitest-environment node
 *
 * Anmerkungen rows (migration 0135) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/annotations/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - numbers run per document, and ten writers at once get ten numbers; a
 *     batch of proposals takes consecutive numbers;
 *   - a person's mark is born open and Piloti's proposed, and the database
 *     refuses Piloti's mark as open without a person who took it over;
 *   - the Fassung a mark was set on comes back by number, and a discarded
 *     version leaves the mark standing;
 *   - a status move is compare-and-swap: the second of two moves from the same
 *     state finds nothing to move;
 *   - a thread comes back in order and goes with its mark;
 *   - another organization reads none of them and cannot plant one on this
 *     organization's document.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_annotations_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_annotations_${STAMP}`

describe('the Anmerkungen suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Anmerkungen against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  const ids = { project: '', document: '', second: '', v1: '', v2: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_ann_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(projectId: string, filename: string): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_ann_${projectId}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  async function version(documentId: string, number: number, state: 'published' | 'superseded'): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${documentId}::uuid, ${ids.project}::uuid, ${number}, ${state}, ${`k/${STAMP}/v${number}`},
                  ${`sha256:${STAMP}${number}`}, ${USER}, ${USER}, now()) returning id`)
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
    body: 'Stiegenbreite prüfen',
    basis: null,
    assigneeUserId: null,
    dueOn: null,
    ...extra,
  })

  const insert = (
    documentId: string,
    marks = [mark()],
    extra: Partial<import('./repository').NewAnnotationsInput> = {}
  ) =>
    inOrg(extra.organizationId ?? ORG, () =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId,
        versionId: null,
        authorKind: 'person',
        createdBy: USER,
        marks,
        ...extra,
      })
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.project = await project(ORG, 'Wohnbau')
    await project(OTHER_ORG, 'Fremd')
    ids.document = await document(ids.project, 'EG_Grundriss.pdf')
    ids.second = await document(ids.project, 'OG_Grundriss.pdf')
    ids.v1 = await version(ids.document, 1, 'superseded')
    ids.v2 = await version(ids.document, 2, 'published')
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

  it('numbers per document, ten writers at once get ten numbers, and a batch takes consecutive ones', async () => {
    await insert(ids.second)
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, index) => insert(ids.document, [mark({ body: `Mark ${index}` })]))
    )
    expect(
      rows
        .flat()
        .map((row) => row.number)
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const batch = await insert(ids.document, [mark({ body: 'a' }), mark({ body: 'b' }), mark({ body: 'c' })], {
      authorKind: 'piloti',
    })
    expect(batch.map((row) => [row.number, row.status, row.authorKind])).toEqual([
      [11, 'proposed', 'piloti'],
      [12, 'proposed', 'piloti'],
      [13, 'proposed', 'piloti'],
    ])
    const second = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, ids.second))
    expect(second.map((row) => [row.number, row.status])).toEqual([[1, 'open']])
  })

  it('stores a region, and refuses one off its page', async () => {
    const [region] = await insert(ids.document, [mark({ shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })])
    expect(region).toMatchObject({ shape: 'region', w: 0.3, h: 0.4 })
    await expect(insert(ids.document, [mark({ shape: 'region', x: 0.8, y: 0.2, w: 0.3, h: 0.4 })])).rejects.toThrow()
  })

  it("refuses Piloti's mark as the office's own until a person took it over", async () => {
    const [proposal] = await insert(ids.document, [mark()], { authorKind: 'piloti' })
    await expect(
      inOrg(ORG, () => db.execute(sql`update document_annotations set status = 'open' where id = ${proposal.id}::uuid`))
    ).rejects.toThrow()

    const taken = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, proposal.id, 'proposed', {
        transition: { status: 'open', acceptedBy: USER, acceptedAt: new Date(), closedBy: null, closedAt: null },
      })
    )
    expect(taken).toMatchObject({ status: 'open', acceptedBy: USER })
  })

  it('moves a status by compare and swap: the second move from the same state finds nothing', async () => {
    const [row] = await insert(ids.document)
    const resolve = () =>
      inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
          transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
        })
      )
    expect(await resolve()).toMatchObject({ status: 'resolved' })
    expect(await resolve()).toBeNull()
    await expect(
      inOrg(ORG, () =>
        db.execute(sql`update document_annotations set closed_by = null, closed_at = null where id = ${row.id}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('reads the Fassung number it was set on, and keeps the mark when that version goes', async () => {
    const [onOld] = await insert(ids.document, [mark()], { versionId: ids.v1 })
    const [onNew] = await insert(ids.document, [mark()], { versionId: ids.v2 })
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id)))?.fassungNumber).toBe(1)
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onNew.id)))?.fassungNumber).toBe(2)

    await inOrg(ORG, () => db.execute(sql`delete from document_versions where id = ${ids.v1}::uuid`))
    const after = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id))
    expect(after).toMatchObject({ versionId: null, fassungNumber: null })
  })

  it('keeps a thread in order, touches the mark, and lets the thread go with its mark', async () => {
    const [row] = await insert(ids.document)
    for (const body of ['Erste', 'Zweite', 'Dritte']) {
      await inOrg(ORG, () =>
        repo.insertAnnotationReply({ organizationId: ORG, annotationId: row.id, authorKind: 'person', body, createdBy: USER })
      )
    }
    const found = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
    expect(found?.replies.map((reply) => reply.body)).toEqual(['Erste', 'Zweite', 'Dritte'])
    expect(found!.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime())

    await inOrg(ORG, () => repo.deleteDocumentAnnotation(ORG, ids.document, row.id))
    const left = await inOrg(ORG, () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from document_annotation_replies where annotation_id = ${row.id}::uuid`
      )
    )
    expect(Number(Array.from(left)[0]?.n)).toBe(0)
  })

  it('shows another organization none of them, and refuses one planted on this document', async () => {
    expect(await inOrg(OTHER_ORG, () => repo.listDocumentAnnotations(OTHER_ORG, ids.document))).toEqual([])
    const leaked = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(
        sql`select (select count(*) from document_annotations) + (select count(*) from document_annotation_replies) as n`
      )
    )
    expect(Number(Array.from(leaked)[0]?.n)).toBe(0)

    await expect(insert(ids.document, [mark()], { organizationId: OTHER_ORG })).rejects.toThrow()
  })
})
