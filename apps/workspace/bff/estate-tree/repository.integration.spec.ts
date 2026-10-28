/**
 * @vitest-environment node
 *
 * The estate tree's SQL against a REAL Postgres, through the restricted runtime
 * role (`task db:test:rls`):
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     bunx vitest run bff/estate-tree/repository.integration.spec.ts
 *
 * Under the reach a conversation's shared audience gets (`screenedOnly`, the
 * restricted folders hidden; built here from the real `getRestrictedFolderIds`
 * rather than WorkOS), it proves: an empty folder is listed with its description
 * and its card; a restricted folder, its subfolder and its document are absent;
 * a binned folder and its document are absent; a held upload is absent, its
 * uploader's included; an archived document is absent; the projection's
 * Dokumentart and pages and the published Fassung ride on the row; the page is
 * bounded and the cursor walks it without a gap or a repeat; the conversation's
 * own files are its own; another organization reads nothing.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_estate_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_estate'
const COLLECTION = `proj_estate_${STAMP}`
const CHAT = `s_estate_${STAMP}`
const OTHER_CHAT = `s_estate_other_${STAMP}`

describe.skipIf(!url)('the estate tree against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let reach: import('@/lib/search/reach').SearchReach
  let projectId: string
  const folder: Record<string, string> = {}
  const doc: Record<string, string> = {}

  const as = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  async function insertFolder(name: string, path: string, parent: string | null, extra: { description?: string; custom?: boolean } = {}) {
    const [row] = Array.from(
      await as(ORG, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, description, access_mode,
                                       access_changed_by, access_changed_at)
          VALUES (${ORG}, ${projectId}::uuid, ${parent}::uuid, ${name}, ${path}, ${extra.description ?? null},
                  ${extra.custom ? 'custom' : 'inherit'}, ${extra.custom ? USER : null}, ${extra.custom ? sql`now()` : null})
          RETURNING id`),
      ),
    )
    folder[path] = String(row.id)
    return folder[path]
  }

  async function insertDocument(
    key: string,
    fields: { filename: string; folder?: string | null; collection?: string; status?: string; lifecycle?: string; createdBy?: string; scope?: 'project' | 'session'; conversation?: string; org?: string },
  ) {
    const scope = fields.scope ?? 'project'
    const org = fields.org ?? ORG
    const [row] = Array.from(
      await as(org, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope,
                                 project_id, conversation_id, folder_id, lifecycle, screening_outcome, content_hash, screened_hash)
          VALUES (${org}, ${fields.createdBy ?? USER}, ${fields.filename}, ${`k/${key}`}, ${fields.collection ?? COLLECTION},
                  ${fields.status ?? 'completed'}, ${scope}, ${scope === 'project' ? projectId : null}::uuid,
                  ${fields.conversation ?? null}, ${fields.folder ?? null}::uuid, ${fields.lifecycle ?? 'active'},
                  ${fields.status === 'quarantined' ? 'quarantined' : 'clean'}, 'h', 'h')
          RETURNING id`),
      ),
    )
    doc[key] = String(row.id)
    return doc[key]
  }

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    const { restrictedCollectionName } = await import('@/lib/authz/folder-access-rule')
    const { getRestrictedFolderIds } = await import('@/lib/authz/folder-access')

    const [project] = Array.from(
      await as(ORG, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Hubergasse', ${USER}, ${COLLECTION}) RETURNING id`),
      ),
    )
    projectId = String(project.id)
    for (const [org, id] of [[ORG, CHAT], [ORG, OTHER_CHAT], [OTHER_ORG, `${CHAT}_x`]] as const) {
      await as(org, () =>
        db.execute(sql`INSERT INTO conversations (id, organization_id, created_by, title) VALUES (${id}, ${org}, ${USER}, 'Chat')`),
      )
    }

    const submission = await insertFolder('Einreichung', 'Einreichung', null, { description: 'Unterlagen der Einreichung' })
    await insertFolder('Pläne', 'Einreichung/Pläne', submission)
    await insertFolder('Leer', 'Leer', null, { description: 'Noch nichts darin' })
    const personal = await insertFolder('Personal', 'Personal', null, { custom: true })
    await insertFolder('Verträge', 'Personal/Verträge', personal)
    const binned = await insertFolder('Alt', 'Alt', null)

    await insertDocument('root', { filename: 'Lageplan.pdf' })
    await insertDocument('plan', { filename: 'EP-01_Grundrisse_Index-B.pdf', folder: folder['Einreichung/Pläne'] })
    await insertDocument('restricted', { filename: 'Gehaltsliste.pdf', folder: personal, collection: restrictedCollectionName(COLLECTION, personal) })
    await insertDocument('restrictedChild', { filename: 'Dienstvertrag.pdf', folder: folder['Personal/Verträge'], collection: restrictedCollectionName(COLLECTION, personal) })
    await insertDocument('binned', { filename: 'Alt.pdf', folder: binned })
    // Binned after its document is filed: nothing may be filed into a deleted folder (migration 0111's trigger).
    await as(ORG, () =>
      db.execute(sql`UPDATE project_folders SET deleted_at = now(), deleted_by = ${USER}, bin_root_id = id WHERE id = ${binned}::uuid`),
    )
    await insertDocument('held', { filename: 'Upload.pdf', status: 'quarantined' })
    await insertDocument('archived', { filename: 'Archiviert.pdf', lifecycle: 'archived' })
    for (let n = 0; n < 5; n++) await insertDocument(`bulk${n}`, { filename: `Bulk-${n}.pdf`, folder: submission })
    await insertDocument('chat', { filename: 'Foto.jpg', scope: 'session', conversation: CHAT, collection: CHAT })
    await insertDocument('otherChat', { filename: 'Fremd.jpg', scope: 'session', conversation: OTHER_CHAT, collection: OTHER_CHAT })
    await insertDocument('otherOrg', { filename: 'Lageplan.pdf', org: OTHER_ORG, scope: 'session', conversation: `${CHAT}_x`, collection: CHAT })

    await as(ORG, () =>
      db.execute(sql`
        INSERT INTO folder_cards (organization_id, folder_id, scope, collection, abstract, input_hash, status, generated_at)
        VALUES (${ORG}, ${submission}::uuid, 'project', ${COLLECTION}, 'Die Einreichung.', 'h1', 'fresh', now())`),
    )
    await as(ORG, () =>
      db.execute(sql`
        INSERT INTO document_search_facets (document_id, organization_id, document_type, page_count, superseded, plan_number, plan_index, fingerprint)
        VALUES (${doc.plan}::uuid, ${ORG}, 'floor_plan', 4, false, 'EP-01', 'B', 'f1')`),
    )
    await as(ORG, async () => {
      const [version] = Array.from(
        await db.execute<{ id: string }>(sql`
          INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         approved_by, approved_at, published_by, published_at, created_by)
          VALUES (${ORG}, ${doc.plan}::uuid, ${projectId}::uuid, 2, 'published', 'k/plan-2', ${USER}, now(), ${USER}, now(), ${USER})
          RETURNING id`),
      )
      await db.execute(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by)
        VALUES (${ORG}, ${doc.plan}::uuid, ${projectId}::uuid, 1, 'superseded', 'k/plan-1', ${USER})`)
      await db.execute(sql`UPDATE documents SET published_version_id = ${version.id}::uuid WHERE id = ${doc.plan}::uuid`)
    })

    const { listProjectFolderTree } = await import('@/lib/authz/folder-access-repository')
    expect((await listProjectFolderTree(ORG, projectId)).length).toBe(6)
    const restricted = await getRestrictedFolderIds(ORG, projectId)
    const projectRow = { id: projectId, collectionName: COLLECTION } as import('@/lib/db/schema').Project
    reach = {
      organizationId: ORG,
      userId: USER,
      scope: { kind: 'project', projectId },
      projects: [{ project: projectRow, hiddenFolderIds: restricted, collections: [COLLECTION], reviewsQuarantine: false }],
      officeShelf: null,
      folderIds: null,
      screenedOnly: true,
    }
  })

  afterAll(async () => {
    await withPlatformAccess('estate tree spec cleanup', async () => {
      await db.execute(sql`DELETE FROM documents WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM conversations WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}::uuid`)
    })
  })

  const allDocuments = async (source: import('./repository').TreeSource, org = ORG) => {
    const names: string[] = []
    let cursor: import('./repository').TreeCursor | null = null
    for (let guard = 0; guard < 20; guard++) {
      const rows = await as(org, () => repo.listTreeDocuments(source, { cursor, limit: 2 }))
      const page = rows.slice(0, 2)
      expect(page.length).toBeLessThanOrEqual(2)
      names.push(...page.map((row) => row.filename))
      if (rows.length <= 2) return names
      cursor = { filename: page[1].filename, id: page[1].id }
    }
    throw new Error('the cursor did not end')
  }

  it('lists every folder the audience may list, empty ones with their description and the card beside them', async () => {
    const { rows, truncated } = await as(ORG, () => repo.listTreeFolders(reach))
    expect(truncated).toBe(false)
    expect(rows.map((row) => row.path)).toEqual(['Einreichung', 'Einreichung/Pläne', 'Leer'])
    expect(rows.find((row) => row.path === 'Leer')).toMatchObject({ description: 'Noch nichts darin', cardStatus: null })
    expect(rows.find((row) => row.path === 'Einreichung')).toMatchObject({ cardStatus: 'fresh', parentId: null })
    expect(rows.find((row) => row.path === 'Einreichung/Pläne')?.parentId).toBe(folder['Einreichung'])
  })

  it('pages the documents without a restricted, binned, held or archived one, and without a gap or a repeat', async () => {
    const names = await allDocuments({ kind: 'reach', reach })
    expect(names).toEqual(['Bulk-0.pdf', 'Bulk-1.pdf', 'Bulk-2.pdf', 'Bulk-3.pdf', 'Bulk-4.pdf', 'EP-01_Grundrisse_Index-B.pdf', 'Lageplan.pdf'])
  })

  it('carries what ingestion read and the published Fassung on the row', async () => {
    const rows = await as(ORG, () => repo.listTreeDocuments({ kind: 'reach', reach }, { cursor: null, limit: 100 }))
    expect(rows.find((row) => row.id === doc.plan)).toMatchObject({
      folderPath: 'Einreichung/Pläne',
      documentType: 'floor_plan',
      pageCount: 4,
      superseded: false,
      planNumber: 'EP-01',
      planIndex: 'B',
      publishedVersion: 2,
      versionCount: 2,
    })
    expect(rows.find((row) => row.id === doc.root)).toMatchObject({ documentType: null, pageCount: null, publishedVersion: null, versionCount: 0 })
  })

  it('reads a folder subtree as the reach scopes it', async () => {
    const scoped = { ...reach, folderIds: [folder['Einreichung'], folder['Einreichung/Pläne']] }
    expect((await as(ORG, () => repo.listTreeFolders(scoped))).rows.map((row) => row.path)).toEqual(['Einreichung', 'Einreichung/Pläne'])
    expect(await allDocuments({ kind: 'reach', reach: scoped })).toHaveLength(6)
  })

  it('resolves a path to a living folder of the shelf only', async () => {
    const { projectShelf } = await import('@/lib/documents/shelf')
    expect(await as(ORG, () => repo.findFolderIdByPath(ORG, projectShelf(projectId), 'Leer'))).toBe(folder['Leer'])
    expect(await as(ORG, () => repo.findFolderIdByPath(ORG, projectShelf(projectId), 'Alt'))).toBeNull()
    expect(await as(OTHER_ORG, () => repo.findFolderIdByPath(OTHER_ORG, projectShelf(projectId), 'Leer'))).toBeNull()
  })

  it('reads the conversation’s own files only, under the audience’s reader', async () => {
    expect(await allDocuments({ kind: 'session', reach, conversationId: CHAT })).toEqual(['Foto.jpg'])
  })

  it('lets another organization read nothing, by the WHERE and by the policy', async () => {
    const foreign = { ...reach, organizationId: OTHER_ORG }
    expect((await as(OTHER_ORG, () => repo.listTreeFolders(foreign))).rows).toEqual([])
    expect(await allDocuments({ kind: 'reach', reach: foreign }, OTHER_ORG)).toEqual([])
    // Asked in the other tenant for this one's rows: RLS answers nothing.
    expect(await allDocuments({ kind: 'reach', reach }, OTHER_ORG)).toEqual([])
    expect(await allDocuments({ kind: 'session', reach, conversationId: CHAT }, OTHER_ORG)).toEqual([])
  })
})
