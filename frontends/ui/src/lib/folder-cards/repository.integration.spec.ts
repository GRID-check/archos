/**
 * @vitest-environment node
 *
 * The folder cards against a REAL Postgres (migration 0180, ADR-0127), through
 * the restricted runtime role:
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     bunx vitest run src/lib/folder-cards/repository.integration.spec.ts
 *
 * Proves the SQL the route rests on: a path resolves to its folder inside the
 * organization and shelf; another organization neither reads nor writes the
 * card; a rewrite replaces the card; a deleted folder's card is not listed; a
 * restricted folder's card is written and read under its own collection alone,
 * including a card written before the folder was restricted; and a folder's
 * description is returned before it has a card.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const ORG = `org_fc_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const SHELF = `archiv_${ORG}`

const body = (patch: Partial<import('./types').PutFolderCardRequest> = {}): import('./types').PutFolderCardRequest => ({
  organization_id: ORG,
  collection: SHELF,
  folder_path: 'Vertraege',
  abstract: 'Erste Fassung.',
  key_facts: [],
  input_hash: 'h1',
  abstract_hash: 'a1',
  model: 'm',
  prompt_version: 'v1',
  status: 'fresh',
  ...patch,
})

describe.skipIf(!url)('folder cards against Postgres', () => {
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  const as = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: null }, run)

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    for (const org of [ORG, OTHER_ORG]) {
      await as(org, () =>
        db.execute(
          sql`INSERT INTO project_folders (organization_id, scope, name, path) VALUES (${org}, 'office_shelf', 'Vertraege', 'Vertraege')`,
        ),
      )
    }
  })

  afterAll(async () => {
    await withPlatformAccess('folder cards spec cleanup', () =>
      db.execute(sql`DELETE FROM project_folders WHERE organization_id IN (${ORG}, ${OTHER_ORG})`),
    )
  })

  it('resolves a shelf path inside the organization, and not a foreign collection', async () => {
    const folder = await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege'))
    expect(folder?.scope).toBe('office_shelf')
    expect(await as(ORG, () => repo.findCardFolder(ORG, `archiv_${OTHER_ORG}`, 'Vertraege'))).toBeNull()
    expect(await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Nope'))).toBeNull()
  })

  it('replaces the card on a second write, one card per folder', async () => {
    const folder = (await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege')))!
    await as(ORG, () => repo.upsertFolderCard(ORG, folder, body()))
    await as(ORG, () => repo.upsertFolderCard(ORG, folder, body({ abstract: 'Zweite Fassung.', input_hash: 'h2' })))
    const { cards } = await as(ORG, () => repo.getFolderCards(ORG, SHELF))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ abstract: 'Zweite Fassung.', input_hash: 'h2', folder_path: 'Vertraege' })
  })

  it('keeps another organization out, by the WHERE and by the policy', async () => {
    expect((await as(OTHER_ORG, () => repo.getFolderCards(OTHER_ORG, SHELF))).cards).toEqual([])
    expect((await as(OTHER_ORG, () => repo.getFolderCards(ORG, SHELF))).cards).toEqual([])
    const folder = (await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege')))!
    // Stating the other organization's id inside this one's scope is refused by WITH CHECK or finds nothing.
    await expect(as(OTHER_ORG, () => repo.upsertFolderCard(ORG, folder, body()))).rejects.toThrow()
  })

  describe('a project with a folder that restricts reading', () => {
    const PROJECT_COLLECTION = `proj_fc_${Date.now()}`
    let projectId: string
    let personalId: string
    let restricted: string

    const projectBody = (patch: Partial<import('./types').PutFolderCardRequest> = {}) =>
      body({ collection: PROJECT_COLLECTION, folder_path: 'Personal', abstract: 'Gehälter der Mitarbeiter.', ...patch })

    beforeAll(async () => {
      const { restrictedCollectionName } = await import('@/lib/authz/folder-access-rule')
      const [project] = Array.from(
        await as(ORG, () =>
          db.execute<{ id: string }>(sql`
            INSERT INTO projects (organization_id, name, created_by, collection_name)
            VALUES (${ORG}, 'Folder cards', 'user_fc', ${PROJECT_COLLECTION}) RETURNING id
          `),
        ),
      )
      projectId = project.id
      const [personal] = Array.from(
        await as(ORG, () =>
          db.execute<{ id: string }>(sql`
            INSERT INTO project_folders (organization_id, project_id, name, path, description)
            VALUES (${ORG}, ${projectId}::uuid, 'Personal', 'Personal', 'Personalakten') RETURNING id
          `),
        ),
      )
      personalId = personal.id
      restricted = restrictedCollectionName(PROJECT_COLLECTION, personalId)
    })

    afterAll(async () => {
      await withPlatformAccess('folder cards spec cleanup', () =>
        db.execute(sql`DELETE FROM projects WHERE id = ${projectId}::uuid`),
      )
    })

    const restrict = () =>
      as(ORG, () =>
        db.execute(sql`
          UPDATE project_folders SET access_mode = 'custom', access_changed_by = 'user_fc', access_changed_at = now()
          WHERE id = ${personalId}::uuid
        `),
      )

    it('returns a folder’s description before it has a card', async () => {
      const read = await as(ORG, () => repo.getFolderCards(ORG, PROJECT_COLLECTION))
      expect(read.cards).toEqual([])
      expect(read.folders).toEqual([{ folder_id: personalId, folder_path: 'Personal', folder_description: 'Personalakten' }])
    })

    it('stops serving a card under the project collection once its folder is restricted', async () => {
      const folder = (await as(ORG, () => repo.findCardFolder(ORG, PROJECT_COLLECTION, 'Personal')))!
      await as(ORG, () => repo.upsertFolderCard(ORG, folder, projectBody()))
      expect((await as(ORG, () => repo.getFolderCards(ORG, PROJECT_COLLECTION))).cards).toHaveLength(1)

      await restrict()

      const open = await as(ORG, () => repo.getFolderCards(ORG, PROJECT_COLLECTION))
      expect(open.cards).toEqual([])
      expect(open.folders).toEqual([])
      const own = await as(ORG, () => repo.getFolderCards(ORG, restricted))
      expect(own.cards).toHaveLength(1)
      expect(own.cards[0]).toMatchObject({ folder_path: 'Personal', collection: restricted })
    })

    it('refuses to file a restricted folder’s card under any collection but its own', async () => {
      expect(await as(ORG, () => repo.findCardFolder(ORG, PROJECT_COLLECTION, 'Personal'))).toBeNull()
      expect(await as(ORG, () => repo.findCardFolder(ORG, `${PROJECT_COLLECTION}_r000000000000`, 'Personal'))).toBeNull()
      expect((await as(ORG, () => repo.findCardFolder(ORG, restricted, 'Personal')))?.folderId).toBe(personalId)
    })

    it('keeps when the last good card was generated through a stale mark', async () => {
      const folder = (await as(ORG, () => repo.findCardFolder(ORG, restricted, 'Personal')))!
      await as(ORG, () => repo.upsertFolderCard(ORG, folder, projectBody({ collection: restricted })))
      const [before] = (await as(ORG, () => repo.getFolderCards(ORG, restricted))).cards
      await as(ORG, () => repo.upsertFolderCard(ORG, folder, projectBody({ collection: restricted, status: 'stale' })))
      const [after] = (await as(ORG, () => repo.getFolderCards(ORG, restricted))).cards
      expect(after.status).toBe('stale')
      expect(after.generated_at).toBe(before.generated_at)
    })
  })

  it('removes a card on request, and says so when there was none', async () => {
    const folder = (await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege')))!
    expect(await as(ORG, () => repo.deleteFolderCard(ORG, folder))).toBe(true)
    expect(await as(ORG, () => repo.deleteFolderCard(ORG, folder))).toBe(false)
    expect((await as(ORG, () => repo.getFolderCards(ORG, SHELF))).cards).toEqual([])
  })
})
