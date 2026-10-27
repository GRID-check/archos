/**
 * @vitest-environment node
 *
 * The search's annotation, folder and conversation providers against a REAL
 * Postgres through the restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/search/providers.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The reach is built by hand, as `reachFor` would hand it over (the project the
 * reader may view, with its hidden folder); who holds which folder role in
 * WorkOS is the one thing faked, and the reader holds none. What it proves:
 *   - an annotation is found on a document the reader's listing shows, by its
 *     body or a reply, and never on a document in a hidden folder, on another
 *     person's held upload, or in a project out of reach; and only on a
 *     document the search's document filters admit (its type, its drawing
 *     number), read off the same predicate the documents are found with;
 *   - a folder is found by its name or description, and never when it is
 *     hidden, binned, or in a project out of reach;
 *   - a conversation is found by its title or topic tag as the list would show
 *     it, never another person's private one, a deleted one, one in a project
 *     out of reach, or one whose content is withheld from the reader (ADR-0088).
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { SearchReach } from './reach'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/membership-roles', () => ({
  resolveMembershipRoles: vi.fn(async () => ['member']),
}))
vi.mock('@/lib/authz/folder-roles', () => ({ heldFolderLevels: vi.fn(async () => ({})) }))

const url = process.env.TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_search_providers_${STAMP}`
const READER = `user_search_reader_${STAMP}`
const OTHER = `user_search_other_${STAMP}`

describe('the search providers suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('the search providers against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let providers: typeof import('./providers')
  let reach: SearchReach
  const ids = { project: '', outside: '', hidden: '', restricted: '' }
  /** The documents' question with no filter: the reach alone. */
  const ALL_DOCUMENTS = { filters: {}, citedBy: null, citing: null }

  const session = {
    userId: READER,
    email: 'reader@grid.test',
    name: 'Reader',
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: `om_${READER}`,
    role: 'member',
    roles: ['member'],
    permissions: [],
    featureFlags: null,
  } satisfies AuthorizedSession

  const inOrg = <T>(run: () => PromiseLike<T>) =>
    withTenant({ organizationId: ORG, userId: READER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)
  const page = { limit: 50, offset: 0 }

  const project = async (name: string) =>
    first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, ${name}, ${READER}, ${`proj_sp_${name}_${STAMP}`}) returning id`)
      )
    )

  const folder = async (
    projectId: string,
    name: string,
    extra: { description?: string; custom?: boolean; deleted?: boolean } = {}
  ) =>
    first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into project_folders (organization_id, project_id, name, path, description, access_mode, access_changed_by,
                                       access_changed_at, deleted_at)
          values (${ORG}, ${projectId}::uuid, ${name}, ${name}, ${extra.description ?? null},
                  ${extra.custom ? 'custom' : 'inherit'}, ${extra.custom ? READER : null}, ${extra.custom ? sql`now()` : null},
                  ${extra.deleted ? sql`now()` : null})
          returning id`)
      )
    )

  const documentIn = async (
    projectId: string,
    filename: string,
    {
      createdBy = OTHER,
      held = false,
      folderId = null,
    }: { createdBy?: string; held?: boolean; folderId?: string | null } = {}
  ) =>
    first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome, folder_id)
          values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${projectId}/${filename}`},
                  ${`proj_sp_${projectId}`}, ${createdBy}, ${held ? 'quarantined' : 'completed'}, ${held ? null : 'clean'},
                  ${folderId}::uuid) returning id`)
      )
    )

  const mark = async (documentId: string, body: string) => {
    const repo = await import('@/lib/annotations/repository')
    const [created] = await inOrg(() =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId,
        versionId: null,
        authorKind: 'person',
        createdBy: OTHER,
        marks: [
          {
            page: 1,
            shape: 'point',
            x: 0.5,
            y: 0.5,
            w: null,
            h: null,
            kind: 'defect',
            body,
            basis: null,
            assigneeUserId: null,
            dueOn: null,
          },
        ],
      })
    )
    return created
  }

  const conversation = async (
    id: string,
    {
      title,
      projectId = ids.project,
      createdBy = READER,
      visibility = 'private',
      tags = [],
      deleted = false,
    }: {
      title: string
      projectId?: string | null
      createdBy?: string
      visibility?: 'private' | 'project' | 'organization'
      tags?: string[]
      deleted?: boolean
    }
  ) => {
    const tagArray =
      tags.length > 0
        ? sql`ARRAY[${sql.join(
            tags.map((tag) => sql`${tag}`),
            sql`, `
          )}]::text[]`
        : sql`'{}'::text[]`
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, title, project_id, visibility, tags, deleted_at)
        values (${id}, ${ORG}, ${createdBy}, ${title}, ${projectId}::uuid, ${visibility}, ${tagArray},
                ${deleted ? sql`now()` : null})`)
    )
  }

  const titles = (hits: ReadonlyArray<{ title: string }>) => hits.map((hit) => hit.title).sort()

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    providers = await import('./providers')
    const { projects } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')

    ids.project = await project('Wohnbau')
    ids.outside = await project('Fremdprojekt')
    ids.hidden = await folder(ids.project, 'Verträge geheim', {
      description: 'Fluchtweg im Vertrag',
    })
    ids.restricted = await folder(ids.project, 'Personal', { custom: true })
    await folder(ids.project, 'Verträge Planer', { description: 'Werkverträge' })
    await folder(ids.project, 'Verträge alt', { deleted: true })
    await folder(ids.outside, 'Verträge fremd')

    const shown = await documentIn(ids.project, 'EG.pdf')
    // EG.pdf was read as a submission drawing EP-05; the other documents have no reading.
    const { toSearchFacets } = await import('./facets')
    const { upsertSearchFacets } = await import('./facets-repository')
    const reading = toSearchFacets(
      { documentId: shown, organizationId: ORG, superseded: false },
      {
        summary: 'Grundriss EG',
        revisionFacts: { documentNumber: 'EP-05', revision: 'C', revisionDate: null, scale: null, title: 'Grundriss EG' },
        dossier: { documentType: 'submission_drawing', title: null, summary: null, parties: [], dates: [], place: null, facts: [] },
      } as never
    )
    expect(await upsertSearchFacets(ORG, [reading!])).toBe(1)
    const inHidden = await documentIn(ids.project, 'geheim.pdf', { folderId: ids.hidden })
    const heldForeign = await documentIn(ids.project, 'held-foreign.pdf', { held: true })
    const heldOwn = await documentIn(ids.project, 'held-own.pdf', { createdBy: READER, held: true })
    const elsewhere = await documentIn(ids.outside, 'fremd.pdf')
    await mark(shown, 'Fluchtweg zu schmal')
    const answered = await mark(shown, 'Türbreite prüfen')
    await mark(inHidden, 'Fluchtweg im geheimen Ordner')
    await mark(heldForeign, 'Fluchtweg auf fremdem Upload')
    await mark(heldOwn, 'Fluchtweg auf eigenem Upload')
    await mark(elsewhere, 'Fluchtweg im Fremdprojekt')
    const repo = await import('@/lib/annotations/repository')
    await inOrg(() =>
      repo.insertAnnotationReply({
        organizationId: ORG,
        annotationId: answered.id,
        authorKind: 'person',
        body: 'Der Fluchtweg ist betroffen',
        createdBy: OTHER,
      })
    )

    await conversation(`s_sp_own_${STAMP}`, { title: 'Fluchtweg Besprechung' })
    await conversation(`s_sp_team_${STAMP}`, {
      title: 'Fluchtweg Team',
      createdBy: OTHER,
      visibility: 'project',
    })
    await conversation(`s_sp_private_${STAMP}`, { title: 'Fluchtweg privat', createdBy: OTHER })
    await conversation(`s_sp_outside_${STAMP}`, {
      title: 'Fluchtweg fremd',
      projectId: ids.outside,
      createdBy: OTHER,
      visibility: 'project',
    })
    await conversation(`s_sp_deleted_${STAMP}`, { title: 'Fluchtweg gelöscht', deleted: true })
    await conversation(`s_sp_unstamped_${STAMP}`, {
      title: 'Fluchtweg allgemein',
      projectId: null,
      createdBy: OTHER,
      visibility: 'organization',
    })
    await conversation(`s_sp_tagged_${STAMP}`, { title: 'Stiegenhaus', tags: ['fire_safety'] })
    const withheld = `s_sp_withheld_${STAMP}`
    await conversation(withheld, { title: 'Fluchtweg Personalakte' })
    await inOrg(() =>
      db.execute(sql`
        insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
        values (${ORG}, ${withheld}, ${ids.restricted}::uuid)`)
    )

    const [row] = await inOrg(() => db.select().from(projects).where(eq(projects.id, ids.project)))
    reach = {
      organizationId: ORG,
      userId: READER,
      scope: { kind: 'office' },
      projects: [
        {
          project: row,
          hiddenFolderIds: [ids.hidden],
          collections: [row.collectionName],
          reviewsQuarantine: false,
        },
      ],
      officeShelf: null,
      folderIds: null,
    }
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(
        sql`delete from conversation_restricted_folders where organization_id = ${ORG}`
      )
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('annotations', () => {
    it('finds the marks on documents the reader’s listing shows, by body or reply, and no others', async () => {
      const found = await providers.searchAnnotations(reach, 'fluchtweg', {}, ALL_DOCUMENTS, page)
      expect(found.hits.map((hit) => hit.excerpt).sort()).toEqual(
        [
          'Der Fluchtweg ist betroffen',
          'Fluchtweg auf eigenem Upload',
          'Fluchtweg zu schmal',
        ].sort()
      )
      expect(found.total).toBe(3)
      expect(found.hits.find((hit) => hit.excerpt === 'Fluchtweg zu schmal')).toMatchObject({
        documentName: 'EG.pdf',
        projectName: 'Wohnbau',
        annotationKind: 'defect',
        status: 'open',
      })
    })

    it('does not find a mark on a document in a hidden folder', async () => {
      const found = await providers.searchAnnotations(reach, 'geheimen', {}, ALL_DOCUMENTS, page)
      expect(found).toEqual({ hits: [], total: 0 })
    })

    it('does not find a mark on another person’s held upload', async () => {
      const found = await providers.searchAnnotations(reach, 'fremdem Upload', {}, ALL_DOCUMENTS, page)
      expect(found).toEqual({ hits: [], total: 0 })
    })

    it('lists by the filters alone without text, and narrows to the reader’s own marks', async () => {
      const all = await providers.searchAnnotations(reach, null, {}, ALL_DOCUMENTS, page)
      expect(all.total).toBe(3)
      const mine = await providers.searchAnnotations(reach, null, { createdByMe: true }, ALL_DOCUMENTS, page)
      expect(mine.total).toBe(0)
    })

    it('narrows through the document: only marks on documents the document filters admit', async () => {
      const onDrawings = await providers.searchAnnotations(
        reach,
        'fluchtweg',
        {},
        { filters: { documentTypes: ['submission_drawing'], planNumber: 'ep 0' }, citedBy: null, citing: null },
        page
      )
      // EG.pdf is the submission drawing EP-05; the reader's own held upload has no reading.
      expect(onDrawings.hits.map((hit) => hit.excerpt).sort()).toEqual(['Der Fluchtweg ist betroffen', 'Fluchtweg zu schmal'])
      expect(onDrawings.total).toBe(2)
      const onConcepts = await providers.searchAnnotations(
        reach,
        null,
        {},
        { filters: { documentTypes: ['fire_safety_concept'] }, citedBy: null, citing: null },
        page
      )
      expect(onConcepts).toEqual({ hits: [], total: 0 })
    })
  })

  describe('folders', () => {
    it('finds a living folder in reach by its name or description, never a hidden, binned or foreign one', async () => {
      const byName = await providers.searchFolders(reach, 'Verträge', page)
      expect(byName.hits.map((hit) => hit.name)).toEqual(['Verträge Planer'])
      expect(byName.total).toBe(1)
      const byDescription = await providers.searchFolders(reach, 'werkvertr', page)
      expect(byDescription.hits).toEqual([
        expect.objectContaining({
          name: 'Verträge Planer',
          shelf: 'project',
          projectName: 'Wohnbau',
          excerpt: 'Werkverträge',
        }),
      ])
    })

    it('does not find a hidden folder, not even by its description', async () => {
      expect(await providers.searchFolders(reach, 'geheim', page)).toEqual({ hits: [], total: 0 })
      expect(await providers.searchFolders(reach, 'Fluchtweg im Vertrag', page)).toEqual({
        hits: [],
        total: 0,
      })
    })
  })

  describe('conversations', () => {
    it('finds what the list would show the reader, by title or topic tag', async () => {
      const found = await providers.searchConversations(session, reach, 'Fluchtweg', page)
      expect(titles(found.hits)).toEqual(
        ['Fluchtweg Besprechung', 'Fluchtweg Team', 'Fluchtweg allgemein'].sort()
      )
      expect(found.total).toBe(3)
      const tagged = await providers.searchConversations(session, reach, 'Brandschutz', page)
      expect(titles(tagged.hits)).toEqual(['Stiegenhaus'])
    })

    it('does not find another person’s private conversation', async () => {
      const found = await providers.searchConversations(session, reach, 'privat', page)
      expect(found).toEqual({ hits: [], total: 0 })
    })

    it('does not match a conversation whose content is withheld from the reader', async () => {
      const found = await providers.searchConversations(session, reach, 'Personalakte', page)
      expect(found).toEqual({ hits: [], total: 0 })
    })

    it('reads only that project’s rows within a project scope', async () => {
      const found = await providers.searchConversations(
        session,
        { ...reach, scope: { kind: 'project', projectId: ids.project } },
        'Fluchtweg',
        page
      )
      expect(titles(found.hits)).toEqual(['Fluchtweg Besprechung', 'Fluchtweg Team'])
    })
  })
})
