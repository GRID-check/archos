/**
 * @vitest-environment node
 *
 * Which documents a Skizze was traced over (migration 0193), against a REAL
 * Postgres as the restricted runtime role: a row is written once, read back
 * for both directions of the move check, invisible to another organization,
 * unable to name another tenant's document, and never a Skizze over itself.
 * Runs with the RLS suite (`task db:test:rls`):
 *
 *   scripts/rls-test-db.sh --only bff/diagrams/sketch-underlay-register.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const ORG = `org_underlay_${Date.now()}`
const OTHER = `org_underlay_other_${Date.now()}`

describe('the underlay register suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set. Check `task db:test:rls`.').toBeTruthy()
  })
})

describe.skipIf(!url)('sketch_underlay_bases against Postgres', () => {
  let register: typeof import('./sketch-underlay-register')
  let closeDb: typeof import('@/lib/db').closeDb
  let getDb: typeof import('@/lib/db').getDb
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    const db = await import('@/lib/db')
    const context = await import('@/lib/db/tenant-context')
    getDb = db.getDb
    closeDb = db.closeDb
    withTenant = context.withTenant
    register = await import('./sketch-underlay-register')
    const seed = (org: string, name: string) =>
      context.withPlatformAccess('seed a document for the underlay register', async () => {
        const rows = await getDb().execute<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope)
          VALUES (${org}, 'seed', ${name}, ${`seed/${name}`}, 'seed', 'completed', 'office_shelf')
          RETURNING id
        `)
        return Array.from(rows)[0].id
      })
    ids.base = await seed(ORG, 'Lohn.pdf')
    ids.sketch = await seed(ORG, 'Skizze.svg')
    ids.foreign = await seed(OTHER, 'Fremd.pdf')
  }, 60_000)

  afterAll(async () => {
    await closeDb?.()
  })

  it('records a base once and reads it from both ends', async () => {
    await register.recordUnderlayBase(ORG, ids.sketch, ids.base)
    await register.recordUnderlayBase(ORG, ids.sketch, ids.base)
    expect((await register.underlayBasesOf(ORG, ids.sketch)).map((row) => row.id)).toEqual([ids.base])
    expect((await register.sketchesTracing(ORG, ids.base)).map((row) => [row.id, row.name])).toEqual([[ids.sketch, 'Skizze.svg']])
  })

  it('shows another organization nothing', async () => {
    expect(await register.underlayBasesOf(OTHER, ids.sketch)).toEqual([])
    const seen = await withTenant({ organizationId: OTHER }, () => getDb().execute(sql`SELECT * FROM sketch_underlay_bases`))
    expect(Array.from(seen)).toEqual([])
  })

  it('refuses a row naming another tenant’s document, and a Skizze over itself', async () => {
    await expect(
      withTenant({ organizationId: ORG }, () =>
        getDb().execute(sql`INSERT INTO sketch_underlay_bases (organization_id, sketch_document_id, base_document_id) VALUES (${ORG}, ${ids.sketch}, ${ids.foreign})`)
      )
    ).rejects.toThrow()
    await expect(
      withTenant({ organizationId: ORG }, () =>
        getDb().execute(sql`INSERT INTO sketch_underlay_bases (organization_id, sketch_document_id, base_document_id) VALUES (${ORG}, ${ids.sketch}, ${ids.sketch})`)
      )
    ).rejects.toThrow()
  })
})
