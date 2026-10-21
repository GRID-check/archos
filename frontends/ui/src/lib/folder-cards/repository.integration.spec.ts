/**
 * @vitest-environment node
 *
 * The folder cards against a REAL Postgres (migration 0180, ADR-0127), through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     bunx vitest run src/lib/folder-cards/repository.integration.spec.ts
 *
 * Proves the SQL the route rests on: a path resolves to its folder inside the
 * organization and shelf; another organization neither reads nor writes the
 * card; a rewrite replaces the card; a deleted folder's card is not listed.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
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
    process.env.GRID_APP_DATABASE_URL = url
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
    const cards = await as(ORG, () => repo.getFolderCards(ORG, SHELF))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ abstract: 'Zweite Fassung.', input_hash: 'h2', folder_path: 'Vertraege' })
  })

  it('keeps another organization out, by the WHERE and by the policy', async () => {
    expect(await as(OTHER_ORG, () => repo.getFolderCards(OTHER_ORG, SHELF))).toEqual([])
    expect(await as(OTHER_ORG, () => repo.getFolderCards(ORG, SHELF))).toEqual([])
    const folder = (await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege')))!
    // Stating the other organization's id inside this one's scope is refused by WITH CHECK or finds nothing.
    await expect(as(OTHER_ORG, () => repo.upsertFolderCard(ORG, folder, body()))).rejects.toThrow()
  })

  it('removes a card on request, and says so when there was none', async () => {
    const folder = (await as(ORG, () => repo.findCardFolder(ORG, SHELF, 'Vertraege')))!
    expect(await as(ORG, () => repo.deleteFolderCard(ORG, folder))).toBe(true)
    expect(await as(ORG, () => repo.deleteFolderCard(ORG, folder))).toBe(false)
    expect(await as(ORG, () => repo.getFolderCards(ORG, SHELF))).toEqual([])
  })
})
