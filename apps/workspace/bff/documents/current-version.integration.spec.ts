/**
 * @vitest-environment node
 *
 * One path makes a Fassung current (`./published-version.ts`), against a REAL
 * Postgres through the restricted runtime role:
 *
 *   scripts/rls-test-db.sh --only bff/documents/current-version.integration.spec.ts
 *
 * The interference audit's reproductions (C2, C4), turned round:
 *   - a Freigabe that publishes an approved draft over two later sketch saves
 *     takes the pinned mark along onto the promoted Fassung, and the next save
 *     carries it on again; it used to stay on the superseded save for good;
 *   - a Skizze with a version in review is `review_open` to the save, and one
 *     with a draft open is `draft`: the save no longer publishes around a round.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_current_version_${STAMP}`
const USER = `user_current_version_${STAMP}`
const SCENE = { elements: [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }], viewBox: { width: 132, height: 132 } }

describe('the current Fassung suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('every path that makes a Fassung current carries the pinned marks, against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let annotations: typeof import('@/lib/annotations/repository')
  let versions: typeof import('./version-repository')
  let target: typeof import('@/lib/diagrams/sketch-target')
  const ids = { project: '' }

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function sketchDocument(name: string): Promise<string> {
    return first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome, content_type)
          values (${ORG}, ${ids.project}::uuid, 'project', ${name}, ${`k/${STAMP}/${name}`}, ${`proj_cf_${STAMP}`}, ${USER},
                  'completed', 'clean', 'image/svg+xml') returning id`)
      )
    )
  }

  const values = (documentId: string, n: string) => ({
    organizationId: ORG,
    documentId,
    projectId: ids.project,
    storageKey: `k/${STAMP}/${documentId}/${n}`,
    storageBucket: null,
    contentType: 'image/svg+xml',
    fileSize: 10,
    contentHash: `sha256:${STAMP}${documentId}${n}`,
    createdBy: USER,
    state: 'published' as const,
    origin: 'upload' as const,
    publishedBy: USER,
    publishedAt: new Date(),
  })
  const draftOf = (documentId: string, n: string) => ({ ...values(documentId, n), state: 'draft' as const, origin: 'draft' as const, publishedBy: null, publishedAt: null })
  const markOn = async (documentId: string, versionId: string) =>
    (
      await inOrg(() =>
        annotations.insertDocumentAnnotations({
          organizationId: ORG,
          documentId,
          versionId,
          authorKind: 'person',
          createdBy: USER,
          marks: [
            { page: 1, shape: 'region', x: 0.1, y: 0.1, w: 0.2, h: 0.2, anchorElementIds: ['a'], kind: 'hint', body: 'Treppe', basis: null, assigneeUserId: null, dueOn: null },
          ],
        })
      )
    )[0]
  const versionOf = async (documentId: string, markId: string) =>
    (await inOrg(() => annotations.findDocumentAnnotation(ORG, documentId, markId)))?.versionId

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    annotations = await import('@/lib/annotations/repository')
    versions = await import('./version-repository')
    target = await import('@/lib/diagrams/sketch-target')
    ids.project = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Fassungen', ${USER}, ${`proj_cf_${STAMP}`}) returning id`)
      )
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

  it('a Freigabe publish over later saves takes the pinned mark onto the promoted Fassung, and the next save on again', async () => {
    const documentId = await sketchDocument('Skizze.svg')
    const { version: v1 } = await inOrg(() => versions.insertPublishedVersion(values(documentId, 'v1'), { publishedVersionId: null }))
    const mark = await markOn(documentId, v1.id)
    const draft = await inOrg(() => versions.insertDocumentVersion(draftOf(documentId, 'd')))
    await inOrg(() => db.execute(sql`update document_versions set state = 'approved', approved_by = ${USER}, approved_at = now() where id = ${draft.id}::uuid`))
    // Two saves meanwhile (as they could before the save refused an open round), each carrying the mark.
    const s1 = await inOrg(() => versions.insertPublishedVersion(values(documentId, 's1'), { publishedVersionId: v1.id }, SCENE))
    expect(s1.carried.moved).toEqual([mark.id])
    const s2 = await inOrg(() => versions.insertPublishedVersion(values(documentId, 's2'), { publishedVersionId: s1.version.id }, SCENE))
    expect(await versionOf(documentId, mark.id)).toBe(s2.version.id)

    const promoted = await inOrg(() =>
      versions.promoteVersionToPublished(draft.id, documentId, ORG, 'approved', { state: 'published', publishedBy: USER, publishedAt: new Date() })
    )
    expect(promoted?.superseded.map((row) => row.id)).toEqual([s2.version.id])
    expect(promoted?.carried.moved).toEqual([mark.id])
    expect(await versionOf(documentId, mark.id)).toBe(draft.id)

    const s3 = await inOrg(() => versions.insertPublishedVersion(values(documentId, 's3'), { publishedVersionId: draft.id }, SCENE))
    expect(s3.carried.moved).toEqual([mark.id])
    expect(await versionOf(documentId, mark.id)).toBe(s3.version.id)
  })

  it('an upload of a new Fassung carries the pinned mark too, keeping its box', async () => {
    const documentId = await sketchDocument('Skizze Upload.svg')
    const { version: v1 } = await inOrg(() => versions.insertPublishedVersion(values(documentId, 'u1'), { publishedVersionId: null }))
    const mark = await markOn(documentId, v1.id)
    const uploaded = await inOrg(() => versions.insertPublishedVersion(values(documentId, 'u2')))
    expect(uploaded.carried.moved).toEqual([mark.id])
    const row = await inOrg(() => annotations.findDocumentAnnotation(ORG, documentId, mark.id))
    expect(row).toMatchObject({ versionId: uploaded.version.id, x: 0.1, w: 0.2 })
  })

  it('a save meets the round: review_open while a version is in review, the draft while one is open', async () => {
    const documentId = await sketchDocument('Skizze Runde.svg')
    await inOrg(() => versions.insertPublishedVersion(values(documentId, 'r1'), { publishedVersionId: null }))
    const doc = { id: documentId, organizationId: ORG }
    expect(await inOrg(() => target.sketchTargetOf(doc))).toEqual({ kind: 'published' })
    const draft = await inOrg(() => versions.insertDocumentVersion(draftOf(documentId, 'r2')))
    expect(await inOrg(() => target.sketchTargetOf(doc))).toMatchObject({ kind: 'draft', version: { id: draft.id } })
    await inOrg(() => db.execute(sql`update document_versions set state = 'in_review' where id = ${draft.id}::uuid`))
    expect(await inOrg(() => target.sketchTargetOf(doc))).toMatchObject({ kind: 'review_open', version: { id: draft.id } })
  })
})
