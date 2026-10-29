/**
 * @vitest-environment node
 *
 * A Skizze's marks going on with its next Fassung (migration 0192), against a
 * REAL Postgres through the restricted runtime role:
 *
 *   scripts/rls-test-db.sh --only bff/annotations/sketch-carry.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - an open and a proposed mark pinned to elements move onto the new Fassung,
 *     their box drawn again from the elements still there;
 *   - a mark whose elements are all gone moves too, keeps its last box and is
 *     marked lost; an element that comes back clears it;
 *   - a resolved mark, and a mark pinned to nothing, stay where they were;
 *   - a second move from the same Fassung finds nothing to move: compare and swap;
 *   - the database refuses elements on a point, on another page, an empty or
 *     overlong list, and a loss without elements.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_sketch_marks_${STAMP}`
const USER = `user_sketch_marks_${STAMP}`

/** The scene of the next Fassung: `a` moved, `b` deleted, `c` added; drawn 432 × 332 with 16 of padding. */
const NEXT = {
  elements: [
    { id: 'a', x: 100, y: 100, width: 200, height: 100 },
    { id: 'b', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
    { id: 'c', x: 400, y: 300, width: 100, height: 100 },
  ],
  viewBox: { width: 432, height: 332 },
}

describe('the sketch marks suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('a Skizze’s marks on its next Fassung, against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let carry: typeof import('./sketch-carry')
  const ids = { project: '', document: '', v1: '', v2: '', v3: '' }

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function version(number: number): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${ids.document}::uuid, ${ids.project}::uuid, ${number}, 'superseded', ${`k/${STAMP}/v${number}`},
                  ${`sha256:${STAMP}${number}`}, ${USER}, ${USER}, now()) returning id`)
      )
    )
  }

  const pinned = (anchorElementIds: string[] | null, body: string) => ({
    page: 1,
    shape: 'region' as const,
    x: 0.5,
    y: 0.5,
    w: 0.2,
    h: 0.2,
    anchorElementIds,
    kind: 'hint' as const,
    body,
    basis: null,
    assigneeUserId: null,
    dueOn: null,
  })

  const insert = (marks: ReturnType<typeof pinned>[], authorKind: 'person' | 'piloti' = 'person') =>
    inOrg(() =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId: ids.document,
        versionId: ids.v1,
        authorKind,
        createdBy: USER,
        marks,
      })
    )

  // `_from` names the Fassung the marks sit on, for the reader: the carry takes them from any earlier one.
  const move = (_from: string, to: string, sketch: typeof NEXT | null = NEXT) =>
    inOrg(() =>
      db.transaction((tx) =>
        carry.moveSketchMarks(tx, {
          organizationId: ORG,
          documentId: ids.document,
          toVersionId: to,
          sketch,
        })
      )
    )

  const read = async (id: string) => (await inOrg(() => repo.findDocumentAnnotation(ORG, ids.document, id)))!

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    carry = await import('./sketch-carry')
    ids.project = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Skizzen', ${USER}, ${`proj_sketch_${STAMP}`}) returning id`)
      )
    )
    ids.document = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome, content_type)
          values (${ORG}, ${ids.project}::uuid, 'project', 'Skizze Stiege.svg', ${`k/${STAMP}/sketch`},
                  ${`proj_sketch_${STAMP}`}, ${USER}, 'completed', 'clean', 'image/svg+xml') returning id`)
      )
    )
    ids.v1 = await version(1)
    ids.v2 = await version(2)
    ids.v3 = await version(3)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('moves the live pinned marks onto the new Fassung, drawn again from what is left of their elements', async () => {
    const [moved] = await insert([pinned(['a'], 'Stiege')])
    const [proposed] = await insert([pinned(['a', 'b'], 'Stiege und Podest')], 'piloti')
    const [lost] = await insert([pinned(['b'], 'Podest')])
    const [loose] = await insert([pinned(null, 'Ohne Element')])
    const [closed] = await insert([pinned(['a'], 'Erledigt')])
    await inOrg(() =>
      repo.updateDocumentAnnotation(ORG, ids.document, closed.id, 'open', {
        transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
      })
    )

    const result = await move(ids.v1, ids.v2)

    expect(new Set(result.moved)).toEqual(new Set([moved.id, proposed.id, lost.id]))
    expect(result.lost).toEqual([lost.id])
    for (const id of [moved.id, proposed.id]) {
      const row = await read(id)
      expect(row).toMatchObject({ versionId: ids.v2, revisionNumber: 2, anchorLostAt: null })
      expect(row.x).toBeCloseTo(16 / 432)
      expect(row.w).toBeCloseTo(200 / 432)
    }
    expect(await read(lost.id)).toMatchObject({ versionId: ids.v2, x: 0.5, w: 0.2, anchorElementIds: ['b'] })
    expect((await read(lost.id)).anchorLostAt).toBeInstanceOf(Date)
    expect(await read(loose.id)).toMatchObject({ versionId: ids.v1 })
    expect(await read(closed.id)).toMatchObject({ versionId: ids.v1, status: 'resolved' })

    // A second move from the same Fassung, as a racing save would make it, finds nothing.
    expect(await move(ids.v1, ids.v2)).toEqual({ moved: [], lost: [] })
  })

  it('clears the loss when an element comes back, and keeps every box when no scene is given', async () => {
    const back = { ...NEXT, elements: [...NEXT.elements, { id: 'b', x: 400, y: 100, width: 100, height: 100 }] }
    const before = await inOrg(() => repo.listDocumentAnnotations(ORG, ids.document))
    const lost = before.find((row) => row.anchorLostAt !== null)!
    await move(ids.v2, ids.v3, { ...back, elements: back.elements.filter((element) => !element.isDeleted) })
    expect(await read(lost.id)).toMatchObject({ versionId: ids.v3, anchorLostAt: null })
    expect((await read(lost.id)).x).toBeGreaterThan(0.5)

    const kept = await read(lost.id)
    const v4 = await version(4)
    await move(ids.v3, v4, null)
    expect(await read(lost.id)).toMatchObject({ versionId: v4, x: kept.x, w: kept.w, anchorLostAt: null })
  })

  it('refuses elements on a point, off the sheet’s page, an empty or overlong list, and a loss without elements', async () => {
    const [row] = await insert([pinned(['a'], 'Prüfen')])
    const refused = (change: ReturnType<typeof sql>) =>
      expect(inOrg(() => db.execute(sql`update document_annotations set ${change} where id = ${row.id}::uuid`))).rejects.toThrow()
    await refused(sql`shape = 'point', w = null, h = null`)
    await refused(sql`page = 2`)
    await refused(sql`anchor_element_ids = '{}'`)
    await refused(sql`anchor_element_ids = ${sql.raw(`'{${Array.from({ length: 21 }, (_, n) => `e${n}`).join(',')}}'`)}`)
    await refused(sql`anchor_element_ids = null, anchor_lost_at = now()`)
  })
})
