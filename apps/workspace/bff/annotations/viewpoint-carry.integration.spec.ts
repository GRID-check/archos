/**
 * @vitest-environment node
 *
 * Carrying a mark on a model to a newer Fassung (migration 0195) against a
 * REAL Postgres through the restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run bff/annotations/viewpoint-carry.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - in place, the mark moves to the new Fassung onto a NEW viewpoint that
 *     names the old one, which stays as written; a stale read moves nothing
 *     and writes no viewpoint;
 *   - none of its elements left, the mark keeps its viewpoint and is marked
 *     lost, which the CHECKs now allow on a viewpoint mark;
 *   - across, the mark goes on as a linked mark of the replacing model on a
 *     viewpoint of that document, the source is closed, and a second carry
 *     moves nothing;
 *   - deleting a carried mark takes its viewpoint and the ones of the same
 *     document it was carried from;
 *   - the GlobalIds and the Fassung number the service reads.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CarriedViewpointSource } from './viewpoint-carry-plan'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_vpcarry_${STAMP}`
const USER = `user_vpcarry_${STAMP}`
const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const DOOR = '3pGKgn9xH4$PdVA0l_Bk8z'
const GONE = '1hOSvn6df7weDDVAKgmDHz'

describe('the viewpoint carry suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('carrying viewpoint marks against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let viewpoints: typeof import('./viewpoint-repository')
  let carry: typeof import('./viewpoint-carry-repository')
  let plan: typeof import('./viewpoint-carry-plan')
  let memberReader: typeof import('@/lib/documents/visibility').memberReader
  const ids = { project: '', model: '', next: '', bimModel: '', v1: '', v2: '', nextV1: '' }

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function document(filename: string): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.project}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_vpc_${STAMP}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  async function version(documentId: string, number: number): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${documentId}::uuid, ${ids.project}::uuid, ${number}, 'superseded', ${`k/${STAMP}/${documentId}/v${number}`},
                  ${`sha256:${STAMP}${documentId}${number}`}, ${USER}, ${USER}, now()) returning id`)
      )
    )
  }

  const source = (selection: string[]): CarriedViewpointSource & { id: string } => ({
    id: randomUUID(),
    cameraKind: 'perspective',
    camera: {
      type: 'perspective',
      position: { x: 2683010, y: 1245020, z: 5 },
      direction: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
      aspectRatio: 1.5,
    },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }],
    selectionIds: selection,
    defaultVisibility: true,
    visibilityExceptionIds: [],
    coloring: [],
    pinPoint: { x: 1, y: 2, z: 3 },
    pinGlobalId: selection[0] ?? null,
  })

  const content = { kind: 'defect' as const, body: 'Auflager fehlt', mentions: [], basis: null, assigneeUserId: null, dueOn: null }

  /** A mark on the model's first Fassung, as a person sets it. */
  async function markOnV1(selection: string[]) {
    const vp = source(selection)
    const row = await inOrg(() =>
      viewpoints.insertViewpointMark({
        organizationId: ORG,
        documentId: ids.model,
        versionId: ids.v1,
        createdBy: USER,
        viewpoint: { ...vp, snapshotKey: null, snapshotContentType: null, snapshotBytes: null },
        mark: content,
      })
    )
    return { row, vp }
  }

  const readMark = (row: { id: string; status: 'open' | 'proposed' | 'resolved' | 'dismissed'; versionId: string | null }, viewpointId: string) => ({
    id: row.id,
    status: row.status,
    versionId: row.versionId,
    viewpointId,
  })

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    viewpoints = await import('./viewpoint-repository')
    carry = await import('./viewpoint-carry-repository')
    plan = await import('./viewpoint-carry-plan')
    memberReader = (await import('@/lib/documents/visibility')).memberReader
    ids.project = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Modell', ${USER}, ${`proj_vpc_${STAMP}`}) returning id`)
      )
    )
    ids.model = await document('Haus.ifc')
    ids.next = await document('Haus_rev4.ifc')
    ids.v1 = await version(ids.model, 3)
    ids.v2 = await version(ids.model, 4)
    ids.nextV1 = await version(ids.next, 1)
    ids.bimModel = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into bim_models (organization_id, project_id, document_id, status, element_count)
          values (${ORG}, ${ids.project}::uuid, ${ids.model}::uuid, 'ready', 2) returning id`)
      )
    )
    await inOrg(() =>
      db.execute(sql`
        insert into bim_elements (model_id, global_id, express_id, ifc_type)
        values (${ids.bimModel}::uuid, ${WALL}, 1, 'IfcWall'), (${ids.bimModel}::uuid, ${DOOR}, 2, 'IfcDoor')`)
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

  it('reads which GlobalIds the model has and the number of a Fassung', async () => {
    const present = await carry.presentGlobalIds(ORG, ids.bimModel, [WALL, GONE, DOOR], memberReader(USER))
    expect([...present].sort()).toEqual([WALL, DOOR].sort())
    expect(await carry.versionNumberOf(ORG, ids.model, ids.v2)).toBe(4)
    expect(await carry.versionNumberOf(ORG, ids.next, ids.v2)).toBeNull()
  })

  it('carries a mark in place onto a new viewpoint that names the old one, which stays as written', async () => {
    const { row, vp } = await markOnV1([WALL, GONE])
    const next = plan.carriedViewpointValues(vp, new Set([WALL, DOOR]), randomUUID())
    const moved = await carry.carryViewpointMarkInPlace({
      organizationId: ORG,
      documentId: ids.model,
      mark: readMark(row, vp.id),
      toVersionId: ids.v2,
      viewpoint: next,
      carriedBy: USER,
    })
    expect(moved).toMatchObject({ id: row.id, number: row.number, versionId: ids.v2, viewpointId: next.id, anchorLostAt: null })
    const written = await viewpoints.findViewpoint(ORG, ids.model, next.id)
    expect(written).toMatchObject({ versionId: ids.v2, carriedFromId: vp.id, selectionIds: [WALL], pinGlobalId: WALL, snapshotKey: null })
    expect(await viewpoints.findViewpoint(ORG, ids.model, vp.id)).toMatchObject({ selectionIds: [WALL, GONE], versionId: ids.v1 })

    // Read before that carry: it moves nothing and writes no viewpoint.
    const again = plan.carriedViewpointValues(vp, new Set([WALL]), randomUUID())
    const stale = await carry.carryViewpointMarkInPlace({
      organizationId: ORG,
      documentId: ids.model,
      mark: readMark(row, vp.id),
      toVersionId: ids.v2,
      viewpoint: again,
      carriedBy: USER,
    })
    expect(stale).toBeNull()
    expect(await viewpoints.findViewpoint(ORG, ids.model, again.id)).toBeNull()

    // Deleting the mark takes the viewpoint it is on and the one it was carried from.
    expect(await inOrg(() => repo.deleteDocumentAnnotation(ORG, ids.model, row.id))).toBe(true)
    expect(await viewpoints.findViewpoints(ORG, ids.model, [vp.id, next.id])).toEqual([])
  })

  it('keeps the viewpoint of a mark none of whose elements is left, and says it lost them', async () => {
    const { row, vp } = await markOnV1([GONE])
    const lost = await carry.carryViewpointMarkInPlace({
      organizationId: ORG,
      documentId: ids.model,
      mark: readMark(row, vp.id),
      toVersionId: ids.v2,
      viewpoint: null,
      carriedBy: USER,
    })
    expect(lost).toMatchObject({ versionId: ids.v2, viewpointId: vp.id })
    expect(lost?.anchorLostAt).toBeInstanceOf(Date)
  })

  it('carries an open mark across onto a viewpoint of the replacing model, closes the source, and only once', async () => {
    const { row, vp } = await markOnV1([WALL, DOOR])
    const next = plan.carriedViewpointValues(vp, new Set([DOOR]), randomUUID())
    const input = {
      organizationId: ORG,
      source: row,
      target: { documentId: ids.next, versionId: ids.nextV1 },
      values: { mentions: [], assigneeUserId: null },
      viewpoint: next,
      closedBy: USER,
    }
    const copy = await carry.carryViewpointMarkAcross(input)
    expect(copy).toMatchObject({
      documentId: ids.next,
      versionId: ids.nextV1,
      anchorKind: 'viewpoint',
      viewpointId: next.id,
      carriedFromId: row.id,
      status: 'open',
      page: null,
    })
    expect(await viewpoints.findViewpoint(ORG, ids.next, next.id)).toMatchObject({ carriedFromId: vp.id, selectionIds: [DOOR] })
    expect(await repo.findDocumentAnnotation(ORG, ids.model, row.id)).toMatchObject({ status: 'resolved', closedBy: USER })
    const twice = await carry.carryViewpointMarkAcross({ ...input, viewpoint: { ...next, id: randomUUID() } })
    expect(twice).toBeNull()
  })

  it('marks a mark lost where it stands when the replacing model has none of its elements', async () => {
    const { row, vp } = await markOnV1([GONE])
    const lost = await carry.markViewpointAnchorLost({ organizationId: ORG, documentId: ids.model, mark: readMark(row, vp.id) })
    expect(lost).toMatchObject({ documentId: ids.model, status: 'open', viewpointId: vp.id })
    expect(lost?.anchorLostAt).toBeInstanceOf(Date)
  })
})
