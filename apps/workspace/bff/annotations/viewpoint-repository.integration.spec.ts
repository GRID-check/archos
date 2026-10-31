/**
 * @vitest-environment node
 *
 * Marks on a model (migration 0193) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run bff/annotations/viewpoint-repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - a viewpoint mark takes the next number of its document beside the page
 *     marks, ten writers at once get ten numbers, and the mark has no box;
 *   - the viewpoint comes back as written, camera and element lists included,
 *     and its summary says what it holds;
 *   - a mark and its viewpoint are one transaction: a viewpoint the database
 *     refuses leaves no mark behind;
 *   - the elements a model lacks are named, as the reader may see the document;
 *   - another organization reads no viewpoint and cannot plant one on this
 *     organization's document.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_viewpoints_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_viewpoints_${STAMP}`
const ID_A = '2O2Fr$t4X7Zf8NOew3FLOH'
const ID_B = '3pGKgn9xH4$PdVA0l_Bk8z'
const ID_C = '1hOSvn6df7weDDVAKgmDHz'

describe('the viewpoint suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('viewpoint marks against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let viewpoints: typeof import('./viewpoint-repository')
  let memberReader: typeof import('@/lib/documents/visibility').memberReader
  const ids = { project: '', model: '', pdf: '', bimModel: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function document(filename: string): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.project}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_vp_${STAMP}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  const viewpoint = (patch: Partial<import('./viewpoint-repository').NewViewpointValues> = {}) => ({
    id: randomUUID(),
    cameraKind: 'perspective' as const,
    camera: {
      type: 'perspective' as const,
      position: { x: 2683010, y: 1245020, z: 5 },
      direction: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
      aspectRatio: 1.5,
    },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }],
    selectionIds: [ID_A, ID_B],
    defaultVisibility: false,
    visibilityExceptionIds: [ID_A],
    coloring: [{ color: 'FF0000', globalIds: [ID_B] }],
    pinPoint: null,
    pinGlobalId: null,
    snapshotKey: null,
    snapshotContentType: null,
    snapshotBytes: null,
    ...patch,
  })

  const content = { kind: 'defect' as const, body: 'Sturz fehlt', mentions: [], basis: null, assigneeUserId: null, dueOn: null }

  const insert = (documentId: string, vp = viewpoint(), organizationId = ORG) =>
    inOrg(organizationId, () =>
      viewpoints.insertViewpointMark({ organizationId, documentId, versionId: null, createdBy: USER, viewpoint: vp, mark: content })
    )

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    viewpoints = await import('./viewpoint-repository')
    memberReader = (await import('@/lib/documents/visibility')).memberReader
    ids.project = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Modell', ${USER}, ${`proj_vp_${STAMP}`}) returning id`)
      )
    )
    ids.model = await document('Haus.ifc')
    ids.pdf = await document('Grundriss.pdf')
    ids.bimModel = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into bim_models (organization_id, project_id, document_id, status, element_count)
          values (${ORG}, ${ids.project}::uuid, ${ids.model}::uuid, 'ready', 2) returning id`)
      )
    )
    await inOrg(ORG, () =>
      db.execute(sql`
        insert into bim_elements (model_id, global_id, express_id, ifc_type)
        values (${ids.bimModel}::uuid, ${ID_A}, 1, 'IfcWall'), (${ids.bimModel}::uuid, ${ID_B}, 2, 'IfcDoor')`)
    )
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('numbers beside the page marks, ten writers at once get ten numbers, and the mark has no box', async () => {
    const [pageMark] = await inOrg(ORG, () =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId: ids.model,
        versionId: null,
        authorKind: 'person',
        createdBy: USER,
        marks: [{ page: 1, shape: 'point', x: 0.5, y: 0.5, w: null, h: null, ...content }],
      })
    )
    expect(pageMark.number).toBe(1)
    const rows = await Promise.all(Array.from({ length: 10 }, () => insert(ids.model)))
    expect(rows.map((row) => row.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(rows[0]).toMatchObject({ anchorKind: 'viewpoint', page: null, shape: null, x: null, y: null, w: null, h: null, status: 'open' })
    expect(rows[0].viewpointId).toBeTruthy()
  })

  it('reads the viewpoint as written and summarises it', async () => {
    const vp = viewpoint({ pinPoint: { x: 1, y: 2, z: 3 }, pinGlobalId: ID_A })
    const row = await insert(ids.model, vp)
    const found = await inOrg(ORG, () => viewpoints.findViewpoint(ORG, ids.model, vp.id))
    expect(found).toMatchObject({
      id: vp.id,
      documentId: ids.model,
      cameraKind: 'perspective',
      camera: vp.camera,
      clippingPlanes: vp.clippingPlanes,
      selectionIds: [ID_A, ID_B],
      defaultVisibility: false,
      visibilityExceptionIds: [ID_A],
      coloring: vp.coloring,
      pinPoint: { x: 1, y: 2, z: 3 },
      pinGlobalId: ID_A,
      createdBy: USER,
    })
    expect(row.viewpointId).toBe(vp.id)
    const summaries = await inOrg(ORG, () => viewpoints.viewpointSummariesFor(ORG, ids.model, [vp.id, randomUUID()]))
    expect([...summaries.values()]).toEqual([
      { id: vp.id, cameraKind: 'perspective', selectionCount: 2, hasSection: true, hasSnapshot: false },
    ])
    expect(await viewpoints.viewpointSummariesFor(ORG, ids.model, [])).toEqual(new Map())
  })

  it('deletes the viewpoint with its mark, and only that one', async () => {
    const mine = viewpoint()
    const other = viewpoint()
    const row = await insert(ids.model, mine)
    await insert(ids.model, other)
    expect(await inOrg(ORG, () => repo.deleteDocumentAnnotation(ORG, ids.model, row.id))).toEqual({ snapshotKeys: [] })
    expect(await inOrg(ORG, () => viewpoints.findViewpoint(ORG, ids.model, mine.id))).toBeNull()
    expect(await inOrg(ORG, () => viewpoints.findViewpoint(ORG, ids.model, other.id))).not.toBeNull()
  })

  it('carries a sketch mark in place, and leaves a viewpoint mark where it is', async () => {
    const versionId = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${ids.model}::uuid, ${ids.project}::uuid, 1, 'published', ${`k/${STAMP}/v1`},
                  ${`sha256:${STAMP}`}, ${USER}, ${USER}, now()) returning id`)
      )
    )
    const [sketch] = await inOrg(ORG, () =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId: ids.model,
        versionId: null,
        authorKind: 'person',
        createdBy: USER,
        marks: [{ page: 1, shape: 'region', x: 0.1, y: 0.1, w: 0.2, h: 0.2, anchorElementIds: ['a'], anchorKind: 'sketch', ...content }],
      })
    )
    const carried = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.model, sketch.id, 'open', { revision: { from: null, to: versionId } })
    )
    expect(carried?.versionId).toBe(versionId)
    const mark = await insert(ids.model)
    const refused = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.model, mark.id, 'open', { revision: { from: null, to: versionId } })
    )
    expect(refused).toBeNull()
  })

  it('does not find a viewpoint through another document', async () => {
    const vp = viewpoint()
    await insert(ids.model, vp)
    expect(await inOrg(ORG, () => viewpoints.findViewpoint(ORG, ids.pdf, vp.id))).toBeNull()
  })

  it('leaves no mark behind when the viewpoint is refused', async () => {
    const before = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, ids.model))
    await expect(insert(ids.model, viewpoint({ snapshotBytes: 0, snapshotKey: 'k', snapshotContentType: 'image/png' }))).rejects.toThrow()
    const after = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, ids.model))
    expect(after).toHaveLength(before.length)
  })

  it('names the elements a model lacks, for a reader who may see the document', async () => {
    const reader = memberReader(USER)
    const missing = await inOrg(ORG, () => viewpoints.findMissingElements(ORG, ids.bimModel, [ID_A, ID_B, ID_C], reader))
    expect(missing).toEqual([ID_C])
    expect(await viewpoints.findMissingElements(ORG, ids.bimModel, [], reader)).toEqual([])
  })

  it('shows another organization no viewpoint and takes none on this organization’s document', async () => {
    const vp = viewpoint()
    await insert(ids.model, vp)
    // Raw SQL under the other organization's context: the repository functions set the context they are given.
    const seen = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from annotation_viewpoints where id = ${vp.id}::uuid`)
    )
    expect(Number(Array.from(seen)[0]?.n)).toBe(0)
    await expect(insert(ids.model, viewpoint(), OTHER_ORG)).rejects.toThrow()
  })
})
