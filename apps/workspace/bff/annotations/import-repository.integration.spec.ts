/**
 * @vitest-environment node
 *
 * Marks imported from a BCF file (migration 0196) against a REAL Postgres
 * through the restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run bff/annotations/import-repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - one topic is one mark with its viewpoint, its replies (by their own
 *     authors, each marked with the import, its importer and the comment's
 *     own date) and the topic's guid and batch, in one transaction;
 *   - a topic closed in the file arrives closed by the importer;
 *   - the same topic on the same model is refused as a second mark, on another
 *     model it is a mark of its own;
 *   - the model's imported guids are read back for the skip;
 *   - an imported mark without a viewpoint, or with a guid and no batch, is
 *     refused by the CHECKs.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_bcf_import_${STAMP}`
const USER = `user_bcf_import_${STAMP}`
const OTHER_USER = `user_bcf_other_${STAMP}`

describe('the BCF import suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('imported marks against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let imports: typeof import('./import-repository')
  let repo: typeof import('./repository')
  const ids = { project: '', model: '', other: '' }

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function document(filename: string): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.project}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_bcf_${STAMP}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  const viewpoint = () => ({
    id: randomUUID(),
    cameraKind: 'orthographic' as const,
    camera: {
      type: 'orthographic' as const,
      position: { x: 10, y: -5, z: 20 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      viewToWorldScale: 12,
      aspectRatio: 16 / 9,
    },
    clippingPlanes: [],
    selectionIds: ['2O2Fr$t4X7Zf8NOew3FLOH'],
    defaultVisibility: true,
    visibilityExceptionIds: [],
    coloring: [],
    pinPoint: null,
    pinGlobalId: null,
    snapshotKey: null,
    snapshotContentType: null,
    snapshotBytes: null,
  })

  const insert = (documentId: string, guid: string, status: 'open' | 'resolved' = 'open', batch = randomUUID()) =>
    inOrg(() =>
      imports.insertImportedMark({
        organizationId: ORG,
        documentId,
        versionId: null,
        createdBy: USER,
        viewpoint: viewpoint(),
        mark: { kind: 'defect', body: 'Durchbruch fehlt', mentions: [], basis: null, assigneeUserId: null, dueOn: '2026-11-13', status },
        sourceTopicGuid: guid,
        importBatchId: batch,
        replies: [
          { body: 'Bitte prüfen.', createdBy: OTHER_USER, createdAt: new Date('2026-10-31T08:00:00.000Z'), sourceDate: new Date('2026-10-20T08:00:00Z') },
          { body: 'Aus der BCF-Datei übernommen.', createdBy: USER, createdAt: new Date('2026-10-31T08:00:00.001Z'), sourceDate: null },
        ],
      })
    )

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    imports = await import('./import-repository')
    repo = await import('./repository')
    ids.project = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Koordination', ${USER}, ${`proj_bcf_${STAMP}`}) returning id`)
      )
    )
    ids.model = await document('Haus.ifc')
    ids.other = await document('Haus TWP.ifc')
  })

  afterAll(async () => {
    if (!db) return
    await inOrg(() => db.execute(sql`delete from documents where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from projects where organization_id = ${ORG}`))
  })

  it('writes one topic as one mark with its viewpoint, thread, guid and batch', async () => {
    const guid = randomUUID()
    const batch = randomUUID()
    const row = await insert(ids.model, guid, 'open', batch)
    expect(row).toMatchObject({ anchorKind: 'viewpoint', authorKind: 'person', status: 'open', createdBy: USER, sourceTopicGuid: guid, importBatchId: batch })
    expect(row.page).toBeNull()
    const record = await inOrg(() => repo.findDocumentAnnotation(ORG, ids.model, row.id))
    expect(record?.replies.map((reply) => [reply.createdBy, reply.body])).toEqual([
      [OTHER_USER, 'Bitte prüfen.'],
      [USER, 'Aus der BCF-Datei übernommen.'],
    ])
    // A colleague's comment from the file is theirs, and says it came in by this import.
    expect(record?.replies.map((reply) => [reply.importBatchId, reply.importedBy])).toEqual([
      [batch, USER],
      [batch, USER],
    ])
    expect(record?.replies[0].createdAt.toISOString()).toBe('2026-10-31T08:00:00.000Z')
    expect(record?.replies[0].sourceDate?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
  })

  it('brings a topic closed in the file in closed, by the importer', async () => {
    const row = await insert(ids.model, randomUUID(), 'resolved')
    expect(row.status).toBe('resolved')
    expect(row.closedBy).toBe(USER)
    expect(row.closedAt).not.toBeNull()
  })

  it('refuses the same topic twice on one model, and takes it on another', async () => {
    const guid = randomUUID()
    await insert(ids.model, guid)
    await expect(insert(ids.model, guid)).rejects.toBeInstanceOf(imports.TopicImportedTwiceError)
    await expect(insert(ids.other, guid)).resolves.toMatchObject({ sourceTopicGuid: guid })
    const known = await inOrg(() => imports.importedTopicGuids(ORG, ids.model))
    expect(known.has(guid)).toBe(true)
  })

  /** The constraint a refused statement names (the driver's error is the wrapper's cause), or `accepted`. */
  async function refusal(work: () => PromiseLike<unknown>): Promise<string> {
    try {
      await work()
      return 'accepted'
    } catch (error) {
      return String((error as { cause?: unknown }).cause ?? error)
    }
  }

  it('refuses an imported page mark and a guid without a batch', async () => {
    const pageMark = await refusal(() =>
      inOrg(() =>
        db.execute(sql`
          insert into document_annotations (organization_id, document_id, number, page, shape, x, y, kind, body, author_kind,
                                            status, created_by, source_topic_guid, import_batch_id)
          values (${ORG}, ${ids.other}::uuid, 900, 1, 'point', 0.5, 0.5, 'hint', 'x', 'person', 'open', ${USER},
                  ${randomUUID()}::uuid, ${randomUUID()}::uuid)`)
      )
    )
    expect(pageMark).toMatch(/document_annotations_import_is_viewpoint/)
    const row = await insert(ids.other, randomUUID())
    const unbatched = await refusal(() =>
      inOrg(() => db.execute(sql`update document_annotations set import_batch_id = null where id = ${row.id}::uuid`))
    )
    expect(unbatched).toMatch(/document_annotations_import_complete/)
    const record = await inOrg(() => repo.findDocumentAnnotation(ORG, ids.other, row.id))
    const replyId = record?.replies[0].id ?? ''
    const anonymous = await refusal(() =>
      inOrg(() => db.execute(sql`update document_annotation_replies set imported_by = null where id = ${replyId}::uuid`))
    )
    expect(anonymous).toMatch(/document_annotation_replies_import_complete/)
  })
})
